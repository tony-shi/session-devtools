// proxy-first attribution：从 ProxyQuerySnapshot 推断每个 segment 的 category/mechanism/confidence。
// 不读取 JSONL；不生成 ContextMutation；不把 unknown 强行归类为 known。
//
// 规则优先级（从高到低）：
//   1. billing_noise_pattern   — system[0] billing header
//   2. system_prompt_pattern   — Claude Code identity / main system prompt
//   3. tools_schema_pattern    — tools[] 数组
//   4. system_reminder_pattern — <system-reminder> 注入块
//   5. local_command_pattern   — <local-command-caveat>/<bash-input>/<bash-stdout>/slash command
//   6. tool_use_id_match       — tool_use / tool_result 结构
//   7. large_segment_detector  — 超大 tool_result / tools schema（仅打 flag，不改 category）
//   8. cache_hint_detector     — cache_control 线索（仅追加 note，不改 category）
//   9. prior_session_guess     — 无法在当前 query 解释的历史消息
//  10. unknown                 — 无法归类的 segment（不静默吞掉）
//
// ---- 已知局限与后续 TODO -----------------------------------------------
//
// TODO(system_prompt_split): system[2] 目前整块归为 system_prompt，但它包含两个逻辑段：
//   - 静态段（# System … # auto memory）：session 级，内容稳定，适合长期 cache。
//     实测约占 system[2] 的 94%（~26,310 chars）。
//   - 动态段（# Environment … gitStatus / recent commits）：每次 query 都会变化，
//     应归类为 harness_injection，而非 system_prompt。
//     实测约占 6%（~1,601 chars），边界标记为 "# Environment"。
//   拆分需要对 system[2].text 做正则匹配（找 "^# Environment"），
//   或依赖 JSONL reconciliation 对比静态/动态边界。
//   参考：Claude Code sourcemap SYSTEM_PROMPT_DYNAMIC_BOUNDARY 策略。
//
// TODO(tools_schema_per_tool): tools[] 目前整块归为一条 tools_schema attribution，
//   但实际上每个 tool 的体积差异很大（实测 top 5：Bash 12,125 chars、Agent 9,536、
//   TeamCreate 7,417、Monitor 6,163、AskUserQuestion 4,880）。
//   后续可拆分为 per-tool attribution，支持：
//     - 识别哪些 tool 是 bloat 主因（大 description 的 tool）
//     - 区分 built-in tool（harness_rule）和 MCP tool（mcp_server）
//     - 跨 session 对比 tools[] 变化（如 34 → 40 工具的增量来自哪个 worktree/MCP config）
//   拆分只需遍历 rawBody.tools[]，每条 entry 单独生成 attribution。
//
// TODO(large_segment_detector_threshold): 当前阈值 10,000 chars 是拍的。
//   建议后续从真实 fixture 的 token 分布中推导合理阈值（如 p90 tool_result size）。
//
// NOTE(prior_session_guess): 当前实现仅对 messages[0] 的纯文本 block 触发 prior_session_guess。
//   依据：Claude Code 把历史对话打包进第一条 user message；messages[1] 以后的 user turn
//   都是新的交互轮次（"are you there" / 任务描述 / tool_result 等），不应归为历史。
//   已知局限：messages[0] 里如果混有当前 query 的真实用户输入（极少见），会被误归为历史。

import { createHash } from "node:crypto";
import { CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE } from "./rule-registry";
import type { ContextLedgerRule } from "./rule-registry";
import type {
  CacheHint,
  ContextSegment,
  MutationSourceKind,
  ProxyQuerySnapshot,
  ProxySegmentAttribution,
  SegmentCategory,
  SegmentFlag,
  SegmentLifecycle,
  SegmentSection,
  SourceRef,
} from "./types";

// ---- 常量 ----------------------------------------------------------------

// billing header 的完整前缀（system[0] 专用）
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

// system-reminder 标签
const SYSTEM_REMINDER_OPEN = "<system-reminder>";

