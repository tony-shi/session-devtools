export interface ProxyMeta {
  cli_tool: "claude" | "codex" | "gemini" | null;
  session_id: string | null;
  model: string | null;
  req_message_count: number | null;
  req_has_tools: boolean | null;
  res_input_tokens: number | null;
  res_output_tokens: number | null;
  res_cache_creation_tokens: number | null;
  res_cache_read_tokens: number | null;
  res_stop_reason: string | null;
  error_class: string | null;
}

export interface ExtractInput {
  reqHeaders: Record<string, string>;
  reqBody: string | null;       // decoded utf8 text; null if unavailable or binary
  resHeaders: Record<string, string>;
  resBody: string | null;       // decoded utf8 text; null if unavailable or binary
  status: number;
  isStream: boolean;
  sseEvents?: Array<{ eventType: string; data: string }>;
}
