// parser/attribution/resolver：RuleHit / wire fallback / rule_gap → SegmentAttribution。
//
// 模块职责（语义层）：
//   - 把 rule-matcher 的 RuleHit + evidence 模块的字符级证据组合成对外的 SegmentAttribution。
//   - 推导 classification/materialization 双轨 confidence。
//   - 处理 verifiedFor 降级、wire_schema fallback、unknown/rule_gap。
//   - 渲染 notes（rule.attribution.notesTemplate）。

import type { Confidence } from "../../types";
import {
  CONTEXT_RULE_BY_ID,
  SUPPORTED_CLAUDE_CODE_VERSION,
} from "../../rules/context-rule-registry";
import type { ContextRule } from "../../rules/context-rule-registry";
import type { SegmentNode } from "../types";
import {
  RULE_GAP_MATERIALIZATION,
  SHAPE_MATERIALIZATION,
  WIRE_SCHEMA_MATERIALIZATION,
  buildDynamicFields,
  buildMatchEvidence,
  buildRuleGapEvidence,
  buildWireSchemaEvidence,
  materializationFromRule,
} from "./evidence";
import type { RuleHit, SegmentAttribution } from "./types";

// ── notes 渲染 ───────────────────────────────────────────────────────────────

function renderNotes(
  rule: ContextRule,
  groups: Record<string, string | undefined> | undefined,
): string[] | undefined {
  const templates = rule.attribution.notesTemplate;
  if (!templates?.length) return undefined;

  const notes = templates
    .map(({ format, requireGroup, absentGroup }) => {
      if (requireGroup && (!groups || !groups[requireGroup])) return null;
      if (absentGroup && groups?.[absentGroup]) return null;
      return format.replace(/\{(\w+)\}/g, (_, key: string) => groups?.[key] ?? "?");
    })
    .filter((note): note is string => note !== null && !note.endsWith("?"));

  return notes.length > 0 ? notes : undefined;
}

// ── confidence 推导 ─────────────────────────────────────────────────────────

interface ConfidenceInput {
  rule: ContextRule;
  hit: RuleHit;
  /** materialization.canReconstructBytes：用于决定 materializationConfidence 是否 exact */
  canReconstructBytes: boolean;
  materializationKind: string;
}

function deriveConfidence(input: ConfidenceInput): { classification: Confidence; materialization: Confidence } {
  const { rule, hit, canReconstructBytes, materializationKind } = input;
  const groups = hit.groups;
  const hasGroups = !!groups && Object.keys(groups).length > 0;
  const allGroupsFilled = hasGroups && Object.values(groups).every((value) => value !== undefined && value !== "");

  let classification: Confidence;
  let materialization: Confidence;

  if (hit.mode === "exact") {
    classification = "exact";
    materialization = canReconstructBytes ? "exact" : "estimated";
  } else if (hit.mode === "regex") {
    classification = allGroupsFilled ? "exact" : "estimated";
    if (materializationKind === "exact_text") {
      materialization = "exact";
    } else if (materializationKind === "normalized_text") {
      materialization = allGroupsFilled ? "estimated" : "inferred";
    } else {
      materialization = "inferred";
    }
  } else {
    // prefix / contains
    classification = "estimated";
    materialization = "inferred";
  }

  if (rule.attribution.confidenceOverride) {
    classification = rule.attribution.confidenceOverride;
    materialization = rule.attribution.confidenceOverride;
  }

  // 未校对 rule：confidence 强制降级（与升级前的 P3-5 策略一致）。
  if (rule.verifiedFor !== SUPPORTED_CLAUDE_CODE_VERSION) {
    classification = "inferred";
    materialization = "inferred";
  }

  return { classification, materialization };
}

// ── 主入口：RuleHit → SegmentAttribution ─────────────────────────────────────

/**
 * resolveFromHit：把 RuleHit 升级成 SegmentAttribution。
 *
 * rule 通过 hit.ruleId 从 CONTEXT_RULE_BY_ID 取回。如果 rule 在 registry 中查不到
 * （理论上不会，因 hit.ruleId 来自同一 registry），按 rule_gap 降级处理。
 */
export function resolveFromHit(node: SegmentNode, hit: RuleHit): SegmentAttribution {
  const rule = CONTEXT_RULE_BY_ID.get(hit.ruleId);
  if (!rule) {
    // 极小概率分支：保护性兜底，避免 attribution 发散。
    return ruleGap(node, `unknown ruleId in hit: ${hit.ruleId}`);
  }

  const evidence = buildMatchEvidence(node, rule, hit);
  const dynamicFields = buildDynamicFields(hit);
  const materialization = materializationFromRule(rule, hit);
  const { classification, materialization: matConf } = deriveConfidence({
    rule,
    hit,
    canReconstructBytes: materialization.canReconstructBytes,
    materializationKind: materialization.kind,
  });

  const notes = renderNotes(rule, hit.groups);

  return {
    nodeId: node.id,
    slotId: node.slotId,
    category: rule.attribution.category,
    mechanism: rule.attribution.mechanism,
    classificationConfidence: classification,
    materializationConfidence: matConf,
    match: evidence,
    materialization,
    ...(dynamicFields ? { dynamicFields } : {}),
    ruleId: rule.ruleId,
    ...(notes ? { notes } : {}),
  };
}

// ── wire-schema fallback ─────────────────────────────────────────────────────

export function wireFallback(node: SegmentNode): SegmentAttribution | null {
  if (node.slotId === "messages.tool_use") {
    return {
      nodeId: node.id,
      slotId: node.slotId,
      category: "tool_use",
      mechanism: "wire_schema",
      classificationConfidence: "exact",
      materializationConfidence: "exact",
      match: buildWireSchemaEvidence(node),
      materialization: WIRE_SCHEMA_MATERIALIZATION,
    };
  }

  if (node.slotId === "messages.tool_result") {
    return {
      nodeId: node.id,
      slotId: node.slotId,
      category: "tool_result",
      mechanism: "wire_schema",
      classificationConfidence: "exact",
      materializationConfidence: "exact",
      match: buildWireSchemaEvidence(node),
      materialization: WIRE_SCHEMA_MATERIALIZATION,
    };
  }

  if (node.slotId.startsWith("tools.builtin.")) {
    return {
      nodeId: node.id,
      slotId: node.slotId,
      category: "tools_schema",
      mechanism: "wire_schema",
      classificationConfidence: "exact",
      materializationConfidence: "inferred",
      match: buildWireSchemaEvidence(node),
      materialization: SHAPE_MATERIALIZATION,
      notes: ["tool schema slot recognized, but no context rule matched this tool description"],
    };
  }

  return null;
}

// ── rule_gap ────────────────────────────────────────────────────────────────

export function ruleGap(node: SegmentNode, reason: string): SegmentAttribution {
  return {
    nodeId: node.id,
    slotId: node.slotId,
    category: "unknown",
    mechanism: "rule_gap",
    classificationConfidence: "unknown",
    materializationConfidence: "unknown",
    match: buildRuleGapEvidence(node),
    materialization: RULE_GAP_MATERIALIZATION,
    notes: [reason],
  };
}
