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

export interface HealthResponse {
  ok: boolean;
  pid?: number;
  port?: number;
  mode?: string;
  uptime?: number;
}

export function pingHealth(port: number, timeoutMs = 1500): Promise<HealthResponse | null> {
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
export async function waitForHealth(port: number, totalTimeoutMs: number): Promise<HealthResponse | null> {
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

export async function killByPort(port: number, log: (msg: string) => void): Promise<{ killed: boolean; pid?: number; method?: "SIGTERM" | "SIGKILL" }> {
  const pid = await findListeningPid(port);
  if (!pid) return { killed: false };

  log(`[runner] sending SIGTERM to proxy PID ${pid} on port ${port}`);
  try { process.kill(pid, "SIGTERM"); } catch { /* may have already died */ }
  if (await waitPortReleased(port, 1500)) return { killed: true, pid, method: "SIGTERM" };

  log(`[runner] SIGTERM did not release port, escalating to SIGKILL`);
  try { process.kill(pid, "SIGKILL"); } catch { /* same */ }
  if (await waitPortReleased(port, 1500)) return { killed: true, pid, method: "SIGKILL" };

  return { killed: false, pid };
}