// local command 相关标签
const LOCAL_COMMAND_TAGS = [
  "<local-command-caveat>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<command-name>",
  "<local-command-stdout>",
];

// 超大 segment 阈值（chars）
const LARGE_SEGMENT_THRESHOLD = 10_000;

// ---- 内部类型 ------------------------------------------------------------

interface RawContentBlock {
  type: string;
  text?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  input?: unknown;
  // tool_result 的 content 可能是 string 或 block 数组
  content?: string | RawContentBlock[];
  cache_control?: { type: string; ttl?: string };
}

interface RawProxyBody {
  system?: Array<{ type: string; text?: string; cache_control?: { type: string; ttl?: string } }>;
  tools?: unknown[];
  messages?: Array<{
    role: string;
    // content 可能是 block 数组（正常情况），也可能是 string（Claude Code 有时直接传文本）
    content?: RawContentBlock[] | string;
  }>;
}

// ---- 辅助工具 ------------------------------------------------------------

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function proxyRef(
  file: string,
  jsonPath: string,
): Extract<SourceRef, { kind: "proxy" }> {
  return { kind: "proxy", proxy: { file, jsonPath } };
}

function charCount(text: string | undefined): number {
  return text?.length ?? 0;
}

// cache_control → CacheHint（proxy 只能看到 write 标记；read 由 API 响应决定，proxy 无法直接观测）
function cacheHintFromControl(cc: { type: string; ttl?: string } | undefined): CacheHint {
  if (!cc) return "none";
  // ephemeral 是 Claude Code 写入 cache 的标记；proxy 层面只能推断 "write"
  if (cc.type === "ephemeral") return "write";
  return "unknown";
}

// ---- 规则判断 ------------------------------------------------------------

function isBillingNoise(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith(BILLING_HEADER_PREFIX);
}

// matchesAttributionRule：从 ContextLedgerRule.attribution 取 pattern + location，
// 执行 text match + section 约束双重校验。
//
// section 约束：attribution.location.section 不满足时直接 no match。
// text match（matchMode=exact）：trimStart 后以 pattern 开头即命中。
//   "以 pattern 开头"涵盖两种情况：
//     (a) 整段就是 pattern（57-char identity block）
//     (b) 段以 pattern 打头后跟更多内容（未来 full system prompt rule 的场景）
//
// orderHint / jsonPathHint 仅作审核参考，不参与运行时约束——
// 因为 billing header 的存在性影响绝对索引，不适合作为硬约束。
// segmentPosition = segment_start 已由 startsWith 语义保证。
function matchesAttributionRule(
  rule: ContextLedgerRule,
  text: string,
  section: SegmentSection,
): boolean {
  const attr = rule.attribution;
  if (!attr?.pattern) return false;

  // section 硬约束
  if (attr.location?.section !== undefined && attr.location.section !== section) return false;

  // text match：segment_start / exact 均用 startsWith（pattern 须出现在 segment 起始）
  const trimmed = text.trimStart();
  return trimmed.startsWith(attr.pattern);
}

function isSystemReminder(text: string): boolean {
  return text.trimStart().startsWith(SYSTEM_REMINDER_OPEN);
}

function isLocalCommand(text: string): boolean {
  const t = text.trimStart();
  return LOCAL_COMMAND_TAGS.some((tag) => t.startsWith(tag));
}

// ---- 核心函数 ------------------------------------------------------------

/**
 * 从 ProxyQuerySnapshot 推断每个 proxy segment 的 attribution。
 * 不依赖 JSONL；不生成 ContextMutation。
 *
 * rawBody 必须由上游 parser 填入 snapshot.metadata.rawBody；
 * 缺失时抛出明确错误，避免静默返回空列表。
 */
