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
// modified 标识：v1 不做（rawHash 不等的同 slot 段会被识别为 added + removed）。
// 后续如需 modified 配对，可在 buildSections 中按 slotType + 位置邻近度做后处理。

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

export interface DiffSection {
  id: DiffSectionId;
  newTotal: number;
  oldTotal: number;
  delta: number;
  counts: { added: number; removed: number; modified: number; kept: number };
  leaves: DiffLeaf[];
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
    fetchProxyReqBodyAt: (sessionId: string, ts: string, excludeProxyId?: number) => Promise<{
      reqBody: Record<string, unknown> | null;
      reqHeaders: Record<string, string>;
      proxyRequestId: number | null;
      startedAt: string;
    } | null>;
    resolveCallMeta: (sessionId: string, callId: number) => {
      call: { id: number; timestamp: string; turnId: number; sourceFile: string };
      prevCall: { id: number; timestamp: string } | null;
    } | null;
  },
): Promise<DiffTreeResult> {
  const emptySummary = { addedCount: 0, removedCount: 0, modifiedCount: 0, keptCount: 0, netCharDelta: 0 };

  const meta = helpers.resolveCallMeta(sessionId, callId);
  if (!meta) {
    return { callId, sessionId, prevCallId: null, sections: [], summary: emptySummary, error: "call not found" };
  }

  const proxy = await helpers.fetchProxyReqBodyAt(sessionId, meta.call.timestamp);
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

  // 指针配对算法（详见文件头注释）：
  //   - prev 端遇到 removed → 输出 removed
  //   - cur 端遇到 added → 输出 added
  //   - 两端都到 unchanged → 配对成 kept，同时前进
  const merged: DiffLeaf[] = [];
  let ip = 0;
  let ic = 0;

  while (ip < prevLeaves.length || ic < curLeaves.length) {
    const prevL = ip < prevLeaves.length ? prevLeaves[ip] : null;
    const curL  = ic < curLeaves.length  ? curLeaves[ic]  : null;
    const prevIsRemoved = !!prevL && prevStatus[prevL.id] === "removed";
    const curIsAdded    = !!curL  && diff.leafStatus[curL.id] === "added";

    if (prevIsRemoved && prevL) {
      merged.push(toRemovedLeaf(prevL, prevSnap!));
      ip += 1;
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

  const order: DiffSectionId[] = ["system", "tools", "messages", "other"];
  const out: DiffSection[] = [];
  for (const sid of order) {
    const leaves = map.get(sid);
    if (!leaves || leaves.length === 0) continue;
    out.push(summarizeSection(sid, leaves));
  }
  return out;
}

function summarizeSection(id: DiffSectionId, leaves: DiffLeaf[]): DiffSection {
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
  return { id, newTotal, oldTotal, delta: newTotal - oldTotal, counts, leaves };
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

// ─── 工具：内容预览 ──────────────────────────────────────────────────────────

function previewOf(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
}
