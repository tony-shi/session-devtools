// Proxy v2 Controller —— 仿 K8s controller 的状态机 + 自愈循环。
//
// 模型（"target/actual"）：
//   target: 用户意图，"STOPPED" | "RUNNING"
//   actual: 由 child 句柄 + /_health + active.json 共同决定
//   reconcile(): 把 actual 拉向 target，幂等
//
// 关键不变量：
// - 同一时刻只有一个 reconcile 在跑（FIFO 队列串行化）
// - 任何 setTarget 调用最终都会让 controller 进入"target 与 actual 一致"的稳定态
// - watchdog 的 backoff 计数仅在用户 setTarget 时清零；reconcile 自身不动它
// - 所有错误进 lastError 字段供 UI 展示，不抛
import type { ManagedChild } from "./runner";
import { spawnProxy, waitForHealth, pingHealth, isOurs } from "./runner";
import { prepareForStart, reconcileToStopped, type ReconcileWarning } from "./reconcile";
import { isActive } from "./settings";
import { FIXED_PORT } from "./port";

export type Target = "STOPPED" | "RUNNING";
export type Phase = "idle" | "starting" | "running" | "stopping";

export interface ControllerSnapshot {
  target: Target;
  phase: Phase;
  port: number;
  pid: number | null;
  active: boolean;             // active.json 是否存在（settings 是否被注入）
  lastError: string | null;
  lastWarnings: ReconcileWarning[];
  preflightWarnings: string[];
  respawnAttempt: number;      // 当前连续崩溃次数
  log: string[];               // 最近 50 行日志（环形缓冲）
}

const HEALTH_TIMEOUT_MS = 5000;
const RESPAWN_BACKOFFS_MS = [1000, 2000, 4000];
const MAX_RESPAWN_ATTEMPTS = RESPAWN_BACKOFFS_MS.length;
const LOG_BUFFER_SIZE = 50;

class ProxyController {
  private target: Target = "STOPPED";
  private phase: Phase = "idle";
  private child: ManagedChild | null = null;
  private lastError: string | null = null;
  private lastWarnings: ReconcileWarning[] = [];
  private preflightWarnings: string[] = [];
  private respawnAttempt = 0;
  private respawnTimer: NodeJS.Timeout | null = null;
  // 串行化：所有 reconcile 通过这个 Promise 链排队
  private inFlight: Promise<void> = Promise.resolve();
  private logBuffer: string[] = [];

  // ── 公共 API ────────────────────────────────────────────────────────────────

  getSnapshot(): ControllerSnapshot {
    return {
      target: this.target,
      phase: this.phase,
      port: FIXED_PORT,
      pid: this.child?.pid ?? null,
      active: isActive(),
      lastError: this.lastError,
      lastWarnings: this.lastWarnings,
      preflightWarnings: this.preflightWarnings,
      respawnAttempt: this.respawnAttempt,
      log: [...this.logBuffer],
    };
  }

  // 用户意图入口。串行化：连续点击不会并发
  async setTarget(t: Target): Promise<ControllerSnapshot> {
    this.target = t;
    // 用户主动操作 = 重置崩溃计数，否则上次失败会立即让新的 RUNNING 也放弃
    this.respawnAttempt = 0;
    this.cancelRespawnTimer();

    this.inFlight = this.inFlight.catch(() => {}).then(() => this.reconcile());
    await this.inFlight;
    return this.getSnapshot();
  }

  // dashboard 退出时调用（同步路径不要 await，async 路径可以 await）
  async shutdown(): Promise<void> {
    this.target = "STOPPED";
    this.cancelRespawnTimer();
    // 不走 inFlight 队列 —— shutdown 是终态，必须立刻执行
    await this.driveToStopped();
  }

