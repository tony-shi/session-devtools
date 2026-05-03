// proxy-first attribution：消费 snapshot.segments（由 proxy-snapshot-parser 产出），
// 对每个 segment 匹配 rule，产出 ProxySegmentAttribution[]。
//
// 职责边界：
//   - 不读取 rawBody，不重建 segment，不 mutate snapshot
//   - 不读取 JSONL，不生成 ContextMutation
//   - attribution 的 proxySegmentIds 直接使用 parser 产出的 segment.id
//   - 所有语义判断均由 CONTEXT_LEDGER_RULES 驱动，attribution 函数本身不写 pattern 假设
//
// 设计原则（rule 驱动）：
//   - 每个 segment 遍历 RULE_TABLE（有序），第一个命中的 rule 决定 attribution 全部字段
//   - attribution 函数只处理 rule 无法覆盖的 wire-schema 感知事项：
//       · tool_use / tool_result：category 由 parser 的 wire schema 解析直接确定，无文本 pattern
//       · billing header fallback：regex 未命中但前缀存在时保守兜底
//       · prior_session_guess：messages[0] 结构性推断，无文本 pattern 可写
//   - 未命中任何 rule 时明确标 rule_gap，不再用 heuristic 伪装归类
//
// 规则表（RULE_TABLE）按优先级排列，section 约束由 rule.attribution.location.section 决定：
//   优先级 1  side_query rules      (queryScope=side_query)
//   优先级 2  billing_noise_pattern (system + messages)
//   优先级 3  system prompt rules   (identity / dynamic sections / static body)
//   优先级 4  context_management    (system，动态 git 状态)
//   优先级 5  tool schema rules     (tools section，每个 tool 独立 rule)
//   优先级 6  兜底：wire schema + prior_session_guess + rule_gap

import {
  CONTEXT_LEDGER_RULES,
  CLAUDE_CODE_BILLING_NOISE_RULE,
  CLAUDE_CODE_SESSION_GUIDANCE_EMBEDDED_RULE,
  CLAUDE_CODE_ENVIRONMENT_SECTION_RULE,
  CLAUDE_CODE_AUTO_MEMORY_SECTION_RULE,
  CLAUDE_CODE_CONTEXT_MANAGEMENT_RULE,
  CLAUDE_CODE_TOOL_RESULT_SMOOSH_RULE,
} from "./rule-registry";
import type { ContextLedgerRule } from "./rule-registry";
import { DYNAMIC_SECTION_HEADERS } from "./proxy-block-splitter";
import type {
  ContextSegment,
  MutationSourceKind,
  ProxyQuerySnapshot,
  ProxySegmentAttribution,
  RuleMatchCapture,
  RuleMatchEvidence,
  SegmentCategory,
  SegmentFlag,
  SegmentLifecycle,
  SegmentSection,
} from "./types";

// ── 常量 ──────────────────────────────────────────────────────────────────────

const LARGE_SEGMENT_THRESHOLD = 10_000;

// billing header 前缀（fallback 用，regex rule 未命中时的保守兜底）
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

// messages 里的 harness injection 标签（无文本 pattern rule 可覆盖，保留为 wire schema 检测）
const SYSTEM_REMINDER_TAG = "<system-reminder>";
const LOCAL_COMMAND_TAGS = [
  "<local-command-caveat>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<command-name>",
  "<local-command-stdout>",
];

// ── rule 驱动的 pattern match ──────────────────────────────────────────────────

// RuleMatchData：tryMatchRule 的返回结构，携带捕获组值和偏移 indices（P1-1）
interface RuleMatchData {
  groups: Record<string, string | undefined> | null;
  // regex 命中时的命名捕获组偏移（ES2022 d flag），非 regex 时为 null
  groupIndices: Record<string, [number, number] | undefined> | null;
}

