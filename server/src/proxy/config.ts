// 代理模块的统一配置入口。
// 全部路径与端口都从此处读，禁止散落在其它文件里硬编码。
//
// 命名规范：所有 env 变量与项目本体共享 API_DASHBOARD_ 前缀（见 .env.example、AGENTS.md §1）。
import { homedir } from "node:os";
import { join } from "node:path";

// 与项目本体共享一份 home 目录；默认 ~/.api-dashboard/，可被 env 覆盖。
const projectHome = process.env.API_DASHBOARD_DIR
  ? expandHome(process.env.API_DASHBOARD_DIR)
  : join(homedir(), ".api-dashboard");

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return join(homedir(), p.slice(1));
  return p;
}

export const PROJECT_HOME = projectHome;
export const PROXY_HOME = join(projectHome, "proxy");
export const BACKUPS_HOME = join(projectHome, "backups");

export const PATHS = {
  projectHome: PROJECT_HOME,
  home: PROXY_HOME,
  caCert: join(PROXY_HOME, "ca.pem"),
  caKey: join(PROXY_HOME, "ca.key"),
  trafficLog: join(PROXY_HOME, "traffic.jsonl"),
  pidFile: join(PROXY_HOME, "proxy.pid"),
  portFile: join(PROXY_HOME, "proxy.port"),
  backups: BACKUPS_HOME,
};

// SNI MITM 白名单。设计文档 §2.1 — 仅 LLM 推理流量。
export const MITM_WHITELIST = new Set<string>(["api.anthropic.com"]);

// 默认监听端口；安装器会写入实际值到 portFile。
export const DEFAULT_LISTEN_PORT = Number(process.env.API_DASHBOARD_PROXY_PORT ?? 38421);
export const LISTEN_HOST = "127.0.0.1";

export const DEBUG = !!process.env.API_DASHBOARD_PROXY_DEBUG;

export type UpstreamProxy = {
  protocol: "http";
  host: string;
  port: number;
  auth?: string; // 已是 base64 后的 "Basic xxx" header 值
};

// 解析 API_DASHBOARD_PROXY_UPSTREAM。空 / 未设 → null（直连）。
// 仅接受 http:// scheme（设计文档 §3.2.1）。其它 scheme 视为非法，抛错。
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
