export interface SessionV2 {
  session_id: string;
  tool: "claude";
  source_file: string;
  file_mtime: number;
  file_size: number;
  parser_version: number;
  schema_fingerprint: string;
  source_present: number;
  first_event_at: string;
  last_event_at: string;
  cwd: string;
  project: string;
  title: string | null;
  first_user_message: string;
  event_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  models: string[];
  tool_call_count: number;
  human_input_count: number;
  claude_code_api_error_count: number;
  parser_warnings: string[];
  proxy_count: number;
}

export interface SessionsV2Response {
  sessions: SessionV2[];
  total: number;
  limit: number;
  offset: number;
}

export interface DashboardV2 {
  date: string;
  session_count: number;
  by_tool: Record<string, number>;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  tool_call_count: number;
  human_input_count: number;
}

export interface ProxyRequestV2 {
  id: number;
  started_at: string;
  method: string;
  url: string;
  status: number;
  model: string | null;
  req_message_count: number | null;
  req_has_tools: number | null;
  res_input_tokens: number | null;
  res_output_tokens: number | null;
  res_cache_creation_tokens: number | null;
  res_cache_read_tokens: number | null;
  res_stop_reason: string | null;
  error_class: string | null;
  duration_ms: number | null;
  is_stream: number;
  sse_event_count: number;
}

export interface SessionProxyResponse {
  session_id: string;
  requests: ProxyRequestV2[];
  total: number;
}
