// parser/attribution/evidence：RuleHit + node + rule → 字符级证据。
//
// 模块职责（证据层）：
//   - 把 rule-matcher 的 RuleHit 转为 char 桶（literal/dynamic/unmatched）+ DynamicField[]。
//   - 把 ContextRule.materialization 转为 MaterializationEvidence。
//   - 不写 confidence、不做 fallback、不读 verifiedFor——那是 resolver 的职责。
//
// 字符桶分配规则：
//   exact      整段进 literalChars
//   template   rule.materialization=exact_text 且 regex 命中：整段视作模板，dynamicChars=0
//   regex      literalChars = matchedChars - sum(captureGroup chars)
//   prefix     pattern 长度进 literalChars，剩余 unmatched
//   contains   同 prefix
//   wire_schema 整段进 literalChars
//   rule_gap   全部进 unmatchedChars

import type { ContextRule, ContextRuleMaterialization } from "../../rules/context-rule-registry";
import type { SegmentNode } from "../types";
import type {
  DynamicField,
  DynamicFieldSource,
  EvidenceMode,
  MaterializationEvidence,
  MaterializationKind,
  RuleHit,
  RuleMatchEvidence,
} from "./types";

// ── 动态字段来源推断 ─────────────────────────────────────────────────────────

/**
 * inferCaptureSource：从捕获组名字推测来源。
 * 这是一个保守启发，准确语义由 rule.attribution.captureGroups 文档化。
 */
export function inferCaptureSource(name: string): DynamicFieldSource {
  if (/cwd|platform|shell|osVersion|model|cutoff|gitUser|branch/i.test(name)) return "env";
  if (/memory|memoryDir/i.test(name)) return "memory";
  if (/version|entrypoint|cch|workload|fingerprint|sessionId|userId/i.test(name)) return "runtime";
  return "unknown";
}

// ── DynamicField 构造 ────────────────────────────────────────────────────────

/**
 * buildDynamicFields：从 RuleHit 的命名捕获组解释动态字段。
 * 没有捕获组时返回 undefined（不返回空数组，避免下游做空判断）。
 */
export function buildDynamicFields(hit: RuleHit): DynamicField[] | undefined {
  if (hit.mode !== "regex" || !hit.groups) return undefined;
  const fields: DynamicField[] = [];
  for (const [name, value] of Object.entries(hit.groups)) {
    if (value === undefined) continue;
    const range = hit.groupIndices?.[name];
    const charStart = range?.start ?? -1;
    const charEnd = range?.end ?? (charStart >= 0 ? charStart + value.length : -1);
    const charCount = charStart >= 0 && charEnd >= charStart ? charEnd - charStart : value.length;
    fields.push({
      name,
      valuePreview: value.length > 120 ? value.slice(0, 117) + "…" : value,
      charStart: charStart >= 0 ? charStart : 0,
      charEnd: charEnd >= 0 ? charEnd : 0,
      charCount,
      source: inferCaptureSource(name),
    });
  }
  return fields.length > 0 ? fields : undefined;
}

// ── 字符比例计算 ────────────────────────────────────────────────────────────

interface CharBuckets {
  matchedChars: number;
  literalChars: number;
  dynamicChars: number;
  unmatchedChars: number;
}

function ratiosOf(rawChars: number, b: CharBuckets) {
  if (rawChars <= 0) return { matchedRatio: 0, literalRatio: 0, dynamicRatio: 0 };
  return {
    matchedRatio: b.matchedChars / rawChars,
    literalRatio: b.literalChars / rawChars,
    dynamicRatio: b.dynamicChars / rawChars,
  };
}

// ── evidence 构造 ────────────────────────────────────────────────────────────

/**
 * buildMatchEvidence：把 RuleHit + ContextRule + node.rawText 转为字符级证据。
 *
 * mode 推导：
 *   exact / prefix / contains   直接对应 hit.mode
 *   regex + materialization=exact_text  → "template"（整段视作可重建模板）
 *   regex + 其它 materialization        → "regex"
 */
