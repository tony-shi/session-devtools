// parser/attribution/types：AST attribution 子系统的公共产物类型。
//
// 设计口径：
//   - 每个 SegmentNode 最终只产生一条 SegmentAttribution。
//   - 字符解释统一放进 CharCoverage，不再拆多层命中/证据/物质化包装。
//   - reconstructable 是 rule materialization 的布尔派生；audit 层按需展示，
//     不再维护额外的物质化证据对象。

import type { Confidence, SegmentCategory } from "../../types";

/** 命中区间在 rawText 中的位置（左闭右开）。 */
export interface CharRange {
  start: number;
  end: number;
}

/**
 * SegmentAttribution.matchMode：最终归因使用的命中口径。
 *
 * wire_schema fallback 不是 matchMode，而是 mechanism；该路径使用 matchMode=exact。
 * rule_gap 表示没有任何 rule 或 wire fallback 能解释该节点。
 */
export type AttributionMatchMode = "exact" | "regex" | "prefix" | "rule_gap";

/**
 * CharCoverage：单节点字符级解释桶。
 *
 * rawChars        节点 rawText 总字符数
 * matchedChars    rule 或 wire fallback 命中的字符数
 * literalChars    静态规则文本解释的字符数
 * dynamicChars    regex 命名捕获组解释的动态字符数
 * unmatchedChars  rawChars - matchedChars，或未被 rule 声称解释的尾部字符
 */
export interface CharCoverage {
  rawChars: number;
  matchedChars: number;
  literalChars: number;
  dynamicChars: number;
  unmatchedChars: number;
}

// ── regex 动态字段 ───────────────────────────────────────────────────────────

/**
 * DynamicField.source 是保守启发，准确语义仍由 rule.attribution.captureGroups 文档化。
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

// ── SegmentAttribution：对外 attribution 记录 ───────────────────────────────

export interface SegmentAttribution {
  nodeId: string;
  slotId: string;
  category: SegmentCategory;
  mechanism: string;
  /** 命中的 context rule；wire_schema / rule_gap 路径没有 ruleId。 */
  ruleId?: string;
  matchMode: AttributionMatchMode;
  matchedRange?: CharRange;
  charCoverage: CharCoverage;
  /** regex 命名捕获组的值与 rawText 偏移。 */
  dynamicFields?: DynamicField[];
  /** 能否按当前 rule/fallback 逐字节重建该节点。 */
  reconstructable: boolean;
  /** 单一置信度，表达分类识别本身的确信度。 */
  confidence: Confidence;
}

// ── AttributionCoverage：字符级桶统计 ───────────────────────────────────────

/**
 * AttributionCoverage：基于 SegmentAttribution.charCoverage 的字符级桶统计。
 *
 * 字段名保持不变，避免影响 audit/view 下游。
 */
export interface AttributionCoverage {
  totalNodes: number;
  totalChars: number;

  /** matchMode=exact 且 reconstructable=true 的 literalChars。 */
  exactChars: number;
  /** regex 命中中的静态 literal 部分。 */
  templateLiteralChars: number;
  /** regex 命名捕获组覆盖的动态字段字符。 */
  dynamicCapturedChars: number;
  /** 已识别 slot/rule，但不可作为 exact/template/dynamic 证据的字符。 */
  recognizedUnexplainedChars: number;
  /** 完全 rule_gap 的字符。 */
  ruleGapChars: number;

  /** 兼容 proxy-attribution-view 的页头摘要：以 rule_gap chars 占比显示。 */
  ruleGap: { nodes: number; chars: number };

  /** (totalChars - ruleGapChars) / totalChars */
  recognitionRatio: number;
  /** (exactChars + templateLiteralChars + dynamicCapturedChars) / totalChars */
  evidenceBackedRatio: number;
  /** exactChars / totalChars */
  byteReconstructableRatio: number;
}
