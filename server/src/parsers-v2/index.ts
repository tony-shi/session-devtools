export interface SessionMetaV2 {
  session_id: string;
  tool: "claude";
  source_file: string;

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

  claude_code_api_error_count: number;  // Claude Code "system/api_error" events; NOT HTTP errors
  parser_warnings: string[];
  schema_fingerprint: string;
}

export type ParserV2 = (filePath: string) => Promise<SessionMetaV2>;

import { parseClaudeSessionV2 } from "./claude.ts";

export const PARSERS_V2: Record<string, ParserV2> = {
  claude: parseClaudeSessionV2,
};

export const PARSER_VERSION = 1;
