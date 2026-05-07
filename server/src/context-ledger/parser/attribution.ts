// parser/attribution：AST slot 内 rule 匹配 + attribution 解析。
//
// 职责边界：
//   - 输入是 ParsedQuerySnapshot（结构事实树），不读取 reqBody / JSONL / proxy snapshot。
//   - rule 候选集由 slotId 从 ContextRule registry 取得，不做全表扫描。
//   - rule matcher 只产出局部命中；本文件的 resolver 统一处理 confidence、wire fallback、
//     unknown/rule_gap 和 coverage 统计。

import type { Confidence, SegmentCategory } from "../types";
import type { ParsedQuerySnapshot, SegmentNode } from "./types";
import { isUnknownSlotId } from "./types";
import {
  getContextRulesForSlotId,
  SUPPORTED_CLAUDE_CODE_VERSION,
} from "../rules/context-rule-registry";
import type { ContextRule } from "../rules/context-rule-registry";

export interface SegmentAttribution {
  nodeId: string;
  slotId: string;
  category: SegmentCategory;
  mechanism: string;
  classificationConfidence: Confidence;
  materializationConfidence: Confidence;
  ruleId?: string;
  notes?: string[];
}

export interface AttributionCoverageBucket {
  nodes: number;
  chars: number;
}

export interface AttributionCoverage {
  totalNodes: number;
  totalChars: number;
  exact: AttributionCoverageBucket;
  estimated: AttributionCoverageBucket;
  inferred: AttributionCoverageBucket;
  ruleGap: AttributionCoverageBucket;
  /** (exact.chars + estimated.chars) / totalChars */
  evidenceBackedRatio: number;
  /** (totalChars - ruleGap.chars) / totalChars */
  recognitionRatio: number;
}

interface RegexMatchData {
  groups: Record<string, string | undefined> | null;
}

type RuleMatchData = true | RegexMatchData;

function flattenNodes(roots: SegmentNode[]): SegmentNode[] {
  const out: SegmentNode[] = [];
  function visit(node: SegmentNode): void {
    out.push(node);
    for (const child of node.children) visit(child);
  }
  for (const root of roots) visit(root);
  return out;
}

function tryMatchRule(rule: ContextRule, text: string, queryKind: string): RuleMatchData | null {
  if (rule.queryScope && rule.queryScope !== "any" && queryKind !== rule.queryScope) {
    return null;
  }

  const { pattern, matchMode } = rule.attribution;
  if (pattern === null) return null;

  if (matchMode === "regex") {
    const m = new RegExp(pattern, "sd").exec(text);
    if (!m) return null;
    return { groups: (m.groups ?? {}) as Record<string, string | undefined> };
  }

  if (matchMode === "exact") {
    return text === pattern ? true : null;
  }

  if (matchMode === "contains") {
    return text.includes(pattern) ? true : null;
  }

  return text.trimStart().startsWith(pattern) ? true : null;
}

function groupsFromMatch(matchData: RuleMatchData): Record<string, string | undefined> | null {
  return matchData === true ? null : matchData.groups;
}

