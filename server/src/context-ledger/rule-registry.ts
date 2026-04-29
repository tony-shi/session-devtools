// Rule Registry：context-ledger attribution rule 的元数据与查找层。
// 仅收录人工审核确认过的 rule，不做自动推断、不写入 ContextMutation。
//
// 当前版本只包含一条已人工确认的 rule：
//   claude-code.system-prompt-identity.v1
//
// ruleVersion = "2.1.123" 是当前占位版本口径，表示"本 rule 基于对
// Claude Code 2.1.x 系列的人工审核"，不是严格的最小兼容版本声明。
// 后续如有版本锁定需求，需人工重新审核并更新。

import type { SegmentCategory } from "./types";
import type { ProxySegmentAttribution } from "./types";

export type RuleStability = "static" | "semi-static" | "dynamic";

// matchMode 对应 promptPattern 的匹配方式：
//   exact       — promptPattern 是完整固定字符串，严格相等，无动态变量
//   prefix      — promptPattern 是前缀，内容可有尾部动态部分
//   contains    — promptPattern 是子串
//   structural  — 无固定文本，依赖结构特征（如 section/role/字段存在性）
export type RuleMatchMode = "exact" | "prefix" | "contains" | "structural";

export interface AttributionRule {
  ruleId: string;
  // ruleVersion：当前为占位版本口径，见文件头注释
  ruleVersion: string;
  description: string;
  // promptPattern 为 null 表示该 rule 不依赖文本内容匹配（structural mode）
  promptPattern: string | null;
  matchMode: RuleMatchMode;
  stability: RuleStability;
  mechanism: ProxySegmentAttribution["mechanism"];
  category: SegmentCategory;
  // sourcemapRef：人工审核时对应的 claude-code-sourcemap 路径
  sourcemapRef?: string;
}

// ── 首批已人工确认的 rule ────────────────────────────────────────────────────

// 参考 restored-src/src/constants/system.ts:10（DEFAULT_PREFIX 定义）：
// Claude Code system prompt 以该固定字符串开头，人工在多次 proxy dump 中
// 确认稳定出现，matchMode = exact。
//
// 职责边界：本 rule 仅用于识别"这段 system 内容属于 Claude Code"，
// 不代表对整段 system prompt 内容来源的归因。
// 内容来源归因（charCount、完整文本）需独立的 system-prompt-full rule。
export const CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE: AttributionRule = {
  ruleId: "claude-code.system-prompt-identity.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt 的固定身份标识行，仅用于识别锚点，不归因整段内容来源。",
  // 严格精确匹配，无动态变量，无尾部换行
  promptPattern: "You are Claude Code, Anthropic's official CLI for Claude.",
  matchMode: "exact",
  stability: "static",
  mechanism: "system_prompt_pattern",
  category: "system_prompt",
  sourcemapRef: "restored-src/src/constants/system.ts",
};

// ── Registry 导出 ────────────────────────────────────────────────────────────

export const ATTRIBUTION_RULES: AttributionRule[] = [
  CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE,
];

export const ATTRIBUTION_RULE_BY_ID: ReadonlyMap<string, AttributionRule> = new Map(
  ATTRIBUTION_RULES.map((rule) => [rule.ruleId, rule]),
);

export function getAttributionRule(ruleId: string): AttributionRule | undefined {
  return ATTRIBUTION_RULE_BY_ID.get(ruleId);
}
