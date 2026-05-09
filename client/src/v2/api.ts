import type { DashboardV2, SessionProxyResponse, SessionsV2Response } from "./types";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

export const apiV2 = {
  dashboard: (date: string) =>
    get<DashboardV2>(`/api/v2/dashboard?date=${date}`),

  sessions: (date: string, tool?: string) =>
    get<SessionsV2Response>(
      `/api/v2/sessions?date=${date}&limit=100${tool ? `&tool=${tool}` : ""}`,
    ),

  sessionProxy: (sessionId: string) =>
    get<SessionProxyResponse>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/proxy`),

  sync: () =>
    get<{ synced: number; skipped: number; errors: number }>("/api/v2/sessions/sync"),
};
