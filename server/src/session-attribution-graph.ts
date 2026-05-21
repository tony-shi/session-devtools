// session-attribution-graph：把"每个 call 单独跑出的 attribution snapshot"
// 反向投影成"jsonl event 维度的消费历史"。
//
// 数据形态：
//
//   per-call snapshot                       SessionAttributionGraph
//   ────────────────────────                ──────────────────────────────
//   Tree.leaf.origin.jsonlLineIdx  →  jsonl event[lineIdx].consumedByCallIds
//                                                                  .firstSeenInCall
//                                                                  .contextImpact
//
// 这是双向归因边的**反向**那一半 —— 正向（leaf → jsonl line）已经在 JsonlOrigin
// 上有了；session-graph 把它跨整个 session 聚合，让"jsonl event 视角"知道自己
// 在哪些 call 里被使用过。
//
// 与 audit 的关系：
//   - audit (per-call) 关心"一个 call 的 prompt 解释了多少"
//   - session-graph 关心"一个 jsonl event 影响了哪些 call"
//   - 两者用的是同一份 snapshot，只是聚合方向不同
//
// 与 scripts/audit.ts 的关系：
//   - scripts/audit.ts 是离线统计工具，跑全量、产文本报告
//   - 本服务是 server runtime，按 sessionId 现算，供 API/前端消费
//   - 计算逻辑共享 loadAttributionTree —— 不重复底层 attribution，只多一层聚合

import type { Database } from "better-sqlite3";
import { loadAttributionTree, readSessionEventsForLinker } from "./attribution-service";
import type { AttributionTreeResult } from "./attribution-service";
import {
  authorshipOf,
  type Authorship,
  type LinkableJsonlEvent,
  type JsonlEventSource,
} from "./context-ledger/parser";
import {
  buildEventIndex,
  linkMessages,
  messageFingerprint,
  sharedPrefixLength,
  type EventIndex,
} from "./session-attribution-light-linker";

// ─── 输出类型 ─────────────────────────────────────────────────────────────────

/**
 * JsonlEventAnnotation：一条 jsonl event 在"被 LLM call 消费"这一维度上的标注。
 *
 * 与 LinkableJsonlEvent 区别：
 *   - LinkableJsonlEvent  是 jsonl 行的**结构化解析**（解出 userText / toolUses / 等）
 *   - JsonlEventAnnotation 是该行在**整个 session 跑完所有 call 之后**的归宿统计
 */
export interface JsonlEventAnnotation {
  /** jsonl 行号（0-based）。 */
  lineIdx: number;
  /**
   * 事件主类型（authorship 已包含在 source 投影里）。
   * 多内容事件按"最显著的一类"取一个 source —— harness > attachment > tool >
   * assistant > user > thinking。同一事件通常只有一类核心内容。
   */
  source: JsonlEventSource;
  /** 派生：authorship 五值。前端 Origin lens 默认配色键。 */
  authorship: Authorship;
  /**
   * 首次被任一 call 的 reqBody 引用（即 reqBody leaf 的 JsonlOrigin.jsonlLineIdx
   * 指向此 lineIdx）的 callId。
   * null = 整个 session 内从未被任何 call 引用过。
   */
  firstSeenInCall: number | null;
  /**
   * 所有引用过此事件的 callId（升序去重）。
   * - length === 0 + contextImpact !== "skipped" → "pending"（未来 call 可能消费 / 异常未消费）
   * - length >= 1 → "indexed"
   */
  consumedByCallIds: number[];
  /**
   * 该事件在"上下文影响力"上的归属：
   *
   *   "indexed"  — 至少进过一次 reqBody，是 LLM 真实看到的 token
   *   "skipped"  — 事件本身无可消费内容（system metadata / sidechain base 等），
   *                按设计永远不会进 reqBody
   *   "pending"  — 有可消费内容但**没**被任何已审 call 引用。可能是异常（dropped）、
   *                也可能是 audit 还没覆盖到的 call 范围
   */
  contextImpact: "indexed" | "skipped" | "pending";
  /**
   * True when `firstSeenInCall` is the earliest *audited* call but unaudited
   * calls exist before it — meaning the "true" first-seen call might be one
   * of those unaudited calls, not this one. Front-end uses this to hide the
   * jump chip (or show a "audit gap" warning) so users aren't misled into
   * thinking the event was first consumed by a call hundreds of slots later.
   *
   * Typical trigger: user started a session before installing the local
   * proxy → first N calls have no reqBody → graph can only see references
   * from call N+1 onward, so every event from the unaudited prefix gets
   * firstSeenInCall = N+1 (the first audited call), which is misleading.
   */
  firstSeenIsAfterAuditGap?: boolean;
}

