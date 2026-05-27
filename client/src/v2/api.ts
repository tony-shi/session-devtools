import type { SessionProxyResponse, SessionsV2Response, SummaryV2 } from "./types";
import type { SessionDrilldown, CallDetail } from "./drilldown-types";
import type { AttributionTreeResult } from "./attribution-tree-types";
import type { ResponseTreeResult } from "./response-tree-types";
import type { DiffTreeResult } from "./diff-tree-types";
import type { SessionAttributionGraph } from "./attribution-graph-types";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

export const apiV2 = {
  summary: () =>
    get<SummaryV2>("/api/v2/summary"),

  sessions: (opts?: { lastActiveDate?: string; activeSinceHours?: number; limit?: number; offset?: number; search?: string }) => {
    const params = new URLSearchParams();
    params.set("limit", String(opts?.limit ?? 50));
    if (opts?.offset) params.set("offset", String(opts.offset));
    if (opts?.lastActiveDate) params.set("last_active_date", opts.lastActiveDate);
    if (opts?.activeSinceHours != null) params.set("active_since_hours", String(opts.activeSinceHours));
    if (opts?.search) params.set("search", opts.search);
    return get<SessionsV2Response>(`/api/v2/sessions?${params}`);
  },

  sessionProxy: (sessionId: string) =>
    get<SessionProxyResponse>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/proxy`),

  sessionDrilldown: (sessionId: string) =>
    get<SessionDrilldown>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/drilldown`),

  callDetail: (sessionId: string, callId: number) =>
    get<CallDetail>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/calls/${callId}/detail`),

  /**
   * Per-call attribution tree. Server enriches every jsonl-origin leaf
   * with `firstSeenInCall` / `consumedByCallIds` so the UI can use
   * `leaf.origin.firstSeenInCall` directly as a jump target.
   */
  attributionTree: (sessionId: string, callId: number) =>
    get<AttributionTreeResult>(
      `/api/v2/sessions/${encodeURIComponent(sessionId)}/calls/${callId}/attribution-tree`,
    ),

  responseTree: (sessionId: string, callId: number) =>
    get<ResponseTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/calls/${callId}/response-tree`),

  diffTree: (sessionId: string, callId: number) =>
    get<DiffTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/calls/${callId}/diff-tree`),

  /**
   * Reverse attribution graph for the session — every jsonl event
   * annotated with which calls consumed it. Always runs over the full
   * session; server caches the result for 5min.
   */
  attributionGraph: (sessionId: string) =>
    get<SessionAttributionGraph>(
      `/api/v2/sessions/${encodeURIComponent(sessionId)}/attribution-graph`,
    ),

  subAgentDrilldown: (sessionId: string, agentFileId: string) =>
    get<SessionDrilldown>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentFileId)}/drilldown`),

  // Sub-agent variants of the per-call endpoints. URL path encodes the
  // parent session id (where proxy_requests rows live) plus the agentFileId
  // identifying which sub-agent JSONL to parse.
  subAgentCallDetail: (sessionId: string, agentFileId: string, callId: number) =>
    get<CallDetail>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentFileId)}/calls/${callId}/detail`),

  subAgentAttributionTree: (sessionId: string, agentFileId: string, callId: number) =>
    get<AttributionTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentFileId)}/calls/${callId}/attribution-tree`),

  subAgentResponseTree: (sessionId: string, agentFileId: string, callId: number) =>
    get<ResponseTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentFileId)}/calls/${callId}/response-tree`),

  subAgentDiffTree: (sessionId: string, agentFileId: string, callId: number) =>
    get<DiffTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentFileId)}/calls/${callId}/diff-tree`),

  // Compact-as-call endpoints. compact_boundary 是一次独立 summarization
  // LLM call，合成 callId 是 -(idx+1)，所以走专用的 :idx 路由（不混 :callId）。
  // CallDetail shape 完全一致，前端 LlmCallDetailPanel 收到 `compactIdx` prop
  // 时把 4 个 fetch 路由切到这一组。
  compactCallDetail: (sessionId: string, compactIdx: number) =>
    get<CallDetail>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/compact/${compactIdx}/detail`),

  compactAttributionTree: (sessionId: string, compactIdx: number) =>
    get<AttributionTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/compact/${compactIdx}/attribution-tree`),

  compactResponseTree: (sessionId: string, compactIdx: number) =>
    get<ResponseTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/compact/${compactIdx}/response-tree`),

  // Side calls —— session 在对话主线之外发的后台 LLM 请求（标题生成 / quota
  // 探测 / 提示建议 …）。captured=false 时 proxy 没抓到（仅 JSONL 留痕），
  // proxyRequestId / token / model 都为 null。
  sideCalls: (sessionId: string) =>
    get<SideCallsResponse>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/side-calls`),

  // Side-call-as-call endpoints. 一个 side call 只由 proxy_requests.id 寻址（没有
  // transcript turn / prev call / jsonl 坐标），所以走专用的 :proxyRequestId 路由。
  // 返回 shape 与 compact 端点一致（CallDetail / AttributionTreeResult /
  // ResponseTreeResult），前端 side-call 模式直接复用 LLM-call 详情的三个 tab。
  // attribution 端点的 diff 永远是"全 added"（无 prev），由前端 hideDiff 隐藏；
  // cache 也在 side-call 模式下被前端强制隐藏。
  sideCallDetail: (sessionId: string, proxyRequestId: number) =>
    get<CallDetail>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/side-call/${proxyRequestId}/detail`),

  sideCallAttributionTree: (sessionId: string, proxyRequestId: number) =>
    get<AttributionTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/side-call/${proxyRequestId}/attribution-tree`),

  sideCallResponseTree: (sessionId: string, proxyRequestId: number) =>
    get<ResponseTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/side-call/${proxyRequestId}/response-tree`),

  // 原始 proxy 请求/响应体。req_body 是 Anthropic 请求 JSON 字符串
  // （{model, system, messages, tools}），res_body 是 SSE 文本（流式）或 JSON。
  proxyBody: (proxyRequestId: number) =>
    get<ProxyBodyResponse>(`/api/proxy/requests/${proxyRequestId}/body`),

  sync: () =>
    get<{ synced: number; skipped: number; errors: number }>("/api/v2/sessions/sync"),
};

export type SideCallKind =
  | "generate_session_title"
  | "quota"
  | "prompt_suggestion"
  | "agent_summary"
  | "auto_dream"
  | "extract_memories"
  | "away_summary";

export interface SideCall {
  proxyRequestId: number | null;
  kind: SideCallKind;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: string | null;
  title?: string;
  /** True iff this side call已被对话主线锚定（anchored = 出现在 transcript 里）。 */
  anchored: boolean;
  /** True iff proxy 抓到了请求；false 时 proxyRequestId / token / model 为 null。 */
  captured: boolean;
}

export interface SideCallsResponse {
  sideCalls: SideCall[];
  tokenTotals: { input: number; output: number };
}

export interface ProxyBodyResponse {
  req_body: string;
  res_body: string;
  req_body_encoding?: string;
  res_body_encoding?: string;
  error?: string;
}
