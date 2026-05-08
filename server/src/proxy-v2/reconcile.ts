// 状态收敛函数：把世界拉回到 STOPPED，或为 START 做准备。
//
// 关键不变量：
// - reconcileToStopped 永远不抛。失败的子步骤进 warnings，整体仍然完成。
// - kill 与 restore 完全解耦：哪怕端口上是非我们的进程没敢杀，settings 也照样要还原
//   （否则 Claude Code 仍指向那个外部进程，污染未消除）
// - prepareForStart 失败时调用方应当立刻 reconcileToStopped 自动 rollback
import { runPreflight } from "./preflight";
import { isActive, markActive, restoreSettings, injectSettings } from "./settings";
import { killByPort } from "./runner";
import { FIXED_PORT } from "./port";
import { V2_PATHS } from "./paths";

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

  // 1. 杀我们家的 proxy（外部进程不杀，只 warn）
  try {
    const r = await killByPort(FIXED_PORT, log);
    if (r.killed) {
      actions.push(`killed devtools proxy PID ${r.pid} via ${r.method} on port ${FIXED_PORT}`);
    } else if (r.reason === "external-process") {
      warnings.push({
        step: "kill-proxy",
        reason: `port ${FIXED_PORT} held by non-devtools PID ${r.pid}; not killed. Resolve manually: lsof -i:${FIXED_PORT}`,
      });
    } else if (r.reason === "kill-timeout") {
      warnings.push({
        step: "kill-proxy",
        reason: `our proxy PID ${r.pid} did not release port ${FIXED_PORT} after SIGTERM+SIGKILL`,
      });
    }
    // r.reason === "no-listener" 是 happy default，不报 warning
  } catch (err) {
    warnings.push({ step: "kill-proxy", reason: (err as Error).message });
  }

  // 2. 还原 settings.json — 与 kill 结果完全独立
  // 唯一判定依据：active.json 是否存在（不依赖 settings 内容判断"是否注入"，
  // 避免误判用户手写的 NODE_EXTRA_CA_CERTS 等）
  try {
    if (isActive()) {
      const r = restoreSettings();
      if (r.kind === "restored-from-active") {
        actions.push(`restored settings.json from active marker (originalExisted=${r.originalExisted})`);
      }
    }
  } catch (err) {
    warnings.push({ step: "restore-settings", reason: (err as Error).message });
  }

  // 3. (REMOVED) 不删数据目录。
  // ca.pem / traffic.jsonl / mitm-hosts.json / target-ca/ 是产品数据 + 用户配置，
  // stop 不动它们。完全擦除应当走独立的 wipe 动词（待加）。

  return { warnings, actions };
}

export interface PrepareForStartResult {
  ok: boolean;
  error?: string;
  preflightWarnings: string[];
  activePath?: string;
  historyPath?: string | null;
  caFingerprint?: string;
}

// Start 流程的准备阶段：refuse-if-active → preflight → checkpoint → inject → ensureCa
// 调用方在此之后负责 spawn proxy。任一步失败 → ok=false，调用方应立刻
// reconcileToStopped 来 rollback 已经写下的部分（active.json 标记 + settings 注入）。
export async function prepareForStart(log: (msg: string) => void = noop): Promise<PrepareForStartResult> {
  const preflightWarnings: string[] = [];

  // 0. 拒绝在已注入状态下重复 start
  // active.json 存在 = 上次会话没干净退出（或正在跑），强制要求先跑 stop
  if (isActive()) {
    return {
      ok: false,
      error: `previous session is still active (marker at ${V2_PATHS.active}). Run 'bun run proxy-v2:stop' first.`,
      preflightWarnings,
    };
  }

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

  // 2. checkpoint：写 active.json 标记 + history 归档
  // 必须在 inject 之前 —— 这是"我们注入过"的唯一证据
  let activePath: string | undefined;
  let historyPath: string | null | undefined;
  try {
    log("[prepare] checkpointing settings.json → active.json...");
    const r = markActive(FIXED_PORT);
    activePath = r.activePath;
    historyPath = r.historyPath;
    log(`  active marker → ${activePath}`);
    log(`  history archive → ${historyPath ?? "(none — settings.json did not exist)"}`);
  } catch (err) {
    return { ok: false, error: `checkpoint failed: ${(err as Error).message}`, preflightWarnings };
  }

  // 3. 注入 5 个 env key
  try {
    log("[prepare] injecting settings.json env keys...");
    injectSettings(FIXED_PORT);
  } catch (err) {
    return { ok: false, error: `inject failed: ${(err as Error).message}`, preflightWarnings, activePath, historyPath };
  }

  // 4. 确保 CA 存在（10 年期，复用现存 ca.pem/ca.key）
  let caFingerprint: string | undefined;
  try {
    log("[prepare] ensuring local CA certificate...");
    const ca = await import("./ca");
    const result = await ca.ensureCa();
    caFingerprint = ca.caFingerprint(result.certPem);
    log(`  CA SHA-256: ${caFingerprint}`);
  } catch (err) {
    return { ok: false, error: `ensureCa failed: ${(err as Error).message}`, preflightWarnings, activePath, historyPath };
  }

  return { ok: true, preflightWarnings, activePath, historyPath, caFingerprint };
}
