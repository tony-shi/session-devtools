// proxy 进程的拉起 + 健康探测。
// 关键决策：每次 spawn 都是一次性的子进程，没有 PID 文件、没有 adopted 概念。
// "活着"的判定只依赖 /_health 探测，不读任何持久化状态。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import type { Readable } from "node:stream";
import { readSettings } from "./settings";

// When bundled (dist/server.js), import.meta.dirname = <package-root>/dist/
// When running via tsx (dev), import.meta.dirname = server/src/proxy-v2/
//
// In bundled mode: proxy-server.js lives alongside server.js in dist/
// In dev mode: proxy TS source is at server/src/proxy-v2/server/start.ts
const PROXY_BUNDLE = join(import.meta.dirname, "proxy-server.js");
// Dev mode paths
//   - server root = server/                  (two levels up from server/src/proxy-v2/)
//   - repo root   = <repo>/                  (three levels up, where workspaces hoist .bin)
// 自 server 加入 npm workspaces 后，tsx 默认被 hoist 到 <repo>/node_modules/.bin/tsx；
// 旧的 nested install (server/node_modules/.bin/tsx) 作为 fallback 兼容残留环境。
const SERVER_ROOT = join(import.meta.dirname, "../..");
const REPO_ROOT = join(import.meta.dirname, "../../..");
const TSX_CANDIDATES = [
  join(REPO_ROOT, "node_modules/.bin/tsx"),
  join(SERVER_ROOT, "node_modules/.bin/tsx"),
];
function resolveTsxBin(): string | null {
  for (const p of TSX_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}
const TSCONFIG = join(SERVER_ROOT, "tsconfig.node.json");
const SERVER_ENTRY = join(import.meta.dirname, "server/start.ts");
const AMBIENT_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

// 本地 ChildProcess 接口 —— 使用最小可用面 cast，避免直接依赖 node:child_process 完整类型。
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

export async function spawnProxy(port: number, log: (msg: string) => void): Promise<SpawnedProxy> {
  // settings.json 的 env 块需要传给 proxy 子进程，否则它读不到 ANTHROPIC_BASE_URL 等业务配置。
  // 但标准代理变量不能传给 proxy 自己：它们是给 Claude 客户端消费的，不是给本地 proxy server 消费的。
  const settingsEnv = readSettings().env;
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...settingsEnv,
    API_DASHBOARD_PROXY_MODE: "managed-v2",
  };
  for (const key of AMBIENT_PROXY_ENV_KEYS) {
    delete childEnv[key];
  }

  let spawnArgs: [string, string[]];
  const tsxBin = resolveTsxBin();
  if (existsSync(PROXY_BUNDLE)) {
    // Published package: run pre-compiled JS bundle
    log("[runner] spawning proxy server via node (compiled bundle)...");
    spawnArgs = [process.execPath, [PROXY_BUNDLE, "--port", String(port)]];
  } else if (tsxBin && existsSync(TSCONFIG)) {
    // Dev mode: run TypeScript source via tsx
    log("[runner] spawning proxy server via tsx (dev mode)...");
    spawnArgs = [tsxBin, ["--tsconfig", TSCONFIG, SERVER_ENTRY, "--port", String(port)]];
  } else {
    throw new Error(
      `Proxy bundle not found at ${PROXY_BUNDLE} ` +
      `and tsx not found in any of: ${TSX_CANDIDATES.join(", ")}.\n` +
      `Run "npm run build" to compile the proxy bundle, ` +
      `or "npm install" from the repo root for dev mode.`,
    );
  }

  const child = spawn(spawnArgs[0], spawnArgs[1], {
    cwd: SERVER_ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ManagedChild;

  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[proxy] ${chunk}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[proxy] ${chunk}`));
  child.on("error", (err) => log(`[runner] proxy spawn error: ${err.message}`));

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
 * 实现端：server/src/proxy-v2/server/index.ts 的 `/_health` 端点。任何对该端点 JSON
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
