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
// v11: Bash tool 规则 pattern 改 JSON 形态(匹整个 tool JSON node.rawText,非 description 主体)——
//      修复 tool 规则因 pattern 锚 description 而永不命中、全退 wire 的问题;Bash 提交署名模型名
//      现作为 dynamicField 露出(≥2.1.158),前端自动标动态。其余 tool 规则仍 description 形态(待扫)。
// v12: 新增 global-instructions 规则 —— 全局/用户级 ~/.claude/CLAUDE.md(desc "user's private global
//      instructions…") 不再 RULE_GAP 裸 slug,独立命中、显示「全局指令」;同 project-instructions slot、
//      靠 desc 区分。对真实 2.1.160 session(820f368b) 验证。
// v13: system 区静态段坍缩 —— ast-builder.collapseStaticSections 把相邻纯静态 H1 section(开场/
//      Harness/会话守则/上下文管理/语气/工具/...)合并成单一 prompt-body 壳(新壳 rule),动态段
//      (环境/记忆/Git)仍独立结构化。判据=corpus stability:dynamic 保留。退役式简化,跨版本免维护。
// v14: 新增 local-instructions 规则 —— 项目本地 CLAUDE.local.md(desc "user's private project
//      instructions, not checked in") 不再 STRUCTURAL 裸 slug,独立命中、显示「本地指令」;同
//      project-instructions slot、靠 desc 区分(与 global/project 三者 pattern 互斥)。
//      对真实 2.1.158 session(31b1334b T1C1) 验证。
export const PARSER_VERSION = 14;
