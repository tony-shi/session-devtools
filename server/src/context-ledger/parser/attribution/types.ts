// parser/attribution/types：attribution 子系统的全部公共类型。
//
// 模块职责：
//   - 此文件不包含运行时逻辑，只承载类型定义。
//   - rule-evaluator.ts 写入 RuleHit；evidence.ts 读 RuleHit 写 RuleMatchEvidence；
//     resolver.ts 把两者拼成 SegmentAttribution；coverage.ts 用 SegmentAttribution
//     的 evidence 桶计算覆盖率。
//   - 接入旧调用方时只需 re-export，不暴露子模块的内部 helpers。
//
// 命名约定：
//   - RuleHit 描述"是否命中 + 命中位置"，是 rule-evaluator 的输出层。
//   - RuleMatchEvidence 描述"命中后的字符级证据"，是 evidence 层的输出。
//   - SegmentAttribution 是 attribution 子系统对外的归因记录。
//   - AttributionCoverage 是字符级 evidence 的统计口径。

import type { Confidence, SegmentCategory } from "../../types";

// ── RuleHit：rule-evaluator 层输出 ────────────────────────────────────────────

export type RuleHitMode = "exact" | "regex" | "prefix" | "contains";

/** 命中区间在 rawText 中的位置（左闭右开）。 */
export interface CharRange {
  start: number;
  end: number;
}

/**
 * RuleHit：单个 AST node 在 rule 集合上的命中结果。
 *
 * 不解释来源、不算 confidence、不区分 fallback——纯粹是 matcher 的事实层。
 *
 * 字段语义：
 *   nodeId / slotId   节点身份回填，便于 resolver 直接出 SegmentAttribution
 *   ruleId            命中的 ContextRule.id
 *   mode              来自 ContextRule.attribution.matchMode
 *   matchedRange      regex/exact 命中区间；prefix/contains 锚点视作 [0, anchor.length)
 *   matchedChars      命中区间长度（含锚点 / regex 整段 / exact 全文）
 *   groups / groupIndices  regex 命名捕获组的值与偏移；非 regex 时为 undefined
 */
export interface RuleHit {
  nodeId: string;
  slotId: string;
  ruleId: string;
  mode: RuleHitMode;
  matchedRange: CharRange;
  matchedChars: number;
  groups?: Record<string, string | undefined>;
  groupIndices?: Record<string, CharRange | undefined>;
}

// ── Evidence 层：rule-evaluator → evidence 后产出的字符级证据 ──────────────────

/**
 * RuleMatchEvidence：rule 命中后的字符级证据，是 SegmentAttribution 的核心字段。
 *
 * mode 决定证据精度：
 *   exact          字符串 ===，rawChars === matchedChars，全部进入 literalChars
 *   template       rule.materialization=exact_text 的 regex 命中（整段视作模板）
 *   regex          regex + 命名捕获组：literalChars=模板，dynamicChars=占位符
 *   prefix         pattern.startsWith(...) 命中：仅 pattern 长度算 anchor
 *   contains       锚点存在；与 prefix 同算法
 *   wire_schema    由 wire schema 判定（tool_use/tool_result）
 *   rule_gap       没有任何 rule 命中
 *
 * 字符桶语义（评分口径）：
 *   rawChars        rawText.length
 *   matchedChars    rule 命中区间字符数
 *   literalChars    rule 静态模板覆盖
 *   dynamicChars    regex 命名捕获组覆盖
 *   unmatchedChars  rawChars - matchedChars
 */
export type EvidenceMode =
  | "exact"
  | "template"
  | "regex"
  | "prefix"
  | "contains"
  | "wire_schema"
  | "rule_gap";

export interface RuleMatchEvidence {
  mode: EvidenceMode;
  rawChars: number;
  /**
   * rule "期望"覆盖的字符数。提供给 audit 对比 rule 应当解释多少 vs 实际命中多少。
   *   exact         expectedChars === rawChars（pattern 等于全文）
   *   template      expectedChars === matchedChars
   *   regex         expectedChars === literalChars + dynamicChars（≡ matchedChars）
   *   prefix/contains  expectedChars === pattern.length（仅锚点；可能 < rawChars）
   *   wire_schema   expectedChars === rawChars
   *   rule_gap      undefined（rule 不存在，无"期望"可言）
   * 当 expectedChars < rawChars 时，差额表示 rule 没有解释的字符。
   */
  expectedChars?: number;
  matchedChars: number;
  literalChars: number;
  dynamicChars: number;
  unmatchedChars: number;
  /** matchedRatio = matchedChars / rawChars；rawChars=0 时为 0 */
  matchedRatio: number;
  /** literalRatio = literalChars / rawChars */
  literalRatio: number;
  /** dynamicRatio = dynamicChars / rawChars */
  dynamicRatio: number;
  matchedRange?: CharRange;
}

