// Context Ledger Rule Registry
//
// 每条 rule 描述三个视角的语义：
//   attribution   — 如何从 proxy segment 识别它是什么（pattern / location）
//   reconstruction — 如何在 expected context 里正向生成它（trigger / materialization）
//   reconciliation — 如何在对账时比较 proxy 与 expected（comparePolicy / confidence）
//
// 当前只收录一条人工审核确认的 rule：
//   claude-code.system-prompt-identity.v1
//
// ruleVersion = "2.1.123" 是人工审核版本占位，表示"基于 Claude Code 2.1.x 系列审核"，
// 不是严格最小兼容版本声明。
//
// 新增 rule 必须经过：sourcemap grep → proxy 样本确认 → PR 人工 review → 入 registry。
// proxy diff 只能产生 candidate，不能自动写入 registry。

import type {
  Confidence,
  SegmentCategory,
  SegmentFlag,
  SegmentLifecycle,
  SegmentRole,
  SegmentSection,
} from "./types";
import type { ProxySegmentAttribution } from "./types";

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export type RuleStability = "static" | "semi-static" | "dynamic";

export type RuleMatchMode = "exact" | "prefix" | "contains" | "structural";

// materialization：reconstruction 层能否复现该 segment 的文本内容。
//   exact_text     — 文本固定，可完整复现（如 identity prefix）
//   normalized_text — 文本有微小变体，可规范化后复现
//   shape          — 只能复现结构/轮廓，不能复现完整文本
//   presence       — 只能确认"有这段"，内容不可预测（如 billing header 含 fingerprint）
//   unavailable    — 无法从 JSONL/harness 推断任何内容
export type RuleMaterialization =
  | "exact_text"
  | "normalized_text"
  | "shape"
  | "presence"
  | "unavailable";

// comparePolicy：reconciliation 对账时的比较策略。
//   raw_hash       — 精确哈希比对，要求内容完全一致
//   normalized_hash — 规范化后哈希比对
//   char_diff      — 字符级 diff，允许内容存在，量化偏差
//   structural     — 只比较结构特征（section/category/role）
//   presence_only  — 只检查是否存在，不比较内容（适合动态注入内容）
//   known_noise    — 已知噪声，不计入 coverage 分子
export type RuleComparePolicy =
  | "raw_hash"
  | "normalized_hash"
  | "char_diff"
  | "structural"
  | "presence_only"
  | "known_noise";

// 位置约束：描述 rule 在 proxy rawBody 里的语义位置。
//   section / category / role：segment 维度约束
//   segmentPosition：在 segment 文本内的位置语义
//     segment_start  — 必须是 segment 文本的起始（trimStart 后 startsWith）
//     first_paragraph — 必须是第一段落
//     anywhere       — 文本中任意位置（contains）
//   jsonPathHint / orderHint：仅供人工审核参考，不参与运行时硬约束
export interface RuleLocationConstraint {
  section?: SegmentSection;
  category?: SegmentCategory;
  role?: SegmentRole;
  segmentPosition?: "segment_start" | "first_paragraph" | "anywhere";
  jsonPathHint?: string;
  orderHint?: number;
}

export interface ContextLedgerRule {
  ruleId: string;
  ruleVersion: string;
  description: string;
  stability: RuleStability;
  sourcemapRef?: string;

  // attribution：proxy → 识别视角
  attribution?: {
    pattern: string | null;
    matchMode: RuleMatchMode;
    location?: RuleLocationConstraint;
    mechanism: ProxySegmentAttribution["mechanism"];
    category: SegmentCategory;
  };

  // reconstruction：mutation/harness → 构建 expected 视角
  reconstruction?: {
    // always_per_query — harness 每次请求无条件注入（不依赖 JSONL mutation）
    // from_jsonl       — 从 JSONL mutation 流派生
    // from_memory      — 从 memory_fs 读取
    // from_harness_state — 从 harness 运行时状态（env/config）派生
    trigger: "always_per_query" | "from_jsonl" | "from_memory" | "from_harness_state";
    materialization: RuleMaterialization;
    emits: {
      section: SegmentSection;
      category: SegmentCategory;
      lifecycle?: SegmentLifecycle;
      flags?: SegmentFlag[];
      // contentPattern：内容可复现时的完整文本；presence/unavailable 时为 null
      contentPattern?: string | null;
    };
  };

  // reconciliation：对账视角
  reconciliation?: {
    comparePolicy: RuleComparePolicy;
    confidence: Confidence;
    // exactTextExpected：reconciliation 是否期望 proxy 与 expected 文本完全一致
    exactTextExpected: boolean;
  };
}

