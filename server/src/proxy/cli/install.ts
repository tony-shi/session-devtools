// 安装器 —— 设计文档 §5.1 / §5.3。
// 流程：preflight → 备份 settings → 迁移 HTTPS_PROXY → 写入 5 个 env key。
//
// 当前阶段 proxy 不再安装为 LaunchAgent/systemd 常驻服务。安装器只写入 settings，
// 实际代理进程由管理页显式启动/停止，避免 `bun run dev` 隐式改写 Claude Code 出口。
// --dry-run: 打印 diff，不写盘。
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_LISTEN_PORT, PATHS } from "../config";
import { runPreflight } from "../preflight";
import { uninstallDaemon } from "./daemon";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
// 我们注入的 5 个 env key（精确匹配，卸载时只删这些）
const OUR_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "API_DASHBOARD_PROXY_UPSTREAM",
] as const;

// NO_PROXY 最小集：只排除 localhost 域名形式，不排除 127.0.0.1 IP。
// 原因：用户可能把自定义网关放在 127.0.0.1:xxxx，需要经过我们 MITM。
// 我们自己的代理地址（127.0.0.1:PORT）由 HTTPS_PROXY 指定，undici 不会对它自身走代理，不需要加 NO_PROXY。
const OUR_NO_PROXY_MIN = ["localhost", "::1"];

function log(msg: string) {
  console.log(`[install] ${msg}`);
}

function printDiff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const bEnv = (before.env ?? {}) as Record<string, string>;
  const aEnv = (after.env ?? {}) as Record<string, string>;
  const allKeys = new Set([...Object.keys(bEnv), ...Object.keys(aEnv)]);
  const changed: string[] = [];
  for (const k of allKeys) {
    const bv = bEnv[k];
    const av = aEnv[k];
    if (bv === av) continue;
    if (bv === undefined) changed.push(`  + ${k} = ${av}`);
    else if (av === undefined) changed.push(`  - ${k} (was: ${bv})`);
    else changed.push(`  ~ ${k}: ${bv} → ${av}`);
  }
  if (changed.length === 0) {
    log("settings.json env 块无变化");
  } else {
    log("settings.json env 变更预览：");
    for (const line of changed) console.log(line);
  }
}

function collectCaptureHosts(existingEnv: Record<string, string>): Set<string> {
  const hosts = new Set<string>(["api.anthropic.com"]);
  const baseUrl = existingEnv.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.hostname) hosts.add(parsed.hostname.toLowerCase());
    } catch {
      // 非法 base URL 由 preflight 报告；安装器这里不额外失败。
    }
  }
  return hosts;
}

function noProxyPatternMatchesHost(pattern: string, host: string): boolean {
  const normalized = pattern.toLowerCase().trim();
  if (!normalized) return false;
  if (normalized === "*") return true;
  const withoutPort = normalized.includes(":") ? normalized.split(":")[0]! : normalized;
  if (withoutPort.startsWith(".")) {
    const suffix = withoutPort.slice(1);
    return host === suffix || host.endsWith(withoutPort);
  }
  return host === withoutPort;
}