// tryMatchRule：对单条 rule 做匹配，返回 RuleMatchData 或 null（不命中）。
function tryMatchRule(
  rule: ContextLedgerRule,
  text: string,
  section: SegmentSection,
  queryKind: string,
): RuleMatchData | null {
  const attr = rule.attribution;
  if (!attr?.pattern) return null;

  if (attr.location?.section !== undefined && attr.location.section !== section) return null;

  if (rule.queryScope && rule.queryScope !== "any") {
    if (queryKind !== rule.queryScope) return null;
  }

  if (attr.matchMode === "regex") {
    // d flag 开启 indices，用于 P1-1 捕获组偏移计算
    const m = new RegExp(attr.pattern, "sd").exec(text);
    if (!m) return null;
    return {
      groups: (m.groups ?? {}) as Record<string, string | undefined>,
      groupIndices: (m.indices?.groups ?? null) as Record<string, [number, number] | undefined> | null,
    };
  }
  if (attr.matchMode === "exact") {
    return text === attr.pattern ? { groups: null, groupIndices: null } : null;
  }
  if (attr.matchMode === "contains") {
    return text.includes(attr.pattern) ? { groups: null, groupIndices: null } : null;
  }
  // prefix / structural
  return text.trimStart().startsWith(attr.pattern) ? { groups: null, groupIndices: null } : null;
}

// findMatchingRule：按 CONTEXT_LEDGER_RULES 顺序遍历，返回第一个命中的 rule + 匹配数据。
function findMatchingRule(
  text: string,
  section: SegmentSection,
  queryKind: string,
): { rule: ContextLedgerRule; matchData: RuleMatchData } | null {
  for (const rule of CONTEXT_LEDGER_RULES) {
    const matchData = tryMatchRule(rule, text, section, queryKind);
    if (matchData !== null) {
      return { rule, matchData };
    }
  }
  return null;
}

// ── rule → attribution 字段映射 ───────────────────────────────────────────────
// 从 rule 的 attribution 字段推导出 ProxySegmentAttribution 的各语义字段。
// 这里是唯一的"rule → 字段"映射点，attribution 主流程不再重复这些逻辑。

interface RuleMatchResult {
  category: SegmentCategory;
  mechanism: ProxySegmentAttribution["mechanism"];
  confidence: ProxySegmentAttribution["confidence"];
  attributedSource: MutationSourceKind;
  lifecycle: SegmentLifecycle | undefined;
  ruleId: string;
  flags: SegmentFlag[];
  notes: string[] | undefined;
  evidence: RuleMatchEvidence | undefined;
}

// P1-1：从捕获组 name 推断动态字段来源
function inferCaptureSource(name: string): RuleMatchCapture["source"] {
  if (/cwd|platform|shell|osVersion|model|cutoff/.test(name)) return "env";
  if (/memory|memoryDir/.test(name)) return "memory";
  if (/branch|gitUser|version|entrypoint|cch|workload/.test(name)) return "runtime";
  return "unknown";
}

// P1-1：从 matchData 生成结构化 RuleMatchEvidence
function buildEvidence(
  rule: ContextLedgerRule,
  rawText: string,
  matchData: RuleMatchData,
): RuleMatchEvidence | undefined {
  const mat = rule.reconstruction?.materialization;

  // mode 映射
  const mode: RuleMatchEvidence["mode"] =
    rule.attribution?.matchMode === "exact" ? "exact"
    : mat === "exact_text" ? "template"
    : matchData.groups && Object.keys(matchData.groups).length > 0 ? "regex"
    : "presence";

  if (mode === "presence" || mode === "exact") {
    // presence/exact 无捕获组，不需要详细 evidence
    return undefined;
  }

  const captures: RuleMatchCapture[] = [];
  const groups = matchData.groups ?? {};
  const indices = matchData.groupIndices ?? {};

  for (const [name, value] of Object.entries(groups)) {
    if (value === undefined) continue;
    const range = indices[name];
    const charStart = range?.[0] ?? 0;
    const charEnd = range?.[1] ?? (charStart + value.length);
    captures.push({
      name,
      valuePreview: value.length > 120 ? value.slice(0, 117) + "…" : value,
      charStart,
      charEnd,
      source: inferCaptureSource(name),
    });
  }

  const placeholderChars = captures.reduce((s, c) => s + (c.charEnd - c.charStart), 0);
  const totalChars = rawText.length;
  const literalChars = Math.max(0, totalChars - placeholderChars);
  const placeholderRatio = totalChars > 0 ? placeholderChars / totalChars : 0;

  return {
    ruleId: rule.ruleId,
    mode,
    literalChars,
    placeholderChars,
    placeholderRatio,
    captures,
  };
}

