// 代理模块的统一配置入口。
// 全部路径与端口都从此处读，禁止散落在其它文件里硬编码。
//
// 命名规范：所有 env 变量与项目本体共享 API_DASHBOARD_ 前缀（见 .env.example、AGENTS.md §1）。
//
// 重要：proxy 是机器级全局基础设施（CA 证书、pid 文件、traffic.jsonl、settings.json 注入），
// 路径固定为 ~/.api-dashboard/proxy，不随 worktree 的 API_DASHBOARD_DIR 变化。
// 原因：不可能并发开发多个 proxy 实例；路径随 worktree 变只会造成路径不一致的 bug。
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return join(homedir(), p.slice(1));
  return p;
}

// sessions DB 等项目数据随 worktree 隔离，proxy 数据固定在全局路径。
export const PROJECT_HOME = process.env.API_DASHBOARD_DIR
  ? expandHome(process.env.API_DASHBOARD_DIR)
  : join(homedir(), ".api-dashboard");

// proxy 固定在 ~/.api-dashboard/proxy，不受 API_DASHBOARD_DIR 影响
export const PROXY_HOME = join(homedir(), ".api-dashboard", "proxy");
export const BACKUPS_HOME = join(homedir(), ".api-dashboard", "backups");

export const PATHS = {
  projectHome: PROJECT_HOME,
  home: PROXY_HOME,
  caCert: join(PROXY_HOME, "ca.pem"),
  caKey: join(PROXY_HOME, "ca.key"),
  trafficLog: join(PROXY_HOME, "traffic.jsonl"),
  pidFile: join(PROXY_HOME, "proxy.pid"),
  portFile: join(PROXY_HOME, "proxy.port"),
  desiredStateFile: join(PROXY_HOME, "desired-state.json"),
  backups: BACKUPS_HOME,
  // A5.1: 用户声明的自定义拦截主机列表（L1 层）
  mitmHostsFile: join(PROXY_HOME, "mitm-hosts.json"),
  // A5.3: 用户上传的上游自签 CA 目录（L2 层）
  targetCaDir: join(PROXY_HOME, "target-ca"),
};

// A5.1: MITM 白名单 lazy-init。
// 合并三源：内置 api.anthropic.com + settings.json 的 ANTHROPIC_BASE_URL（L0）+ mitm-hosts.json（L1）。
// 调用 getMitmWhitelist() 获取当前生效集合；daemon 热重载时调用 reloadMitmWhitelist() 刷新。
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

  // L0：settings.json env 块里的 ANTHROPIC_BASE_URL（进程启动时已注入到 process.env）
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    try {
      const hostname = new URL(baseUrl).hostname;
      if (hostname) hosts.add(hostname);
    } catch {
      // 格式非法，忽略
    }
  }

  // L1：mitm-hosts.json 的 hosts 数组
  if (existsSync(PATHS.mitmHostsFile)) {
    try {
      const raw = JSON.parse(readFileSync(PATHS.mitmHostsFile, "utf8"));
      if (Array.isArray(raw.hosts)) {
        for (const h of raw.hosts) {
          if (typeof h === "string" && h.trim()) hosts.add(h.trim());
        }
      }
    } catch {
      // 文件损坏，忽略；不影响已有白名单
    }
  }

  return hosts;
}

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

// A5.3: 加载用户上传的上游自签 CA PEM 列表。
// 返回 PEM 字符串数组，追加到 tls.connect() 的 ca 选项（不替换系统信任链）。
export function loadTargetCaPems(): string[] {
  const dir = PATHS.targetCaDir;
  if (!existsSync(dir)) return [];
  const pems: string[] = [];
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".pem")) continue;
      try {
        pems.push(readFileSync(join(dir, name), "utf8"));
      } catch {
        // 单个文件读失败，跳过
      }
    }
  } catch {
    // 目录读失败
  }
  return pems;
}
