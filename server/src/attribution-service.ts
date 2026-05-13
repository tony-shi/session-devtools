// attribution-service：把 server 侧数据源（proxy_requests / session JSONL）
// 适配到 context-ledger 的 attributeWithJsonl 管线，并附加与上一个 call 的 tree-diff。
//
// 数据流：
//
//   sessions_meta_v2.source_file (session JSONL)         proxy_requests (reqBody + headers)
//          │                                                       │
//          └────────── readSessionEvents ───────────────────────────┴────── readProxyForCall
//                              │                                           │
//                              ▼                                           ▼
//                     LinkableJsonlEvent[]                            wire reqBody (current + previous)
//                              │                                           │
//                              └─────────────── attributeWithJsonl ────────┘
//                                                       │
//                                                       ▼
//                                          ParsedQuerySnapshot (origin 已填)
//                                                       │
//                                                       ▼  +tree-diff(previousSnapshot)
//                                          AttributionTreeResult (serializable)

import { readFileSync, existsSync } from "fs";
import type { Database } from "better-sqlite3";

import {
  attributeWithJsonl,
  computeTreeDiff,
  collectLeaves,
  type ParsedQuerySnapshot,
  type LinkableJsonlEvent,
  type LinkJsonlReport,
  type AttributionTreeDiff,
  type SegmentNode,
} from "./context-ledger/parser";
import { parseQuery, attributeSnapshot } from "./context-ledger/parser";

// ─── 服务层输出 ──────────────────────────────────────────────────────────────

export interface AttributionTreeResult {
  callId: number;
  sessionId: string;
  hasProxy: boolean;
  /** previous call 的 id，用于 UI 关联；首个 call 为 null */
  previousCallId: number | null;
  /** Serialized snapshot — tree + 平铺 index。前端按需消费。 */
  snapshot: SerializedSnapshot | null;
  /** jsonl-linker 命中统计 */
  linkReport: LinkJsonlReport | null;
  /** tree diff vs previous call；首个 call 或无 previous proxy 时为 null */
  diff: AttributionTreeDiff | null;
  /**
   * previous snapshot 的叶子摘要（含 rootSlotType + diffStatus），按 in-order 排列。
   * 仅当 prev snapshot 存在时有值。前端两行 strip 的"上一行"消费此数据。
   *
   * 不发送完整 prev 树以节省带宽 — 视图层只需要叶子，container 关系由 rootSlotType 表达。
   */
  previousLeaves?: PreviousLeafLite[];
  /** 错误信息（reqBody 缺失 / 解析失败等） */
  error?: string;
}

export interface PreviousLeafLite {
  nodeId: string;
  slotType: string;
  charCount: number;
  rawHash: string;
  preview: string;
  jsonPath: string;
  /** 该叶子归属的顶层 root 的 slotType（如 system.identity / messages.text / tools.builtin.Read） */
  rootSlotType: string;
  /** 双行 strip 上一行的着色：unchanged 灰、removed 红 */
  diffStatus: "unchanged" | "removed";
}

/**
 * SerializedSnapshot：把 ParsedQuerySnapshot 中循环引用 (parentId via index) 摊平为 JSON。
 *
 * 树结构通过 children 数组自然嵌套；index 单独提供以便 O(1) 查找。
 * 不发送整个 rawText（可能很大）— 太长的叶子只送 preview + charCount，配合 byPos 视图按需懒加载。
 */
export interface SerializedSnapshot {
  queryKind: string;
  roots: SerializedNode[];
  /** id → SerializedNode 摘要（不嵌套 children；children 在 roots 树里） */
  nodeSummaries: Record<string, SerializedNodeSummary>;
}