function applyRuleMatch(
  rule: ContextLedgerRule,
  rawText: string,
  matchData: RuleMatchData,
): RuleMatchResult {
  const groups = matchData.groups;
  const attr = rule.attribution!;

  // lifecycle：从 rule.reconstruction.emits.lifecycle 推导
  const lifecycle = rule.reconstruction?.emits?.lifecycle;

  // flags
  const flags: SegmentFlag[] = [];
  if (rule.reconstruction?.emits?.flags?.includes("injected")) flags.push("injected");
  if (rule.reconstruction?.emits?.flags?.includes("known_noise")) flags.push("known_noise");

  // category：从 rule.attribution.category
  const category = attr.category;

  // mechanism：从 rule.attribution.mechanism
  const mechanism = attr.mechanism;

  // confidence：有命名捕获组且全部非空 → exact；否则按 rule.reconciliation.confidence 降级
  const hasGroups = groups && Object.keys(groups).length > 0;
  const allGroupsFilled = hasGroups && Object.values(groups!).every((v) => v !== undefined && v !== "");
  const baseConfidence = rule.reconciliation?.confidence ?? "inferred";
  const confidence: ProxySegmentAttribution["confidence"] =
    attr.matchMode === "exact" ? "exact"
    : allGroupsFilled ? "exact"
    : hasGroups ? "inferred"
    : baseConfidence;

  // attributedSource：tool_use/tool_result 由 wire schema 决定，其余由 rule 决定
  const attributedSource: MutationSourceKind =
    category === "tool_use" || category === "tool_result" ? "jsonl" : "harness_rule";

  // notes：billing rule 专用捕获组、dynamic section 专用捕获组
  let notes: string[] | undefined;
  if (category === "billing_noise" && groups) {
    notes = [
      `cc_version=${groups["version"] ?? "?"}`,
      `cc_entrypoint=${groups["entrypoint"] ?? "?"}`,
      ...(groups["cch"] ? [`cch=${groups["cch"]}`] : []),
      ...(groups["workload"] ? [`cc_workload=${groups["workload"]}`] : []),
    ].filter((n) => !n.endsWith("?"));
    if (notes.length === 0) notes = undefined;
  } else if (rule.ruleId === CLAUDE_CODE_ENVIRONMENT_SECTION_RULE.ruleId && groups) {
    notes = [
      `cwd=${groups["cwd"] ?? "?"}`,
      `platform=${groups["platform"] ?? "?"}`,
      `shell=${groups["shell"] ?? "?"}`,
      `osVersion=${groups["osVersion"] ?? "?"}`,
      `model=${groups["modelDesc"] ?? "?"}`,
      ...(groups["cutoff"] ? [`cutoff=${groups["cutoff"]}`] : []),
    ];
  } else if (rule.ruleId === CLAUDE_CODE_AUTO_MEMORY_SECTION_RULE.ruleId && groups?.["memoryDir"]) {
    notes = [`memoryDir=${groups["memoryDir"]}`];
  } else if (rule.ruleId === CLAUDE_CODE_CONTEXT_MANAGEMENT_RULE.ruleId && groups) {
    if (groups["currentBranch"]) {
      notes = [
        `currentBranch=${groups["currentBranch"]}`,
        `mainBranch=${groups["mainBranch"] ?? "?"}`,
        ...(groups["gitUser"] ? [`gitUser=${groups["gitUser"]}`] : []),
      ];
    } else {
      notes = ["no_git_repo: gitStatus block absent"];
    }
  }

  // P1-1：生成结构化 evidence（regex/template 命中时）
  const evidence = buildEvidence(rule, rawText, matchData);

  // Session-specific guidance：embedded variant 升 confidence
  if (rule.ruleId === CLAUDE_CODE_SESSION_GUIDANCE_EMBEDDED_RULE.ruleId) {
    return { category, mechanism, confidence: "exact", attributedSource, lifecycle, ruleId: rule.ruleId, flags, notes, evidence };
  }

  return { category, mechanism, confidence, attributedSource, lifecycle, ruleId: rule.ruleId, flags, notes, evidence };
}

// ── text 検出工具（wire schema 感知、不依赖文本 pattern rule）────────────────────

function isBillingNoise(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith(BILLING_HEADER_PREFIX);
}

function isSystemReminder(text: string): boolean {
  return text.trimStart().startsWith(SYSTEM_REMINDER_TAG);
}

function isLocalCommand(text: string): boolean {
  const t = text.trimStart();
  return LOCAL_COMMAND_TAGS.some((tag) => t.startsWith(tag));
}

// ── jsonPath 解析 ─────────────────────────────────────────────────────────────

