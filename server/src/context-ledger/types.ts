// PR8 精简后的 types.ts：只暴露新链路（rule-registry + context-rule-registry +
// parser/attribution）需要的最小类型集合。
//
// 历史背景：原 types.ts ~700 行，承载旧 reconcile/audit 体系的所有类型
// （ContextSegment / ProxySegmentAttribution / ExpectedQueryContext /
// ReconciliationFinding 等）。这些类型只服务于已归档的代码路径，本 PR 将完整
// 副本移至 _archive/types-legacy.ts；如需查阅历史口径，请直接读归档文件
// 或翻 git history。

/**
 * SegmentCategory：rule 命中后描述的 segment 大类。新链路保留这套分类
 * （前端按 category 着色，rule-evaluator 把 rule.attribution.category 透传给
 * SegmentAttribution）；其余旧字段未迁移过来。
 */
export type SegmentCategory =
  | "user_message"
  | "assistant_text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "system_prompt"
  | "tools_schema"
  | "billing_noise"
  | "harness_injection"
  | "ide_injection"
  | "memory_injection"
  | "user_image"
  | "user_image_placeholder"
  | "skill_listing"
  | "local_command_history"
  | "slash_command"
  | "system_local_command"
  | "prior_session_history"
  | "permission"
  | "hook_event"
  | "compaction"
  | "attachment"
  | "unknown";

/**
 * Confidence：rule / jsonl 命中的信心级别。
 *   - definitive：原子精确匹配（exact / wire id / 内容相等）
 *   - estimated：内容近似匹配（regex 全段命中 / substring）
 *   - inferred：仅按位置或类型回退
 *   - unknown：未命中或不适用
 */
export type Confidence = "definitive" | "estimated" | "inferred" | "unknown";

/**
 * RuleMechanism：rule.attribution.mechanism 取值集合。PR4 起从旧
 * ProxySegmentAttribution["mechanism"] 提升为独立类型；旧名仅保留在归档。
 */
export type RuleMechanism =
  | "tool_use_id_match"
  | "system_prompt_pattern"
  | "tools_schema_pattern"
  | "billing_noise_pattern"
  | "system_reminder_pattern"
  | "local_command_pattern"
  | "large_segment_detector"
  | "cache_hint_detector"
  | "task_reminder_smoosh"
  | "smoosh_content_match"
  | "messages_content_block_pattern"
  | "session_recap_prompt"
  | "manual_fixture"
  | "unknown";
