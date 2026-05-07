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
 * 不变量：
 *   rawChars     = matchedChars + unmatchedChars
 *   matchedChars = staticChars  + dynamicChars
 *
 * rawChars        节点 rawText 总字符数（外部输入）
 * matchedChars    rule 或 wire fallback 命中的字符数（外部输入）
 * dynamicChars    regex 命名捕获组解释的动态字符数（外部输入）
 * staticChars     派生：matchedChars - dynamicChars，覆盖 exact 文本与 regex 静态片段
 * unmatchedChars  派生：rawChars - matchedChars，未被 rule 声称解释的尾部字符
 */
export interface CharCoverage {
  rawChars: number;
  matchedChars: number;
  staticChars: number;
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
 * staticChars 合并了原 exactChars + templateLiteralChars 两个桶——
 * matchMode=exact 与 matchMode=regex 路径的静态字符在覆盖率上同质，
 * 不再为 audit 单独区分两者。
 */
export interface AttributionCoverage {
  totalNodes: number;
  totalChars: number;

  /** matchMode=exact 与 regex 路径合并后的静态字符（rule 文本可解释的部分）。 */
  staticChars: number;
  /** regex 命名捕获组覆盖的动态字段字符。 */
  dynamicCapturedChars: number;
  /** 已识别 slot/rule，但不可作为 static/dynamic 证据的字符。 */
  recognizedUnexplainedChars: number;
  /** 完全 rule_gap 的字符。 */
  ruleGapChars: number;

  /** 页头摘要：rule_gap 节点数与字符数。 */
  ruleGap: { nodes: number; chars: number };

  /** (totalChars - ruleGapChars) / totalChars */
  recognitionRatio: number;
  /** (staticChars + dynamicCapturedChars) / totalChars */
  evidenceBackedRatio: number;
}