export function inferClaudeProxyAttributions(
  snapshot: ProxyQuerySnapshot,
): ProxySegmentAttribution[] {
  const proxyFile = snapshot.sourceRef.proxy.file;
  const snapshotId = snapshot.id;
  const results: ProxySegmentAttribution[] = [];

  const rawBody = snapshot.metadata?.rawBody as RawProxyBody | undefined;
  if (!rawBody) {
    throw new Error(
      `inferClaudeProxyAttributions: snapshot "${snapshotId}" is missing metadata.rawBody. ` +
        "The upstream parser must populate it before calling this function.",
    );
  }
  const systemBlocks = rawBody.system ?? [];
  const tools = rawBody.tools ?? [];
  const messages = rawBody.messages ?? [];

  const totalMessages = messages.length;

  // ---- 1. system[] 处理 ------------------------------------------------

  for (let si = 0; si < systemBlocks.length; si++) {
    const block = systemBlocks[si];
    const text = block.text ?? "";
    const jsonPath = `reqBody.system[${si}]`;
    const cc = block.cache_control;
    const chars = charCount(text);

    let category: SegmentCategory;
    let mechanism: ProxySegmentAttribution["mechanism"];
    let confidence: ProxySegmentAttribution["confidence"];
    let attributedSource: MutationSourceKind;
    let notes: string[] | undefined;
    let lifecycle: SegmentLifecycle;
    let identityRuleId: string | undefined;
    const flags: SegmentFlag[] = [];

    if (si === 0 && isBillingNoise(text)) {
      // 规则 1：billing_noise_pattern（system[0] 专用，sourcemap 保证位置）
      category = "billing_noise";
      mechanism = "billing_noise_pattern";
      confidence = "exact";
      attributedSource = "harness_rule";
      lifecycle = "noise";
      flags.push("known_noise");
    } else if (matchesAttributionRule(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE, text, "system")) {
      // 规则 2：identity rule（从 registry 读 pattern，section=system + segment_start）
      // 不依赖绝对索引：billing header 存在时落在 system[1]，不存在时落在 system[0]，
      // matchesAttributionRule 只校验 section + startsWith(pattern)。
      category = "system_prompt";
      mechanism = "system_prompt_pattern";
      confidence = "exact";
      attributedSource = "harness_rule";
      lifecycle = "session";
      identityRuleId = CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.ruleId;
      if (chars > LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");
    } else if (text.trim().length > 0) {
      // 其他 system block：启发式推断为 system_prompt（可能是 CLAUDE.md 注入等）
      category = "system_prompt";
      mechanism = "system_prompt_pattern";
      confidence = "inferred";
      attributedSource = "harness_rule";
      lifecycle = "session";
      notes = ["heuristic: non-identity system block attributed as system_prompt"];
      flags.push("approximate");
    } else {
      category = "unknown";
      mechanism = "unknown";
      confidence = "unknown";
      attributedSource = "unknown";
      lifecycle = "unknown";
      notes = ["empty system block; cannot attribute"];
    }

    const segId = `pseg-system-${si}-${shortHash(text.slice(0, 64))}`;

    const segment: ContextSegment = {
      id: segId,
      section: "system",
      category,
      label: `system[${si}] ${category}`,
      sourceRefs: [proxyRef(proxyFile, jsonPath)],
      charCount: chars,
      tokenEstimate: Math.round(chars / 4),
      cacheHint: cacheHintFromControl(cc),
      lifecycle,
      flags: flags.length > 0 ? flags : undefined,
      order: si,
    };

    snapshot.segments.push(segment);

    results.push({
      id: `attr-system-${si}-${shortHash(text.slice(0, 64))}`,
      snapshotId,
      proxySegmentIds: [segId],
      category,
      attributedSource,
      sourceRefs: [proxyRef(proxyFile, jsonPath)],
      mechanism,
      confidence,
      charCount: chars,
      tokenEstimate: Math.round(chars / 4),
      notes,
      ...(identityRuleId ? { ruleId: identityRuleId } : {}),
    });
  }

  // ---- 2. tools[] 处理 -------------------------------------------------

  if (tools.length > 0) {
    const toolsJson = JSON.stringify(tools);
    const chars = charCount(toolsJson);
    const jsonPath = "reqBody.tools";
    const segId = `pseg-tools-schema-${shortHash(toolsJson.slice(0, 64))}`;
    const flags: SegmentFlag[] = [];
    if (chars > LARGE_SEGMENT_THRESHOLD) flags.push("large_segment");

    const segment: ContextSegment = {
      id: segId,
      section: "tools",
      category: "tools_schema",
      label: `tools[] (${tools.length} tools)`,
      sourceRefs: [proxyRef(proxyFile, jsonPath)],
      charCount: chars,
      tokenEstimate: Math.round(chars / 4),
      cacheHint: "none",
      lifecycle: "session",
      flags: flags.length > 0 ? flags : undefined,
      order: systemBlocks.length,
    };

    snapshot.segments.push(segment);

    results.push({
      id: `attr-tools-schema-${shortHash(toolsJson.slice(0, 64))}`,
      snapshotId,
      proxySegmentIds: [segId],
      category: "tools_schema",
      attributedSource: "harness_rule",
      sourceRefs: [proxyRef(proxyFile, jsonPath)],
      mechanism: "tools_schema_pattern",
      confidence: "exact",
      charCount: chars,
      tokenEstimate: Math.round(chars / 4),
      notes:
        chars > LARGE_SEGMENT_THRESHOLD
          ? [`large_segment_detector: tools schema ${chars} chars > ${LARGE_SEGMENT_THRESHOLD} threshold`]
          : undefined,
    });
  }

  // ---- 3. messages[] 处理 ----------------------------------------------

  // 先收集所有 tool_use_id，用于 tool_use_id_match
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    const rawContent = msg.content;
    if (!Array.isArray(rawContent)) continue;
    for (const block of rawContent) {
      if (block.type === "tool_use" && block.id) toolUseIds.add(block.id);
    }
  }

  let segOrder = systemBlocks.length + (tools.length > 0 ? 1 : 0);

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    const role = msg.role ?? "user";
    const rawContent = msg.content;

    // content 为 string 时，整条 message 视为单一 user_message 文本块
    if (typeof rawContent === "string") {
      const text = rawContent;
      const chars = charCount(text);
      const jsonPath = `reqBody.messages[${mi}].content`;
      const segId = `pseg-msg-${mi}-str-${shortHash(text.slice(0, 64))}`;

      let category: SegmentCategory;
      let mechanism: ProxySegmentAttribution["mechanism"];
      let confidence: ProxySegmentAttribution["confidence"];
      let attributedSource: MutationSourceKind;
      let lifecycle: SegmentLifecycle;
      let notes: string[] | undefined;

      if (mi === 0 && totalMessages > 1) {
        category = "prior_session_history";
        mechanism = "unknown";
        confidence = "inferred";
        attributedSource = "prior_session";
        lifecycle = "session";
        notes = [
          `prior_session_guess: messages[0].content is a plain string in a ${totalMessages}-message context`,
        ];
      } else {
        category = "user_message";
        mechanism = "unknown";
        confidence = "inferred";
        attributedSource = "jsonl";
        lifecycle = "query";
        notes = ["inferred: string content block attributed as user_message"];
      }

      const segment: ContextSegment = {
        id: segId,
        section: "messages",
        category,
        label: `messages[${mi}].content (string, ${category})`,
        role: role as "user" | "assistant",
        sourceRefs: [proxyRef(proxyFile, jsonPath)],
        charCount: chars,
        tokenEstimate: Math.round(chars / 4),
        cacheHint: "none",
        lifecycle,
        order: segOrder++,
      };
      snapshot.segments.push(segment);

      results.push({
        id: `attr-msg-${mi}-str-${shortHash(text.slice(0, 64))}`,
        snapshotId,
        proxySegmentIds: [segId],
        category,
        attributedSource,
        sourceRefs: [proxyRef(proxyFile, jsonPath)],
        mechanism,
        confidence,
        charCount: chars,
        tokenEstimate: Math.round(chars / 4),
        notes,
      });
      continue;
    }

    const blocks = rawContent ?? [];

    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      const jsonPath = `reqBody.messages[${mi}].content[${bi}]`;
      const text = block.text ?? "";
      // tool_result 的实际内容在 block.content（可能是 string 或数组）
      const toolResultContent = block.type === "tool_result" ? block.content : undefined;
      const chars =
        block.type === "text"
          ? charCount(text)
          : block.type === "tool_result"
            ? typeof toolResultContent === "string"
              ? charCount(toolResultContent)
              : charCount(JSON.stringify(toolResultContent ?? block))
            : charCount(JSON.stringify(block));

      const cc = block.cache_control;
      const flags: SegmentFlag[] = [];

      let category: SegmentCategory;
      let mechanism: ProxySegmentAttribution["mechanism"];
      let confidence: ProxySegmentAttribution["confidence"];
      let attributedSource: MutationSourceKind;
      let notes: string[] | undefined;
      let lifecycle: SegmentLifecycle;
      let toolUseId: string | undefined;

      if (block.type === "tool_use") {
        // 规则 6：tool_use_id_match
        category = "tool_use";
        mechanism = "tool_use_id_match";
        confidence = "exact";
        attributedSource = "jsonl";
        lifecycle = "query";
        toolUseId = block.id;
      } else if (block.type === "tool_result") {
        // 规则 6：tool_use_id_match — 仅在 tool_use_id 能在本次请求中找到对应 tool_use 时才是 exact
        const tid = block.tool_use_id;
        const idMatched = !!tid && toolUseIds.has(tid);
        category = "tool_result";
        mechanism = idMatched ? "tool_use_id_match" : "unknown";
        confidence = idMatched ? "exact" : "inferred";
        attributedSource = "jsonl";
        lifecycle = "query";
        toolUseId = tid;
        if (!idMatched) {
          notes = [
            `tool_use_id "${tid ?? "(missing)"}" not found in this request's tool_use blocks — confidence downgraded to inferred`,
          ];
        }
        // 规则 7：large_segment_detector
        if (chars > LARGE_SEGMENT_THRESHOLD) {
          flags.push("large_segment");
          notes = [
            `large_segment_detector: tool_result ${chars} chars > ${LARGE_SEGMENT_THRESHOLD} threshold`,
          ];
        }
      } else if (block.type === "text" && isBillingNoise(text)) {
        // 规则 1：billing_noise_pattern（messages 里出现的 billing header）
        category = "billing_noise";
        mechanism = "billing_noise_pattern";
        confidence = "exact";
        attributedSource = "harness_rule";
        lifecycle = "noise";
        flags.push("known_noise");
      } else if (block.type === "text" && isSystemReminder(text)) {
        // 规则 4：system_reminder_pattern
        category = "harness_injection";
        mechanism = "system_reminder_pattern";
        confidence = "exact";
        attributedSource = "harness_rule";
        lifecycle = "one_shot";
        flags.push("injected");
        // 规则 8：cache_hint_detector
        if (cc) {
          notes = [`cache_hint_detector: cache_control=${JSON.stringify(cc)}`];
        }
      } else if (block.type === "text" && isLocalCommand(text)) {
        // 规则 5：local_command_pattern
        category = "local_command_history";
        mechanism = "local_command_pattern";
        confidence = "exact";
        attributedSource = "harness_rule";
        lifecycle = "one_shot";
        flags.push("injected");
      } else if (block.type === "text" && role === "user" && text.trim().length > 0) {
        // 区分：是当前 query 的 user message，还是历史 session 携带的消息？
        // 规则 9：prior_session_guess —— 仅当 mi < lastUserMsgIdx 时才视为历史。
        // 最后一条 user message（lastUserMsgIdx）一定包含当前 query 的输入，不能归为历史。
        // 之前的 user turn 在多轮对话中是被 Claude Code 携带进来的历史上下文。
        // 规则 9：prior_session_guess — messages[0] 是 Claude Code 把历史对话打包进来的地方；
        // messages[1] 以后的 user turn 都是新的交互轮次，不归为历史。
        if (mi === 0 && totalMessages > 1) {
          category = "prior_session_history";
          mechanism = "unknown";
          confidence = "inferred";
          attributedSource = "prior_session";
          lifecycle = "session";
          notes = [
            `prior_session_guess: messages[0] text block in a ${totalMessages}-message context — likely repeated/historical user input`,
          ];
          flags.push("approximate");
        } else {
          category = "user_message";
          mechanism = "unknown";
          confidence = "inferred";
          attributedSource = "jsonl";
          lifecycle = "query";
          notes = [
            "inferred: user text block without structural markers — attributed as user_message",
          ];
        }
      } else if (block.type === "text" && role === "assistant") {
        category = "assistant_text";
        mechanism = "unknown";
        confidence = "inferred";
        attributedSource = "jsonl";
        lifecycle = "query";
        notes = ["inferred: assistant text block"];
      } else {
        // 规则 10：unknown（不静默吞掉）
        category = "unknown";
        mechanism = "unknown";
        confidence = "unknown";
        attributedSource = "unknown";
        lifecycle = "unknown";
        flags.push("unexplained");
        notes = [
          `unknown: messages[${mi}].content[${bi}] type=${block.type} role=${role} — no rule matched`,
        ];
      }

      const segId = `pseg-msg-${mi}-${bi}-${shortHash(text.slice(0, 64))}`;

      const segment: ContextSegment = {
        id: segId,
        section: "messages",
        category,
        label: `messages[${mi}].content[${bi}] (${category})`,
        role: role as "user" | "assistant",
        sourceRefs: [proxyRef(proxyFile, jsonPath)],
        charCount: chars,
        tokenEstimate: Math.round(chars / 4),
        cacheHint: cacheHintFromControl(cc),
        toolUseId,
        lifecycle,
        flags: flags.length > 0 ? flags : undefined,
        order: segOrder++,
      };

      snapshot.segments.push(segment);

      // 规则 8：cache_hint_detector — 对任何有 cache_control 的 block 追加说明
      const cacheNotes: string[] = [];
      if (cc) {
        cacheNotes.push(`cache_hint_detector: cache_control=${JSON.stringify(cc)} at ${jsonPath}`);
      }
      const allNotes = [...(notes ?? []), ...cacheNotes];

      results.push({
        id: `attr-msg-${mi}-${bi}-${shortHash(text.slice(0, 64))}`,
        snapshotId,
        proxySegmentIds: [segId],
        category,
        attributedSource,
        sourceRefs: [proxyRef(proxyFile, jsonPath)],
        mechanism,
        confidence,
        charCount: chars,
        tokenEstimate: Math.round(chars / 4),
        toolUseId,
        notes: allNotes.length > 0 ? allNotes : undefined,
      } as ProxySegmentAttribution & { toolUseId?: string });
    }
  }

  return results;
}

// ---- 分析工具 -----------------------------------------------------------

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

/**
 * 对 attribution 结果生成可读的 breakdown，用于验收输出。
 */
export function buildAttributionBreakdown(
  fixtureName: string,
  attributions: ProxySegmentAttribution[],
): AttributionBreakdown {
  // byCategory 聚合
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

  // top bloat sources（按 charCount 降序，取前 5）
  const topBloatSources = [...attributions]
    .sort((a, b) => (b.charCount ?? 0) - (a.charCount ?? 0))
    .slice(0, 5)
    .map((attr) => ({
      proxySegmentId: attr.proxySegmentIds[0] ?? "?",
      category: attr.category,
      charCount: attr.charCount ?? 0,
      jsonPath: (attr.sourceRefs[0] as Extract<typeof attr.sourceRefs[0], { kind: "proxy" }>)?.proxy
        ?.jsonPath ?? "?",
    }));

  // unknown segments
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
          "需要 JSONL reconciliation 或人工标注来确认来源；" +
          "可能是 compaction summary、memory injection、或未知 harness rule。",
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
