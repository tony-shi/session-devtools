import type {
  DigestData,
  SessionsResponse,
  StatsResponse,
  SummaryData,
  TurnsResponse,
} from "./types";

const BASE = "";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}


export const api = {
  summary: (date: string) =>
    get<SummaryData>(`/api/sessions/summary?date=${date}`),

  sessions: (date: string, tool?: string) =>
    get<SessionsResponse>(
      `/api/sessions?date=${date}&limit=100${tool ? `&tool=${tool}` : ""}`,
    ),

  turns: (sessionId: string, date: string) =>
    get<TurnsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/turns?date=${date}`,
    ),

  stats: (sessionId: string, date: string) =>
    get<StatsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/stats?date=${date}`,
    ),

  digest: (date: string, force = false) =>
    get<DigestData>(`/api/sessions/digest?date=${date}${force ? "&force=true" : ""}`),

  sync: () => get<{ synced: number; skipped: number; errors: number }>("/api/sessions/sync"),
};