export function buildMatchEvidence(
  node: SegmentNode,
  rule: ContextRule,
  hit: RuleHit,
): RuleMatchEvidence {
  const rawChars = node.rawText.length;

  if (hit.mode === "exact") {
    const buckets: CharBuckets = {
      matchedChars: rawChars,
      literalChars: rawChars,
      dynamicChars: 0,
      unmatchedChars: 0,
    };
    return {
      mode: "exact",
      rawChars,
      expectedChars: rawChars,
      ...buckets,
      ...ratiosOf(rawChars, buckets),
      ...(rawChars > 0 ? { matchedRange: { start: 0, end: rawChars } } : {}),
    };
  }

  if (hit.mode === "regex") {
    // dynamicChars = sum(命名捕获组覆盖)
    const dynamicChars = (() => {
      if (!hit.groups) return 0;
      let total = 0;
      for (const [name, value] of Object.entries(hit.groups)) {
        if (value === undefined) continue;
        const range = hit.groupIndices?.[name];
        if (range) {
          total += range.end - range.start;
        } else {
          total += value.length;
        }
      }
      return total;
    })();

    // exact_text materialization 把整段 regex 命中视作"模板满覆盖"
    const isTemplate = rule.materialization === "exact_text";
    const mode: EvidenceMode = isTemplate ? "template" : "regex";

    const matchedChars = hit.matchedChars;
    const literalChars = isTemplate ? matchedChars : Math.max(0, matchedChars - dynamicChars);
    const dynamicCharsOut = isTemplate ? 0 : dynamicChars;

    const buckets: CharBuckets = {
      matchedChars,
      literalChars,
      dynamicChars: dynamicCharsOut,
      unmatchedChars: Math.max(0, rawChars - matchedChars),
    };
    return {
      mode,
      rawChars,
      // regex/template：rule 期望的就是 matchedChars（命中区间的 literal+dynamic）。
      expectedChars: matchedChars,
      ...buckets,
      ...ratiosOf(rawChars, buckets),
      matchedRange: hit.matchedRange,
    };
  }

  // prefix / contains：anchor 进 literal，剩余 unmatched。
  // expectedChars=锚点长度——"rule 只声称这个锚点存在"，可能 < rawChars。
  const anchor = Math.max(0, Math.min(hit.matchedChars, rawChars));
  const buckets: CharBuckets = {
    matchedChars: anchor,
    literalChars: anchor,
    dynamicChars: 0,
    unmatchedChars: Math.max(0, rawChars - anchor),
  };
  return {
    mode: hit.mode,
    rawChars,
    expectedChars: anchor,
    ...buckets,
    ...ratiosOf(rawChars, buckets),
  };
}

/** wire_schema：tool_use/tool_result 等 wire 路径整段视作 literal 满覆盖。 */
export function buildWireSchemaEvidence(node: SegmentNode): RuleMatchEvidence {
  const rawChars = node.rawText.length;
  const buckets: CharBuckets = {
    matchedChars: rawChars,
    literalChars: rawChars,
    dynamicChars: 0,
    unmatchedChars: 0,
  };
  return {
    mode: "wire_schema",
    rawChars,
    expectedChars: rawChars,
    ...buckets,
    ...ratiosOf(rawChars, buckets),
  };
}

/** rule_gap：完全无 rule 命中，rawChars 全部计入 unmatchedChars。 */
export function buildRuleGapEvidence(node: SegmentNode): RuleMatchEvidence {
  const rawChars = node.rawText.length;
  return {
    mode: "rule_gap",
    rawChars,
    matchedChars: 0,
    literalChars: 0,
    dynamicChars: 0,
    unmatchedChars: rawChars,
    matchedRatio: 0,
    literalRatio: 0,
    dynamicRatio: 0,
  };
}

// ── MaterializationEvidence 构造 ────────────────────────────────────────────

const MATERIALIZATION_REASON: Record<MaterializationKind, string> = {
  exact_text: "rule.contentPattern 为字面文本，可逐字节重建",
  normalized_text: "静态模板 + 动态字段可解释，但字节级重建不保证（动态值由 runtime 决定）",
  shape: "只能复现结构/轮廓，rule 不承诺文本内容",
  presence: "只能确认这段存在，内容由 runtime 决定",
  wire_schema: "由 wire schema 直接确定（jsonl 原样拷贝路径）",
  unavailable: "无 rule 命中或无 materialization 证据",
};

/**
 * materializationFromRule：rule.materialization 是权威信号；缺失时按 hit.mode 兜底。
 */
export function materializationFromRule(
  rule: ContextRule,
  hit: RuleHit,
): MaterializationEvidence {
  const declared: ContextRuleMaterialization | undefined = rule.materialization;

  if (declared) {
    // legacy 的 "unavailable" 直接透传
    return {
      kind: declared,
      canReconstructBytes: declared === "exact_text",
      reason: MATERIALIZATION_REASON[declared],
    };
  }

  if (hit.mode === "exact") {
    return { kind: "exact_text", canReconstructBytes: true, reason: MATERIALIZATION_REASON.exact_text };
  }
  if (hit.mode === "regex") {
    return { kind: "normalized_text", canReconstructBytes: false, reason: MATERIALIZATION_REASON.normalized_text };
  }
  return { kind: "presence", canReconstructBytes: false, reason: MATERIALIZATION_REASON.presence };
}

export const WIRE_SCHEMA_MATERIALIZATION: MaterializationEvidence = {
  kind: "wire_schema",
  canReconstructBytes: true,
  reason: MATERIALIZATION_REASON.wire_schema,
};

export const SHAPE_MATERIALIZATION: MaterializationEvidence = {
  kind: "shape",
  canReconstructBytes: false,
  reason: MATERIALIZATION_REASON.shape,
};

export const RULE_GAP_MATERIALIZATION: MaterializationEvidence = {
  kind: "unavailable",
  canReconstructBytes: false,
  reason: MATERIALIZATION_REASON.unavailable,
};
