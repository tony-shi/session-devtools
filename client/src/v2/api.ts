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

  attributionTree: (sessionId: string, callId: number) =>
    get<AttributionTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/calls/${callId}/attribution-tree`),

  responseTree: (sessionId: string, callId: number) =>
    get<ResponseTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/calls/${callId}/response-tree`),

  diffTree: (sessionId: string, callId: number) =>
    get<DiffTreeResult>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/calls/${callId}/diff-tree`),

  /**
   * Reverse attribution graph for the session — every jsonl event annotated
   * with which calls consumed it. `lastN` limits the audit window (only
   * the last K calls drive the reverse lookup); omit for full session
   * (slow on big sessions: ~13s for 149 calls).
   */
  attributionGraph: (sessionId: string, opts?: { lastN?: number }) => {
    const qs = opts?.lastN ? `?lastN=${opts.lastN}` : "";
    return get<SessionAttributionGraph>(
      `/api/v2/sessions/${encodeURIComponent(sessionId)}/attribution-graph${qs}`,
    );
  },

  subAgentDrilldown: (sessionId: string, agentFileId: string) =>
    get<SessionDrilldown>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentFileId)}/drilldown`),

  sync: () =>
    get<{ synced: number; skipped: number; errors: number }>("/api/v2/sessions/sync"),
};
