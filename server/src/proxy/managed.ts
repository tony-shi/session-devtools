// Dashboard 托管模式的 proxy 进程管理。
//
// 当前阶段不把 proxy 安装成系统级 daemon，也不默认随 dashboard server 启动：
// - 用户在管理页显式启动：拉起 proxy 子进程
// - dashboard 退出：只停止本进程拉起的 proxy，避免后台残留
// - setup UI 的启动/停止：操作的也是这个托管子进程，而不是 LaunchAgent/systemd
//
// 注意：pid/port 文件只是给 CLI 和 UI 的缓存。运行态的事实来源仍然是 /_health 探测；
// 因为旧版本曾经出现过进程存在但 pid/port 文件丢失的情况。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import http from "node:http";
import { DEFAULT_LISTEN_PORT, PATHS } from "./config";

type ManagedStatus = "OK" | "DEGRADED" | "DOWN";

export interface ManagedProxyStatus {
  injected: boolean;
  desiredRunning: boolean;
  daemonStatus: ManagedStatus;
  statusHint?: string;
  pid: number | null;
  port: number | null;
  health: Record<string, unknown> | null;
  managed: boolean;
}

interface ManagedChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout?: Readable | null;
  stderr?: Readable | null;
  on(event: "close" | "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

let proxyChild: ManagedChild | null = null;
let adoptedProxyPid: number | null = null;

interface StopOptions {
  rememberDesired?: boolean;
}

function getRepoRoot(): string {
  return join(import.meta.dir, "../../..");
}

function getDistPath(): string {
  return join(import.meta.dir, "dist/start.mjs");
}

function isChildAlive(child: ManagedChild | null): boolean {
  return !!child && child.exitCode === null && child.signalCode === null;
}

export function readClaudeSettingsEnv(): Record<string, string> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) return {};
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    return settings?.env && typeof settings.env === "object" ? settings.env : {};
  } catch {
    return {};
  }
}

function parseProxyPort(raw: string | undefined): number | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
    const port = Number(url.port || 80);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export function getConfiguredProxyPort(): number {
  const env = readClaudeSettingsEnv();
  if (!hasDashboardProxyMarker(env)) return DEFAULT_LISTEN_PORT;
  return parseProxyPort(env.HTTPS_PROXY ?? env.https_proxy) ?? DEFAULT_LISTEN_PORT;
}

function hasDashboardProxyMarker(env: Record<string, string>): boolean {
  return env.NODE_EXTRA_CA_CERTS === PATHS.caCert || env.API_DASHBOARD_PROXY_UPSTREAM !== undefined;
}

export function isProxyConfigured(): boolean {
  const env = readClaudeSettingsEnv();
  return hasDashboardProxyMarker(env);
}

export function readProxyDesiredRunning(): boolean {
  if (!existsSync(PATHS.desiredStateFile)) return false;
  try {
    const state = JSON.parse(readFileSync(PATHS.desiredStateFile, "utf8"));
    return state?.desiredRunning === true;
  } catch {
    return false;
  }
}

function writeProxyDesiredRunning(desiredRunning: boolean): void {
  try {
    mkdirSync(PATHS.home, { recursive: true, mode: 0o700 });
    writeFileSync(
      PATHS.desiredStateFile,
      JSON.stringify({ desiredRunning, updatedAt: new Date().toISOString() }, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch {}
}

async function ensureBuilt(): Promise<void> {
  if (existsSync(getDistPath())) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", ["run", "proxy:build"], {
      cwd: getRepoRoot(),
      env: process.env,
      stdio: "inherit",
    }) as unknown as ManagedChild;
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`proxy:build failed with code ${code}`));
    });
    child.on("error", reject);
  });
}

