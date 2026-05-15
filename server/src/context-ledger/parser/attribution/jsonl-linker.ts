// parser/attribution/jsonl-linker：把 ParsedQuerySnapshot 中能由 JSONL 事件解释的节点
// 重写为 JsonlOrigin。
//
// 处理 5 类 deterministic 归因：
//
//   1. messages.tool_use          → 通过 wireMeta.toolUseId 在 jsonl assistant 事件中
//                                    匹配 tool_use block id。命中即 exact。
//   2. messages.tool_result       → 通过 wireMeta.toolUseId 在 jsonl user 事件中
//                                    匹配 tool_result block 的 tool_use_id。命中即 exact。
//   3. user_input (messages[0].content 内 role=user 的非 tool_result text block)
//                                → 在 jsonl 中匹配 isHumanInput=true 的 user 事件，
//                                   优先内容相等 (exact)，否则取 callContext.turnId 范围内
//                                   首条 (inferred)。
//   4. assistant_text (role=assistant 的 messages.text 节点 / inline free-text)
//                                → 按内容相等匹配 jsonl assistant 事件的纯文本部分。
//                                   命中即 exact；找不到则保留原 origin。
//   5. SmooshContent SR 子节点    → tool_result.content 尾部切出的 system-reminder 子段。
//                                   origin 已由 SmooshContent rule 命中（task-reminder.v2 等），
//                                   此处用 jsonl attachment 内容指纹升级为 JsonlOrigin：
//                                   task-reminder ↔ attachment.type=task_reminder
//                                   queued-command ↔ attachment.type=queued_command
//                                   file-modified  ↔ attachment.type=edited_text_file
//                                   plan-mode-* 无 jsonl 来源，保留 rule origin。
//
// 设计原则：
//   - 命中才覆盖 origin；找不到不动（保留 PR 1/2 的 rule 或 structural 默认）。
//   - 全部为 O(events + nodes)，预建 index 一次性消费。
//   - 不依赖 session-drilldown-parser 的具体事件类型 — 通过 LinkableJsonlEvent 接口解耦。

import { createHash } from "crypto";
import type { ParsedQuerySnapshot, SegmentNode } from "../types";
import type { JsonlOrigin, JsonlEventKind } from "./origin";

// ─── 输入契约 ────────────────────────────────────────────────────────────────

/**
 * LinkableJsonlEvent：linker 需要的 jsonl 事件最小接口。
 *
 * 上层（session-drilldown 等）负责把它们的具体事件类型适配到这个接口；
 * linker 只消费它需要的字段，不耦合 session 数据模型。
 */
export interface LinkableJsonlEvent {
  /** 在 jsonl 中的行号（0-based）。 */
  lineIdx: number;
  /** "user" | "assistant" | "system" 或其他自定义 type。 */
  type: string;
  /** 如果事件归属某个 LLM call，提供 call id（一般是 assistant 事件的 message.id 对应 call）。 */
  callId?: number;
  /** 如果事件归属某个 user turn，提供 turn id。 */
  turnId?: number;
  /** 事件时间戳（ISO 字符串），可选。 */
  ts?: string;
  /** assistant 事件携带的 tool_use blocks（用于 #1 匹配）。 */
  toolUses?: Array<{ id: string; name?: string }>;
  /** user 事件携带的 tool_result blocks（用于 #2 匹配）。 */
  toolResults?: Array<{ toolUseId: string; contentText: string }>;
  /** user 事件的人类输入文本（isHumanInput=true 时填写，用于 #3 匹配）。 */
  userText?: string;
  /**
   * user 事件里 claude-code 注入的"本地命令/外壳"文本（slash command 调用、
   * <local-command-stdout> / <local-command-stderr> / <local-command-caveat>、
   * <bash-input> / <bash-stdout> / <bash-stderr> 等），由 isCommandLikeText 识别。
   * 拆成独立维度而非走 userText，是因为这类内容不是"人类自由输入"，
   * 在 audit / 前端展示上需要和真实人类输入区分。
   */
  commandText?: string;
  /** assistant 事件的纯文本输出（content 中 type=text 的拼接，用于 #4 匹配）。 */
  assistantText?: string;
  /**
   * assistant 事件携带的 extended thinking 块（type="thinking" / "redacted_thinking"），
   * 用于 thinking 节点按 signature deterministic 匹配。
   *   thinking          → signature: block.signature, content: block.thinking
   *   redacted_thinking → signature: block.data,     content: block.data
   */
  thinkingBlocks?: Array<{ signature: string; content: string }>;
  /** user 事件携带的 image content blocks（用于 #6 image link）。
   *  digest = sha256(source.data) 前 16 位（base64 形态）或 sha256(source.url) 前 16 位（url 形态）。 */
  userImages?: Array<{ digest: string; mediaType?: string; sourceType: "base64" | "url" }>;
  /** attachment 事件（type === "attachment"）携带的内容，用于 #5 SmooshContent 子段 link。 */
  attachment?: {
    /** "task_reminder" | "queued_command" | "edited_text_file" | 其他自定义。 */
    type: string;
    /** attachment 的原始内容（任意结构，linker 会做最少必要的解析）。 */
    content?: unknown;
    /** queued_command 专用：prompt 文本（content 为空时备用）。 */
    prompt?: unknown;
    /** parentUuid 链关系，用于辅助溯源。 */
    parentUuid?: string;
    /** record 自身的 uuid。 */
    uuid?: string;
  };
}

