// devtools proxy v2 — start CLI。
//
// 设计：
// - 内存状态机：STOPPED → STARTING → RUNNING → STOPPING → STOPPED
// - 进程生命周期 = 状态机生命周期；无任何持久化"意图"文件
// - prepareForStart 失败 → 立刻 reconcileToStopped 回 STOPPED
// - RUNNING 中 proxy 崩 → watchdog 退避重启（1s/2s/4s，3 次失败放弃）
// - 收到 SIGINT/SIGTERM → reconcileToStopped 后 exit

// TODO：现在的设计是在start/stop下。我理解可以，但是我更希望的是更k8s的controller的风格。
// reconcile是核心函数。然后controller负责维护状态机，然后按照用户的内存的要求，调用reconcile？
// 这样的话，逻辑能够更清晰？请分析有这个可能吗？
import { prepareForStart, reconcileToStopped } from "../reconcile";
import { spawnProxy, waitForHealth, pingHealth, isOurs, type ManagedChild } from "../runner";
import { FIXED_PORT } from "../port";

const HEALTH_TIMEOUT_MS = 5000;
const RESPAWN_BACKOFFS_MS = [1000, 2000, 4000];

const log = (msg: string) => console.log(msg);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  log(`[start] devtools proxy v2 — port ${FIXED_PORT}`);

  // 0. 先看看端口是否已被占用（旧版残留 / 我们自己上次没退干净 / 别的进程）
  const existing = await pingHealth(FIXED_PORT, 800);
  if (existing?.ok) {
    if (isOurs(existing)) {
      log(`[start] ✗ port ${FIXED_PORT} already serving devtools-proxy (PID ${existing.pid as number})`);
      log(`[start]   先运行 'bun run proxy-v2:stop' 清理，再重试`);
    } else {
      log(`[start] ✗ port ${FIXED_PORT} already serving HTTP but not our service (mode=${String(existing.mode)})`);
      log(`[start]   端口被外部进程占用，请手动检查：lsof -i:${FIXED_PORT}`);
    }
    process.exit(1);
  }

  // 1. 信号处理 —— intentional 标记让 watchdog 区分"用户停止 vs 异常崩溃"
  let intentional = false;
  let currentChild: ManagedChild | null = null;
  const onSignal = (sig: string) => {
    if (intentional) return;
    intentional = true;
    log(`\n[start] received ${sig}, draining...`);
    if (currentChild && !currentChild.killed) currentChild.kill("SIGTERM");
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // 2. 准备阶段：preflight + backup + inject + ensureCa
  const prep = await prepareForStart(log);
  if (!prep.ok) {
    log(`[start] ✗ prepare failed: ${prep.error}`);
    log(`[start] reconciling to STOPPED to clean up partial state...`);
    const r = await reconcileToStopped(log);
    for (const a of r.actions) log(`  ${a}`);
    for (const w of r.warnings) log(`  ⚠ ${w.step}: ${w.reason}`);
    process.exit(1);
  }
  if (prep.preflightWarnings.length > 0) {
    log(`[start] preflight warnings (non-blocking):`);
    for (const w of prep.preflightWarnings) log(`  - ${w}`);
  }

  // 3. 拉起 proxy + 健康探测 + 监视循环（watchdog 内嵌）
  let attempt = 0;
  let runningHealthy = false;

  while (!intentional) {
    if (attempt >= RESPAWN_BACKOFFS_MS.length) {
      log(`[watchdog] ✗ proxy crashed ${attempt} times, giving up`);
      break;
    }

    if (attempt > 0) {
      const wait = RESPAWN_BACKOFFS_MS[attempt - 1] ?? 4000;
      log(`[watchdog] retry in ${wait}ms (attempt ${attempt}/${RESPAWN_BACKOFFS_MS.length})`);
      await sleep(wait);
      if (intentional) break;
    }

    log(`[start] spawning proxy...`);
    let spawned;
    try {
      spawned = await spawnProxy(FIXED_PORT, log);
    } catch (err) {
      log(`[start] spawn error: ${(err as Error).message}`);
      attempt++;
      continue;
    }
    currentChild = spawned.child;

    const health = await waitForHealth(FIXED_PORT, HEALTH_TIMEOUT_MS);
    if (!health) {
      log(`[start] ✗ proxy spawned but /_health did not respond within ${HEALTH_TIMEOUT_MS}ms`);
      currentChild.kill("SIGTERM");
      currentChild = null;
      attempt++;
      continue;
    }

    runningHealthy = true;
    log(`[start] ✓ proxy ready — port ${FIXED_PORT}, PID ${currentChild.pid}`);
    if (attempt === 0) log(`[start] press Ctrl-C to stop and restore settings.json`);
    attempt = 0;  // 健康启动后重置计数

    // 阻塞直到 child 退出
    await new Promise<void>((resolve) => {
      currentChild!.once("exit", (code, signal) => {
        log(`[start] proxy exited (code=${code}, signal=${signal})`);
        resolve();
      });
    });
    currentChild = null;
    runningHealthy = false;

    if (intentional) break;

    log(`[watchdog] proxy crashed unexpectedly, will retry`);
    attempt++;
  }

  // 4. 清理：reconcileToStopped 永远不抛，但可能有 warnings
  log(`[stop] reconciling to STOPPED...`);
  const result = await reconcileToStopped(log);
  for (const a of result.actions) log(`  ${a}`);

  if (result.warnings.length > 0) {
    log(`[stop] ⚠ completed with warnings:`);
    for (const w of result.warnings) log(`  - ${w.step}: ${w.reason}`);
    process.exit(1);
  }
  if (!intentional && !runningHealthy) {
    // 没收到信号，说明是 watchdog 放弃后退出
    log(`[stop] ✗ proxy could not stay healthy — exiting after cleanup`);
    process.exit(2);
  }
  log(`[stop] ✓ all clean`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[start] fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
  // 兜底：fatal 路径也要尽力清理
  reconcileToStopped(log).finally(() => process.exit(1));
});