/**
 * DynamicField：regex 命名捕获组的解释。
 *
 * source 暗示动态字段的来源（用于 audit 时区分 env 漂移 / runtime 注入 / memory 同步问题）：
 *   env       — 环境/进程级（cwd / platform / shell / model 等）
 *   memory    — memory_fs 注入（memoryDir / memory 字段）
 *   runtime   — 每次请求都可能变化（version fingerprint / cch / branch / gitUser）
 *   user      — 用户提供的内容（暂未使用，预留）
 *   unknown   — 不在已知映射内，需要在 rule.captureGroups 里补充语义
 */
export type DynamicFieldSource = "env" | "memory" | "runtime" | "user" | "unknown";

export interface DynamicField {
  name: string;
  valuePreview: string;
  charStart: number;
  charEnd: number;
  charCount: number;
  source: DynamicFieldSource;
}

/**
 * MaterializationEvidence：该 rule 是否能让 expected 侧"物质化"出此段内容。
 *
 *   exact_text       contentPattern 字面，可 100% 字节重建（rawHash 应当一致）
 *   normalized_text  静态模板 + 动态字段可解释，但字节重建不保证（如 billing 的 fingerprint）
 *   shape            只能复现结构/轮廓，文本内容不可预测
 *   presence         只能确认"有这段"，内容由动态运行时决定
 *   wire_schema      由 wire schema 直接确定（tool_use/tool_result 的 jsonl 拷贝路径）
 *   unavailable      尚未提供任何 materialization 证据（rule_gap / unmatched）
 */
export type MaterializationKind =
  | "exact_text"
  | "normalized_text"
  | "shape"
  | "presence"
  | "wire_schema"
  | "unavailable";

export interface MaterializationEvidence {
  kind: MaterializationKind;
  canReconstructBytes: boolean;
  reason?: string;
}

// ── SegmentAttribution：对外 attribution 记录 ────────────────────────────────

export interface SegmentAttribution {
  nodeId: string;
  slotId: string;
  category: SegmentCategory;
  mechanism: string;
  classificationConfidence: Confidence;
  materializationConfidence: Confidence;
  /** char 级 rule 命中证据（替代仅有 confidence badge 的"标签层"） */
  match: RuleMatchEvidence;
  /** rule 的 materialization 语义；rule_gap / unmatched 时给 unavailable */
  materialization: MaterializationEvidence;
  /** regex 命名捕获组：动态字段值 + 在 rawText 内的偏移 */
  dynamicFields?: DynamicField[];
  ruleId?: string;
  notes?: string[];
}

// ── AttributionCoverage：字符级 evidence 桶 ──────────────────────────────────

/**
 * AttributionCoverage：基于 RuleMatchEvidence 的字符级桶统计。
 *
 * 桶选择规则（按 evidence.mode 而非 confidence）：
 *   exact / wire_schema    → exactChars
 *   template               → templateLiteralChars（整段视为可重建模板）
 *   regex                  → literalChars 进 templateLiteralChars，dynamicChars 进 dynamicCapturedChars，
 *                            unmatched 进 recognizedUnexplainedChars
 *   prefix / contains      → matchedChars + unmatched 都进 recognizedUnexplainedChars（仅识别 slot）
 *   rule_gap               → rawChars 全部进 ruleGapChars
 */
export interface AttributionCoverage {
  totalNodes: number;
  totalChars: number;

  /** exact matchMode 命中或 wire_schema 精确路径：可 100% 字节重建 */
  exactChars: number;
  /** regex 命中中静态 literal 部分：可解释结构、可拼回模板 */
  templateLiteralChars: number;
  /** regex 命名捕获组覆盖：动态字段已显式解释 */
  dynamicCapturedChars: number;
  /** prefix/contains/wire fallback：识别到 category 但内容不可解释 */
  recognizedUnexplainedChars: number;
  /** 完全 rule_gap：未识别 */
  ruleGapChars: number;

  /** 兼容 proxy-attribution-view 的页头摘要：以"rule_gap chars 占比"显示 */
  ruleGap: { nodes: number; chars: number };

  /** (totalChars - ruleGapChars) / totalChars */
  recognitionRatio: number;
  /** (exactChars + templateLiteralChars + dynamicCapturedChars) / totalChars */
  evidenceBackedRatio: number;
  /** exactChars / totalChars */
  byteReconstructableRatio: number;
}
