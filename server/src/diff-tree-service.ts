// diff-tree-service：把 attribution-service 计算的 tree-diff（leafStatus / removedFromPrevious）
// 重组成"按 section 分组 + leaves 已合并到正确顺序"的 DiffTreeResult。
//
// 关键差异 vs attribution-service：
//   - 不返回完整 snapshot 树，而是扁平的 DiffLeaf[] —— 前端直接消费、不必做树到 strip 的转换
//   - removed 段已"按原位置"插回 current leaves 序列（指针配对算法）
//   - 按 system / tools / messages / other 分 section，附带 totals + counts + delta
//
// 数据流：
//   resolveCallMeta → 拿 cur + prev call
//   fetchProxyReqBodyAt(cur)  → cur reqBody  → attributeWithJsonl → curSnapshot
//   fetchProxyReqBodyAt(prev) → prev reqBody → parseQuery + attributeSnapshot → prevSnapshot
//   computeTreeDiff(curSnapshot, prevSnapshot) → diff（leafStatus / previousLeafStatus / ...）
//   buildSections(curLeaves, prevLeaves, diff) → DiffSection[]
//
// modified 标识（v2）：在 buildSections 中按 (slotType, jsonPath) 在 prev-removed × cur-added
// 之间做一次配对 —— 同槽位 + 同路径但 hash 不同的段，视为同一段被改写过，emit 一条 modified。
// 没匹配到的就退化为 added / removed 各自呈现（保留 v1 的诚实表达）。

import type { Database } from "better-sqlite3";

import {
  attributeSnapshot,
  attributeWithJsonl,
  collectLeaves,
  computeTreeDiff,
  parseQuery,
  type AttributionTreeDiff,
  type LinkableJsonlEvent,
  type ParsedQuerySnapshot,
  type SegmentNode,
} from "./context-ledger/parser";
import { readSessionEventsForLinker } from "./attribution-service.ts";

// ─── 对外类型 ────────────────────────────────────────────────────────────────

export type DiffKind = "kept" | "added" | "removed" | "modified";
export type DiffSectionId = "system" | "tools" | "messages" | "other";

export interface DiffLeaf {
  /** node id（current 端 id 或 removed 时的 prev 端 id） */
  id: string;
  slotType: string;
  /** 该 leaf 归属的顶层 root slot —— 用于 section 分组 */
  rootSlotType: string;
  kind: DiffKind;
  /** 当前 size — kept / added / modified */
  newCharCount: number;
  /** 旧 size — removed / modified */
  oldCharCount?: number;
  preview: string;
  /** 当前内容 — kept / added / modified */
  rawText?: string;
  /** 旧内容 — removed / modified */
  oldRawText?: string;
  /** 沿用 attribution 的 origin */
  origin?: SegmentNode["origin"];
  wireMeta?: SegmentNode["wireMeta"];
}

/**
 * Cache breakpoint declared on the wire via `cache_control: ephemeral`.
 * Surface every top-level block whose `cachePolicy` is set — these are the
 * positions the client *asked* Anthropic to write a cache entry at.
 * Pure declarative — does NOT claim whether the cache was actually hit;
 * the server-side resolution lives in response.usage (see CacheImpactRow).
 */
export interface PinInfo {
  /** SegmentNode.slotType — e.g. "system.main-prompt-block", "messages.tool_result" */
  slotType: string;
  /** TTL declared on the wire; default "5m" when omitted, "1h" when extended */
  ttl: "5m" | "1h";
  /** scope=global → cross-org cache pool */
  scope: "org" | "global";
  /** Char count of the block this pin sits on. Visual cue for "how much of
   *  the bar this pin represents". Not the cumulative prefix size. */
  charCount: number;
  /** Chars from the start of the **Anthropic cache prefix** (tools → system →
   *  messages, regardless of JSON field order) up to and including this pin's
   *  block. Drives the absolute X position of the pin marker over a continuous
   *  bar in the UI. */
  cumulativePrefixChars: number;
  /** Chars from the start of **this section** (within the section's own root
   *  ordering) up to and including this pin's block. Used by drill-in views
   *  to render a pin marker at the precise within-section position. */
  cumulativeSectionChars: number;
  /** Wire jsonPath of the pinned block — e.g. "reqBody.system[3]" or
   *  "reqBody.messages[4].content[1]". UI shortens it to a label like
   *  "sys[3]" / "msg[4][1]" so the user sees the exact field that carries
   *  cache_control. */
  jsonPath: string;
}

