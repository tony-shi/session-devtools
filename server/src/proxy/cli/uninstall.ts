// 卸载器 —— 设计文档 §5.2。
// 反向操作：回填 HTTPS_PROXY/HTTP_PROXY，删我们注入的 5 个 env key，停 daemon，
// 删 LaunchAgent/systemd unit，删 proxy/ 目录（backups/ 保留）。
import { existsSync, readFileSync, writeFileSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PATHS } from "../config";
import { uninstallDaemon } from "./daemon";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
// 与 install.ts 保持一致的 5 个 key
const OUR_ENV_KEYS = new Set([
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "API_DASHBOARD_PROXY_UPSTREAM",
]);
// 我们写的 NO_PROXY 最小集（卸载时从合并值里摘除，与 install.ts 保持一致）
const OUR_NO_PROXY_MIN = new Set(["localhost", "::1"]);


function log(msg: string) {
  console.log(`[uninstall] ${msg}`);
}

function readSettings(): Record<string, unknown> {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

// 备份当前 settings（卸载前再存一份，以防需要"回滚的回滚"）
function backupCurrentSettings(ts: string) {
  if (!existsSync(SETTINGS_PATH)) return;
  mkdirSync(PATHS.backups, { recursive: true, mode: 0o700 });
  const dest = join(PATHS.backups, `settings.json.pre-rollback-${ts}`);
  cpSync(SETTINGS_PATH, dest);
  log(`当前 settings.json 已备份到 ${dest}`);
}

// 停 daemon（读 pid 文件，发 SIGTERM）
function stopDaemon(): void {
  if (!existsSync(PATHS.pidFile)) {
    log("未找到 pid 文件，daemon 可能未运行");
    return;
  }
  const pid = readFileSync(PATHS.pidFile, "utf8").trim();
  if (!pid) return;
  try {
    process.kill(Number(pid), "SIGTERM");
    log(`已发送 SIGTERM 到 PID ${pid}`);
    // 等一下让进程退出
    let waited = 0;
    while (waited < 3000) {
      try {
        process.kill(Number(pid), 0); // 探测进程是否还在
        Bun.sleepSync(200);
        waited += 200;
      } catch {
        break; // 进程已退出
      }
    }
  } catch (err: any) {
    if (err.code !== "ESRCH") {
      log(`SIGTERM 失败: ${err.message}（daemon 可能已停止）`);
    }
  }
}


async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  log(`开始卸载 session-dashboard MITM 代理${dryRun ? "（dry-run）" : ""}`);

  // ── 1. 读取当前 settings ──────────────────────────────────────────────────
  const settings = readSettings();
  const existingEnv = ((settings.env ?? {}) as Record<string, string>);

  // ── 2. 计算回填值 ─────────────────────────────────────────────────────────
  // 把 API_DASHBOARD_PROXY_UPSTREAM 的值回填到 HTTPS_PROXY / HTTP_PROXY
  const upstream = existingEnv.API_DASHBOARD_PROXY_UPSTREAM;
  const newEnv: Record<string, string> = { ...existingEnv };

  // 删除我们注入的 key
  for (const k of OUR_ENV_KEYS) {
    delete newEnv[k];
  }

  // 回填上游代理（如果有）
  if (upstream) {
    newEnv.HTTPS_PROXY = upstream;
    newEnv.HTTP_PROXY = upstream;
    log(`回填上游代理 ${upstream} → HTTPS_PROXY / HTTP_PROXY`);
  }

  // 清理 NO_PROXY 里我们追加的最小集（只摘除，保留用户原有值）
  const origNoProxy = existingEnv.NO_PROXY ?? "";
  if (origNoProxy) {
    const filtered = origNoProxy
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !OUR_NO_PROXY_MIN.has(s));
    if (filtered.length > 0) {
      newEnv.NO_PROXY = filtered.join(",");
    }
    // 如果过滤后为空，且原来就只有我们加的值，则删除 NO_PROXY
    if (!newEnv.NO_PROXY && OUR_ENV_KEYS.has("NO_PROXY")) {
      delete newEnv.NO_PROXY;
    }
  }

  const newSettings = { ...settings, env: newEnv };

  if (dryRun) {
    log("--dry-run 模式，不写盘。env 变更预览：");
    const allKeys = new Set([...Object.keys(existingEnv), ...Object.keys(newEnv)]);
    for (const k of allKeys) {
      const bv = existingEnv[k];
      const av = newEnv[k];
      if (bv === av) continue;
      if (av === undefined) console.log(`  - ${k} (was: ${bv})`);
      else console.log(`  ~ ${k}: ${bv} → ${av}`);
    }
    log("dry-run 结束。");
    process.exit(0);
  }

  // ── 3. 停 daemon ──────────────────────────────────────────────────────────
  log("停止 daemon...");
  stopDaemon();

  // ── 4. 卸载平台 daemon 包装 ───────────────────────────────────────────────
  uninstallDaemon();

  // ── 5. 备份当前 settings，再写入回滚后的版本 ──────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  backupCurrentSettings(ts);
  writeSettings(newSettings);
  log(`settings.json 已还原（${SETTINGS_PATH}）`);

  // ── 6. 删除 proxy/ 目录（backups/ 保留）──────────────────────────────────
  if (existsSync(PATHS.home)) {
    try {
      rmSync(PATHS.home, { recursive: true, force: true });
      log(`已删除 ${PATHS.home}`);
    } catch (err: any) {
      log(`删除 proxy/ 失败: ${err.message}（可手动删除）`);
    }
  }

  // A5 清理：mitm-hosts.json 与 target-ca/ 已在 proxy/ 目录内，随上面一起删除
  log("mitm-hosts.json 与 target-ca/ 已随 proxy/ 目录一并清理");

  log("卸载完成。重启 Claude Code 后生效。");
  log(`备份保留在: ${PATHS.backups}`);
}

main().catch((err) => {
  console.error("[uninstall] 致命错误:", err);
  process.exit(1);
});
