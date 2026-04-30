// proxy-first attribution：消费 snapshot.segments（由 proxy-snapshot-parser 产出），
// 对每个 segment 匹配 rule，产出 ProxySegmentAttribution[]。
//
// 职责边界：
//   - 不读取 rawBody，不重建 segment，不 mutate snapshot
//   - 不读取 JSONL，不生成 ContextMutation
//   - attribution 的 proxySegmentIds 直接使用 parser 产出的 segment.id
//   - 所有语义判断（billing_noise / harness_injection / lifecycle 等）在此层完成
//   - 依据 segment.rawText 做 pattern match，不依赖 parser 提前做的分类
//
// rule 优先级（system section）：
//   R1  billing_noise_pattern   — rawText 以 x-anthropic-billing-header: 开头
//   R2  identity rule           — rawText startsWith identity pattern → system_prompt, lifecycle=session
//   R2b dynamic section rule    — sectionHeader ∈ DYNAMIC_SECTION_HEADERS → harness_injection, lifecycle=query
//   R2c static section fallback — 其余 system segment → system_prompt, lifecycle=session
//
// rule 优先级（tools section）：
//   R3  tools_schema_pattern    — category=tools_schema, lifecycle=session
//
// rule 优先级（messages section）：
//   R1m billing_noise_pattern   — rawText 以 billing header 开头
//   R4  system_reminder_pattern — rawText 以 <system-reminder> 开头
//   R5  local_command_pattern   — rawText 以 <local-command-caveat>/<bash-*> 开头
//   R6  tool_use_id_match       — category=tool_use / tool_result（wire schema）
//   R9  prior_session_guess     — messages[0] 的 user text block
//   R10 unknown                 — 无法归类

import {
  CLAUDE_CODE_BILLING_NOISE_RULE,
  CLAUDE_CODE_SYSTEM_PROMPT_DYNAMIC_SECTION_RULE,
  CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE,
} from "./rule-registry";
import type { ContextLedgerRule } from "./rule-registry";
import { DYNAMIC_SECTION_HEADERS } from "./proxy-block-splitter";
import type {
  ContextSegment,
  MutationSourceKind,
  ProxyQuerySnapshot,
  ProxySegmentAttribution,
  SegmentCategory,
  SegmentFlag,
  SegmentLifecycle,
  SegmentSection,
} from "./types";

// ── 常量 ──────────────────────────────────────────────────────────────────────

const LARGE_SEGMENT_THRESHOLD = 10_000;

// billing header 前缀（system 和 messages 两处都可能出现）
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

// messages 里的 harness injection 标签
const SYSTEM_REMINDER_TAG = "<system-reminder>";
const LOCAL_COMMAND_TAGS = [
  "<local-command-caveat>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<command-name>",
  "<local-command-stdout>",
];

// ── rule pattern match ────────────────────────────────────────────────────────

function matchesRulePattern(
  rule: ContextLedgerRule,
  text: string,
  section: SegmentSection,
): boolean {
  const attr = rule.attribution;
  if (!attr?.pattern) return false;
  if (attr.location?.section !== undefined && attr.location.section !== section) return false;
  if (attr.matchMode === "regex") return new RegExp(attr.pattern).test(text);
  if (attr.matchMode === "contains") return text.includes(attr.pattern);
  return text.trimStart().startsWith(attr.pattern);
}

// matchesRulePatternWithGroups：matchMode=regex 时同时返回命名捕获组，供 attribution 提取字段。
// 非 regex 或无命名捕获组时返回 null。
function matchesRulePatternWithGroups(
  rule: ContextLedgerRule,
  text: string,
  section: SegmentSection,
): Record<string, string | undefined> | null {
  const attr = rule.attribution;
  if (!attr?.pattern || attr.matchMode !== "regex") return null;
  if (attr.location?.section !== undefined && attr.location.section !== section) return null;
  const m = new RegExp(attr.pattern).exec(text);
  if (!m) return null;
  return (m.groups ?? {}) as Record<string, string | undefined>;
}

// ── text 检测工具 ──────────────────────────────────────────────────────────────

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
 * 消费 snapshot.segments，对每个 segment 应用 rule，产出 ProxySegmentAttribution[]。
 * 不修改 snapshot；attribution 与 segments 1:1 对应。
 */