/**
 * CallContext：linker 操作的"参考坐标"。
 *
 * 用于：判断 user_input 应当锚定到哪一条 user 事件，以及给 JsonlOrigin 填充
 * sourceCallId / sourceTurnId 默认值。
 */
export interface CallContext {
  /** 当前 proxy request 对应的 LLM call id。 */
  callId: number;
  /** 当前 LLM call 所属的 user turn id。 */
  turnId: number;
  /** 当前 call 的时间戳，可用于事件范围筛选（可选）。 */
  ts?: string;
}

// ─── 索引构建 ────────────────────────────────────────────────────────────────

interface JsonlIndex {
  /** tool_use.id → assistant 事件（首次出现）。 */
  toolUseEventById: Map<string, LinkableJsonlEvent>;
  /** tool_use_id → 含该 tool_result 的 user 事件（首次出现）。 */
  toolResultEventById: Map<string, { event: LinkableJsonlEvent; contentText: string }>;
  /** 按 lineIdx 升序的所有 user (isHumanInput) 事件。 */
  userInputEvents: LinkableJsonlEvent[];
  /** userText (normalized) → 事件，便于 O(1) 内容匹配。与 assistantTextIndex 同构。 */
  userInputTextIndex: Map<string, LinkableJsonlEvent>;
  /** 按 lineIdx 升序的所有 commandText 事件（slash command / local command / bash 外壳）。 */
  commandTextEvents: LinkableJsonlEvent[];
  /** commandText (normalized) → 事件，O(1) 内容匹配，与 userInputTextIndex 同构。 */
  commandTextIndex: Map<string, LinkableJsonlEvent>;
  /** 按 lineIdx 升序的所有 assistant 事件（按 assistantText 文本可定位）。 */
  assistantEvents: LinkableJsonlEvent[];
  /** assistantText (修剪后) → 事件，便于 O(1) 内容匹配。 */
  assistantTextIndex: Map<string, LinkableJsonlEvent>;
  /** attachment.type → 该类型的所有 attachment 事件（用于 #5 SmooshContent link）。 */
  attachmentEventsByType: Map<string, LinkableJsonlEvent[]>;
  /** thinking signature → 含该 thinking 块的 assistant 事件（用于 #7 thinking link）。 */
  thinkingEventBySignature: Map<string, LinkableJsonlEvent>;
  /** image digest → 含该 image 的 user 事件（用于 #6 image link）。 */
  userImageEventByDigest: Map<string, { event: LinkableJsonlEvent; mediaType?: string }>;
}