/** 归因 skip 分类：让前端能用结构化方式渲染（NoProxyDot vs amber 文字 vs 错误样式），
 *  不必再字符串 sniff 服务端的诊断 message。`reason` 字段保留诊断原文。 */
export type UnauditedKind = "no-proxy" | "drilldown-miss" | "parse-error" | "other";

export interface UnauditedCall {
  callId: number;
  /** 结构化分类，前端按此切视觉。 */
  kind: UnauditedKind;
  /** 服务端原文（开发者诊断 / 兜底 tooltip 文案）。 */
  reason: string;
}

export interface SessionAttributionGraph {
  sessionId: string;
  /** 按 lineIdx 升序排列；含全部已解析的 jsonl 行，包括 contextImpact="skipped" 的。 */
  events: JsonlEventAnnotation[];
  /** session 内已被成功 audit 的 call.id（reverse 反查的输入域）。升序。 */
  auditedCallIds: number[];
  /** 跳过的 call（无 proxy / 错号 / fork）—— 报告给前端，让用户知道 graph 的"已知边界"。 */
  unauditedCallIds: UnauditedCall[];
}

// ─── helper 形状（与 loadAttributionTree 兼容） ──────────────────────────────

export interface SessionGraphHelpers {
  /** 列出 session 全部 call 的 (id, sourceFile)。顺序为 call.id 升序。 */
  listCalls: (sessionId: string) => Array<{ callId: number; sourceFile: string }>;
  /** loadAttributionTree 的 helper，与 attribution-service 的同名结构兼容。 */
  loadCallHelpers: Parameters<typeof loadAttributionTree>[3];
}

// ─── 单事件辅助 ──────────────────────────────────────────────────────────────

/**
 * 把 LinkableJsonlEvent 的内容维度收敛成一个 "主 source" —— 多内容事件按显著
 * 性优先级取最重要的一类。这个 source 给 annotation.authorship 做投影用。
 */
function pickPrimarySource(ev: LinkableJsonlEvent): JsonlEventSource {
  if (ev.harnessInjection) return "harness_injection";
  if (ev.commandText) return "system_local_command";
  if (ev.attachment) return "attachment";
  if (ev.toolUses && ev.toolUses.length > 0) return "tool_use";
  if (ev.toolResults && ev.toolResults.length > 0) return "tool_result";
  if (ev.assistantText) return "assistant_text";
  if (ev.userText) return "user_input";
  if (ev.thinkingBlocks && ev.thinkingBlocks.length > 0) return "thinking";
  return "unknown";
}

/**
 * authorship 在 jsonl event 维度的投影（不走 origin 中转）。结构与 authorshipOf
 * 镜像，但输入是 LinkableJsonlEvent 而非 SegmentOrigin。
 */
function eventAuthorshipOf(ev: LinkableJsonlEvent): Authorship {
  if (ev.harnessInjection) return "harness";
  if (ev.commandText) return "harness";        // CLI 命令外壳 / 输出
  if (ev.attachment) return "harness";         // task_reminder 等 CLI 注入
  if (ev.toolResults && ev.toolResults.length > 0) return "tool_protocol";
  if (ev.toolUses && ev.toolUses.length > 0) return "assistant";
  if (ev.assistantText || (ev.thinkingBlocks && ev.thinkingBlocks.length > 0)) return "assistant";
  if (ev.userText) return "human";
  return "unattributed";
}

