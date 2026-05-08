// proxy 进程的拉起 + 健康探测。
// 关键决策：每次 spawn 都是一次性的子进程，没有 PID 文件、没有 adopted 概念。
// "活着"的判定只依赖 /_health 探测，不读任何持久化状态。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import type { Readable } from "node:stream";
import { readSettings } from "./settings";

const REPO_ROOT = join(import.meta.dir, "../../..");
const DIST_PATH = join(import.meta.dir, "../proxy/dist/start.mjs");

// 本地 ChildProcess 接口 —— Bun 的 @types/bun 屏蔽了 node:child_process 的 on/once，
// 我们用最小可用面 cast，与 server/src/proxy/managed.ts 同样的处理。
export interface ManagedChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  stdout?: Readable | null;
  stderr?: Readable | null;
  on(event: "close" | "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  once(event: "close" | "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnedProxy {
  child: ManagedChild;
}

async function ensureBuilt(log: (msg: string) => void): Promise<void> {
  if (existsSync(DIST_PATH)) return;
  log("[runner] proxy dist not found, building (bun run proxy:build)...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", ["run", "proxy:build"], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "inherit",
    }) as unknown as ManagedChild;
    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`proxy:build failed with exit code ${code}`));
    });
    child.on("error", reject);
  });
}

export async function spawnProxy(port: number, log: (msg: string) => void): Promise<SpawnedProxy> {
  await ensureBuilt(log);

  // settings.json 的 env 块需要传给 proxy 子进程，否则它读不到 ANTHROPIC_BASE_URL / 上游代理等
  const settingsEnv = readSettings().env;
  const childEnv = {
    ...process.env,
    ...settingsEnv,
    API_DASHBOARD_PROXY_MODE: "managed-v2",
  };

  const child = spawn("node", [DIST_PATH, "--port", String(port)], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ManagedChild;

  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[proxy] ${chunk}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[proxy] ${chunk}`));

  return { child };
}

/**
 * /_health 响应契约 —— VERSION-STABLE。
 *
 * reconcile / killByPort / start preempt-check 等所有路径靠 `service` 字段判定
 * "端口上的进程是不是我们家的"。这是误杀的硬防线。
 *
 * 修改原则：
 *   - 只允许新增可选字段
 *   - 不允许删除/改名/改语义已有字段
 *   - 真要 break 时，bump `version` 并支持读旧版
 *
 * 实现端：server/src/proxy/server/index.ts 的 `/_health` 端点。任何对该端点 JSON
 * 形状的修改必须同步更新这里的 interface 与下面的 `isOurs()`。
 */
export interface HealthV1 {
  service: "session-devtools-proxy";   // 唯一服务标识；isOurs 的硬条件
  version: 1;
  ok: boolean;
  pid: number;
  port: number;
  mode: "managed" | "managed-v2" | "standalone";
  upstream: "configured" | "none";
  uptime: number;
  requestCount: number;
}

// pingHealth 返回的是 server 给的任意 JSON（可能是老版本、可能 shape 不匹配）。
// 用宽松类型 Record<string, unknown>，让 isOurs 通过 service 字段做硬判定。
export type LooseHealth = Record<string, unknown>;

export function isOurs(health: LooseHealth | null | undefined): boolean {
  if (!health || typeof health !== "object") return false;
  return health.service === "session-devtools-proxy";
}

export function pingHealth(port: number, timeoutMs = 1500): Promise<LooseHealth | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/_health`, (res) => {
      let buf = "";
      res.on("data", (chunk) => (buf += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
    });
    const t = setTimeout(() => { req.destroy(); resolve(null); }, timeoutMs);
    req.on("error", () => { clearTimeout(t); resolve(null); });
    req.on("close", () => clearTimeout(t));
  });
}

// 拉起 proxy 后等它健康；带轮询，避免单次探测过早判失败
export async function waitForHealth(port: number, totalTimeoutMs: number): Promise<LooseHealth | null> {
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    const h = await pingHealth(port, 500);
    if (h?.ok) return h;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// 探测端口上是否有 listener（不解析 /_health，纯 lsof）
async function findListeningPid(port: number): Promise<number | null> {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  return new Promise((resolve) => {
    const child = spawn("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { stdio: ["ignore", "pipe", "ignore"] }) as unknown as ManagedChild;
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("close", () => {
      const pid = Number(out.trim().split("\n")[0]);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
    child.on("error", () => resolve(null));
  });
}

export async function waitPortReleased(port: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await findListeningPid(port))) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return !(await findListeningPid(port));
}

export interface KillByPortResult {
  killed: boolean;
  pid?: number;
  method?: "SIGTERM" | "SIGKILL";
  // 没杀的具体原因，调用方据此决定 warning 文案
  reason?: "no-listener" | "external-process" | "kill-timeout";
}

// 杀我们家的 proxy。识别"我们家"的硬条件是 /_health 返回 service: "session-devtools-proxy"。
// 端口上是别的进程时不动手，只返回 reason: "external-process" 让调用方报 warning。
export async function killByPort(port: number, log: (msg: string) => void): Promise<KillByPortResult> {
  const pid = await findListeningPid(port);
  if (!pid) return { killed: false, reason: "no-listener" };

  // 端口有 listener，先 ping /_health 校验 service 字段
  const health = await pingHealth(port, 800);
  if (!isOurs(health)) {
    log(`[runner] ✗ port ${port} held by PID ${pid}, /_health does not advertise service="session-devtools-proxy" — refusing to kill`);
    return { killed: false, pid, reason: "external-process" };
  }

  log(`[runner] sending SIGTERM to devtools proxy PID ${pid} on port ${port}`);
  try { process.kill(pid, "SIGTERM"); } catch { /* may have already died */ }
  if (await waitPortReleased(port, 1500)) return { killed: true, pid, method: "SIGTERM" };

  log(`[runner] SIGTERM did not release port, escalating to SIGKILL`);
  try { process.kill(pid, "SIGKILL"); } catch { /* same */ }
  if (await waitPortReleased(port, 1500)) return { killed: true, pid, method: "SIGKILL" };

  return { killed: false, pid, reason: "kill-timeout" };
}
