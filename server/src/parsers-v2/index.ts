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

  // agent teams（实测 wf-review，2026-06-12）：teammate 会话每行带 teamName+agentName，
  // lead 会话只带 teamName。编排目录（config/任务板）cleanup 即删——行级字段是
  // 事后发现 team 成员的唯一强键。null = 非 team 会话。
  team_name: string | null;
  team_agent_name: string | null;

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
// v15: workflow 工件纳入 + notification 修正 —— countSubAgents 递归数
//      subagents/workflows/<runId>/ 下已完结 run 的 agent(与 drilldown subAgents 同口径,
//      superseded 转录不计);human_input_count 不再把 <task-notification> 回执
//      (origin.kind 确定性识别)当人类输入。对真实 2.1.167/2.1.170 session
//      (bd5d3dd7、3915787e) 验证。
// v16: agent teams 纳入 —— 提取行级 teamName/agentName 进 team_name/team_agent_name
//      两列(team 域分组键;编排目录 cleanup 即删,行级字段是唯一事后强键);
//      human_input_count 不再把入站 <teammate-message>(含 spawn prompt 行)当人类
//      输入(teamName 字段+内容前缀判别——该行无 origin.kind)。对真实 wf-review
//      四会话(2.1.170+)验证。
// v17: sub_agent_count 口径改为只数 Task 型 —— workflow agent 不再计入 sub-agent
//      数（drilldown subAgentCount / 各 turn subAgent 徽章 / meta sub_agent_count
//      三处统一排除 workflow，与 Workflows 域分离一致）；countSubAgents 不再递归数
//      subagents/workflows/<runId>/。发起 workflow 的 turn 改用独立 ⚙ workflow 徽章。
//      逆转 v15 的 countSubAgents 合并口径。
export const PARSER_VERSION = 17;
