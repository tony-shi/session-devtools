export interface SessionMetaV2 {
  session_id: string;
  tool: "claude";
  source_file: string;

  first_event_at: string;
  last_event_at: string;

  cwd: string;
  project: string;
  custom_title: string | null;
  ai_title: string | null;
  first_user_message: string;

  event_count: number;

  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  models: string[];

  tool_call_count: number;
  llm_call_count: number;
  human_input_count: number;
  sub_agent_count: number;

  claude_code_api_error_count: number;  // Claude Code "system/api_error" events; NOT HTTP errors
  parser_warnings: string[];
  schema_fingerprint: string;

  away_summary: string | null;       // last system/away_summary content (Claude Code auto-recap on return)
  last_assistant_text: string | null; // last non-synthetic assistant plain text, truncated to 300 chars
}

export type ParserV2 = (filePath: string) => Promise<SessionMetaV2>;

import { parseClaudeSessionV2 } from "./claude.ts";

export const PARSERS_V2: Record<string, ParserV2> = {
  claude: parseClaudeSessionV2,
};

// v7: llm_call_count deduplicated by message.id (was raw assistant-frame count,
//     which inflated the number ~2-3x since Claude Code writes one JSONL frame
//     per content block) — fixes the false "N calls lack proxy tracking" badge.
// v8: splitUserContextReminder 改按 CC 固定引导语前缀签名识别(替代硬锁 #claudeMd/#userEmail/
//     #currentDate 三锚点),缺 CLAUDE.md / 缺 #userEmail 不再 bail,有哪段切哪段;常见情形仍是
//     prefix/项目指令/记忆/账号/suffix 五段(逐字节不变)。
// v9: wrapper.prefix/suffix 去掉 rawOnly —— 壳成为普通可见 leaf(进桶/可筛/可点),不再特化隐藏;
//     前端用一道画在 padding 槽的主题 rail 把整组框在一起(纯样式)。
// v10: userContext reminder 切分加位置 gate —— 仅 messages[0] 起始整块(charRange.start===0)才切;
//      会话正文里引用 <system-reminder> 的 prose/代码(offset>0 或 messages[>0])不再被误切成信封。
export const PARSER_VERSION = 10;