/**
 * 该事件是否有"任何会进入 reqBody 的可消费内容"。没有 → contextImpact="skipped"。
 * 这是把 jsonl 里大量 system metadata / sidechain base / 空 user event 从
 * "未消费"统计里剥离的关键判据。
 */
function isConsumableEvent(ev: LinkableJsonlEvent): boolean {
  return Boolean(
    ev.userText
      || ev.commandText
      || ev.assistantText
      || (ev.toolUses && ev.toolUses.length > 0)
      || (ev.toolResults && ev.toolResults.length > 0)
      || ev.harnessInjection
      || ev.attachment
      || (ev.userImages && ev.userImages.length > 0)
      || (ev.thinkingBlocks && ev.thinkingBlocks.length > 0),
  );
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 计算 session 的 attribution graph。
 *
 * 流程：
 *   1. 读取整 session 的 jsonl events 一次（适配为 LinkableJsonlEvent[]）
 *   2. 对每个 call 跑 loadAttributionTree
 *   3. 遍历 snapshot.nodeSummaries，收集 origin.kind=jsonl 的 jsonlLineIdx
 *   4. 反向建立 lineIdx → Set<callId>，再投影成每事件的 annotation
 */
export async function computeSessionAttributionGraph(
  sessionId: string,
  db: Database,
  helpers: SessionGraphHelpers,
  opts?: { algorithm?: "incremental" | "legacy" },
): Promise<SessionAttributionGraph> {
  const algorithm = opts?.algorithm ?? "incremental";
  if (algorithm === "legacy") {
    return computeSessionAttributionGraphLegacy(sessionId, db, helpers);
  }
  return computeSessionAttributionGraphIncremental(sessionId, db, helpers);
}

// ─── Incremental algorithm (default) ────────────────────────────────────────
//
// For each call:
//   1. fetch its reqBody via the same proxy hook the legacy path uses
//   2. compute message fingerprints
//   3. shared-prefix-length with prev call → only audit the *tail* messages
//   4. inherit prev call's consumedLineIdxs (the cached prefix already touched
//      those events); union with the tail's freshly-linked lineIdxs.
//
// Uses a `light linker` (see session-attribution-light-linker.ts) that walks
// reqBody.messages directly and matches by id / content-hash — skipping the
// expensive ParsedQuerySnapshot tree build that loadAttributionTree does.
//
// Falls back to a per-call full audit when the proxy reqBody is missing for
// some call (mcli / no proxy / fork) — that call goes into unauditedCallIds.
//
// Performance: 32478a3f session, lastN=20: ~74s (legacy) → ~1-3s expected.
// Correctness: see ./session-attribution-light-linker.ts coverage notes.
async function computeSessionAttributionGraphIncremental(
  sessionId: string,
  _db: Database,
  helpers: SessionGraphHelpers,
): Promise<SessionAttributionGraph> {
  const calls = helpers.listCalls(sessionId);
  if (calls.length === 0) {
    return { sessionId, events: [], auditedCallIds: [], unauditedCallIds: [] };
  }

  const sourceFile = calls[0].sourceFile;
  const events: LinkableJsonlEvent[] = readSessionEventsForLinker(sourceFile);
  const eventIndex: EventIndex = buildEventIndex(events);

  const callConsumers: Array<{ callId: number; consumedLineIdxs: number[] }> = [];
  const unauditedCallIds: UnauditedCall[] = [];

  // Cross-call carry: lets us audit only the tail messages and inherit the
  // prefix's consumedLineIdxs without re-linking.
  let prevMessages: unknown[] | null = null;
  let prevFingerprints: string[] = [];
  let prevConsumedLineIdxs: Set<number> | null = null;

  for (const { callId } of calls) {
    const meta = helpers.loadCallHelpers.resolveCallMeta(sessionId, callId);
    if (!meta) {
      unauditedCallIds.push({ callId, kind: "drilldown-miss", reason: "call not found in session drilldown" });
      continue;
    }
    const proxy = await helpers.loadCallHelpers.fetchProxyReqBodyAt(
      sessionId, meta.call.timestamp, undefined, meta.call.apiRequestId,
    );
    if (!proxy || !proxy.reqBody) {
      unauditedCallIds.push({ callId, kind: "no-proxy", reason: "proxy reqBody unavailable for this call" });
      continue;
    }

    const messages: unknown[] = Array.isArray((proxy.reqBody as { messages?: unknown[] }).messages)
      ? (proxy.reqBody as { messages: unknown[] }).messages
      : [];
    // Fingerprint each message (cheap structural hash; see light-linker).
    // We compare these to the previous call's fingerprints to find how much
    // prefix is shared, so only newly appended tail messages need linking.
    const curFingerprints = messages.map((m) => messageFingerprint(m as never));

    const auditStart = prevMessages != null
      ? sharedPrefixLength(prevFingerprints, curFingerprints)
      : 0;
    // tail = messages from auditStart onward (everything newer than what
    // prev call already saw). When auditStart === 0 (cache miss / first
    // call / compaction), this is the full message list — same cost as
    // the legacy path's per-call linker run.
    const tail = messages.slice(auditStart);
    const tailMatched = linkMessages(tail as never[], eventIndex);

    // Inherit prefix consumedLineIdxs from prev call, union with tail matches.
    const consumedThisCall: Set<number> = prevConsumedLineIdxs != null
      ? new Set(prevConsumedLineIdxs)
      : new Set<number>();
    for (const li of tailMatched) consumedThisCall.add(li);

    callConsumers.push({
      callId,
      consumedLineIdxs: [...consumedThisCall].sort((a, b) => a - b),
    });

    prevMessages = messages;
    prevFingerprints = curFingerprints;
    prevConsumedLineIdxs = consumedThisCall;
  }

  return annotateJsonlFromCallConsumers(sessionId, events, callConsumers, unauditedCallIds);
}

// ─── Legacy algorithm (kept for fallback / snapshot diff) ────────────────────
//
// Per-call full attribution via loadAttributionTree. Slow on large sessions
// (74s for 32478a3f lastN=20) but exercises the canonical linker with full
// segment tree → useful as a correctness baseline for the incremental path.
async function computeSessionAttributionGraphLegacy(
  sessionId: string,
  db: Database,
  helpers: SessionGraphHelpers,
): Promise<SessionAttributionGraph> {
  const calls = helpers.listCalls(sessionId);
  if (calls.length === 0) {
    return { sessionId, events: [], auditedCallIds: [], unauditedCallIds: [] };
  }

  const sourceFile = calls[0].sourceFile;
  const events: LinkableJsonlEvent[] = readSessionEventsForLinker(sourceFile);

  const callConsumers: Array<{ callId: number; consumedLineIdxs: number[] }> = [];
  const unauditedCallIds: UnauditedCall[] = [];

  for (const { callId } of calls) {
    let result: AttributionTreeResult;
    try {
      result = await loadAttributionTree(sessionId, callId, db, helpers.loadCallHelpers);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      unauditedCallIds.push({
        callId,
        // loadAttributionTree 抛错通常是 parser / serializer 出问题；
        // 用 substring 兜底识别 "proxy reqBody" 的情况（理论上不会走到，
        // 但 helpers 私下可能 throw 而不是返回 falsy），其他归 parse-error。
        kind: /proxy.*reqBody|reqBody.*proxy/i.test(msg) ? "no-proxy" : "parse-error",
        reason: msg,
      });
      continue;
    }
    if (!result.snapshot) {
      const msg = result.error ?? "no snapshot";
      unauditedCallIds.push({
        callId,
        kind: /proxy.*reqBody|no.*proxy|reqBody.*unavail/i.test(msg) ? "no-proxy" : "other",
        reason: msg,
      });
      continue;
    }
    const consumedLineIdxs: number[] = [];
    for (const node of Object.values(result.snapshot.nodeSummaries)) {
      const origin = node.origin;
      if (origin.kind !== "jsonl") continue;
      const li = origin.jsonlLineIdx;
      if (typeof li !== "number") continue;
      consumedLineIdxs.push(li);
    }
    callConsumers.push({ callId, consumedLineIdxs });
  }

  return annotateJsonlFromCallConsumers(sessionId, events, callConsumers, unauditedCallIds);
}

/**
 * 纯函数版本：给定 events + 每个 call 的 consumed lineIdx 列表，产出 annotation。
 *
 * 抽出来的目的：上层 IO（DB 查询 / proxy decompress / attribution）和反查聚合
 * 解耦。前者难单元测，后者纯函数易测。
 */
export function annotateJsonlFromCallConsumers(
  sessionId: string,
  events: LinkableJsonlEvent[],
  callConsumers: Array<{ callId: number; consumedLineIdxs: number[] }>,
  unauditedCallIds: UnauditedCall[] = [],
): SessionAttributionGraph {
  // 反向建立 lineIdx → Set<callId>
  const lineIdxToCalls = new Map<number, Set<number>>();
  const auditedCallIds: number[] = [];
  for (const { callId, consumedLineIdxs } of callConsumers) {
    auditedCallIds.push(callId);
    for (const li of consumedLineIdxs) {
      const bucket = lineIdxToCalls.get(li);
      if (bucket) bucket.add(callId);
      else lineIdxToCalls.set(li, new Set([callId]));
    }
  }

  // For audit-gap detection: any event whose firstSeenInCall equals the
  // smallest audited callId AND there exists an unaudited call with a
  // smaller id, is suspicious. The "true" first-seen might live in those
  // unaudited slots, but we have no proxy data to verify. Mark such events
  // so the front-end can warn / hide the jump chip.
  //
  // Common trigger: user installed proxy mid-session — all calls before
  // installation are unaudited. Every event referenced before the proxy
  // window ends up with firstSeenInCall = first-audited-call (e.g. 70),
  // even though logically the previous call (say #2) consumed it.
  const minAuditedCallId = auditedCallIds.length > 0
    ? Math.min(...auditedCallIds)
    : null;
  const hasUnauditedBeforeMin = minAuditedCallId != null
    && unauditedCallIds.some(u => u.callId < minAuditedCallId);

  const annotations: JsonlEventAnnotation[] = [];
  for (const ev of events) {
    const consumers = lineIdxToCalls.get(ev.lineIdx);
    const callIdsSorted = consumers ? [...consumers].sort((a, b) => a - b) : [];
    const firstSeenInCall = callIdsSorted.length > 0 ? callIdsSorted[0] : null;
    const consumable = isConsumableEvent(ev);
    const contextImpact: JsonlEventAnnotation["contextImpact"] =
      callIdsSorted.length > 0 ? "indexed" : consumable ? "pending" : "skipped";

    // Mark when firstSeen lands on the audit-window boundary and there's
    // an unaudited prefix before it — see audit-gap comment above.
    const firstSeenIsAfterAuditGap =
      firstSeenInCall != null
      && firstSeenInCall === minAuditedCallId
      && hasUnauditedBeforeMin;

    annotations.push({
      lineIdx: ev.lineIdx,
      source: pickPrimarySource(ev),
      authorship: eventAuthorshipOf(ev),
      firstSeenInCall,
      consumedByCallIds: callIdsSorted,
      contextImpact,
      ...(firstSeenIsAfterAuditGap && { firstSeenIsAfterAuditGap: true }),
    });
  }

  annotations.sort((a, b) => a.lineIdx - b.lineIdx);
  auditedCallIds.sort((a, b) => a - b);

  return {
    sessionId,
    events: annotations,
    auditedCallIds,
    unauditedCallIds,
  };
}

// ─── re-export，方便消费方少一次 import ─────────────────────────────────────
export { authorshipOf };
export type { Authorship };