  // dashboard 启动时调用一次。覆盖 SIGKILL / 断电等场景：上次 dashboard 没干净退出，
  // active.json 还在 + settings.json 仍指向死端口。boot 时主动把世界拉回 STOPPED，
  // 这样用户即使不打开 UI，Claude Code 也不会撞 ECONN。
  //
  // 快速路径：active.json 不存在（绝大多数情况）→ 立即返回，几乎零开销。
  // 慢路径：active.json 存在 → 完整 reconcileToStopped（杀残留进程 + 还原 settings）。
  async reconcileOnBoot(): Promise<void> {
    if (!isActive()) return;   // 干净启动，快速路径
    console.log("[proxy-v2] boot detected leftover active.json from previous session, cleaning up...");
    this.appendLog("[controller] boot reconcile starting");
    const r = await reconcileToStopped((m) => {
      this.appendLog(m);
      console.log(`[proxy-v2] ${m}`);
    });
    this.lastWarnings = r.warnings;
    if (r.warnings.length > 0) {
      console.warn(`[proxy-v2] boot reconcile completed with ${r.warnings.length} warning(s):`);
      for (const w of r.warnings) console.warn(`  - ${w.step}: ${w.reason}`);
    } else {
      console.log(`[proxy-v2] boot reconcile done (${r.actions.length} action(s))`);
    }
  }

