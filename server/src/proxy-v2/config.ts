// proxy-v2 server 运行时配置。
// 路径常量在 paths.ts；这里只放运行时函数和类型。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { PROXY_SERVER_PATHS } from "./paths";

export const LISTEN_HOST = "127.0.0.1";
export const DEBUG = !!process.env.API_DASHBOARD_PROXY_DEBUG;

export type UpstreamProxy = {
  protocol: "http";
  host: string;
  port: number;
  auth?: string;
};

export function loadUpstream(): UpstreamProxy | null {
  const raw = (process.env.API_DASHBOARD_PROXY_UPSTREAM ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`API_DASHBOARD_PROXY_UPSTREAM 无法解析: ${raw}`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`API_DASHBOARD_PROXY_UPSTREAM scheme 不支持: ${url.protocol} (仅支持 http://)`);
  }
  const host = url.hostname;
  const port = Number(url.port || 80);
  let auth: string | undefined;
  if (url.username) {
    const cred = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    auth = `Basic ${Buffer.from(cred, "utf8").toString("base64")}`;
  }
  return { protocol: "http", host, port, auth };
}

export function loadTargetCaPems(): string[] {
  const dir = PROXY_SERVER_PATHS.targetCaDir;
  if (!existsSync(dir)) return [];
  const pems: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".pem")) continue;
      try {
        pems.push(readFileSync(dir + "/" + name, "utf8"));
      } catch {}
    }
  } catch {}
  return pems;
}

// A5.1: MITM 白名单 lazy-init。
// 合并三源：内置 api.anthropic.com + ANTHROPIC_BASE_URL（L0）+ mitm-hosts.json（L1）。
let _mitmWhitelist: Set<string> | null = null;

export function getMitmWhitelist(): Set<string> {
  if (!_mitmWhitelist) _mitmWhitelist = buildMitmWhitelist();
  return _mitmWhitelist;
}

export function reloadMitmWhitelist(): void {
  _mitmWhitelist = buildMitmWhitelist();
}

function buildMitmWhitelist(): Set<string> {
  const hosts = new Set<string>(["api.anthropic.com"]);

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    try {
      const hostname = new URL(baseUrl).hostname;
      if (hostname) hosts.add(hostname);
    } catch {}
  }

  if (existsSync(PROXY_SERVER_PATHS.mitmHostsFile)) {
    try {
      const raw = JSON.parse(readFileSync(PROXY_SERVER_PATHS.mitmHostsFile, "utf8"));
      if (Array.isArray(raw.hosts)) {
        for (const h of raw.hosts) {
          if (typeof h === "string" && h.trim()) hosts.add(h.trim());
        }
      }
    } catch {}
  }

  return hosts;
}
