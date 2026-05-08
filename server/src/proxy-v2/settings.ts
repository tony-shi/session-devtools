// ~/.claude/settings.json 的读/写/备份/还原/注入。
// 设计目标：每个动作都是一个原子小函数，reconcile 层负责编排。
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PATHS } from "../proxy/config";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// 我们注入的 5 个 env key（与旧 proxy 一致，保持兼容）
export const OUR_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "API_DASHBOARD_PROXY_UPSTREAM",
] as const;

// NO_PROXY 最小集：只排除 localhost 域名形式，不排除 127.0.0.1 IP
// （用户可能把自定义网关放在 127.0.0.1:xxxx，需要经过我们 MITM）
const OUR_NO_PROXY_MIN = ["localhost", "::1"];

export interface SettingsSnapshot {
  raw: Record<string, unknown>;
  env: Record<string, string>;
}

export function readSettings(): SettingsSnapshot {
  if (!existsSync(SETTINGS_PATH)) return { raw: {}, env: {} };
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    const env = (raw?.env && typeof raw.env === "object" ? raw.env : {}) as Record<string, string>;
    return { raw, env };
  } catch {
    return { raw: {}, env: {} };
  }
}

function writeSettings(raw: Record<string, unknown>): void {
  const dir = join(homedir(), ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS_PATH, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
}

// 当前 settings 是否含我们注入的痕迹（用于决定是否要还原）
export function hasInjectionMarker(env: Record<string, string>): boolean {
  return env.NODE_EXTRA_CA_CERTS === PATHS.caCert ||
    env.API_DASHBOARD_PROXY_UPSTREAM !== undefined;
}

// 备份 settings.json，返回备份路径；原文件不存在则返回 null
export function backupSettings(): string | null {
  if (!existsSync(SETTINGS_PATH)) return null;
  mkdirSync(PATHS.backups, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(PATHS.backups, `settings.json.before-mitm-${ts}`);
  cpSync(SETTINGS_PATH, dest);
  return dest;
}

// 找到最近的 before-mitm 备份（用于 restore）
function findLatestBackup(): string | null {
  if (!existsSync(PATHS.backups)) return null;
  const candidates = readdirSync(PATHS.backups)
    .filter((n) => n.startsWith("settings.json.before-mitm-"))
    .map((n) => join(PATHS.backups, n));
  if (candidates.length === 0) return null;
  candidates.sort();  // ISO 时间戳天然有序
  return candidates[candidates.length - 1] ?? null;
}

// 计算注入后的 env patch（与旧 install.ts buildEnvPatch 等价，但精简为同步）
function buildEnvPatch(existingEnv: Record<string, string>, port: number, caCertPath: string): Record<string, string> {
  const patch: Record<string, string> = {};
  const ourProxy = `http://127.0.0.1:${port}`;

  const currentHttpsProxy = existingEnv.HTTPS_PROXY ?? existingEnv.https_proxy ?? "";
  const isAlreadyOurs = currentHttpsProxy === ourProxy;

  // 已经指向我们 = 重启路径，不动上游
  // 否则有上游 = 迁移到 API_DASHBOARD_PROXY_UPSTREAM
  if (!isAlreadyOurs && currentHttpsProxy) {
    patch.API_DASHBOARD_PROXY_UPSTREAM = currentHttpsProxy;
  }
  patch.HTTPS_PROXY = ourProxy;
  patch.HTTP_PROXY = ourProxy;

  // NO_PROXY：保留用户值，剔除会让我们漏抓的 host，再追加最小集
  const userNoProxy = (existingEnv.NO_PROXY ?? existingEnv.no_proxy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((entry) => entry !== "api.anthropic.com");
  const merged = [...new Set([...userNoProxy, ...OUR_NO_PROXY_MIN])];
  patch.NO_PROXY = merged.join(",");

  patch.NODE_EXTRA_CA_CERTS = caCertPath;
  return patch;
}

// 注入：合并 patch 进 env 块，写盘
export function injectSettings(port: number): void {
  const { raw, env } = readSettings();
  const patch = buildEnvPatch(env, port, PATHS.caCert);
  writeSettings({ ...raw, env: { ...env, ...patch } });
}

export interface RestoreResult {
  // backup    = 直接 cp 整份备份回去（最干净）
  // key-removal = 没找到备份，按 OUR_ENV_KEYS 删除我们的痕迹（fallback）
  // no-change = 当前没有注入痕迹，无需操作
  method: "backup" | "key-removal" | "no-change";
}

// 还原 settings：优先恢复整份备份，缺失则按 key 删除并回填 upstream
export function restoreSettings(): RestoreResult {
  const { raw, env } = readSettings();
  if (!hasInjectionMarker(env) && !existsSync(SETTINGS_PATH)) {
    return { method: "no-change" };
  }

  const backup = findLatestBackup();
  if (backup) {
    cpSync(backup, SETTINGS_PATH);
    return { method: "backup" };
  }

  if (!hasInjectionMarker(env)) return { method: "no-change" };

  const upstream = env.API_DASHBOARD_PROXY_UPSTREAM;
  const newEnv: Record<string, string> = { ...env };
  for (const k of OUR_ENV_KEYS) delete newEnv[k];
  if (upstream) {
    newEnv.HTTPS_PROXY = upstream;
    newEnv.HTTP_PROXY = upstream;
  }

  // 摘除我们追加的 NO_PROXY 最小集
  const orig = env.NO_PROXY ?? "";
  if (orig) {
    const filtered = orig.split(",").map((s) => s.trim()).filter((s) => s && !OUR_NO_PROXY_MIN.includes(s));
    if (filtered.length > 0) newEnv.NO_PROXY = filtered.join(",");
    else delete newEnv.NO_PROXY;
  }

  writeSettings({ ...raw, env: newEnv });
  return { method: "key-removal" };
}