  // ── reconcile 核心 ──────────────────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    if (this.target === "RUNNING") {
      await this.driveToRunning();
    } else {
      await this.driveToStopped();
    }
  }

  private async driveToRunning(): Promise<void> {
    // 0. preempt：端口被外部进程占用 → 不动 settings，立即报错
    const existing = await pingHealth(FIXED_PORT, 500);
    if (existing?.ok && !isOurs(existing)) {
      this.fail(`port ${FIXED_PORT} held by non-devtools process. Free it first: lsof -i:${FIXED_PORT}`);
      return;
    }

    // 1. 幂等：已是 RUNNING（child 在跑且健康）→ no-op
    if (existing?.ok && isOurs(existing) && this.child && !this.child.killed) {
      this.phase = "running";
      this.lastError = null;
      return;
    }

    this.phase = "starting";
    this.lastError = null;

    // 1.5 自愈：检测到上次会话残留（active.json 存在但当前 controller 没有 child 句柄）
    // 典型场景：dashboard SIGKILL → 重启。先清理残留，再走正常 start 流程。
    if (isActive() && !this.child) {
      this.appendLog("[controller] detected leftover active.json from previous session — auto-cleaning");
      const cleanup = await reconcileToStopped((m) => this.appendLog(m));
      if (cleanup.warnings.length > 0) {
        this.lastWarnings = cleanup.warnings;
        this.appendLog(`[controller] auto-cleanup completed with ${cleanup.warnings.length} warning(s)`);
      }
    }

    // 2. preflight + checkpoint + inject + ensureCa
    const prep = await prepareForStart((m) => this.appendLog(m));
    if (!prep.ok) {
      this.lastError = prep.error ?? "prepare failed";
      // rollback：清掉 active.json + 还原 settings + 杀残余进程
      const r = await reconcileToStopped((m) => this.appendLog(m));
      this.lastWarnings = r.warnings;
      this.target = "STOPPED";
      this.phase = "idle";
      this.child = null;
      return;
    }
    this.preflightWarnings = prep.preflightWarnings;

    // 3. spawn + 等健康
    const r = await this.tryStartProxy();
    if (!r.ok) {
      this.lastError = r.reason ?? "proxy failed to become healthy";
      const cleanup = await reconcileToStopped((m) => this.appendLog(m));
      this.lastWarnings = cleanup.warnings;
      this.target = "STOPPED";
      this.phase = "idle";
      this.child = null;
      return;
    }
    this.phase = "running";
    this.respawnAttempt = 0;
    this.appendLog(`[controller] proxy ready — port ${FIXED_PORT}, PID ${this.child?.pid}`);
  }

  private async driveToStopped(): Promise<void> {
    if (this.phase === "idle" && !this.child && !isActive()) {
      // 已经在 STOPPED，幂等
      this.phase = "idle";
      return;
    }
    this.phase = "stopping";
    const r = await reconcileToStopped((m) => this.appendLog(m));
    this.lastWarnings = r.warnings;
    this.lastError = null;
    this.child = null;
    this.phase = "idle";
  }

  // 一次性 spawn + 健康检查。child 仅在健康通过后才挂 watchdog。
  private async tryStartProxy(): Promise<{ ok: boolean; reason?: string }> {
    let spawned;
    try {
      spawned = await spawnProxy(FIXED_PORT, (m) => this.appendLog(m));
    } catch (err) {
      return { ok: false, reason: `spawn: ${(err as Error).message}` };
    }
    this.child = spawned.child;
    spawned.child.stdout?.on("data", (chunk: Buffer) => this.appendLog(`[proxy] ${chunk.toString().trimEnd()}`));
    spawned.child.stderr?.on("data", (chunk: Buffer) => this.appendLog(`[proxy] ${chunk.toString().trimEnd()}`));

    const h = await waitForHealth(FIXED_PORT, HEALTH_TIMEOUT_MS);
    if (!h?.ok) {
      spawned.child.kill("SIGTERM");
      if (this.child === spawned.child) this.child = null;
      return { ok: false, reason: `health check timed out after ${HEALTH_TIMEOUT_MS}ms` };
    }
    this.attachWatchdog(spawned.child);
    return { ok: true };
  }

  // ── watchdog ────────────────────────────────────────────────────────────────

  private attachWatchdog(child: ManagedChild): void {
    child.once("exit", (code, signal) => {
      // 我们已经替换 / 清掉了 → 不是孤立崩溃，是主动操作
      if (this.child !== child) return;
      this.child = null;
      // 用户已经把 target 改回 STOPPED → 不重启
      if (this.target !== "RUNNING") return;

      this.respawnAttempt++;
      this.appendLog(`[watchdog] proxy crashed (code=${code}, signal=${signal}), attempt ${this.respawnAttempt}/${MAX_RESPAWN_ATTEMPTS}`);
      this.scheduleRespawn();
    });
  }

  private scheduleRespawn(): void {
    if (this.respawnAttempt > MAX_RESPAWN_ATTEMPTS) {
      this.giveUpRespawn();
      return;
    }
    const wait = RESPAWN_BACKOFFS_MS[this.respawnAttempt - 1] ?? 4000;
    this.phase = "starting";
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.target !== "RUNNING") return;
      void this.respawnNow();
    }, wait);
  }

  private async respawnNow(): Promise<void> {
    const r = await this.tryStartProxy();
    if (r.ok) {
      this.phase = "running";
      // 不重置 respawnAttempt —— 防止"刚启动又秒崩"循环；真正成功要靠"用户再点 Start"
      // 但若我们想"健康一段时间后认为稳定"，可以加 timeout 重置；当前先不做
      return;
    }
    // spawn 失败（child 没建起来 or 健康超时），手动推进 backoff
    this.respawnAttempt++;
    this.appendLog(`[watchdog] respawn failed: ${r.reason}, attempt ${this.respawnAttempt}/${MAX_RESPAWN_ATTEMPTS}`);
    this.scheduleRespawn();
  }

  private giveUpRespawn(): void {
    this.lastError = `proxy 反复崩溃 ${MAX_RESPAWN_ATTEMPTS} 次，已停止自动重启。请检查日志或重新点击启动。`;
    this.appendLog(`[watchdog] ✗ giving up after ${MAX_RESPAWN_ATTEMPTS} attempts`);
    this.target = "STOPPED";
    this.phase = "stopping";
    void reconcileToStopped((m) => this.appendLog(m)).then((r) => {
      this.lastWarnings = r.warnings;
      this.phase = "idle";
    });
  }

  private cancelRespawnTimer(): void {
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────────────

  private fail(reason: string): void {
    this.lastError = reason;
    this.target = "STOPPED";
    this.phase = "idle";
  }

  private appendLog(line: string): void {
    if (!line) return;
    const stamped = `[${new Date().toISOString()}] ${line}`;
    this.logBuffer.push(stamped);
    if (this.logBuffer.length > LOG_BUFFER_SIZE) {
      this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_SIZE);
    }
  }
}

// 单例 —— dashboard server 进程内全局唯一
export const proxyV2Controller = new ProxyController();
