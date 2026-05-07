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
  title?: string | null;
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

export type ParseResult = { session: Session; turns: Turn[] };
export type Parser = (filePath: string) => Promise<ParseResult>;

import { parseClaudeSession } from "./claude";
import { parseCodexSession } from "./codex";
import { parseGeminiSession } from "./gemini";

export const PARSERS: Record<string, Parser> = {
  claude: parseClaudeSession,
  codex: parseCodexSession,
  gemini: parseGeminiSession,
};