function renderNotes(
  rule: ContextRule,
  groups: Record<string, string | undefined> | null,
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

function applyRuleMatch(
  node: SegmentNode,
  rule: ContextRule,
  matchData: RuleMatchData,
): SegmentAttribution {
  const groups = groupsFromMatch(matchData);
  const attr = rule.attribution;
  const hasGroups = groups !== null && Object.keys(groups).length > 0;
  const allGroupsFilled = hasGroups && Object.values(groups).every((value) => value !== undefined && value !== "");

  let classificationConfidence: Confidence;
  let materializationConfidence: Confidence;

  if (attr.matchMode === "exact") {
    classificationConfidence = "exact";
    materializationConfidence = "exact";
  } else if (attr.matchMode === "regex") {
    classificationConfidence = allGroupsFilled ? "exact" : "estimated";
    materializationConfidence = allGroupsFilled ? "estimated" : "inferred";
  } else {
    classificationConfidence = "estimated";
    materializationConfidence = "inferred";
  }

  if (attr.confidenceOverride) {
    classificationConfidence = attr.confidenceOverride;
    materializationConfidence = attr.confidenceOverride;
  }

  // 未校对 rule 只能作为 inferred 识别证据，不能升级为 exact/estimated。
  if (rule.verifiedFor !== SUPPORTED_CLAUDE_CODE_VERSION) {
    classificationConfidence = "inferred";
    materializationConfidence = "inferred";
  }

  const notes = renderNotes(rule, groups);

  return {
    nodeId: node.id,
    slotId: node.slotId,
    category: attr.category,
    mechanism: attr.mechanism,
    classificationConfidence,
    materializationConfidence,
    ruleId: rule.ruleId,
    ...(notes ? { notes } : {}),
  };
}

function wireFallback(node: SegmentNode): SegmentAttribution | null {
  if (node.slotId === "messages.tool_use") {
    return {
      nodeId: node.id,
      slotId: node.slotId,
      category: "tool_use",
      mechanism: "wire_schema",
      classificationConfidence: "exact",
      materializationConfidence: "exact",
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
      notes: ["tool schema slot recognized, but no context rule matched this tool description"],
    };
  }

  return null;
}

function ruleGap(node: SegmentNode, reason: string): SegmentAttribution {
  return {
    nodeId: node.id,
    slotId: node.slotId,
    category: "unknown",
    mechanism: "rule_gap",
    classificationConfidence: "unknown",
    materializationConfidence: "unknown",
    notes: [reason],
  };
}

export function attributeSnapshot(snapshot: ParsedQuerySnapshot): SegmentAttribution[] {
  const out: SegmentAttribution[] = [];

  for (const node of flattenNodes(snapshot.roots)) {
    const rules = getContextRulesForSlotId(node.slotId);
    let matched: SegmentAttribution | null = null;

    for (const rule of rules) {
      const matchData = tryMatchRule(rule, node.rawText, snapshot.queryKind);
      if (matchData !== null) {
        matched = applyRuleMatch(node, rule, matchData);
        break;
      }
    }

    if (matched) {
      out.push(matched);
      continue;
    }

    const fallback = wireFallback(node);
    if (fallback) {
      out.push(fallback);
      continue;
    }

    if (isUnknownSlotId(node.slotId)) {
      out.push(ruleGap(node, node.metadata?.reason ?? "unknown slot"));
      continue;
    }

    out.push(ruleGap(node, `no context rule matched slot ${node.slotId}`));
  }

  return out;
}

export function computeCoverage(
  attributions: SegmentAttribution[],
  snapshot: ParsedQuerySnapshot,
): AttributionCoverage {
  const nodes = Object.values(snapshot.index);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const attrByNodeId = new Map(attributions.map((attr) => [attr.nodeId, attr]));

  const coverage: AttributionCoverage = {
    totalNodes: nodes.length,
    totalChars: nodes.reduce((sum, node) => sum + node.charCount, 0),
    exact: { nodes: 0, chars: 0 },
    estimated: { nodes: 0, chars: 0 },
    inferred: { nodes: 0, chars: 0 },
    ruleGap: { nodes: 0, chars: 0 },
    evidenceBackedRatio: 0,
    recognitionRatio: 0,
  };

  for (const attr of attributions) {
    const node = nodeById.get(attr.nodeId);
    const chars = node?.charCount ?? 0;

    if (attr.mechanism === "rule_gap") {
      coverage.ruleGap.nodes += 1;
      coverage.ruleGap.chars += chars;
      continue;
    }

    const confidence = attr.materializationConfidence;
    if (confidence === "exact") {
      coverage.exact.nodes += 1;
      coverage.exact.chars += chars;
    } else if (confidence === "estimated") {
      coverage.estimated.nodes += 1;
      coverage.estimated.chars += chars;
    } else {
      coverage.inferred.nodes += 1;
      coverage.inferred.chars += chars;
    }
  }

  // 没有 attribution 的节点按 ruleGap 计入，防止调用方传入不完整数组时覆盖率虚高。
  for (const node of nodes) {
    if (attrByNodeId.has(node.id)) continue;
    coverage.ruleGap.nodes += 1;
    coverage.ruleGap.chars += node.charCount;
  }

  if (coverage.totalChars > 0) {
    coverage.evidenceBackedRatio =
      (coverage.exact.chars + coverage.estimated.chars) / coverage.totalChars;
    coverage.recognitionRatio =
      (coverage.totalChars - coverage.ruleGap.chars) / coverage.totalChars;
  }

  return coverage;
}
