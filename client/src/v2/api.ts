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

  // Workflow run 的脚本源码。脚本全文不在 drilldown payload（WorkflowRunSummary
  // 只带 scriptLength/scriptPath），run 面板 Script tab 按需取。
  workflowScript: (sessionId: string, runId: string) =>
    get<WorkflowScriptResponse>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(runId)}/script`),

  // run 内各 agent 的 StructuredOutput schema（proxy 真值）。Result tab 用
  // schema.properties[k].description 给字段加标注。null 带显式 reason。
  workflowSchemas: (sessionId: string, runId: string) =>
    get<WorkflowSchemasResponse>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(runId)}/schemas`),

  // run 内 agent→agent 数据流（F，逐字节包含的确定性验证）+ 结果回流主线
  // （G，exact/field 两级置信）。"未确认" ≠ "无数据流"——脚本加工过则不可确认。
  workflowDataflow: (sessionId: string, runId: string) =>
    get<WorkflowDataflowResponse>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(runId)}/dataflow`),

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

  // agent teams 域：任一成员 session → 该 team 的成员列表 + 消息时间线。
  // 非 team 会话返回 404（预期路径，调用方静默置 null）。
  sessionTeam: (sessionId: string) =>
    get<TeamDomainResponse>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/team`),

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

export interface WorkflowScriptResponse {
  runId: string;
  workflowName: string;
  scriptPath: string;
  script: string;
}

export interface WorkflowAgentSchema {
  schema: Record<string, unknown> | null;
  /** schema 为 null 的显式原因：no-request（转录无 assistant 行）/
   *  proxy-missing（proxy 未捕获）/ no-structured-output（schema-less agent）。 */
  reason?: string;
}

export interface WorkflowSchemasResponse {
  runId: string;
  schemas: Record<string, WorkflowAgentSchema>;
}

export interface WorkflowDataflowEdge {
  fromAgentId: string;
  fromLabel: string;
  toAgentId: string;
  toLabel: string;
  /** 逐字节匹配的 result 长度（= 注入进下游 prompt 的字符数）。 */
  matchedChars: number;
}

export interface WorkflowMainlineHit {
  agentId: string;
  label: string;
  /** 主 JSONL 0-based 文件行号（与 IntervalEvent.lineIdx 同口径）。 */
  lineIdx: number;
  /** exact = result 全文出现在主线 tool_result；field = 某顶层字段全文（jq 提取场景）。 */
  confidence: "exact" | "field";
  matchedField?: string;
}

export interface WorkflowDataflowResponse {
  runId: string;
  edges: WorkflowDataflowEdge[];
  mainline: WorkflowMainlineHit[];
}

// ─── agent teams（mirrors server/src/team-domain.ts）─────────────────────────

export interface TeamMember {
  sessionId: string;
  agentName: string | null;   // null = lead
  role: "lead" | "teammate";
  firstEventAt: string;
  lastEventAt: string;
  llmCallCount: number;
  subAgentCount: number;
}

export interface TeamTimelineEvent {
  kind: "spawn" | "message" | "shutdown_request" | "idle" | "terminated" | "shutdown";
  from: string;               // 成员 agentName；lead 为 "team-lead"
  to?: string;
  summary?: string;
  textPreview: string;
  textLength: number;
  timestamp: string;
  sessionId: string;          // 留痕所在会话
  lineIdx: number;            // 0-based 文件行号
}

export interface TeamDomainResponse {
  teamName: string;
  members: TeamMember[];
  events: TeamTimelineEvent[];
}

export interface ProxyBodyResponse {
  req_body: string;
  res_body: string;
  req_body_encoding?: string;
  res_body_encoding?: string;
  error?: string;
}
