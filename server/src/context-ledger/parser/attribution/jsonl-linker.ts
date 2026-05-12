// parser/attribution/jsonl-linker：把 ParsedQuerySnapshot 中能由 JSONL 事件解释的节点
// 重写为 JsonlOrigin。
//
// 处理 4 类 deterministic 归因：
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
}

function buildIndex(events: LinkableJsonlEvent[]): JsonlIndex {
  const toolUseEventById = new Map<string, LinkableJsonlEvent>();
  const toolResultEventById = new Map<string, { event: LinkableJsonlEvent; contentText: string }>();
  const userInputEvents: LinkableJsonlEvent[] = [];
  const assistantEvents: LinkableJsonlEvent[] = [];
  const assistantTextIndex = new Map<string, LinkableJsonlEvent>();

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
  }
  userInputEvents.sort((a, b) => a.lineIdx - b.lineIdx);
  assistantEvents.sort((a, b) => a.lineIdx - b.lineIdx);

  return { toolUseEventById, toolResultEventById, userInputEvents, assistantEvents, assistantTextIndex };
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

// ─── 顶层入口 ────────────────────────────────────────────────────────────────

export interface LinkJsonlReport {
  matched: { toolUse: number; toolResult: number; userInput: number; assistantText: number };
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
    matched: { toolUse: 0, toolResult: 0, userInput: 0, assistantText: 0 },
    totalLeaves: 0,
  };

  for (const node of Object.values(snapshot.index)) {
    if (node.children.length > 0) continue;
    report.totalLeaves += 1;

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
  }

  return report;
}