// 读取 settings.json，不存在时返回空对象。
function readSettings(): Record<string, unknown> {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// 写入 settings.json，保留原有所有字段，只改 env 块中我们关心的 key。
function writeSettings(settings: Record<string, unknown>) {
  const dir = join(homedir(), ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

// 备份 settings.json 到 backups/ 目录（带时间戳）。
function backupSettings(ts: string) {
  if (!existsSync(SETTINGS_PATH)) return;
  mkdirSync(PATHS.backups, { recursive: true, mode: 0o700 });
  const dest = join(PATHS.backups, `settings.json.before-mitm-${ts}`);
  cpSync(SETTINGS_PATH, dest);
  log(`settings.json 已备份到 ${dest}`);
}

// §5.3 决策表：根据现有 HTTPS_PROXY 决定如何迁移。
// 返回更新后的 env 块（在原有基础上合并）。
export function buildEnvPatch(
  existingEnv: Record<string, string>,
  ourPort: number,
  caCertPath: string,
): Record<string, string> {
  const patch: Record<string, string> = {};
  const ourProxy = `http://127.0.0.1:${ourPort}`;

  const currentHttpsProxy = existingEnv.HTTPS_PROXY ?? existingEnv.https_proxy ?? "";

  // 如果当前 HTTPS_PROXY 已经指向我们（重装路径），不重复迁移上游
  const isAlreadyOurs =
    currentHttpsProxy === ourProxy || currentHttpsProxy === `http://127.0.0.1:${ourPort}`;

  if (isAlreadyOurs) {
    // 重装：只更新 CA 路径，不动上游
    log("检测到重装路径，保留现有 HTTPS_PROXY 指向");
  } else if (currentHttpsProxy && currentHttpsProxy !== ourProxy) {
    // 有上游代理：迁移到 API_DASHBOARD_PROXY_UPSTREAM，我们接管 HTTPS_PROXY
    patch.API_DASHBOARD_PROXY_UPSTREAM = currentHttpsProxy;
    log(`迁移上游代理 ${currentHttpsProxy} → API_DASHBOARD_PROXY_UPSTREAM`);
  }
  // 无论如何都写入我们的代理地址
  patch.HTTPS_PROXY = ourProxy;
  patch.HTTP_PROXY = ourProxy;

  // 合并 NO_PROXY：保留用户已有的值，追加我们的最小集。
  // 注意：被 MITM 的目标 host 不能出现在 NO_PROXY 中，否则 Claude Code 会绕过我们直连。
  // 典型场景是 claude-free / 公司网关写在 ANTHROPIC_BASE_URL，同时旧配置里有
  // NO_PROXY=internal-llm.example，结果请求直接打到网关，traffic.jsonl 里看不到。
  const captureHosts = collectCaptureHosts(existingEnv);
  const userNoProxy = (existingEnv.NO_PROXY ?? existingEnv.no_proxy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((entry) => ![...captureHosts].some((host) => noProxyPatternMatchesHost(entry, host)));
  const mergedNoProxy = [...new Set([...userNoProxy, ...OUR_NO_PROXY_MIN])];
  patch.NO_PROXY = mergedNoProxy.join(",");

  // NODE_EXTRA_CA_CERTS 指向我们的 CA
  patch.NODE_EXTRA_CA_CERTS = caCertPath;

  return patch;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? Number(args[portArg + 1]) : DEFAULT_LISTEN_PORT;

  log(`开始安装 session-dashboard MITM 代理（port=${port}${dryRun ? ", dry-run" : ""}）`);

  // ── 1. Preflight ──────────────────────────────────────────────────────────
  log("运行 preflight 检查...");
  const report = await runPreflight({ ourPort: port });
  for (const r of report.results) {
    const icon = r.severity === "OK" ? "✓" : r.severity === "WARN" ? "⚠" : "✗";
    console.log(`  ${icon} [${r.id}] ${r.name}: ${r.message}`);
    if (r.hint) console.log(`      提示: ${r.hint}`);
  }
  if (report.blocked) {
    console.error("\n[install] preflight BLOCK，终止安装。请修复上述问题后重试。");
    process.exit(0); // 设计文档 §5.0：BLOCK 走 exit 0
  }
  log("preflight 全部通过，继续...");

  // ── 2. 读取现有 settings ──────────────────────────────────────────────────
  const settings = readSettings();
  const existingEnv = ((settings.env ?? {}) as Record<string, string>);

  // ── 3. 计算 env patch ─────────────────────────────────────────────────────
  const patch = buildEnvPatch(existingEnv, port, PATHS.caCert);
  const newSettings = {
    ...settings,
    env: { ...existingEnv, ...patch },
  };

  if (dryRun) {
    log("--dry-run 模式，不写盘：");
    printDiff(settings, newSettings);
    log("dry-run 结束。");
    process.exit(0);
  }

  // ── 4. 备份 ───────────────────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  backupSettings(ts);

  // ── 5. 确保 proxy/ 目录存在 ───────────────────────────────────────────────
  mkdirSync(PATHS.home, { recursive: true, mode: 0o700 });
  mkdirSync(PATHS.backups, { recursive: true, mode: 0o700 });

  // ── 6. 生成 CA（如果还没有）────────────────────────────────────────────────
  log("检查 CA 证书...");
  const { ensureCa, caFingerprint } = await import("../ca");
  const ca = await ensureCa();
  log(`CA 就绪，SHA-256: ${caFingerprint(ca.certPem)}`);

  // ── 7. 写入 settings.json ─────────────────────────────────────────────────
  printDiff(settings, newSettings);
  writeSettings(newSettings);
  log(`settings.json 已更新（${SETTINGS_PATH}）`);

  // 清理旧版本安装过的常驻服务。当前阶段由 dashboard 托管 proxy，不能再让 LaunchAgent/systemd
  // 在 dashboard 退出后把 proxy 留在后台。
  uninstallDaemon();

  log("安装完成。请在管理页显式启动 proxy；重启 Claude Code 后 settings.json 生效。");
  log(`卸载: bun run proxy:uninstall`);
  log(`状态: bun run proxy:status`);
  log(`白名单诊断: bun run proxy:whitelist`);
}

// import.meta.main 在 bun test 下为 false，保证测试 import buildEnvPatch 时不触发真实安装。
if (import.meta.main) {
  main().catch((err) => {
    console.error("[install] 致命错误:", err);
    process.exit(1);
  });
}
