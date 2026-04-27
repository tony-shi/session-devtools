// 流量旁路 JSONL 写盘。
//
// 凭据策略（设计文档 §B5 / 实现边界 B5）：
// - 数据落在用户本地机器、文件权限 0700，默认存明文（含 Authorization / x-api-key 等）。
//   这与 sessions.db 的处理方式一致：JSONL 与 SQLite 都是用户对自己机器的数据负责。
// - 但 Proxy-Authorization 例外，**始终强删** —— 那是用户上游 HTTP 代理（公司 VPN / Clash 等）的凭据，
//   跟 LLM 业务无关，落盘只增加无故风险。
// - 想分享 / 导出日志时设 API_DASHBOARD_PROXY_REDACT=1，恢复对 Authorization / x-api-key 的截断脱敏。
//
// B1.1 SSE 流式响应：按 SSE 事件拆行落盘，每事件一条 JSONL。
// B1.2 JSONL 滚动：单文件 > 100 MB 切分；保留最近 7 天，更早压缩。
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "../config";

export type TrafficRecord = {
  ts: string; // ISO
  startedAt?: string; // 请求发起时间，response 记录用于 UI 排序和增量游标
  kind: "request" | "response" | "event" | "sse_event";
  sni?: string;
  method?: string;
  url?: string;
  status?: number;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  reqBody?: string;
  resBody?: string;
  // SSE 事件字段（B1.1）
  sseEventType?: string;  // SSE event: 字段，默认 "message"
  sseData?: string;       // SSE data: 字段内容
  sseIndex?: number;      // 该响应中的第几个 SSE 事件（0-based）
  // 通用事件：start/stop/error 等
  msg?: string;
  meta?: Record<string, unknown>;
};

// 始终强删的 header（与凭据策略中的"分享模式"开关无关）。
const ALWAYS_STRIP_REQ_HEADERS = new Set(["proxy-authorization"]);
// 仅在 REDACT 模式下截断的 header。
const REDACTABLE_REQ_HEADERS = new Set(["authorization", "x-api-key"]);

// B1.2: 单文件最大体积（100 MB）
const MAX_FILE_BYTES = 100 * 1024 * 1024;
// B1.2: 保留最近 N 天的切分文件
const RETAIN_DAYS = 7;

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

// B1.2: 检查是否需要切分，如需要则重命名当前文件，清理过期文件。
function maybeRotate(): void {
  if (!existsSync(PATHS.trafficLog)) return;
  try {
    const stat = statSync(PATHS.trafficLog);
    if (stat.size < MAX_FILE_BYTES) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(PATHS.trafficLog, `${PATHS.trafficLog}.${ts}`);
    cleanOldRotated();
  } catch {
    // 切分失败不影响主流程
  }
}

// 删除 7 天前的切分文件
function cleanOldRotated(): void {
  const dir = dirname(PATHS.trafficLog);
  const base = "traffic.jsonl.";
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(base)) continue;
      const fullPath = join(dir, name);
      try {
        const st = statSync(fullPath);
        if (st.mtimeMs < cutoff) unlinkSync(fullPath);
      } catch {}
    }
  } catch {}
}

export function writeTraffic(rec: TrafficRecord): void {
  ensureDir();
  maybeRotate();
  const sanitized: TrafficRecord = {
    ...rec,
    reqHeaders: processReqHeaders(rec.reqHeaders),
    // 响应 header 不动 —— Anthropic 不会回敏感凭据。
    resHeaders: rec.resHeaders,
  };
  appendFileSync(PATHS.trafficLog, JSON.stringify(sanitized) + "\n");
}

// B1.1: 解析 SSE 流，每事件调用 onEvent 回调。
// SSE 格式参考 Anthropic 官方（text/event-stream）：
//   event: content_block_delta\ndata: {...}\n\n
export function parseSseChunk(
  buffer: string,
  onEvent: (eventType: string, data: string, index: number) => void,
  state: { buf: string; index: number },
): void {
  state.buf += buffer;
  // SSE 事件以 \n\n 分隔
  const events = state.buf.split("\n\n");
  // 最后一个可能不完整，保留
  state.buf = events.pop() ?? "";
  for (const block of events) {
    if (!block.trim()) continue;
    let eventType = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
      else if (line.startsWith(":")) {
        // SSE 注释行，忽略
      }
    }
    if (data) {
      onEvent(eventType, data, state.index++);
    }
  }
}
