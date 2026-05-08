// 状态收敛函数：把世界拉回到 STOPPED，或为 START 做准备。
//
// 关键不变量：
// - reconcileToStopped 永远不抛。失败的子步骤进 warnings，整体仍然完成。
// - prepareForStart 失败时调用方应当立刻 reconcileToStopped 自动 rollback。
import { existsSync, rmSync } from "node:fs";
import { PATHS } from "../proxy/config";
import { runPreflight } from "../proxy/preflight";
import { hasInjectionMarker, readSettings, restoreSettings, backupSettings, injectSettings } from "./settings";
import { killByPort } from "./runner";
import { FIXED_PORT } from "./port";

export interface ReconcileWarning {
  step: string;
  reason: string;
}

export interface ReconcileToStoppedResult {
  warnings: ReconcileWarning[];
  actions: string[];   // 实际执行了哪些清理动作（用于日志）
}

const noop = (_msg: string) => {};

// 把世界拉回 STOPPED。每一步独立 try/catch，整体永不抛。
export async function reconcileToStopped(log: (msg: string) => void = noop): Promise<ReconcileToStoppedResult> {
  const warnings: ReconcileWarning[] = [];
  const actions: string[] = [];

  // 1. 杀任何在 FIXED_PORT 上的进程
  try {
    const r = await killByPort(FIXED_PORT, log);
    if (r.killed) {
      actions.push(`killed proxy PID ${r.pid} via ${r.method} on port ${FIXED_PORT}`);
    } else if (r.pid) {
      warnings.push({ step: "kill-proxy", reason: `port ${FIXED_PORT} still held by PID ${r.pid} after SIGTERM+SIGKILL` });
    }
  } catch (err) {
    warnings.push({ step: "kill-proxy", reason: (err as Error).message });
  }

  // 2. 还原 settings.json
  try {
    const { env } = readSettings();
    if (hasInjectionMarker(env)) {
      const r = restoreSettings();
      actions.push(`restored settings via ${r.method}`);
    }
  } catch (err) {
    warnings.push({ step: "restore-settings", reason: (err as Error).message });
  }

  // 3. 删除 proxy 数据目录（保留 backups/，因为它在 ~/.api-dashboard/backups/）
  try {
    if (existsSync(PATHS.home)) {
      rmSync(PATHS.home, { recursive: true, force: true });
      actions.push(`removed ${PATHS.home}`);
    }
  } catch (err) {
    warnings.push({ step: "remove-data-dir", reason: (err as Error).message });
  }

  return { warnings, actions };
}

export interface PrepareForStartResult {
  ok: boolean;
  error?: string;
  preflightWarnings: string[];
  backupPath?: string;
  caFingerprint?: string;
}

// Start 流程的准备阶段：preflight → backup → inject → ensureCa
// 调用方在此之后负责 spawn proxy。任一步失败 → ok=false，调用方应立刻
// reconcileToStopped 来 rollback 已经写下的部分（settings 注入或 CA）。
export async function prepareForStart(log: (msg: string) => void = noop): Promise<PrepareForStartResult> {
  const preflightWarnings: string[] = [];

  // 1. preflight（只读，不写盘）
  log("[prepare] running preflight checks...");
  const pf = await runPreflight({ ourPort: FIXED_PORT });
  for (const r of pf.results) {
    const icon = r.severity === "OK" ? "✓" : r.severity === "WARN" ? "⚠" : "✗";
    log(`  ${icon} [${r.id}] ${r.name}: ${r.message}`);
    if (r.hint) log(`      → ${r.hint}`);
  }
  if (pf.blocked) {
    const blocked = pf.results.filter((r) => r.severity === "BLOCK").map((r) => `${r.id}:${r.message}`).join("; ");
    return { ok: false, error: `preflight blocked: ${blocked}`, preflightWarnings };
  }
  for (const r of pf.results) {
    if (r.severity === "WARN") preflightWarnings.push(`[${r.id}] ${r.message}`);
  }

  // 2. 备份 settings.json
  let backupPath: string | undefined;
  try {
    log("[prepare] backing up ~/.claude/settings.json...");
    const b = backupSettings();
    if (b) {
      backupPath = b;
      log(`  → ${backupPath}`);
    } else {
      log(`  (settings.json does not exist, skipping backup)`);
    }
  } catch (err) {
    return { ok: false, error: `backup failed: ${(err as Error).message}`, preflightWarnings };
  }

  // 3. 注入 5 个 env key
  try {
    log("[prepare] injecting settings.json env keys...");
    injectSettings(FIXED_PORT);
  } catch (err) {
    return { ok: false, error: `inject failed: ${(err as Error).message}`, preflightWarnings, backupPath };
  }

  // 4. 确保 CA 存在
  let caFingerprint: string | undefined;
  try {
    log("[prepare] ensuring local CA certificate...");
    const ca = await import("../proxy/ca");
    const result = await ca.ensureCa();
    caFingerprint = ca.caFingerprint(result.certPem);
    log(`  CA SHA-256: ${caFingerprint}`);
  } catch (err) {
    return { ok: false, error: `ensureCa failed: ${(err as Error).message}`, preflightWarnings, backupPath };
  }

  return { ok: true, preflightWarnings, backupPath, caFingerprint };
}