function buildIndex(events: LinkableJsonlEvent[]): JsonlIndex {
  const toolUseEventById = new Map<string, LinkableJsonlEvent>();
  const toolResultEventById = new Map<string, { event: LinkableJsonlEvent; contentText: string }>();
  const userInputEvents: LinkableJsonlEvent[] = [];
  const userInputTextIndex = new Map<string, LinkableJsonlEvent>();
  const commandTextEvents: LinkableJsonlEvent[] = [];
  const commandTextIndex = new Map<string, LinkableJsonlEvent>();
  const assistantEvents: LinkableJsonlEvent[] = [];
  const assistantTextIndex = new Map<string, LinkableJsonlEvent>();
  const attachmentEventsByType = new Map<string, LinkableJsonlEvent[]>();
  const userImageEventByDigest = new Map<string, { event: LinkableJsonlEvent; mediaType?: string }>();
  const thinkingEventBySignature = new Map<string, LinkableJsonlEvent>();

  for (const ev of events) {
    if (ev.toolUses) {
      for (const tu of ev.toolUses) {
        if (!toolUseEventById.has(tu.id)) toolUseEventById.set(tu.id, ev);
      }
    }
    if (ev.toolResults) {
      for (const tr of ev.toolResults) {
        if (!toolResultEventById.has(tr.toolUseId)) {
          toolResultEventById.set(tr.toolUseId, { event: ev, contentText: tr.contentText });
        }
      }
    }
    if (ev.userText !== undefined) {
      userInputEvents.push(ev);
      const key = normalizeTextKey(ev.userText);
      if (key.length > 0 && !userInputTextIndex.has(key)) {
        userInputTextIndex.set(key, ev);
      }
    }
    if (ev.commandText !== undefined) {
      commandTextEvents.push(ev);
      const key = normalizeTextKey(ev.commandText);
      if (key.length > 0 && !commandTextIndex.has(key)) {
        commandTextIndex.set(key, ev);
      }
    }
    if (ev.assistantText !== undefined) {
      assistantEvents.push(ev);
      const key = normalizeTextKey(ev.assistantText);
      if (key.length > 0 && !assistantTextIndex.has(key)) {
        assistantTextIndex.set(key, ev);
      }
    }
    if (ev.attachment) {
      const bucket = attachmentEventsByType.get(ev.attachment.type) ?? [];
      bucket.push(ev);
      attachmentEventsByType.set(ev.attachment.type, bucket);
    }
    if (ev.userImages) {
      for (const img of ev.userImages) {
        if (!userImageEventByDigest.has(img.digest)) {
          userImageEventByDigest.set(img.digest, { event: ev, mediaType: img.mediaType });
        }
      }
    }
    if (ev.thinkingBlocks) {
      for (const tb of ev.thinkingBlocks) {
        // signature 全局唯一 —— Anthropic 服务端按 thinking 内容 hash 出的 token，
        // 撞 key 几乎不可能；保守起见仍只保留首次，与 toolUse / image 同样语义。
        if (!thinkingEventBySignature.has(tb.signature)) {
          thinkingEventBySignature.set(tb.signature, ev);
        }
      }
    }
  }
  userInputEvents.sort((a, b) => a.lineIdx - b.lineIdx);
  commandTextEvents.sort((a, b) => a.lineIdx - b.lineIdx);
  assistantEvents.sort((a, b) => a.lineIdx - b.lineIdx);

  return { toolUseEventById, toolResultEventById, userInputEvents, userInputTextIndex, commandTextEvents, commandTextIndex, assistantEvents, assistantTextIndex, attachmentEventsByType, userImageEventByDigest, thinkingEventBySignature };
}