export interface DiffSection {
  id: DiffSectionId;
  newTotal: number;
  oldTotal: number;
  delta: number;
  counts: { added: number; removed: number; modified: number; kept: number };
  leaves: DiffLeaf[];
  /** cache_control markers on top-level blocks belonging to this section in
   *  the *current* request. Empty array when the section has no pins. */
  pins: PinInfo[];
}

export interface DiffTreeResult {
  callId: number;
  sessionId: string;
  prevCallId: number | null;
  /** 各 section 的 diff；未变 / 无内容的 section 不出现 */
  sections: DiffSection[];
  /** 顶层 summary，方便前端直接展示 */
  summary: {
    addedCount: number;
    removedCount: number;
    modifiedCount: number;
    keptCount: number;
    netCharDelta: number;
    /** git 风格：插入字符总数（added 全量 + modified 中 newCharCount） */
    insertedChars: number;
    /** git 风格：删除字符总数（removed 全量 + modified 中 oldCharCount） */
    deletedChars: number;
  };
  /** 错误信息（reqBody 缺失 / 解析失败等） */
  error?: string;
}

// ─── 入口 ─────────────────────────────────────────────────────────────────────

export async function loadDiffTree(
  sessionId: string,
  callId: number,
  _db: Database,
  helpers: {
    fetchProxyReqBodyAt: (
      sessionId: string,
      ts: string,
      excludeProxyId?: number,
      apiRequestId?: string | null,
    ) => Promise<{
      reqBody: Record<string, unknown> | null;
      reqHeaders: Record<string, string>;
      proxyRequestId: number | null;
      startedAt: string;
    } | null>;
    resolveCallMeta: (sessionId: string, callId: number) => {
      call: { id: number; timestamp: string; turnId: number; sourceFile: string; apiRequestId: string | null };
      prevCall: { id: number; timestamp: string; apiRequestId: string | null } | null;
    } | null;
  },
): Promise<DiffTreeResult> {
  const emptySummary = {
    addedCount: 0, removedCount: 0, modifiedCount: 0, keptCount: 0,
    netCharDelta: 0, insertedChars: 0, deletedChars: 0,
  };

  const meta = helpers.resolveCallMeta(sessionId, callId);
  if (!meta) {
    return { callId, sessionId, prevCallId: null, sections: [], summary: emptySummary, error: "call not found" };
  }

  const proxy = await helpers.fetchProxyReqBodyAt(
    sessionId, meta.call.timestamp, undefined, meta.call.apiRequestId,
  );
  if (!proxy?.reqBody) {
    return {
      callId, sessionId,
      prevCallId: meta.prevCall?.id ?? null,
      sections: [], summary: emptySummary,
      error: "proxy reqBody unavailable for this call",
    };
  }

  const jsonlEvents: LinkableJsonlEvent[] = readSessionEventsForLinker(meta.call.sourceFile);

  // —— current snapshot —— //
  let curSnapshot: ParsedQuerySnapshot;
  try {
    const out = attributeWithJsonl({
      reqBody: proxy.reqBody as Parameters<typeof attributeWithJsonl>[0]["reqBody"],
      proxyFile: `proxy:${proxy.proxyRequestId ?? "unknown"}`,
      reqHeaders: proxy.reqHeaders,
      ts: proxy.startedAt,
      jsonl: jsonlEvents,
      call: { callId: meta.call.id, turnId: meta.call.turnId, ts: meta.call.timestamp },
    });
    curSnapshot = out.snapshot;
  } catch (err) {
    return {
      callId, sessionId,
      prevCallId: meta.prevCall?.id ?? null,
      sections: [], summary: emptySummary,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // —— previous snapshot（不需 jsonl-linker，仅 parseQuery + attributeSnapshot）—— //
  let prevSnapshot: ParsedQuerySnapshot | null = null;
  if (meta.prevCall) {
    const prevProxy = await helpers.fetchProxyReqBodyAt(
      sessionId,
      meta.prevCall.timestamp,
      proxy.proxyRequestId ?? undefined,
      meta.prevCall.apiRequestId,
    );
    if (prevProxy?.reqBody) {
      try {
        const snap = parseQuery({
          reqBody: prevProxy.reqBody as Parameters<typeof parseQuery>[0]["reqBody"],
          proxyFile: `proxy:${prevProxy.proxyRequestId ?? "prev"}`,
          reqHeaders: prevProxy.reqHeaders,
          ts: prevProxy.startedAt,
        });
        attributeSnapshot(snap);
        prevSnapshot = snap;
      } catch {
        prevSnapshot = null;
      }
    }
  }

  const diff = computeTreeDiff(curSnapshot, prevSnapshot);
  const sections = buildSections(curSnapshot, prevSnapshot, diff);

  // 汇总
  const summary = { ...emptySummary };
  for (const s of sections) {
    summary.addedCount    += s.counts.added;
    summary.removedCount  += s.counts.removed;
    summary.modifiedCount += s.counts.modified;
    summary.keptCount     += s.counts.kept;
    summary.netCharDelta  += s.delta;
    for (const l of s.leaves) {
      if (l.kind === "added") {
        summary.insertedChars += l.newCharCount;
      } else if (l.kind === "removed") {
        summary.deletedChars += l.oldCharCount ?? 0;
      } else if (l.kind === "modified") {
        summary.insertedChars += l.newCharCount;
        summary.deletedChars  += l.oldCharCount ?? 0;
      }
    }
  }

  return {
    callId,
    sessionId,
    prevCallId: meta.prevCall?.id ?? null,
    sections,
    summary,
  };
}

// ─── 核心：构建合并后的 leaves，按 section 分组 ──────────────────────────────

function buildSections(
  curSnap: ParsedQuerySnapshot,
  prevSnap: ParsedQuerySnapshot | null,
  diff: AttributionTreeDiff,
): DiffSection[] {
  const curLeaves = collectLeaves(curSnap.roots);
  const prevLeaves = prevSnap ? collectLeaves(prevSnap.roots) : [];
  const prevStatus = diff.previousLeafStatus ?? {};

  // —— 方案 A：modified 配对 —— //
  // 把所有 prev-removed 按 (slotType, jsonPath) 分桶。同 cur-added 命中桶时取队首
  // 配对成 modified；prev 端再遇到该 leaf 时跳过（已被消费）。
  const removedByKey = new Map<string, SegmentNode[]>();
  for (const p of prevLeaves) {
    if (prevStatus[p.id] !== "removed") continue;
    const key = `${p.slotType}\x00${p.jsonPath}`;
    const list = removedByKey.get(key) ?? [];
    list.push(p);
    removedByKey.set(key, list);
  }
  /** curLeaf.id → 配对的 prev SegmentNode（说明这条 cur 应作为 modified emit） */
  const modifiedPair = new Map<string, SegmentNode>();
  /** prev leaf id 集合 — 已被吃成 modified，不再 emit removed */
  const consumedPrevIds = new Set<string>();
  for (const c of curLeaves) {
    if (diff.leafStatus[c.id] !== "added") continue;
    const key = `${c.slotType}\x00${c.jsonPath}`;
    const queue = removedByKey.get(key);
    if (!queue || queue.length === 0) continue;
    const matched = queue.shift()!;
    modifiedPair.set(c.id, matched);
    consumedPrevIds.add(matched.id);
  }

  // 指针配对算法（详见文件头注释）：
  //   - prev 端遇到 removed（未被 modified 吃掉）→ 输出 removed
  //   - cur 端遇到 added（无 modified 配对）→ 输出 added
  //   - cur 端遇到 added 且 modifiedPair 命中 → 输出 modified（位置随 cur）
  //   - 两端都到 unchanged → 配对成 kept，同时前进
  const merged: DiffLeaf[] = [];
  let ip = 0;
  let ic = 0;

  while (ip < prevLeaves.length || ic < curLeaves.length) {
    const prevL = ip < prevLeaves.length ? prevLeaves[ip] : null;
    const curL  = ic < curLeaves.length  ? curLeaves[ic]  : null;
    const prevIsRemoved = !!prevL && prevStatus[prevL.id] === "removed";
    const prevConsumedAsModified = !!prevL && consumedPrevIds.has(prevL.id);
    const curIsAdded    = !!curL  && diff.leafStatus[curL.id] === "added";
    const curHasModifiedPair = !!curL && modifiedPair.has(curL.id);

    if (prevConsumedAsModified) {
      // prev 端的这条已被 modified 吃掉，不输出，仅前进
      ip += 1;
    } else if (prevIsRemoved && prevL) {
      merged.push(toRemovedLeaf(prevL, prevSnap!));
      ip += 1;
    } else if (curHasModifiedPair && curL) {
      merged.push(toModifiedLeaf(curL, modifiedPair.get(curL.id)!, curSnap));
      ic += 1;
    } else if (curIsAdded && curL) {
      merged.push(toAddedLeaf(curL, curSnap));
      ic += 1;
    } else if (curL && prevL) {
      // 两端 unchanged，配对
      merged.push(toKeptLeaf(curL, curSnap));
      ip += 1;
      ic += 1;
    } else if (curL) {
      // prev 已耗尽，但 cur 剩下的 leaf 不是 added（理论上不会发生 — 防御）
      merged.push(toKeptLeaf(curL, curSnap));
      ic += 1;
    } else if (prevL) {
      // cur 已耗尽，prev 剩下的 leaf 不是 removed（不会发生 — 防御）
      ip += 1;
    } else {
      break;
    }
  }

  // 分 section
  const map = new Map<DiffSectionId, DiffLeaf[]>();
  for (const l of merged) {
    const sid = sectionOf(l.rootSlotType);
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid)!.push(l);
  }

  // 先按 section 聚合本次请求里所有带 cache_control 的顶级 block —— 这是声明式 pin 信息，
  // 与 leaf diff 独立（pin 不一定是 leaf，且不一定有变化）。
  // cumulativePrefixChars 按 Anthropic 实际 cache prefix 顺序（tools → system →
  // messages）走一遍 roots，给每个 pin 记录其 prefix 末尾的累积字符。matcher 产生
  // 的 roots 是 [system, tools, messages] 序（按 JSON 字段顺序 push），所以这里需
  // 要按 sectionOf 重新分桶再拼起来。
  // cumulativeSectionChars 是 section 内的累积位置，用于 drill-in 视图。
  const pinPositions = computePinPositions(curSnap);
  const pinSectionPositions = computeSectionInternalPositions(curSnap);
  const pinsBySection: Record<DiffSectionId, PinInfo[]> = {
    system: [], tools: [], messages: [], other: [],
  };
  for (const root of curSnap.roots) {
    if (!root.cachePolicy) continue;
    const sid = sectionOf(root.slotType);
    pinsBySection[sid].push({
      slotType: root.slotType,
      ttl: root.cachePolicy.ttl,
      scope: root.cachePolicy.scope,
      charCount: root.charCount,
      cumulativePrefixChars: pinPositions.get(root.id) ?? 0,
      cumulativeSectionChars: pinSectionPositions.get(root.id) ?? 0,
      jsonPath: root.jsonPath,
    });
  }

  // 输出顺序匹配 Anthropic 实际 cache prefix 拼接顺序：tools → system → messages → other
  const order: DiffSectionId[] = ["tools", "system", "messages", "other"];
  const out: DiffSection[] = [];
  for (const sid of order) {
    const leaves = map.get(sid);
    const pins = pinsBySection[sid];
    // 留存条件：有 leaves 变化 OR 有声明的 pin
    if ((!leaves || leaves.length === 0) && pins.length === 0) continue;
    out.push(summarizeSection(sid, leaves ?? [], pins));
  }
  return out;
}

function summarizeSection(id: DiffSectionId, leaves: DiffLeaf[], pins: PinInfo[]): DiffSection {
  let newTotal = 0;
  let oldTotal = 0;
  const counts = { added: 0, removed: 0, modified: 0, kept: 0 };
  for (const l of leaves) {
    counts[l.kind] += 1;
    switch (l.kind) {
      case "added":
        newTotal += l.newCharCount;
        break;
      case "removed":
        oldTotal += l.oldCharCount ?? 0;
        break;
      case "modified":
        newTotal += l.newCharCount;
        oldTotal += l.oldCharCount ?? 0;
        break;
      case "kept":
        newTotal += l.newCharCount;
        oldTotal += l.newCharCount;
        break;
    }
  }
  return { id, newTotal, oldTotal, delta: newTotal - oldTotal, counts, leaves, pins };
}

// ─── 工具：leaf → DiffLeaf 转换 ───────────────────────────────────────────────

function toKeptLeaf(leaf: SegmentNode, snap: ParsedQuerySnapshot): DiffLeaf {
  return {
    id: leaf.id,
    slotType: leaf.slotType,
    rootSlotType: rootSlotOf(leaf, snap),
    kind: "kept",
    newCharCount: leaf.charCount,
    preview: previewOf(leaf.rawText),
    rawText: leaf.rawText,
    origin: leaf.origin,
    ...(leaf.wireMeta && { wireMeta: leaf.wireMeta }),
  };
}

function toAddedLeaf(leaf: SegmentNode, snap: ParsedQuerySnapshot): DiffLeaf {
  return {
    id: leaf.id,
    slotType: leaf.slotType,
    rootSlotType: rootSlotOf(leaf, snap),
    kind: "added",
    newCharCount: leaf.charCount,
    preview: previewOf(leaf.rawText),
    rawText: leaf.rawText,
    origin: leaf.origin,
    ...(leaf.wireMeta && { wireMeta: leaf.wireMeta }),
  };
}

function toModifiedLeaf(curLeaf: SegmentNode, prevLeaf: SegmentNode, snap: ParsedQuerySnapshot): DiffLeaf {
  return {
    id: curLeaf.id,
    slotType: curLeaf.slotType,
    rootSlotType: rootSlotOf(curLeaf, snap),
    kind: "modified",
    newCharCount: curLeaf.charCount,
    oldCharCount: prevLeaf.charCount,
    preview: previewOf(curLeaf.rawText),
    rawText: curLeaf.rawText,
    oldRawText: prevLeaf.rawText,
    origin: curLeaf.origin,
    ...(curLeaf.wireMeta && { wireMeta: curLeaf.wireMeta }),
  };
}

function toRemovedLeaf(leaf: SegmentNode, snap: ParsedQuerySnapshot): DiffLeaf {
  return {
    id: leaf.id,
    slotType: leaf.slotType,
    rootSlotType: rootSlotOf(leaf, snap),
    kind: "removed",
    newCharCount: 0,
    oldCharCount: leaf.charCount,
    preview: previewOf(leaf.rawText),
    oldRawText: leaf.rawText,
    origin: leaf.origin,
    ...(leaf.wireMeta && { wireMeta: leaf.wireMeta }),
  };
}

// ─── 工具：从 leaf 找 root slotType ──────────────────────────────────────────

function rootSlotOf(leaf: SegmentNode, snap: ParsedQuerySnapshot): string {
  let node: SegmentNode | undefined = leaf;
  let guard = 0;
  while (node && node.parentId && guard < 64) {
    const parent: SegmentNode | undefined = snap.index[node.parentId];
    if (!parent) break;
    node = parent;
    guard += 1;
  }
  return node?.slotType ?? leaf.slotType;
}

// ─── 工具：section 归属 ──────────────────────────────────────────────────────

function sectionOf(slotType: string): DiffSectionId {
  if (slotType.startsWith("system.") || slotType === "side-query.system") return "system";
  if (slotType.startsWith("tools.")) return "tools";
  if (slotType.startsWith("messages.") || slotType === "side-query.user") return "messages";
  return "other";
}

// ─── 工具：给每个 pin 计算 cache prefix 累积位置 ─────────────────────────────
//
// Anthropic 服务端按 tools → system → messages 顺序拼 cache prefix。每个
// cache_control pin 的 prefix hash 范围是「从 prefix 起点到该 block 末尾」。
// UI 想在 bar 上方画箭头时需要这个累积值（按比例转 px）。
//
// matcher.ts 产生的 curSnap.roots 是按 JSON 字段顺序 [system, tools, messages]
// 推入的，所以这里必须按 sectionOf 重新分桶后再按 Anthropic 顺序拼一遍。

function computePinPositions(curSnap: ParsedQuerySnapshot): Map<string, number> {
  const buckets: Record<DiffSectionId, SegmentNode[]> = {
    tools: [], system: [], messages: [], other: [],
  };
  for (const r of curSnap.roots) {
    buckets[sectionOf(r.slotType)].push(r);
  }
  const ordered = [
    ...buckets.tools,
    ...buckets.system,
    ...buckets.messages,
    ...buckets.other,
  ];
  const positions = new Map<string, number>();
  let cum = 0;
  for (const r of ordered) {
    cum += r.charCount;
    if (r.cachePolicy) positions.set(r.id, cum);
  }
  return positions;
}

/** 每个 pin 在其 section 内的累积字符位置。drill-in 视图按比例画线。
 *  与 computePinPositions 不同：这里以 section 起点为 0，section 内 root 顺序累计。 */
function computeSectionInternalPositions(curSnap: ParsedQuerySnapshot): Map<string, number> {
  const cumBySection: Record<DiffSectionId, number> = {
    tools: 0, system: 0, messages: 0, other: 0,
  };
  const positions = new Map<string, number>();
  for (const r of curSnap.roots) {
    const sid = sectionOf(r.slotType);
    cumBySection[sid] += r.charCount;
    if (r.cachePolicy) positions.set(r.id, cumBySection[sid]);
  }
  return positions;
}

// ─── 工具：内容预览 ──────────────────────────────────────────────────────────

function previewOf(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
}
