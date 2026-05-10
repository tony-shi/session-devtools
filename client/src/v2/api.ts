import type { SessionProxyResponse, SessionsV2Response, SummaryV2 } from "./types";
import type { SessionDrilldown } from "./drilldown-types";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

export const apiV2 = {
  summary: () =>
    get<SummaryV2>("/api/v2/summary"),

  sessions: (opts?: { lastActiveDate?: string; activeSinceHours?: number; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    params.set("limit", String(opts?.limit ?? 50));
    if (opts?.offset) params.set("offset", String(opts.offset));
    if (opts?.lastActiveDate) params.set("last_active_date", opts.lastActiveDate);
    if (opts?.activeSinceHours != null) params.set("active_since_hours", String(opts.activeSinceHours));
    return get<SessionsV2Response>(`/api/v2/sessions?${params}`);
  },

  sessionProxy: (sessionId: string) =>
    get<SessionProxyResponse>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/proxy`),

  sessionDrilldown: (sessionId: string) =>
    get<SessionDrilldown>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/drilldown`),

  sync: () =>
    get<{ synced: number; skipped: number; errors: number }>("/api/v2/sessions/sync"),
};
