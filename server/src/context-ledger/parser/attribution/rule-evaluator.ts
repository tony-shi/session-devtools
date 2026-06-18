// parser/attribution/rule-evaluator：单 ContextRule 在单 AST node 上的命中判定。
//
// 命名取 "evaluator" 而非 "matcher"——后者已被 parser/matcher.ts（结构切割）占用。
//
// 模块职责：
//   - 对单条 rule 做 pattern match，遵守 rule.queryScope。
//   - regex.exec() 只在这里执行一次，并直接产出 matchedRange、CharCoverage、DynamicField。
//   - 不推导 confidence，不处理 wire_schema fallback，不写 rule_gap。

import type { ContextRule } from "../../rules/context-rule-registry";
import { satisfiesCcVersion } from "../../version";
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

// CharCoverage 不变量见 types.ts；这里只接收三个独立输入：
//   rawChars / matchedChars / dynamicChars
// staticChars 与 unmatchedChars 都从这三个值派生，避免调用方手算静态字符。
function charCoverage(params: {
  rawChars: number;
  matchedChars: number;
  dynamicChars?: number;
}): CharCoverage {
  const matchedChars = Math.max(0, Math.min(params.matchedChars, params.rawChars));
  const dynamicChars = Math.max(0, Math.min(params.dynamicChars ?? 0, matchedChars));
  return {
    rawChars: params.rawChars,
    matchedChars,
    staticChars: matchedChars - dynamicChars,
    dynamicChars,
    unmatchedChars: params.rawChars - matchedChars,
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

function appliesToMatches(rule: ContextRule, ccVersion: string | undefined): boolean {
  // 无 appliesTo 字段 = 全版本适用（缺省）
  if (!rule.appliesTo) return true;
  // 有 appliesTo 但 ctx 没有 ccVersion = 不满足（保守：标了 appliesTo 必须有 ctx 校验）
  if (!ccVersion) return false;
  return satisfiesCcVersion(ccVersion, rule.appliesTo);
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
/**
 * tools.builtin.* 节点的匹配域：matcher 有意把 rawText 设为完整 tool JSON
 * （name+description+input_schema，字节真实、cache 口径正确——见 matcher.ts tools
 * 段注释），但 tools_schema 类规则的 pattern 锚的是 description 纯文本——两者直接
 * exact/prefix 比对永不命中（v11 在旧链路修过同义问题；AST 链路自 rawText 改
 * stringify 后全部 tool 规则静默退 wire 兜底，verifiedFor/displayName 富信息丢失）。
 *
 * 这里把匹配域切到 parse 出的 description，命中后 matchedRange 映射回 rawText 中
 * description 的 JSON 转义字面区间（真实偏移）；coverage 按该区间计——pattern 只
 * 解释了 desc 部分，input_schema 不在其覆盖里，诚实表达为部分覆盖。
 */
function toolDescMatchDomain(node: SegmentNode): { text: string; start: number; end: number } | null {
  if (!node.slotType.startsWith("tools.builtin.")) return null;
  try {
    const tool = JSON.parse(node.rawText) as { description?: unknown };
    if (typeof tool.description !== "string" || !tool.description) return null;
    const escaped = JSON.stringify(tool.description).slice(1, -1);
    const at = node.rawText.indexOf(escaped);
    if (at === -1) return null;
    return { text: tool.description, start: at, end: at + escaped.length };
  } catch {
    return null;
  }
}

export function evaluateRuleForNode(
  node: SegmentNode,
  rule: ContextRule,
  queryKind: string,
  ccVersion?: string,
): RuleEvaluation | null {
  if (!queryScopeMatches(rule, queryKind)) return null;
  if (!appliesToMatches(rule, ccVersion)) return null;

  const { pattern, matchMode } = rule.attribution;
  if (pattern === null) return null;

  const rawChars = node.rawText.length;

  // tools_schema 规则在 tools.builtin.* 节点上以 description 为匹配域；
  // 命中后 matchedRange 统一报 desc 字面在 rawText 中的区间（regex 子匹配的
  // 域内偏移不再细分——材料化语义上 desc 整段由该规则解释）。
  const toolDomain = rule.attribution.category === "tools_schema" ? toolDescMatchDomain(node) : null;
  const text = toolDomain ? toolDomain.text : node.rawText;

  if (matchMode === "regex") {
    // d flag 开启 indices，用于命名捕获组偏移与 matchedRange 计算。
    const m = new RegExp(pattern, "sd").exec(text);
    if (!m) return null;
    if (toolDomain) {
      return {
        rule,
        matchMode: "regex",
        matchedRange: { start: toolDomain.start, end: toolDomain.end },
        charCoverage: charCoverage({ rawChars, matchedChars: toolDomain.end - toolDomain.start }),
      };
    }

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
        dynamicChars: dynamic.dynamicChars,
      }),
      ...(dynamic.fields ? { dynamicFields: dynamic.fields } : {}),
    };
  }

  if (matchMode === "exact") {
    if (text !== pattern) return null;
    if (toolDomain) {
      return {
        rule,
        matchMode: "exact",
        matchedRange: { start: toolDomain.start, end: toolDomain.end },
        charCoverage: charCoverage({ rawChars, matchedChars: toolDomain.end - toolDomain.start }),
      };
    }
    return {
      rule,
      matchMode: "exact",
      matchedRange: { start: 0, end: rawChars },
      charCoverage: charCoverage({
        rawChars,
        matchedChars: rawChars,
      }),
    };
  }

  // prefix（含 ContextRule 把 structural 归一化后的结构兜底规则）。
  // 空 pattern 是结构兜底，命中即视作"slot 锚点存在但无可解释内容"。
  const trimmedLeading = text.length - text.trimStart().length;
  if (!text.trimStart().startsWith(pattern)) return null;

  if (toolDomain) {
    return {
      rule,
      matchMode: "prefix",
      matchedRange: { start: toolDomain.start, end: toolDomain.end },
      charCoverage: charCoverage({ rawChars, matchedChars: toolDomain.end - toolDomain.start }),
    };
  }
  const matchedChars = pattern.length;
  return {
    rule,
    matchMode: "prefix",
    matchedRange: { start: trimmedLeading, end: trimmedLeading + matchedChars },
    charCoverage: charCoverage({
      rawChars,
      matchedChars,
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
  ccVersion?: string,
): RuleEvaluation | null {
  for (const rule of rules) {
    const evaluation = evaluateRuleForNode(node, rule, queryKind, ccVersion);
    if (evaluation) return evaluation;
  }
  return null;
}
