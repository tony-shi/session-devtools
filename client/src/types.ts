export interface Session {
  id: string;
  tool: "claude" | "codex" | "gemini";
  project: string;
  cwd: string;
  started_at: string;
  ended_at: string;
  turn_count: number;
  human_turn_count: number;
  model: string;
  source_file: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  tool_call_count: number;
  tool_call_names: Record<string, number>;
}

export interface Turn {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  turn_kind: "human_input" | "tool_result" | "assistant" | "assistant_tool";
  content: string;
  timestamp: string;
  turn_index: number;
  tool_calls: number;
  tool_names: string[];
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

export interface SummaryData {
  date: string;
  total_sessions: number;
  total_turns: number;
  by_tool: Record<string, { sessions: number; turns: number; projects: string[] }>;
}

export interface DigestData {
  date: string;
  summary: string | null;
  pair_count: number;
  model: string;
  mock: boolean;
  generated_at: string | null;
  stale: boolean;
  cached: boolean;
}

export interface SessionsResponse {
  sessions: Session[];
  total: number;
  limit: number;
  offset: number;
}

export interface TurnsResponse {
  session: Session;
  turns: Turn[];
  date_filter: string | null;
}

export interface StatsResponse {
  session_id: string;
  tokens: { input: number; output: number; cache_creation: number; cache_read: number };
  tool_calls: { total: number; by_name: Record<string, number> };
  human_turns: { id: string; turn_index: number; timestamp: string; content: string }[];
}