export interface SerializedNode {
  id: string;
  slotType: string;
  jsonPath: string;
  charCount: number;
  rawHash: string;
  /** 文本预览（长内容截断），children 节点也保留以方便单节点单独渲染 */
  preview: string;
  /** 完整 rawText — 仅对叶子节点提供（container 节点的 rawText 是子节点拼接，不必重复发送） */
  rawText?: string;
  parentId?: string;
  origin: SegmentNode["origin"];
  wireMeta?: SegmentNode["wireMeta"];
  cachePolicy?: SegmentNode["cachePolicy"];
  unknownMeta?: SegmentNode["unknownMeta"];
  children: SerializedNode[];
}

export interface SerializedNodeSummary {
  id: string;
  slotType: string;
  charCount: number;
  preview: string;
  parentId?: string;
  origin: SegmentNode["origin"];
}

// ─── 入口：加载并归因一个 call ────────────────────────────────────────────────

export async function loadAttributionTree(
  sessionId: string,
  callId: number,
  db: Database,
  helpers: {
    /** 由 controller 注入：通过 timestamp 取 proxy_requests + 读 reqBody 的复用函数 */
    fetchProxyReqBodyAt: (sessionId: string, ts: string, excludeProxyId?: number) => Promise<{
      reqBody: Record<string, unknown> | null;
      reqHeaders: Record<string, string>;
      proxyRequestId: number | null;
      startedAt: string;
    } | null>;
    /** 由 controller 注入：从 session drilldown 找出 call + prev call 的元信息 */
    resolveCallMeta: (sessionId: string, callId: number) => {
      call: { id: number; timestamp: string; turnId: number; sourceFile: string };
      prevCall: { id: number; timestamp: string } | null;
    } | null;
  },
): Promise<AttributionTreeResult> {
  const meta = helpers.resolveCallMeta(sessionId, callId);
  if (!meta) {
    return {
      callId, sessionId, hasProxy: false,
      previousCallId: null,
      snapshot: null, linkReport: null, diff: null,
      error: "call not found in session drilldown",
    };
  }

  const proxy = await helpers.fetchProxyReqBodyAt(sessionId, meta.call.timestamp);
  if (!proxy || !proxy.reqBody) {
    return {
      callId, sessionId, hasProxy: false,
      previousCallId: meta.prevCall?.id ?? null,
      snapshot: null, linkReport: null, diff: null,
      error: "proxy reqBody unavailable for this call",
    };
  }

  // —— 读 session JSONL 并适配为 LinkableJsonlEvent —— //
  const jsonlEvents = readSessionEventsForLinker(meta.call.sourceFile);

  // —— 跑归因 + jsonl link —— //
  let snapshot: ParsedQuerySnapshot;
  let linkReport: LinkJsonlReport;
  try {
    const out = attributeWithJsonl({
      reqBody: proxy.reqBody as Parameters<typeof attributeWithJsonl>[0]["reqBody"],
      proxyFile: `proxy:${proxy.proxyRequestId ?? "unknown"}`,
      reqHeaders: proxy.reqHeaders,
      ts: proxy.startedAt,
      jsonl: jsonlEvents,
      call: { callId: meta.call.id, turnId: meta.call.turnId, ts: meta.call.timestamp },
    });
    snapshot = out.snapshot;
    linkReport = out.linkReport;
  } catch (err) {
    return {
      callId, sessionId, hasProxy: true,
      previousCallId: meta.prevCall?.id ?? null,
      snapshot: null, linkReport: null, diff: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // —— 上一个 call 的 snapshot（用于 tree-diff）—— //
  let previousSnapshot: ParsedQuerySnapshot | null = null;
  if (meta.prevCall) {
    const prevProxy = await helpers.fetchProxyReqBodyAt(
      sessionId,
      meta.prevCall.timestamp,
      proxy.proxyRequestId ?? undefined,
    );
    if (prevProxy?.reqBody) {
      try {
        // previous snapshot 不需要 jsonl-linker（diff 只看 leaf rawHash）；
        // 跑 parseQuery + attributeSnapshot 已足够形成可比对的树。
        const prevSnap = parseQuery({
          reqBody: prevProxy.reqBody as Parameters<typeof parseQuery>[0]["reqBody"],
          proxyFile: `proxy:${prevProxy.proxyRequestId ?? "prev"}`,
          reqHeaders: prevProxy.reqHeaders,
          ts: prevProxy.startedAt,
        });
        attributeSnapshot(prevSnap);
        previousSnapshot = prevSnap;
      } catch {
        // previous 失败不阻塞当前 call 的归因
        previousSnapshot = null;
      }
    }
  }

  const diff = computeTreeDiff(snapshot, previousSnapshot);
  const previousLeaves = previousSnapshot
    ? serializePreviousLeaves(previousSnapshot, diff.previousLeafStatus ?? {})
    : undefined;
  return {
    callId, sessionId, hasProxy: true,
    previousCallId: meta.prevCall?.id ?? null,
    snapshot: serializeSnapshot(snapshot),
    linkReport,
    diff,
    ...(previousLeaves && { previousLeaves }),
  };
}

// ─── prev snapshot → PreviousLeafLite[] ─────────────────────────────────────

function rootSlotTypeOf(snapshot: ParsedQuerySnapshot, leaf: SegmentNode): string {
  let cur: SegmentNode | undefined = leaf;
  while (cur?.parentId) {
    cur = snapshot.index[cur.parentId];
  }
  return cur?.slotType ?? leaf.slotType;
}

function shortPreview(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

function serializePreviousLeaves(
  snapshot: ParsedQuerySnapshot,
  statusByNodeId: Record<string, "unchanged" | "removed">,
): PreviousLeafLite[] {
  const leaves = collectLeaves(snapshot.roots);
  return leaves.map((leaf) => ({
    nodeId: leaf.id,
    slotType: leaf.slotType,
    charCount: leaf.charCount,
    rawHash: leaf.rawHash,
    preview: shortPreview(leaf.rawText),
    jsonPath: leaf.jsonPath,
    rootSlotType: rootSlotTypeOf(snapshot, leaf),
    diffStatus: statusByNodeId[leaf.id] ?? "unchanged",
  }));
}

// ─── JSONL → LinkableJsonlEvent 适配 ──────────────────────────────────────────

interface RawJsonlLine {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  timestamp?: string;
  ts?: string;
  message?: {
    id?: string;
    content?: unknown;
  };
  [k: string]: unknown;
}

function isToolResultOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.length > 0 && (content as Array<{ type?: string }>).every((b) => b?.type === "tool_result");
}

function isCommandLikeUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<local-command-caveat>") ||
    t.startsWith("<local-command-stdout>") ||
    t.startsWith("<local-command-stderr>") ||
    t.startsWith("<bash-input>") ||
    t.startsWith("<bash-stdout>") ||
    t.startsWith("<bash-stderr>")
  );
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === "text" && typeof b?.text === "string")
    .map((b) => b.text ?? "")
    .join("");
}

