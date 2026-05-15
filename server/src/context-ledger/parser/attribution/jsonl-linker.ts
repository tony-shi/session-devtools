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
  /** assistant 事件的纯文本输出（content 中 type=text 的拼接，用于 #4 匹配）。 */
  assistantText?: string;
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
  /** 按 lineIdx 升序的所有 assistant 事件（按 assistantText 文本可定位）。 */
  assistantEvents: LinkableJsonlEvent[];
  /** assistantText (修剪后) → 事件，便于 O(1) 内容匹配。 */
  assistantTextIndex: Map<string, LinkableJsonlEvent>;
  /** attachment.type → 该类型的所有 attachment 事件（用于 #5 SmooshContent link）。 */
  attachmentEventsByType: Map<string, LinkableJsonlEvent[]>;
}

function buildIndex(events: LinkableJsonlEvent[]): JsonlIndex {
  const toolUseEventById = new Map<string, LinkableJsonlEvent>();
  const toolResultEventById = new Map<string, { event: LinkableJsonlEvent; contentText: string }>();
  const userInputEvents: LinkableJsonlEvent[] = [];
  const assistantEvents: LinkableJsonlEvent[] = [];
  const assistantTextIndex = new Map<string, LinkableJsonlEvent>();
  const attachmentEventsByType = new Map<string, LinkableJsonlEvent[]>();

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
  }
  userInputEvents.sort((a, b) => a.lineIdx - b.lineIdx);
  assistantEvents.sort((a, b) => a.lineIdx - b.lineIdx);

  return { toolUseEventById, toolResultEventById, userInputEvents, assistantEvents, assistantTextIndex, attachmentEventsByType };
}

// 文本匹配时统一规范化（trim + 折叠连续空白）。
// 不做大小写折叠 — proxy 与 jsonl 都是 verbatim 文本，case 敏感是正确语义。
function normalizeTextKey(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

// ─── 单节点处理 ─────────────────────────────────────────────────────────────

function buildJsonlOrigin(params: {
  eventKind: JsonlEventKind;
  event: LinkableJsonlEvent;
  fallbackCallId?: number;
  fallbackTurnId?: number;
  toolUseId?: string;
  confidence: JsonlOrigin["confidence"];
  fullyCovered: boolean;
}): JsonlOrigin {
  return {
    kind: "jsonl",
    eventKind: params.eventKind,
    jsonlLineIdx: params.event.lineIdx,
    ...(params.event.callId !== undefined
      ? { sourceCallId: params.event.callId }
      : params.fallbackCallId !== undefined
        ? { sourceCallId: params.fallbackCallId }
        : {}),
    ...(params.event.turnId !== undefined
      ? { sourceTurnId: params.event.turnId }
      : params.fallbackTurnId !== undefined
        ? { sourceTurnId: params.fallbackTurnId }
        : {}),
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
    eventKind: "tool_use",
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
  node.origin = buildJsonlOrigin({
    eventKind: "tool_result",
    event: hit.event,
    fallbackCallId: ctx.callId,
    fallbackTurnId: ctx.turnId,
    toolUseId: id,
    confidence: "definitive",
    // tool_result 是 wire 原子单元（即便 SmooshContent 切出 SR 子节点，本节点作为 container 仍由 wire 协议完整解释）。
    fullyCovered: true,
  });
  return true;
}

function linkUserInputNode(node: SegmentNode, index: JsonlIndex, ctx: CallContext): boolean {
  // user_input 候选条件：
  //   - role === "user"
  //   - 是叶子节点 messages.text 或 messages.inline.free-text
  //   - messageIdx === 0（仅原始 user 输入；后续 user 消息通常是 tool_result）
  if (node.wireMeta?.messageRole !== "user") return false;
  if (node.wireMeta.messageIdx !== 0) return false;
  if (!isUserInputLikeSlot(node.slotType)) return false;
  if (node.children.length > 0) return false;

  const key = normalizeTextKey(node.rawText);
  if (key.length === 0) return false;

  // 优先：内容相等的 jsonl 事件
  for (const ev of index.userInputEvents) {
    if (ev.userText && normalizeTextKey(ev.userText) === key) {
      node.origin = buildJsonlOrigin({
        eventKind: "user_input",
        event: ev,
        fallbackCallId: ctx.callId,
        fallbackTurnId: ctx.turnId,
        confidence: "definitive",
        // 内容 normalized 相等 → 完整解释。
        fullyCovered: true,
      });
      return true;
    }
  }

  // 退而：取当前 turn 范围内首条 user input 事件 → inferred
  const inTurn = index.userInputEvents.find((ev) => ev.turnId === undefined || ev.turnId === ctx.turnId);
  if (inTurn) {
    node.origin = buildJsonlOrigin({
      eventKind: "user_input",
      event: inTurn,
      fallbackCallId: ctx.callId,
      fallbackTurnId: ctx.turnId,
      confidence: "inferred",
      // 仅按 turn 范围回退，未做内容核对 → partial。
      fullyCovered: false,
    });
    return true;
  }
  return false;
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
      eventKind: "assistant_text",
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
        eventKind: "assistant_text",
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
      eventKind: "attachment",
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
      eventKind: "attachment",
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

// ─── 顶层入口 ────────────────────────────────────────────────────────────────

export interface LinkJsonlReport {
  matched: { toolUse: number; toolResult: number; userInput: number; assistantText: number; smooshSegment: number };
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
    matched: { toolUse: 0, toolResult: 0, userInput: 0, assistantText: 0, smooshSegment: 0 },
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
    if (linkAssistantTextNode(node, index, ctx)) {
      report.matched.assistantText += 1;
      continue;
    }
    // #5：SmooshContent SR 子节点 — 仅对已被 SmoothContent rule 命中的 SR 叶节点起作用。
    if (linkSmooshSegmentNode(node, index, ctx)) {
      report.matched.smooshSegment += 1;
      continue;
    }
  }

  return report;
}