export function inferClaudeProxyAttributions(
  snapshot: ProxyQuerySnapshot,
): ProxySegmentAttribution[] {
  const snapshotId = snapshot.id;
  const results: ProxySegmentAttribution[] = [];

  // 预收集 tool_use id，用于 tool_result cross-reference
  const knownToolUseIds = new Set<string>();
  for (const seg of snapshot.segments) {
    if (seg.category === "tool_use" && seg.toolUseId) {
      knownToolUseIds.add(seg.toolUseId);
    }
  }

  // 总消息索引数（prior_session_guess 依赖）
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

    let category: SegmentCategory = seg.category;
    let mechanism: ProxySegmentAttribution["mechanism"] = "unknown";
    let confidence: ProxySegmentAttribution["confidence"] = "inferred";
    let attributedSource: MutationSourceKind = "unknown";
    let lifecycle: SegmentLifecycle | undefined;
    let ruleId: string | undefined;
    let notes: string[] | undefined;
    const flags: SegmentFlag[] = [];

    // ── system section ──────────────────────────────────────────────────────

    if (seg.section === "system") {
      const sectionHeader = typeof meta?.["sectionHeader"] === "string"
        ? meta["sectionHeader"]
        : null;

      const billingGroups = matchesRulePatternWithGroups(CLAUDE_CODE_BILLING_NOISE_RULE, rawText, "system");
      if (billingGroups !== null) {
        // R1：billing header（regex 匹配，提取 cc_version/cc_entrypoint/cch/cc_workload）
        category = "billing_noise";
        mechanism = "billing_noise_pattern";
        confidence = "exact";
        attributedSource = "harness_rule";
        lifecycle = "noise";
        ruleId = CLAUDE_CODE_BILLING_NOISE_RULE.ruleId;
        flags.push("known_noise");
        // 把动态字段存入 attribution metadata，供 reconciliation/UI 展示
        if (Object.keys(billingGroups).length > 0) {
          notes = [
            `cc_version=${billingGroups["version"] ?? "?"}`,
            `cc_entrypoint=${billingGroups["entrypoint"] ?? "?"}`,
            ...(billingGroups["cch"] ? [`cch=${billingGroups["cch"]}`] : []),
            ...(billingGroups["workload"] ? [`cc_workload=${billingGroups["workload"]}`] : []),
          ];
        }
      } else if (isBillingNoise(rawText)) {
        // R1 fallback：前缀匹配兜底（regex 未命中但前缀存在，说明格式异常——仍标 billing_noise）
        category = "billing_noise";
        mechanism = "billing_noise_pattern";
        confidence = "inferred";
        attributedSource = "harness_rule";
        lifecycle = "noise";
        ruleId = CLAUDE_CODE_BILLING_NOISE_RULE.ruleId;
        flags.push("known_noise");
        notes = ["billing header detected by prefix fallback; regex did not match — format may differ from expected"];
      } else if (matchesRulePattern(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE, rawText, "system")) {
        // R2：identity rule（57-char 固定前缀，exact pattern match）
        category = "system_prompt";
        mechanism = "system_prompt_pattern";
        confidence = "exact";
        attributedSource = "harness_rule";
        lifecycle = "session";
        ruleId = CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.ruleId;
      } else if (sectionHeader !== null && DYNAMIC_SECTION_HEADERS.has(sectionHeader)) {
        // R2b：dynamic section（由 splitter 提取的 sectionHeader 命中 DYNAMIC_SECTION_HEADERS）
        category = "harness_injection";
        mechanism = "system_prompt_pattern";
        confidence = "inferred";
        attributedSource = "harness_rule";
        lifecycle = "query";
        ruleId = CLAUDE_CODE_SYSTEM_PROMPT_DYNAMIC_SECTION_RULE.ruleId;
        flags.push("injected");
      } else {
        // R2c：其余 system segment → 保守 system_prompt, session
        category = "system_prompt";
        mechanism = "system_prompt_pattern";
        confidence = "inferred";
        attributedSource = "harness_rule";
        lifecycle = "session";
        if (!sectionHeader && rawText.trim().length === 0) {
          notes = ["empty system block; cannot attribute"];
        } else if (sectionHeader) {
          notes = [`heuristic: section header "${sectionHeader}" attributed as static system_prompt`];
        } else {
          notes = ["heuristic: non-identity system block attributed as system_prompt"];
          flags.push("approximate");
        }
      }

      if (chars > LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");
    }

    // ── tools section ───────────────────────────────────────────────────────

    else if (seg.section === "tools") {
      // R3：wire schema（blk.type 由 parser 直接确定）
      category = "tools_schema";
      mechanism = "tools_schema_pattern";
      confidence = "exact";
      attributedSource = "harness_rule";
      lifecycle = "session";
      if (chars > LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");
    }

    // ── messages section ────────────────────────────────────────────────────

    else if (seg.section === "messages") {
      const msgIndex = parseMsgIndex(jsonPath);

      if (seg.category === "tool_use") {
        // R6：wire schema
        mechanism = "tool_use_id_match";
        confidence = "exact";
        attributedSource = "jsonl";
        lifecycle = "query";
      } else if (seg.category === "tool_result") {
        // R6：cross-reference tool_use_id
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
      } else if (isSystemReminder(rawText)) {
        // R4：<system-reminder>
        category = "harness_injection";
        mechanism = "system_reminder_pattern";
        confidence = "exact";
        attributedSource = "harness_rule";
        lifecycle = "one_shot";
        flags.push("injected");
      } else if (isLocalCommand(rawText)) {
        // R5：<bash-stdout> 等
        category = "local_command_history";
        mechanism = "local_command_pattern";
        confidence = "exact";
        attributedSource = "harness_rule";
        lifecycle = "one_shot";
        flags.push("injected");
      } else if (seg.category === "user_message" || seg.category === "assistant_text") {
        // R9：prior_session_guess（messages[0] 的 user text）
        if (seg.category === "user_message" && msgIndex === 0 && totalMessages > 1) {
          category = "prior_session_history";
          mechanism = "unknown";
          confidence = "inferred";
          attributedSource = "prior_session";
          lifecycle = "session";
          notes = [`prior_session_guess: messages[0] user_message in a ${totalMessages}-message context — likely historical input`];
          flags.push("approximate");
        } else {
          mechanism = "unknown";
          confidence = "inferred";
          attributedSource = seg.category === "user_message" ? "jsonl" : "jsonl";
          lifecycle = "query";
          notes = [`inferred: ${seg.category} text block`];
        }
      } else {
        // R10：unknown
        category = "unknown";
        mechanism = "unknown";
        confidence = "unknown";
        attributedSource = "unknown";
        lifecycle = "unknown";
        flags.push("unexplained");
        notes = [`unknown: segment ${segId} category=${seg.category} — no attribution rule matched`];
      }
    }

    // ── 未知 section ────────────────────────────────────────────────────────

    else {
      mechanism = "unknown";
      confidence = "unknown";
      attributedSource = "unknown";
      notes = [`unknown section: ${seg.section}`];
    }

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