// 文本匹配时统一规范化（trim + 折叠连续空白）。
// 不做大小写折叠 — proxy 与 jsonl 都是 verbatim 文本，case 敏感是正确语义。
function normalizeTextKey(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Claude Code 在 user 消息里注入的本地命令/外壳 tag 列表。
 *
 * 这些 tag 永远在文本起始位置，由 claude-code CLI deterministic 生成，
 * 形态固定 —— 不是人类自由输入。把它们从 userText 拆出独立维度 (commandText)，
 * audit 才能区分"人类真正打字"和"CLI 注入的命令外壳/输出"。
 *
 * 维护提示：claude-code 新增 tag 时只需扩这一个正则。adapter / linker 都从
 * 同一个 isCommandLikeText 出发，源头唯一。
 */
export const COMMAND_TEXT_PREFIX_RE =
  /^<(?:command-name|local-command-(?:stdout|stderr|caveat)|bash-(?:input|stdout|stderr))>/;

/** 判断一段文本是否为 claude-code 注入的本地命令/外壳块。trim 后按起始 tag 锚定。 */
export function isCommandLikeText(text: string): boolean {
  return COMMAND_TEXT_PREFIX_RE.test(text.trimStart());
}

// ─── 单节点处理 ─────────────────────────────────────────────────────────────

function buildJsonlOrigin(params: {
  eventKind: JsonlEventKind;
  /** Event whose `lineIdx` will be used as the evidence pointer (`@Lnn`). */
  event: LinkableJsonlEvent;
  fallbackCallId?: number;
  fallbackTurnId?: number;
  toolUseId?: string;
  confidence: JsonlOrigin["confidence"];
  fullyCovered: boolean;
  /** Optional explicit override for the `sourceCallId` field. When set, this
   *  takes precedence over both `event.callId` and `fallbackCallId`. Used by
   *  tool_result linking — the consuming user event is on the *next* call,
   *  but the meaningful "source" is the call that emitted the matching
   *  tool_use, so the back-link UI lands on that producer. */
  sourceCallIdOverride?: number;
  sourceTurnIdOverride?: number;
}): JsonlOrigin {
  const resolvedCallId =
    params.sourceCallIdOverride !== undefined
      ? params.sourceCallIdOverride
      : params.event.callId !== undefined
        ? params.event.callId
        : params.fallbackCallId;
  const resolvedTurnId =
    params.sourceTurnIdOverride !== undefined
      ? params.sourceTurnIdOverride
      : params.event.turnId !== undefined
        ? params.event.turnId
        : params.fallbackTurnId;
  return {
    kind: "jsonl",
    eventKind: params.eventKind,
    jsonlLineIdx: params.event.lineIdx,
    ...(resolvedCallId !== undefined ? { sourceCallId: resolvedCallId } : {}),
    ...(resolvedTurnId !== undefined ? { sourceTurnId: resolvedTurnId } : {}),
    ...(params.toolUseId ? { toolUseId: params.toolUseId } : {}),
    confidence: params.confidence,
    fullyCovered: params.fullyCovered,
  };
}

function linkToolUseNode(node: SegmentNode, index: JsonlIndex, ctx: CallContext): boolean {
  if (node.slotType !== "messages.tool_use") return false;
  const id = node.wireMeta?.toolUseId;
  if (!id) return false;
  const event = index.toolUseEventById.get(id);
  if (!event) return false;
  node.origin = buildJsonlOrigin({
    eventKind: { source: "tool_use" },
    event,
    fallbackCallId: ctx.callId,
    fallbackTurnId: ctx.turnId,
    toolUseId: id,
    confidence: "definitive",
    // tool_use 是 wire 原子单元，id 精确匹配即整段被解释。
    fullyCovered: true,
  });
  return true;
}

function linkToolResultNode(node: SegmentNode, index: JsonlIndex, ctx: CallContext): boolean {
  if (node.slotType !== "messages.tool_result") return false;
  const id = node.wireMeta?.toolUseId;
  if (!id) return false;
  const hit = index.toolResultEventById.get(id);
  if (!hit) return false;
  // Evidence line stays on the consuming user event (that JSONL row IS the
  // tool_result payload). But the `sourceCallId` we expose to attribution
  // consumers should be the call that asked for this execution — i.e. the
  // call that emitted the matching tool_use — not the consuming call (which
  // is just `ctx.callId`, the current one being inspected). Pointing back at
  // self is what the UI used to show; the override below fixes that so the
  // "open source call" link lands on the producer.
  const toolUseEvent = index.toolUseEventById.get(id);
  node.origin = buildJsonlOrigin({
    eventKind: { source: "tool_result" },
    event: hit.event,
    fallbackCallId: ctx.callId,
    fallbackTurnId: ctx.turnId,
    toolUseId: id,
    confidence: "definitive",
    // tool_result 是 wire 原子单元（即便 SmooshContent 切出 SR 子节点，本节点作为 container 仍由 wire 协议完整解释）。
    fullyCovered: true,
    sourceCallIdOverride: toolUseEvent?.callId,
    sourceTurnIdOverride: toolUseEvent?.turnId,
  });
  return true;
}

function linkUserInputNode(node: SegmentNode, index: JsonlIndex, ctx: CallContext): boolean {
  // user_input 候选条件（与 assistant_text 路径对称）：
  //   - role === "user"
  //   - 是叶子节点 messages.text / messages.inline.free-text / side-query.user
  //
  // 不再用 messageIdx 当判据。多轮会话里第二轮新人类输入位于 messages[N>0]
  // （proxy 累积态自然结果），按 messageIdx===0 过滤会把它们漏掉。slot 类型已经
  // 通过 isUserInputLikeSlot 把 tool_result / smoosh SR 子段 / command 类文本排除；
  // 此处只依赖内容相等做 deterministic join，与 assistantTextIndex 同构。
  if (node.wireMeta?.messageRole !== "user") return false;
  if (!isUserInputLikeSlot(node.slotType)) return false;
  if (node.children.length > 0) return false;

  const key = normalizeTextKey(node.rawText);
  if (key.length === 0) return false;

  // 内容相等：O(1) hash 命中即 definitive。
  // 不再走"取 turn 内首条事件"的 inferred 兜底 —— 在产线 LinkableJsonlEvent.turnId
  // 长期为 undefined（attribution-service.readSessionEventsForLinker 未填写）的
  // 实情下，那条兜底实际上等价于"无差别拿全 session 首条 user-input"，会把任何
  // 非首条 turn 的 user 文本误绑到首条 turn 上。改成等值不命中即 structural，
  // 让 audit 的 none/structural_no_rule 桶更诚实地反映"没被 deterministic 解释"。
  const exact = index.userInputTextIndex.get(key);
  if (!exact) return false;
  node.origin = buildJsonlOrigin({
    eventKind: { source: "user_input", contentType: "text" },
    event: exact,
    fallbackCallId: ctx.callId,
    fallbackTurnId: ctx.turnId,
    confidence: "definitive",
    fullyCovered: true,
  });
  return true;
}

function linkCommandTextNode(node: SegmentNode, index: JsonlIndex, ctx: CallContext): boolean {
  // command-text 候选条件：与 user_input 同槽位（role=user 的文本叶子），但文本
  // 必须以 COMMAND_TEXT_PREFIX_RE 锚定的 tag 开头。这一限制让候选集严格收敛到
  // claude-code 注入的 slash command / local command / bash 外壳块，避免和普通
  // user_input 抢命中。adapter 那一头由同一个 isCommandLikeText 把这类文本
  // 路由进 commandText 维度，本函数只对这类节点尝试匹配。
  if (node.wireMeta?.messageRole !== "user") return false;
  if (!isUserInputLikeSlot(node.slotType)) return false;
  if (node.children.length > 0) return false;
  if (!isCommandLikeText(node.rawText)) return false;

  const key = normalizeTextKey(node.rawText);
  if (key.length === 0) return false;

  const exact = index.commandTextIndex.get(key);
  if (!exact) return false;
  node.origin = buildJsonlOrigin({
    eventKind: { source: "system_local_command", contentType: "text" },
    event: exact,
    fallbackCallId: ctx.callId,
    fallbackTurnId: ctx.turnId,
    confidence: "definitive",
    fullyCovered: true,
  });
  return true;
}

function linkAssistantTextNode(node: SegmentNode, index: JsonlIndex, ctx: CallContext): boolean {
  // assistant_text 候选条件：role === "assistant" 且是文本叶子。
  if (node.wireMeta?.messageRole !== "assistant") return false;
  if (!isAssistantTextLikeSlot(node.slotType)) return false;
  if (node.children.length > 0) return false;

  const key = normalizeTextKey(node.rawText);
  if (key.length === 0) return false;

  // 1) 完全相等
  const exact = index.assistantTextIndex.get(key);
  if (exact) {
    node.origin = buildJsonlOrigin({
      eventKind: { source: "assistant_text", contentType: "text" },
      event: exact,
      fallbackCallId: ctx.callId,
      fallbackTurnId: ctx.turnId,
      confidence: "definitive",
      // 内容 normalized 相等 → 完整解释。
      fullyCovered: true,
    });
    return true;
  }

  // 2) jsonl 事件文本"包含" node 内容（claude-code 有时会在 assistant 输出里追加
  //    系统拼接，proxy 看到的是较短的真子串） — 视作 estimated。
  for (const ev of index.assistantEvents) {
    if (!ev.assistantText) continue;
    if (normalizeTextKey(ev.assistantText).includes(key)) {
      node.origin = buildJsonlOrigin({
        eventKind: { source: "assistant_text", contentType: "text" },
        event: ev,
        fallbackCallId: ctx.callId,
        fallbackTurnId: ctx.turnId,
        confidence: "estimated",
        // 严格 v1：非精确相等一律视为 partial（即使 node 整段是 jsonl 子串，信心已降级）。
        fullyCovered: false,
      });
      return true;
    }
  }
  return false;
}

function isUserInputLikeSlot(slotType: string): boolean {
  return (
    slotType === "messages.text" ||
    slotType === "messages.inline.free-text" ||
    slotType === "side-query.user"
  );
}

function isAssistantTextLikeSlot(slotType: string): boolean {
  return slotType === "messages.text" || slotType === "messages.inline.free-text";
}

// ─── thinking 节点 link ──────────────────────────────────────────────────────
//
// thinking / redacted_thinking 块：rawText 可能为空字符串，content equality 不可靠；
// 但 wireMeta.thinkingSignature 是 Anthropic 服务端按 thinking 内容算的唯一 hash，
// 跨 turn 1:1 稳定 —— 用它在 jsonl index O(1) 查 assistant event 即定位。
function linkThinkingNode(node: SegmentNode, index: JsonlIndex, ctx: CallContext): boolean {
  if (node.slotType !== "messages.thinking") return false;
  const sig = node.wireMeta?.thinkingSignature;
  if (!sig) return false;

  const ev = index.thinkingEventBySignature.get(sig);
  if (!ev) return false;

  node.origin = buildJsonlOrigin({
    eventKind: { source: "thinking" },
    event: ev,
    fallbackCallId: ctx.callId,
    fallbackTurnId: ctx.turnId,
    confidence: "definitive",
    // signature 唯一匹配 → 整段视为已被 jsonl 解释（即便 rawText="" 也认 fullyCovered）。
    fullyCovered: true,
  });
  return true;
}

// ─── SmooshContent SR 子节点 link（#5） ──────────────────────────────────────

/** ruleId → 对应的 jsonl attachment.type。plan-mode-* 无 jsonl 来源，返回 null。 */
function smooshRuleIdToAttachmentType(ruleId: string): string | null {
  if (ruleId === "claude-code.smoosh.task-reminder.v2") return "task_reminder";
  if (ruleId === "claude-code.smoosh.queued-command.v2") return "queued_command";
  if (ruleId === "claude-code.smoosh.file-modified.v1") return "edited_text_file";
  // task-reminder.v1（旧 ruleId）保留兼容
  if (ruleId === "claude-code.messages.task-reminder.v1") return "task_reminder";
  return null;
}

/** 从 attachment.content（Task[]）渲染期望的 task list 文本，与 dynamicTaskList 字段比对。 */
function renderTaskListFromAttachment(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const lines: string[] = [];
  for (const t of content) {
    if (!t || typeof t !== "object") continue;
    const rec = t as { id?: unknown; status?: unknown; subject?: unknown };
    if (typeof rec.id !== "number" && typeof rec.id !== "string") continue;
    if (typeof rec.status !== "string") continue;
    if (typeof rec.subject !== "string") continue;
    lines.push(`#${rec.id}. [${rec.status}] ${rec.subject}`);
  }
  return lines.length > 0 ? lines.join("\n") : "";
}

/** 从 queued_command attachment 提取消息文本（content 或 prompt）。 */
function extractQueuedCommandText(attachment: NonNullable<LinkableJsonlEvent["attachment"]>): string | null {
  const src = attachment.content ?? attachment.prompt;
  if (typeof src === "string") return src;
  if (Array.isArray(src)) {
    return src
      .filter((b): b is { type?: string; text?: string } => Boolean(b) && typeof b === "object")
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return null;
}

/** 从 edited_text_file attachment 提取文件路径。 */
function extractFileModifiedPath(attachment: NonNullable<LinkableJsonlEvent["attachment"]>): string | null {
  const content = attachment.content;
  if (content && typeof content === "object" && "filename" in content) {
    const fn = (content as { filename?: unknown }).filename;
    if (typeof fn === "string") return fn;
  }
  // edited_text_file attachment 在 JSONL 顶层也可能有 filename
  const att = attachment as unknown as { filename?: unknown };
  if (typeof att.filename === "string") return att.filename;
  return null;
}

function linkSmooshSegmentNode(node: SegmentNode, index: JsonlIndex, ctx: CallContext): boolean {
  if (node.slotType !== "messages.inline.system-reminder") return false;
  const origin = node.origin;
  if (!origin || origin.kind !== "rule") return false;
  const attachmentType = smooshRuleIdToAttachmentType(origin.ruleId);
  if (!attachmentType) return false;

  const candidates = index.attachmentEventsByType.get(attachmentType) ?? [];
  if (candidates.length === 0) return false;

  // 内容指纹匹配：按 attachment 类型走对应渲染算法，与 node.rawText 做 substring 检查。
  let bestExact: LinkableJsonlEvent | null = null;
  for (const ev of candidates) {
    if (!ev.attachment) continue;
    let fingerprint: string | null = null;
    if (attachmentType === "task_reminder") {
      fingerprint = renderTaskListFromAttachment(ev.attachment.content);
    } else if (attachmentType === "queued_command") {
      fingerprint = extractQueuedCommandText(ev.attachment);
    } else if (attachmentType === "edited_text_file") {
      fingerprint = extractFileModifiedPath(ev.attachment);
    }
    // 空指纹（如 itemCount=0 的 task_reminder）退化为 type+turn 匹配；
    // 非空且 node.rawText 包含指纹则 exact 命中。
    if (fingerprint && fingerprint.length > 0 && node.rawText.includes(fingerprint)) {
      bestExact = ev;
      break;
    }
  }

  if (bestExact) {
    node.origin = buildJsonlOrigin({
      eventKind: { source: "attachment" },
      event: bestExact,
      fallbackCallId: ctx.callId,
      fallbackTurnId: ctx.turnId,
      confidence: "definitive",
      // SR 子段：attachment 指纹仅是 node.rawText 的子串（rule 解释外壳 + jsonl 解释动态片段）。
      // 严格 v1：jsonl 没有完整覆盖整段 SR → partial。
      fullyCovered: false,
    });
    return true;
  }

  // 指纹未命中 → 取同 turn 范围内首条该 type 的 attachment（inferred）。
  // 适用于 itemCount=0 task_reminder 等"内容指纹为空"的 case。
  const inTurn = candidates.find((ev) => ev.turnId === undefined || ev.turnId === ctx.turnId);
  if (inTurn) {
    node.origin = buildJsonlOrigin({
      eventKind: { source: "attachment" },
      event: inTurn,
      fallbackCallId: ctx.callId,
      fallbackTurnId: ctx.turnId,
      confidence: "inferred",
      fullyCovered: false,
    });
    return true;
  }
  return false;
}

// ─── #6 image node link ─────────────────────────────────────────────────────
//
// 从 node.rawText（matcher 写入的 image block JSON 字面量）解出 source.data 或 source.url，
// 算 sha256 前 16 位的 digest，与 JsonlIndex.userImageEventByDigest 做 O(1) 查找。
// 命中 → JsonlOrigin({source:"user_input", contentType:"image"}, definitive)。

function linkImageNode(node: SegmentNode, index: JsonlIndex, ctx: CallContext): boolean {
  if (node.slotType !== "messages.block.image") return false;

  let parsed: { source?: { type?: string; data?: string; url?: string } };
  try {
    parsed = JSON.parse(node.rawText);
  } catch {
    return false;
  }
  const src = parsed?.source;
  if (!src) return false;

  let fingerprint: string | null = null;
  if (src.type === "base64" && typeof src.data === "string") {
    fingerprint = src.data;
  } else if (src.type === "url" && typeof src.url === "string") {
    fingerprint = src.url;
  }
  if (!fingerprint) return false;

  // 使用与 attribution-service.extractUserImages 相同的 sha256 前 16 位口径。
  const digest = sha256First16(fingerprint);
  const hit = index.userImageEventByDigest.get(digest);
  if (!hit) return false;

  node.origin = buildJsonlOrigin({
    eventKind: { source: "user_input", contentType: "image" },
    event: hit.event,
    fallbackCallId: ctx.callId,
    fallbackTurnId: ctx.turnId,
    confidence: "definitive",
    // image digest 精确匹配 → 整段 rawText 由 JSONL 完整解释。
    fullyCovered: true,
  });
  return true;
}

/** sha256(s) 前 16 位（与 attribution-service.digest16 同口径）。 */
function sha256First16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// ─── 顶层入口 ────────────────────────────────────────────────────────────────

export interface LinkJsonlReport {
  matched: {
    toolUse: number;
    toolResult: number;
    /** tool_result container 被 SmooshContent 切出 SR 子段后剩下的 free-text leaf（实际工具输出）
     *  继承父节点 jsonl/tool_result origin 的数量。 */
    toolResultLeftover: number;
    userInput: number;
    commandText: number;
    assistantText: number;
    smooshSegment: number;
    userImage: number;
    thinking: number;
  };
  totalLeaves: number;
}

/**
 * linkJsonl：遍历 snapshot 所有叶子节点，对 4 类可 deterministic 归因的写入 JsonlOrigin。
 *
 * 输入 snapshot 必须先经过 attributeSnapshot（PR 2）以获得 rule origins —— 但本函数
 * 对 origin 当前值无要求：rule / structural / wire 合成 rule 都会被覆盖。
 */
export function linkJsonl(
  snapshot: ParsedQuerySnapshot,
  events: LinkableJsonlEvent[],
  ctx: CallContext,
): LinkJsonlReport {
  const index = buildIndex(events);
  const report: LinkJsonlReport = {
    matched: { toolUse: 0, toolResult: 0, toolResultLeftover: 0, userInput: 0, commandText: 0, assistantText: 0, smooshSegment: 0, userImage: 0, thinking: 0 },
    totalLeaves: 0,
  };

  for (const node of Object.values(snapshot.index)) {
    // tool_result 节点：即便它现在因 SmooshContent 切分而成为 container，也仍要尝试
    // 通过 tool_use_id 链到 jsonl —— 这是 wire-schema 节点的协议级 origin，独立于
    // 其 children 的 SR 子段 attribution。其它 container 节点照旧跳过。
    if (node.children.length > 0 && node.slotType !== "messages.tool_result") {
      continue;
    }
    if (node.children.length === 0) {
      report.totalLeaves += 1;
    }

    if (linkToolUseNode(node, index, ctx)) {
      report.matched.toolUse += 1;
      continue;
    }
    if (linkToolResultNode(node, index, ctx)) {
      report.matched.toolResult += 1;
      continue;
    }
    if (linkUserInputNode(node, index, ctx)) {
      report.matched.userInput += 1;
      continue;
    }
    // #3b：command-text — slash command / local command / bash 外壳；与 user_input
    // 互斥（前者文本以固定 tag 起始，后者不会）。放在 user_input 之后只是 try-chain
    // 的稳定顺序，命中互斥所以语义无关。
    if (linkCommandTextNode(node, index, ctx)) {
      report.matched.commandText += 1;
      continue;
    }
    if (linkAssistantTextNode(node, index, ctx)) {
      report.matched.assistantText += 1;
      continue;
    }
    // #5：SmooshContent SR 子节点 — 仅对已被 SmoothContent rule 命中的 SR 叶节点起作用。
    if (linkSmooshSegmentNode(node, index, ctx)) {
      report.matched.smooshSegment += 1;
      continue;
    }
    // #6：image content block — 通过 source.data/url 的 sha256 前 16 位指纹匹配 user 事件。
    if (linkImageNode(node, index, ctx)) {
      report.matched.userImage += 1;
      continue;
    }
    // #7：thinking 块 — wireMeta.thinkingSignature 在 assistant event 的 thinkingBlocks 上 O(1) 查。
    if (linkThinkingNode(node, index, ctx)) {
      report.matched.thinking += 1;
      continue;
    }
  }

  // 终末 pass：tool_result container 被 SmooshContent 切出 SR 子段后，剩下的
  // free-text leaf 就是真正的工具输出。它的 rawText 是父 tool_result 事件
  // contentText 的一部分（SR 段被切走后的剩余），按"父事件已 deterministic 链上"
  // 这个事实直接继承 origin 即可。
  //
  // 不在主循环里做是因为依赖父节点 origin 已写定（linkToolResultNode 已跑过）。
  // 顺序：container 在 index 里通常在子之前，但不保证；用单独 pass 安全。
  for (const node of Object.values(snapshot.index)) {
    if (node.children.length !== 0) continue;
    if (node.slotType !== "messages.inline.free-text") continue;
    if (node.origin.kind === "jsonl") continue; // 已被前面任何 linker 写过的就别覆盖
    const parent = node.parentId ? snapshot.index[node.parentId] : undefined;
    if (!parent) continue;
    if (parent.slotType !== "messages.tool_result") continue;
    if (parent.origin.kind !== "jsonl") continue;
    if (parent.origin.eventKind?.source !== "tool_result") continue;
    node.origin = buildJsonlOrigin({
      eventKind: { source: "tool_result" },
      // 直接借用父的 jsonlLineIdx：构造一个最小 event-shape 给 buildJsonlOrigin。
      // 父 origin 里已有 jsonlLineIdx 与 sourceCallId/TurnId，全部 forward。
      event: { lineIdx: parent.origin.jsonlLineIdx, type: "user", ...(parent.origin.sourceCallId !== undefined && { callId: parent.origin.sourceCallId }), ...(parent.origin.sourceTurnId !== undefined && { turnId: parent.origin.sourceTurnId }) },
      fallbackCallId: ctx.callId,
      fallbackTurnId: ctx.turnId,
      ...(parent.origin.toolUseId && { toolUseId: parent.origin.toolUseId }),
      confidence: "definitive",
      // leaf rawText 就是父事件 contentText 去掉 SR 段后剩下的实际输出 ——
      // 对 leaf 自身字节级覆盖 = 完整解释。
      fullyCovered: true,
    });
    report.matched.toolResultLeftover += 1;
  }

  return report;
}