function parseMsgIndex(jsonPath: string | undefined): number | null {
  if (!jsonPath) return null;
  const m = /reqBody\.messages\[(\d+)\]/.exec(jsonPath);
  return m ? parseInt(m[1]!, 10) : null;
}

// ── 核心函数 ──────────────────────────────────────────────────────────────────

/**
 * 消费 snapshot.segments，对每个 segment 应用 CONTEXT_LEDGER_RULES，产出 ProxySegmentAttribution[]。
 *
 * 主流程：每个 segment → findMatchingRule → applyRuleMatch → push attribution。
 * Rule 未覆盖的情况（wire schema / prior_session / rule_gap）在主流程末尾兜底。
 * attribution 函数本身不写任何 pattern 假设，只处理 rule 无法覆盖的 wire-schema 感知事项。
 */
export function inferClaudeProxyAttributions(
  snapshot: ProxyQuerySnapshot,
): ProxySegmentAttribution[] {
  const snapshotId = snapshot.id;
  const results: ProxySegmentAttribution[] = [];
  const queryKind = snapshot.request?.queryKind ?? "unknown";

  // 预收集 tool_use id，用于 tool_result cross-reference（wire schema，无文本 pattern）
  const knownToolUseIds = new Set<string>();
  for (const seg of snapshot.segments) {
    if (seg.category === "tool_use" && seg.toolUseId) {
      knownToolUseIds.add(seg.toolUseId);
    }
  }

  // 总消息索引数（prior_session_guess 依赖，结构性推断）
  const msgIndices = new Set<number>();
  for (const seg of snapshot.segments) {
    if (seg.section !== "messages") continue;
    const ref = seg.sourceRefs[0];
    const idx = ref?.kind === "proxy" ? parseMsgIndex(ref.proxy.jsonPath) : null;
    if (idx !== null) msgIndices.add(idx);
  }
  const totalMessages = msgIndices.size;

  let attrCounter = 0;

  for (const seg of snapshot.segments) {
    const segId = seg.id;
    const ref = seg.sourceRefs[0];
    const jsonPath = ref?.kind === "proxy" ? (ref.proxy.jsonPath ?? "") : "";
    const chars = seg.charCount ?? 0;
    const rawText = seg.rawText ?? "";
    const meta = seg.metadata as Record<string, unknown> | undefined;
    const sectionHeader = typeof meta?.["sectionHeader"] === "string" ? meta["sectionHeader"] : null;

    let category: SegmentCategory = seg.category;
    let mechanism: ProxySegmentAttribution["mechanism"] = "unknown";
    let confidence: ProxySegmentAttribution["confidence"] = "inferred";
    let attributedSource: MutationSourceKind = "unknown";
    let lifecycle: SegmentLifecycle | undefined;
    let ruleId: string | undefined;
    let notes: string[] | undefined;
    let evidence: RuleMatchEvidence | undefined;
    const flags: SegmentFlag[] = [];

    // ── 主路径：rule 驱动 ────────────────────────────────────────────────────
    const ruleMatch = findMatchingRule(rawText, seg.section, queryKind);

    if (ruleMatch) {
      const applied = applyRuleMatch(ruleMatch.rule, rawText, ruleMatch.matchData);
      category = applied.category;
      mechanism = applied.mechanism;
      confidence = applied.confidence;
      attributedSource = applied.attributedSource;
      lifecycle = applied.lifecycle;
      ruleId = applied.ruleId;
      notes = applied.notes;
      evidence = applied.evidence;
      flags.push(...applied.flags);

    // ── 兜底路径：wire schema 感知（无文本 pattern rule 可覆盖）─────────────
    } else if (seg.section === "system") {
      // billing fallback：regex rule 未命中但前缀存在，说明 billing header 格式异常
      if (isBillingNoise(rawText)) {
        category = "billing_noise";
        mechanism = "billing_noise_pattern";
        confidence = "inferred";
        attributedSource = "harness_rule";
        lifecycle = "noise";
        ruleId = CLAUDE_CODE_BILLING_NOISE_RULE.ruleId;
        flags.push("known_noise");
        notes = ["billing header detected by prefix fallback; regex did not match — format may differ from expected"];
      } else {
        // rule_gap：system segment 未命中任何 rule
        category = "unknown";
        mechanism = "unknown";
        confidence = "unknown";
        attributedSource = "unknown";
        lifecycle = "unknown";
        flags.push("unexplained");
        if (!rawText.trim()) {
          notes = ["rule_gap: empty system block"];
        } else if (sectionHeader) {
          notes = [`rule_gap: section header "${sectionHeader}" has no matching rule — needs rule coverage`];
        } else {
          notes = ["rule_gap: system block matched no rule — needs rule coverage"];
        }
      }

    } else if (seg.section === "tools") {
      // tools segment：rule 未命中（新 tool 尚无 rule，或 tool 来自 MCP/plugin）。
      // category/section 由 parser wire schema 确定（exact），只是具体 tool 无对应 rule。
      category = "tools_schema";
      mechanism = "tools_schema_pattern";
      confidence = "exact"; // wire schema 确定，parser 已验证 blk.type
      attributedSource = "harness_rule";
      lifecycle = "session";
      // 从 jsonPath 提取 tool name 做 rule_gap 提示（有助于发现新 tool 需要补 rule）
      const toolNameMatch = /reqBody\.tools\[\d+\]/.exec(jsonPath);
      notes = [`rule_gap: no matching tool rule for ${toolNameMatch?.[0] ?? "unknown tool"} — add to registry if stable`];

    } else if (seg.section === "messages") {
      const msgIndex = parseMsgIndex(jsonPath);

      if (seg.category === "tool_use") {
        // wire schema：category 由 parser 直接确定，无文本 pattern 可写
        mechanism = "tool_use_id_match";
        confidence = "exact";
        attributedSource = "jsonl";
        lifecycle = "query";
      } else if (seg.category === "tool_result") {
        // wire schema + cross-reference tool_use_id
        const tid = seg.toolUseId;
        const idMatched = !!tid && knownToolUseIds.has(tid);
        mechanism = idMatched ? "tool_use_id_match" : "unknown";
        confidence = idMatched ? "exact" : "inferred";
        attributedSource = "jsonl";
        lifecycle = "query";
        if (!idMatched) {
          notes = [`tool_use_id "${tid ?? "(missing)"}" not found in this request's tool_use blocks — confidence downgraded to inferred`];
        }
        if (chars > LARGE_SEGMENT_THRESHOLD) {
          flags.push("large_segment");
          notes = [...(notes ?? []), `large_segment_detector: tool_result ${chars} chars > ${LARGE_SEGMENT_THRESHOLD} threshold`];
        }
        // tailInjection 检测：rawText 尾部是否含 harness smoosh 注入（如 task_reminder）
        const tailRule = CLAUDE_CODE_TOOL_RESULT_SMOOSH_RULE.tailInjection;
        if (tailRule && rawText.includes(tailRule.pattern)) {
          const tailStart = rawText.lastIndexOf(tailRule.pattern);
          const tailChars = rawText.length - tailStart;
          flags.push("smooshed_reminder");
          ruleId = CLAUDE_CODE_TOOL_RESULT_SMOOSH_RULE.ruleId;
          notes = [
            ...(notes ?? []),
            `tail_injection_chars:${tailChars}`,
            `tail_injection_rule:${tailRule.reconstructionRuleId}`,
          ];
        }
      } else if (isSystemReminder(rawText)) {
        // <system-reminder>：harness 注入，无独立文本 pattern rule（内容每次不同）
        category = "harness_injection";
        mechanism = "system_reminder_pattern";
        confidence = "exact";
        attributedSource = "harness_rule";
        lifecycle = "one_shot";
        flags.push("injected");
      } else if (isLocalCommand(rawText)) {
        // <bash-stdout> 等 local command 标签
        category = "local_command_history";
        mechanism = "local_command_pattern";
        confidence = "exact";
        attributedSource = "harness_rule";
        lifecycle = "one_shot";
        flags.push("injected");
      } else if (seg.category === "user_message" && msgIndex === 0 && totalMessages > 1) {
        // prior_session_guess：messages[0] 结构性推断，无文本 pattern
        category = "prior_session_history";
        mechanism = "unknown";
        confidence = "inferred";
        attributedSource = "prior_session";
        lifecycle = "session";
        notes = [`prior_session_guess: messages[0] user_message in a ${totalMessages}-message context`];
      } else if (seg.category === "user_message" || seg.category === "assistant_text") {
        // wire schema 确定类型，attribution 只补充 mechanism
        mechanism = "unknown";
        confidence = "inferred";
        attributedSource = "jsonl";
        lifecycle = "query";
      } else {
        category = "unknown";
        mechanism = "unknown";
        confidence = "unknown";
        attributedSource = "unknown";
        lifecycle = "unknown";
        flags.push("unexplained");
        notes = [`unknown: segment ${segId} category=${seg.category} — no attribution rule matched`];
      }

    } else {
      // 未知 section
      mechanism = "unknown";
      confidence = "unknown";
      attributedSource = "unknown";
      notes = [`unknown section: ${seg.section}`];
    }

    if (chars > LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");

    results.push({
      id: `attr-${++attrCounter}-${segId.slice(-8)}`,
      snapshotId,
      proxySegmentIds: [segId],
      category,
      attributedSource,
      sourceRefs: seg.sourceRefs,
      mechanism,
      confidence,
      charCount: chars,
      tokenEstimate: seg.tokenEstimate ?? Math.round(chars / 4),
      ...(notes ? { notes } : {}),
      ...(evidence ? { evidence } : {}),
      ...(ruleId ? { ruleId } : {}),
      ...(lifecycle || flags.length > 0
        ? { metadata: { ...(lifecycle ? { lifecycle } : {}), ...(flags.length > 0 ? { flags } : {}) } }
        : {}),
    });
  }

  return results;
}

// ── 分析工具 ──────────────────────────────────────────────────────────────────

export interface AttributionBreakdown {
  fixture: string;
  totalSegments: number;
  byCategory: Array<{
    category: SegmentCategory;
    count: number;
    totalChars: number;
    mechanisms: string[];
    confidences: string[];
  }>;
  topBloatSources: Array<{
    proxySegmentId: string;
    category: SegmentCategory;
    charCount: number;
    jsonPath: string;
  }>;
  unknownSegments: Array<{
    proxySegmentId: string;
    jsonPath: string;
    charCount: number;
    note: string;
    nextStepEvidence: string;
  }>;
}

export function buildAttributionBreakdown(
  fixtureName: string,
  attributions: ProxySegmentAttribution[],
): AttributionBreakdown {
  const catMap = new Map<
    SegmentCategory,
    { count: number; totalChars: number; mechanisms: Set<string>; confidences: Set<string> }
  >();

  for (const attr of attributions) {
    const existing = catMap.get(attr.category) ?? {
      count: 0,
      totalChars: 0,
      mechanisms: new Set<string>(),
      confidences: new Set<string>(),
    };
    existing.count += 1;
    existing.totalChars += attr.charCount ?? 0;
    existing.mechanisms.add(attr.mechanism);
    existing.confidences.add(attr.confidence);
    catMap.set(attr.category, existing);
  }

  const byCategory = Array.from(catMap.entries())
    .sort((a, b) => b[1].totalChars - a[1].totalChars)
    .map(([category, v]) => ({
      category,
      count: v.count,
      totalChars: v.totalChars,
      mechanisms: Array.from(v.mechanisms),
      confidences: Array.from(v.confidences),
    }));

  const topBloatSources = [...attributions]
    .sort((a, b) => (b.charCount ?? 0) - (a.charCount ?? 0))
    .slice(0, 5)
    .map((attr) => ({
      proxySegmentId: attr.proxySegmentIds[0] ?? "?",
      category: attr.category,
      charCount: attr.charCount ?? 0,
      jsonPath:
        (attr.sourceRefs[0] as Extract<typeof attr.sourceRefs[0], { kind: "proxy" }>)?.proxy
          ?.jsonPath ?? "?",
    }));

  const unknownSegments = attributions
    .filter((attr) => attr.category === "unknown")
    .map((attr) => {
      const jsonPath =
        (attr.sourceRefs[0] as Extract<typeof attr.sourceRefs[0], { kind: "proxy" }>)?.proxy
          ?.jsonPath ?? "?";
      return {
        proxySegmentId: attr.proxySegmentIds[0] ?? "?",
        jsonPath,
        charCount: attr.charCount ?? 0,
        note: attr.notes?.join("; ") ?? "no note",
        nextStepEvidence:
          "需要 JSONL reconciliation 或人工标注来确认来源；可能是 compaction summary、memory injection、或未知 harness rule。",
      };
    });

  return {
    fixture: fixtureName,
    totalSegments: attributions.length,
    byCategory,
    topBloatSources,
    unknownSegments,
  };
}