function extractAssistantToolUses(content: unknown): Array<{ id: string; name?: string }> {
  if (!Array.isArray(content)) return [];
  return (content as Array<{ type?: string; id?: string; name?: string }>)
    .filter((b) => b?.type === "tool_use" && typeof b?.id === "string")
    .map((b) => ({ id: b.id!, ...(b.name && { name: b.name }) }));
}

function extractToolResultsFromUser(content: unknown): Array<{ toolUseId: string; contentText: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; contentText: string }> = [];
  for (const b of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
    if (b?.type !== "tool_result" || !b?.tool_use_id) continue;
    let text = "";
    if (typeof b.content === "string") text = b.content;
    else if (Array.isArray(b.content)) {
      text = (b.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c?.type === "text" && typeof c?.text === "string")
        .map((c) => c.text ?? "")
        .join("");
    }
    out.push({ toolUseId: b.tool_use_id, contentText: text });
  }
  return out;
}

function extractUserPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === "text" && typeof b?.text === "string")
    .map((b) => b.text ?? "")
    .join("");
}

export function readSessionEventsForLinker(sourceFile: string): LinkableJsonlEvent[] {
  if (!existsSync(sourceFile)) return [];
  const text = readFileSync(sourceFile, "utf-8");
  const lines = text.split("\n");
  const out: LinkableJsonlEvent[] = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const raw = lines[lineIdx];
    if (!raw) continue;
    let ev: RawJsonlLine;
    try {
      ev = JSON.parse(raw) as RawJsonlLine;
    } catch {
      continue;
    }

    const ts = ev.timestamp ?? ev.ts;
    const base: LinkableJsonlEvent = {
      lineIdx,
      type: ev.type ?? "unknown",
      ...(ts && { ts }),
    };

    if (ev.type === "user") {
      if (ev.isMeta || ev.isSidechain) {
        // meta / sidechain user 事件不参与 attribution（无 turn 关联）
        out.push(base);
        continue;
      }
      const content = ev.message?.content;
      // tool_result-only user 事件 → toolResults
      if (isToolResultOnlyContent(content)) {
        out.push({ ...base, toolResults: extractToolResultsFromUser(content) });
        continue;
      }
      // command-like user 文本（slash command 等）不算 human input
      const plain = extractUserPlainText(content);
      if (plain && !isCommandLikeUserText(plain)) {
        out.push({ ...base, userText: plain });
        continue;
      }
      out.push(base);
    } else if (ev.type === "assistant") {
      if (ev.isSidechain) {
        // sidechain assistant（如 sub-agent 内部）不参与主链 attribution
        out.push(base);
        continue;
      }
      const content = ev.message?.content;
      const assistantText = extractAssistantText(content);
      const toolUses = extractAssistantToolUses(content);
      out.push({
        ...base,
        ...(assistantText && { assistantText }),
        ...(toolUses.length > 0 && { toolUses }),
      });
    } else {
      out.push(base);
    }
  }
  return out;
}