// ── 首批已人工确认的 rule ──────────────────────────────────────────────────────

// sourcemap 确认（restored-src/src/constants/system.ts）：
//   DEFAULT_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`
//   通过 CLI_SYSPROMPT_PREFIXES Set.has() 精确匹配，无动态变量，无尾部换行。
//   harness 在 buildSystemPrompt 里将其作为独立 block 写入 system[]，
//   在 billing header（若存在）之后紧接出现。
//
// attribution 视角：
//   - pattern 与 sourcemap DEFAULT_PREFIX 字面量完全一致（含句号，无换行）
//   - segmentPosition = segment_start：整个 57-char block 就是这一句话
//   - 职责边界：识别"这段 system content 是 Claude Code identity block"，
//     不归因整段 system prompt 的完整内容来源
//
// reconstruction 视角：
//   - trigger = always_per_query：harness 每次请求都注入，不依赖 JSONL
//   - materialization = exact_text：内容固定，可完整复现
//   - 注入的 segment 本身只有 57 chars，不代表整段 system prompt
//
// reconciliation 视角：
//   - comparePolicy = char_diff：proxy 里这段是 57 chars，expected 也是 57 chars，
//     精确可比；用 char_diff 而非 raw_hash 是因为 expected 段是由 rule 构造的，
//     不是从 JSONL 读出的原始字节，hash 对齐成本高
//   - exactTextExpected = true：内容静态，proxy 与 expected 应完全一致
export const CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE: ContextLedgerRule = {
  ruleId: "claude-code.system-prompt-identity.v1",
  ruleVersion: "2.1.123",
  description:
    "Claude Code system prompt 的固定身份标识行（57 chars）。" +
    "仅用于 attribution 识别锚点与 reconstruction 注入，不归因整段 system prompt 内容来源。",
  stability: "static",
  sourcemapRef: "restored-src/src/constants/system.ts",

  attribution: {
    // 严格精确匹配，含句号，无尾部换行；对应 sourcemap DEFAULT_PREFIX
    pattern: "You are Claude Code, Anthropic's official CLI for Claude.",
    matchMode: "exact",
    mechanism: "system_prompt_pattern",
    category: "system_prompt",
    location: {
      section: "system",
      // segment_start：整个 block 就是这句话（或以这句话开头的更长文本）
      segmentPosition: "segment_start",
      // jsonPathHint / orderHint 仅供人工审核参考
      jsonPathHint: "reqBody.system[*]",
      // billing header 存在时 orderHint=1，不存在时 orderHint=0；
      // 运行时用 segmentPosition 匹配，不依赖硬索引
      orderHint: 1,
    },
  },

  reconstruction: {
    trigger: "always_per_query",
    materialization: "exact_text",
    emits: {
      section: "system",
      category: "system_prompt",
      lifecycle: "session",
      contentPattern: "You are Claude Code, Anthropic's official CLI for Claude.",
    },
  },

  reconciliation: {
    comparePolicy: "char_diff",
    confidence: "exact",
    exactTextExpected: true,
  },
};

// ── Registry 导出 ────────────────────────────────────────────────────────────

export const CONTEXT_LEDGER_RULES: ContextLedgerRule[] = [
  CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE,
];

export const CONTEXT_LEDGER_RULE_BY_ID: ReadonlyMap<string, ContextLedgerRule> = new Map(
  CONTEXT_LEDGER_RULES.map((rule) => [rule.ruleId, rule]),
);

export function getContextLedgerRule(ruleId: string): ContextLedgerRule | undefined {
  return CONTEXT_LEDGER_RULE_BY_ID.get(ruleId);
}

// ── 兼容旧导出（过渡期，待下一阶段清理） ────────────────────────────────────────
// proxy-attribution.ts 等使用旧名称的代码在本次一并迁移；
// 若仍有外部引用，此处保留临时别名避免编译中断。
/** @deprecated 使用 ContextLedgerRule */
export type AttributionRule = ContextLedgerRule;
/** @deprecated 使用 CONTEXT_LEDGER_RULES */
export const ATTRIBUTION_RULES = CONTEXT_LEDGER_RULES;
/** @deprecated 使用 CONTEXT_LEDGER_RULE_BY_ID */
export const ATTRIBUTION_RULE_BY_ID = CONTEXT_LEDGER_RULE_BY_ID;
/** @deprecated 使用 getContextLedgerRule */
export const getAttributionRule = getContextLedgerRule;
