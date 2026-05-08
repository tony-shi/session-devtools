// ~/.claude/settings.json 的读/写/标记/还原/注入。
//
// 设计：backup-only 还原模型。
//
//   start: 先 cp 当前 settings → active.json（marker + 还原源）+ history/<ts>.json（归档）
//          再 apply 注入 patch
//   stop:  active.json 存在 → 拿它的 originalSettings 写回 settings.json，删 active.json
//          active.json 不存在 → 不动 settings（"无 marker = 没注入"，避免误删用户配置）
//
// 这套不依赖 settings 内容做 marker 判定。即使用户手写过 NODE_EXTRA_CA_CERTS=<我们的 ca.pem>，
// 我们也不会乱碰他的 settings —— 只有自己写过 active.json 的会话才会动还原。
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PATHS } from "../proxy/config";   // 仍然用 PATHS.caCert（CA 文件由 proxy server 管）
import { V2_PATHS } from "./paths";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// NO_PROXY 注入的最小集 —— 只豁免 localhost 字符串（不豁免 127.0.0.1，
// 因为用户的自定义网关常在 127.0.0.1:xxxx，那条流量我们要抓）。
// undici 不会自动豁免 localhost；不注入会让 Claude Code 调用本地 MCP / 工具时
// 经过我们 proxy → 浪费 + 可能造成 MITM 自身回环。
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

interface ActiveMarker {
  startedAt: string;       // ISO
  port: number;
  // 原 settings.json 的完整文本（保留原始空白/注释/尾逗号等不严格 JSON）
  // null = 注入前 settings.json 不存在
  originalSettings: string | null;
}

// 当前是否处于已注入会话
export function isActive(): boolean {
  return existsSync(V2_PATHS.active);
}

// 写 active.json（marker + 还原源）+ history/<ts>.json（人工兜底归档）。
// 必须在 inject 之前调用。
export function markActive(port: number): { activePath: string; historyPath: string | null } {
  mkdirSync(V2_PATHS.home, { recursive: true, mode: 0o700 });
  mkdirSync(V2_PATHS.history, { recursive: true, mode: 0o700 });

  const original: string | null = existsSync(SETTINGS_PATH)
    ? readFileSync(SETTINGS_PATH, "utf8")
    : null;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const marker: ActiveMarker = {
    startedAt: new Date().toISOString(),
    port,
    originalSettings: original,
  };

  // 历史归档：仅在原文件存在时写。意外删除 active.json 时用户能从 history 里手工恢复。
  let historyPath: string | null = null;
  if (original !== null) {
    historyPath = join(V2_PATHS.history, `before-mitm-${ts}.json`);
    writeFileSync(historyPath, original, { mode: 0o600 });
  }

  writeFileSync(V2_PATHS.active, JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 });
  return { activePath: V2_PATHS.active, historyPath };
}

// 计算注入 patch
function buildEnvPatch(existingEnv: Record<string, string>, port: number, caCertPath: string): Record<string, string> {
  const patch: Record<string, string> = {};
  const ourProxy = `http://127.0.0.1:${port}`;

  const currentHttpsProxy = existingEnv.HTTPS_PROXY ?? existingEnv.https_proxy ?? "";
  const isAlreadyOurs = currentHttpsProxy === ourProxy;

  // 已经指向我们 = 重启路径，不动上游；否则有上游 = 迁移到 API_DASHBOARD_PROXY_UPSTREAM
  // (env var 名暂保留兼容老 proxy server，迁移期同时支持后改)
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

export function injectSettings(port: number): void {
  const { raw, env } = readSettings();
  const patch = buildEnvPatch(env, port, PATHS.caCert);
  writeSettings({ ...raw, env: { ...env, ...patch } });
}

export type RestoreOutcome =
  | { kind: "restored-from-active"; originalExisted: boolean }
  | { kind: "no-active-marker" };

// 还原 settings：仅依赖 active.json。
// - active.json 不存在 → 我们没注入证据，不动 settings（避免误删用户配置）
// - active.json 存在但 originalSettings=null → 注入前 settings.json 不存在，删除
// - active.json 存在且有 originalSettings → 写回原文（保留原始空白/不严格 JSON）
export function restoreSettings(): RestoreOutcome {
  if (!existsSync(V2_PATHS.active)) return { kind: "no-active-marker" };

  const marker = JSON.parse(readFileSync(V2_PATHS.active, "utf8")) as ActiveMarker;

  if (marker.originalSettings !== null) {
    // 直接写原始字节，不做 JSON.parse+stringify —— 原文件可能 JSON 不严格（注释、尾逗号），
    // re-stringify 会丢失这些细节。
    const dir = join(homedir(), ".claude");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(SETTINGS_PATH, marker.originalSettings, { mode: 0o600 });
  } else if (existsSync(SETTINGS_PATH)) {
    // 原本不存在 settings.json，注入后才有 → 删掉
    rmSync(SETTINGS_PATH, { force: true });
  }

  rmSync(V2_PATHS.active, { force: true });
  return { kind: "restored-from-active", originalExisted: marker.originalSettings !== null };
}