// ─── ParsedQuerySnapshot → serializable ──────────────────────────────────────

function serializeNode(node: SegmentNode): SerializedNode {
  const isLeaf = node.children.length === 0;
  const previewText = node.rawText.length > 200
    ? node.rawText.replace(/\s+/g, " ").trim().slice(0, 197) + "..."
    : node.rawText;
  return {
    id: node.id,
    slotType: node.slotType,
    jsonPath: node.jsonPath,
    charCount: node.charCount,
    rawHash: node.rawHash,
    preview: previewText,
    // 叶子保留完整 rawText（attribution UI 需要展示）；container 不重复发送（拼接自子节点）
    ...(isLeaf && { rawText: node.rawText }),
    ...(node.parentId && { parentId: node.parentId }),
    origin: node.origin,
    ...(node.wireMeta && { wireMeta: node.wireMeta }),
    ...(node.cachePolicy && { cachePolicy: node.cachePolicy }),
    ...(node.unknownMeta && { unknownMeta: node.unknownMeta }),
    children: node.children.map(serializeNode),
  };
}

function serializeSummary(node: SegmentNode): SerializedNodeSummary {
  return {
    id: node.id,
    slotType: node.slotType,
    charCount: node.charCount,
    preview: node.rawText.length > 80
      ? node.rawText.replace(/\s+/g, " ").trim().slice(0, 77) + "..."
      : node.rawText.replace(/\s+/g, " ").trim(),
    ...(node.parentId && { parentId: node.parentId }),
    origin: node.origin,
  };
}

function serializeSnapshot(snapshot: ParsedQuerySnapshot): SerializedSnapshot {
  const nodeSummaries: Record<string, SerializedNodeSummary> = {};
  for (const node of Object.values(snapshot.index)) {
    nodeSummaries[node.id] = serializeSummary(node);
  }
  return {
    queryKind: snapshot.queryKind,
    roots: snapshot.roots.map(serializeNode),
    nodeSummaries,
  };
}
