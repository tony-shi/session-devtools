// 流量旁路 JSONL 写盘。
//
// 凭据策略（设计文档 §B5 / 实现边界 B5）：
// - 数据落在用户本地机器、文件权限 0700，默认存明文（含 Authorization / x-api-key 等）。
//   这与 sessions.db 的处理方式一致：JSONL 与 SQLite 都是用户对自己机器的数据负责。
// - 但 Proxy-Authorization 例外，**始终强删** —— 那是用户上游 HTTP 代理（公司 VPN / Clash 等）的凭据，
//   跟 LLM 业务无关，落盘只增加无故风险。
// - 想分享 / 导出日志时设 API_DASHBOARD_PROXY_REDACT=1，恢复对 Authorization / x-api-key 的截断脱敏。
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "../config";

export type TrafficRecord = {
  ts: string; // ISO
  kind: "request" | "response" | "event";
  sni?: string;
  method?: string;
  url?: string;
  status?: number;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  reqBody?: string;
  resBody?: string;
  // 通用事件：start/stop/error 等
  msg?: string;
  meta?: Record<string, unknown>;
};

// 始终强删的 header（与凭据策略中的"分享模式"开关无关）。
const ALWAYS_STRIP_REQ_HEADERS = new Set(["proxy-authorization"]);
// 仅在 REDACT 模式下截断的 header。
const REDACTABLE_REQ_HEADERS = new Set(["authorization", "x-api-key"]);

function ensureDir() {
  const dir = dirname(PATHS.trafficLog);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function shouldRedact(): boolean {
  return !!process.env.API_DASHBOARD_PROXY_REDACT;
}

function processReqHeaders(h: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!h) return h;
  const redact = shouldRedact();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (ALWAYS_STRIP_REQ_HEADERS.has(lk)) continue;
    if (redact && REDACTABLE_REQ_HEADERS.has(lk)) {
      out[k] = v.length > 12 ? `${v.slice(0, 8)}…[redacted ${v.length - 8} chars]` : "[redacted]";
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function writeTraffic(rec: TrafficRecord): void {
  ensureDir();
  const sanitized: TrafficRecord = {
    ...rec,
    reqHeaders: processReqHeaders(rec.reqHeaders),
    // 响应 header 不动 —— Anthropic 不会回敏感凭据。
    resHeaders: rec.resHeaders,
  };
  appendFileSync(PATHS.trafficLog, JSON.stringify(sanitized) + "\n");
}