function pingHealth(port: number, timeoutMs = 1500): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/_health`, (res) => {
      let buf = "";
      res.on("data", (chunk) => (buf += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(buf));
        } catch {
          resolve(null);
        }
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve(null);
    }, timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function findListeningPid(port: number): Promise<number | null> {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  return new Promise((resolve) => {
    const child = spawn("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { stdio: ["ignore", "pipe", "ignore"] }) as unknown as ManagedChild;
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk.toString()));
    child.on("close", () => {
      const pid = Number(out.trim().split("\n")[0]);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
    child.on("error", () => resolve(null));
  });
}

async function readProcessCommand(pid: number): Promise<string> {
  if (process.platform !== "darwin" && process.platform !== "linux") return "";
  return new Promise((resolve) => {
    const child = spawn("ps", ["-p", String(pid), "-o", "command="], { stdio: ["ignore", "pipe", "ignore"] }) as unknown as ManagedChild;
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk.toString()));
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

function isDashboardProxyCommand(command: string): boolean {
  return command.includes("server/src/proxy/dist/start.mjs");
}

async function waitForPortRelease(port: number, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await findListeningPid(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !(await findListeningPid(port));
}

export async function startManagedProxy(port = getConfiguredProxyPort()): Promise<{ ok: boolean; pid?: number; reason?: string }> {
  if (isChildAlive(proxyChild)) {
    writeProxyDesiredRunning(true);
    return { ok: true, pid: proxyChild!.pid };
  }

  const existingHealth = await pingHealth(port);
  if (existingHealth?.ok) {
    adoptedProxyPid = typeof existingHealth.pid === "number" ? existingHealth.pid : await findListeningPid(port);
    writeProxyDesiredRunning(true);
    return { ok: true, pid: adoptedProxyPid ?? undefined };
  }

  await ensureBuilt();
  const settingsEnv = readClaudeSettingsEnv();
  const childEnv = {
    ...process.env,
    ...settingsEnv,
    API_DASHBOARD_PROXY_MODE: "managed",
  };

  const child = spawn("node", [getDistPath(), "--port", String(port)], {
    cwd: getRepoRoot(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ManagedChild;
  proxyChild = child;
  child.stdout?.on("data", (chunk) => process.stdout.write(`[proxy] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[proxy] ${chunk}`));
  child.on("exit", () => {
    if (proxyChild === child) proxyChild = null;
  });

  await new Promise((resolve) => setTimeout(resolve, 500));
  const health = await pingHealth(port);
  if (health?.ok) {
    writeProxyDesiredRunning(true);
    return { ok: true, pid: child.pid };
  }

  return { ok: false, pid: child.pid, reason: "proxy 子进程已启动，但 /_health 暂无响应" };
}

export async function stopManagedProxy(
  port = getConfiguredProxyPort(),
  options: StopOptions = {},
): Promise<{ ok: boolean; pid?: number; reason?: string }> {
  const rememberDesired = options.rememberDesired ?? true;
  if (isChildAlive(proxyChild)) {
    // 本进程 spawn 的子进程，直接 SIGTERM
    const pid = proxyChild!.pid;
    proxyChild!.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (rememberDesired) writeProxyDesiredRunning(false);
    return { ok: true, pid };
  }

  // adopt 的外部进程（可能是另一个 dashboard worktree 实例持有的 proxy）。
  // 不发 SIGTERM——只有 owner 才能杀自己的子进程；这里只做 detach。
  if (adoptedProxyPid) {
    adoptedProxyPid = null;
    return { ok: false, reason: "当前实例未持有该 proxy 进程，无法停止（由其它 dashboard 实例管理）" };
  }

  const externalPid = await findListeningPid(port);
  if (!externalPid) {
    if (rememberDesired) writeProxyDesiredRunning(false);
    return { ok: false, reason: "未找到正在监听的 proxy 进程" };
  }

  const command = await readProcessCommand(externalPid);
  if (!isDashboardProxyCommand(command)) {
    return {
      ok: false,
      pid: externalPid,
      reason: `端口 ${port} 被非 dashboard proxy 进程占用，未自动停止: ${command || "unknown command"}`,
    };
  }

  try {
    process.kill(externalPid, "SIGTERM");
  } catch (err: any) {
    if (err.code === "ESRCH") return { ok: true, pid: externalPid };
    return { ok: false, pid: externalPid, reason: `停止遗留 proxy 失败: ${err.message}` };
  }

  if (await waitForPortRelease(port)) {
    if (rememberDesired) writeProxyDesiredRunning(false);
    return { ok: true, pid: externalPid };
  }

  try {
    process.kill(externalPid, "SIGKILL");
  } catch (err: any) {
    if (err.code !== "ESRCH") {
      return { ok: false, pid: externalPid, reason: `强制停止遗留 proxy 失败: ${err.message}` };
    }
  }

  if (await waitForPortRelease(port)) {
    if (rememberDesired) writeProxyDesiredRunning(false);
    return { ok: true, pid: externalPid };
  }
  return { ok: false, pid: externalPid, reason: `已发送停止信号，但端口 ${port} 仍被占用` };
}

export async function getManagedProxyStatus(): Promise<ManagedProxyStatus> {
  const injected = isProxyConfigured();
  const desiredRunning = readProxyDesiredRunning();
  const port = getConfiguredProxyPort();
  const health = await pingHealth(port);
  if (health?.ok && typeof health.pid === "number" && !isChildAlive(proxyChild)) {
    adoptedProxyPid = health.pid;
  }
  const pid = typeof health?.pid === "number"
    ? health.pid
    : isChildAlive(proxyChild)
      ? proxyChild!.pid ?? null
      : adoptedProxyPid ?? await findListeningPid(port);

  if (health?.ok) {
    const managed = health.mode === "managed" || pid === proxyChild?.pid;
    return { injected, desiredRunning, daemonStatus: "OK", pid, port, health, managed };
  }
  if (pid) {
    return {
      injected,
      desiredRunning,
      daemonStatus: "DEGRADED",
      statusHint: "端口存在监听进程，但 /_health 无响应，可能是旧版 proxy 或非 dashboard 托管进程。",
      pid,
      port,
      health: null,
      managed: pid === proxyChild?.pid,
    };
  }
  return { injected, desiredRunning, daemonStatus: "DOWN", pid: null, port, health: null, managed: false };
}

export async function startManagedProxyIfConfigured(): Promise<void> {
  if (!isProxyConfigured()) return;
  const result = await startManagedProxy();
  if (!result.ok) {
    console.warn(`[proxy] managed start failed: ${result.reason ?? "unknown"}`);
  }
}

export async function startManagedProxyIfDesired(): Promise<void> {
  if (!readProxyDesiredRunning()) return;
  const result = await startManagedProxy();
  if (!result.ok) {
    console.warn(`[proxy] desired start failed: ${result.reason ?? "unknown"}`);
  }
}

export async function stopManagedProxyIfRunning(): Promise<void> {
  // 只有 owner（自己 spawn 的）才在 shutdown 时停止；adopt 的外部进程不干预
  if (!isChildAlive(proxyChild)) return;
  await stopManagedProxy(getConfiguredProxyPort(), { rememberDesired: false });
}
