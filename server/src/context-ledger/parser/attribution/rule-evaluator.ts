// parser/attribution/rule-evaluator：单 ContextRule 在单 AST node 上的命中判定。
//
// 命名取 "evaluator" 而非 "matcher"——后者已被 parser/matcher.ts（结构切割）占用。
//
// 模块职责：
//   - 对单条 rule 做 pattern match，遵守 rule.queryScope。
//   - regex.exec() 只在这里执行一次，并直接产出 matchedRange、CharCoverage、DynamicField。
//   - 不推导 confidence，不处理 wire_schema fallback，不写 rule_gap。

import type { ContextRule } from "../../rules/context-rule-registry";
import type { SegmentNode } from "../types";
import type {
  AttributionMatchMode,
  CharCoverage,
  CharRange,
  DynamicField,
  DynamicFieldSource,
} from "./types";

export interface RuleEvaluation {
  rule: ContextRule;
  matchMode: Exclude<AttributionMatchMode, "rule_gap">;
  matchedRange: CharRange;
  charCoverage: CharCoverage;
  dynamicFields?: DynamicField[];
}

// ── 动态字段来源推断 ─────────────────────────────────────────────────────────

/**
 * inferCaptureSource：从捕获组名字保守推测来源。
 * 准确语义仍由 rule.attribution.captureGroups 文档化；这里仅服务 audit 初筛。
 */
export function inferCaptureSource(name: string): DynamicFieldSource {
  if (/cwd|platform|shell|osVersion|model|cutoff|gitUser|branch/i.test(name)) return "env";
  if (/memory|memoryDir/i.test(name)) return "memory";
  if (/version|entrypoint|cch|workload|fingerprint|sessionId|userId/i.test(name)) return "runtime";
  return "unknown";
}

function charCoverage(params: {
  rawChars: number;
  matchedChars: number;
  literalChars: number;
  dynamicChars?: number;
}): CharCoverage {
  const dynamicChars = params.dynamicChars ?? 0;
  const matchedChars = Math.max(0, Math.min(params.matchedChars, params.rawChars));
  const literalChars = Math.max(0, Math.min(params.literalChars, matchedChars));
  return {
    rawChars: params.rawChars,
    matchedChars,
    literalChars,
    dynamicChars: Math.max(0, Math.min(dynamicChars, matchedChars)),
    unmatchedChars: Math.max(0, params.rawChars - matchedChars),
  };
}

function buildDynamicFields(
  groups: Record<string, string | undefined> | undefined,
  groupIndices: Record<string, [number, number] | undefined> | undefined,
): { fields?: DynamicField[]; dynamicChars: number } {
  if (!groups) return { dynamicChars: 0 };

  const fields: DynamicField[] = [];
  let dynamicChars = 0;

  for (const [name, value] of Object.entries(groups)) {
    if (value === undefined) continue;

    const range = groupIndices?.[name];
    const charStart = range?.[0] ?? 0;
    const charEnd = range?.[1] ?? value.length;
    const charCount = Math.max(0, charEnd - charStart);
    dynamicChars += charCount;

    fields.push({
      name,
      valuePreview: value.length > 120 ? value.slice(0, 117) + "..." : value,
      charStart,
      charEnd,
      charCount,
      source: inferCaptureSource(name),
    });
  }

  return {
    dynamicChars,
    ...(fields.length > 0 ? { fields } : {}),
  };
}

function queryScopeMatches(rule: ContextRule, queryKind: string): boolean {
  return !rule.queryScope || rule.queryScope === "any" || queryKind === rule.queryScope;
}

/**
 * evaluateRuleForNode：判定一条 rule 是否命中 node。
 *
 * 命中语义：
 *   exact   text === pattern；matchedRange = [0, text.length)
 *   regex   `new RegExp(pattern, "sd").exec(text)` 命中；matchedRange = m.indices[0]
 *   prefix  text.trimStart().startsWith(pattern)；matchedRange 为锚点区间
 *
 * 不命中或 queryScope 不符返回 null。
 */
export function evaluateRuleForNode(
  node: SegmentNode,
  rule: ContextRule,
  queryKind: string,
): RuleEvaluation | null {
  if (!queryScopeMatches(rule, queryKind)) return null;

  const { pattern, matchMode } = rule.attribution;
  if (pattern === null) return null;

  const text = node.rawText;
  const rawChars = text.length;

  if (matchMode === "regex") {
    // d flag 开启 indices，用于命名捕获组偏移与 matchedRange 计算。
    const m = new RegExp(pattern, "sd").exec(text);
    if (!m) return null;

    const overall = m.indices?.[0];
    const start = overall?.[0] ?? m.index ?? 0;
    const end = overall?.[1] ?? start + m[0].length;
    const matchedChars = Math.max(0, end - start);
    const groups = m.groups as Record<string, string | undefined> | undefined;
    const groupIndices = m.indices?.groups as Record<string, [number, number] | undefined> | undefined;
    const dynamic = buildDynamicFields(groups, groupIndices);

    return {
      rule,
      matchMode: "regex",
      matchedRange: { start, end },
      charCoverage: charCoverage({
        rawChars,
        matchedChars,
        literalChars: Math.max(0, matchedChars - dynamic.dynamicChars),
        dynamicChars: dynamic.dynamicChars,
      }),
      ...(dynamic.fields ? { dynamicFields: dynamic.fields } : {}),
    };
  }

  if (matchMode === "exact") {
    if (text !== pattern) return null;
    return {
      rule,
      matchMode: "exact",
      matchedRange: { start: 0, end: rawChars },
      charCoverage: charCoverage({
        rawChars,
        matchedChars: rawChars,
        literalChars: rawChars,
      }),
    };
  }

  // prefix（含 ContextRule 把 structural 归一化后的结构兜底规则）。
  // 空 pattern 是结构兜底，命中即视作"slot 锚点存在但无可解释内容"。
  const trimmedLeading = text.length - text.trimStart().length;
  if (!text.trimStart().startsWith(pattern)) return null;

  const matchedChars = pattern.length;
  return {
    rule,
    matchMode: "prefix",
    matchedRange: { start: trimmedLeading, end: trimmedLeading + matchedChars },
    charCoverage: charCoverage({
      rawChars,
      matchedChars,
      literalChars: matchedChars,
    }),
  };
}

/**
 * findFirstRuleEvaluation：在候选 rule 集里取首个命中。
 *
 * candidate 顺序由 rule registry 控制（实体 rule 在前，结构兜底在后），
 * 这里不重排，保持 registry 的优先级语义。
 */
export function findFirstRuleEvaluation(
  node: SegmentNode,
  rules: ContextRule[],
  queryKind: string,
): RuleEvaluation | null {
  for (const rule of rules) {
    const evaluation = evaluateRuleForNode(node, rule, queryKind);
    if (evaluation) return evaluation;
  }
  return null;
}
