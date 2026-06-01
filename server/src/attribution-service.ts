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
import { createHash } from "crypto";
import type { Database } from "better-sqlite3";
import { deriveAxes, sourceBucket } from "./context-ledger/rule-corpus/axes";

import {
  attributeWithJsonl,
  computeTreeDiff,
  collectLeaves,
  isCommandLikeText,
  authorshipOf,
  coverageStateOf,
  type ParsedQuerySnapshot,
  type LinkableJsonlEvent,
  type LinkJsonlReport,
  type AttributionTreeDiff,
  type SegmentNode,
  type ForwardAudit,
  type ReverseAudit,
  type Authorship,
  type CoverageState,
} from "./context-ledger/parser";
import { parseQuery, attributeSnapshot } from "./context-ledger/parser";
import { checkVersionAgainstBaseline } from "./context-ledger/rule-corpus/version-baseline";
import { CORPUS_LEDGER_RULES_BY_ID } from "./context-ledger/rule-corpus/runtime";

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
  /**
   * Audit 双视角（PR6 起）：
   *   - forward：proxy 叶子节点按 coverageState 分三桶（full / partial / none）
   *   - reverse：jsonl 原子单元（tool_use / tool_result / user_input / assistant_text / attachment）
   *     是否被 segment 引用，未引用进 missing 列表
   * 前端 AuditBadge / filter 直接消费此对象。
   */
  audit: { forward: ForwardAudit; reverse: ReverseAudit } | null;
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
  /**
   * 从 system[0] billing-header 抽出的 cc_version（完整四段字符串，如 "2.1.142.6c2"）。
   * 抽取失败（header 漂移 / 非 CLI 入口）时为 undefined —— 配合
   * snapshot.attributionContext.failure 一起 surface。下游可据此做按版本统计 /
   * UI 标签等无侵入派生。
   */
  ccVersion?: string;
  /**
   * 版本/归因上下文诊断（UI 关键位置的版本 badge + "为什么没归因"自助诊断）。
   *   - contextOk=false 时，attributionContext 抽取失败（billing header 未命中等），
   *     pipeline 会跳过所有依赖 ctx 的 rule（system prompt / system-reminder 类），
   *     这些 leaf 全部落 unknown —— 这是"某段没有任何归因信息"的最常见根因。
   *   - matchLevel 比对 proxy cc_version 与 corpus baseline（粗粒度温度计）。
   */
  versionDiag: {
    contextOk: boolean;
    /** ctx 失败原因（no_system_block_0 / system_block_0_not_text / billing_header_not_matched）。 */
    contextFailureKind?: string;
    /** proxy 实际 cc_version（ctx 成功时有；失败时为 null）。 */
    ccVersion: string | null;
    /** corpus 对齐的 baseline cc_version（如 "2.1.150"）。 */
    baseline: string | null;
    /** exact / minor-match / minor-mismatch / major-mismatch / unparseable / baseline-missing。 */
    matchLevel: string;
    /** 人类可读的一句话，可直接放进 UI tooltip。 */
    message: string;
  };
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
  /** 完整 rawText — 叶子节点提供；少量需要 raw 高亮的 container（如 userContext reminder）也提供。 */
  rawText?: string;
  /** 相对父节点 rawText 的字符偏移（左闭右开）；用于 raw 视图高亮。 */
  charRange?: { start: number; end: number };
  /** 展示可见性。rawOnly 节点保留在树和审计中，但默认 leaf 列表不展示。 */
  visibility?: "default" | "rawOnly";
  parentId?: string;
  origin: SegmentNode["origin"];
  /**
   * 派生轴 1：authorship（"谁写的"）。origin 多维信息在 5 值枚举上的投影，前端
   * Origin lens 默认配色键。后端单点 derive，前端只读，避免口径漂移。
   */
  authorship: Authorship;
  /**
   * 派生轴 2：coverageState（audit 三桶主轴）。origin + fullyCovered 的投影，
   * 前端 Coverage facet / 旧 Audit lens 直接消费。
   */
  coverageState: CoverageState;
  wireMeta?: SegmentNode["wireMeta"];
  cachePolicy?: SegmentNode["cachePolicy"];
  unknownMeta?: SegmentNode["unknownMeta"];
  /**
   * 用户向展示元数据（仅命中 corpus rule 的 leaf 有）。把后端 corpus 的"机器解读"
   * 透出为前端可读的"导览"信息:displayName=人类可读段名 / summary=一句话解读 /
   * stability=时间维度稳定性(static/semi-static/dynamic) / dynamicSource=动态段变的是哪部分。
   * attribution 面板（如 system 区扁平列表）据此渲染。
   */
  ruleMeta?: {
    displayName?: string;
    summary?: string;
    stability?: string;
    dynamicSource?: string;
  };
  /**
   * 正交分类轴 v2（由 axes.deriveAxes 从 slotType+ruleId 派生；rule 显式声明值优先待
   * generator 透出后接入）。前端用法:semantic 做两层(大类→细分)lens 分组;source/sourceBucket
   * 作"点开属性";位置=slotType(树);动态填充=origin.dynamicFields 非空。每个节点都带。
   */
  axes?: {
    semantic: string;        // 6 大类:identity/directive/capability/context/dialogue/meta
    semanticDetail?: string; // 语义细分(二级)
    source: string;          // 7 值来源(作者归属)
    sourceBucket: string;    // 3 桶:harness(CC自带) / user(你配置) / session(会话产生)
  };
  children: SerializedNode[];
}

export interface SerializedNodeSummary {
  id: string;
  slotType: string;
  charCount: number;
  preview: string;
  parentId?: string;
  origin: SegmentNode["origin"];
  authorship: Authorship;
  coverageState: CoverageState;
}

// ─── 入口：加载并归因一个 call ────────────────────────────────────────────────

export async function loadAttributionTree(
  sessionId: string,
  callId: number,
  db: Database,
  helpers: {
    /** 由 controller 注入：优先用 apiRequestId 精确匹配 proxy_requests, fallback 时间戳 */
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
    /** 由 controller 注入：从 session drilldown 找出 call + prev call 的元信息 */
    resolveCallMeta: (sessionId: string, callId: number) => {
      call: { id: number; timestamp: string; turnId: number; sourceFile: string; apiRequestId: string | null };
      prevCall: { id: number; timestamp: string; apiRequestId: string | null } | null;
    } | null;
    /**
     * 可选：批量调用方可以预读 LinkableJsonlEvent[] 并通过此 hook 复用，避免
     * 每个 call 都重新解析整个 session jsonl。返回 null 时退回到默认的
     * readSessionEventsForLinker(sourceFile)。
     */
    loadJsonlEvents?: (sourceFile: string) => LinkableJsonlEvent[] | null;
  },
): Promise<AttributionTreeResult> {
  const meta = helpers.resolveCallMeta(sessionId, callId);
  if (!meta) {
    return {
      callId, sessionId, hasProxy: false,
      previousCallId: null,
      snapshot: null, linkReport: null, audit: null, diff: null,
      error: "call not found in session drilldown",
    };
  }

  const proxy = await helpers.fetchProxyReqBodyAt(
    sessionId, meta.call.timestamp, undefined, meta.call.apiRequestId,
  );
  if (!proxy || !proxy.reqBody) {
    return {
      callId, sessionId, hasProxy: false,
      previousCallId: meta.prevCall?.id ?? null,
      snapshot: null, linkReport: null, audit: null, diff: null,
      error: "proxy reqBody unavailable for this call",
    };
  }

  // —— 读 session JSONL 并适配为 LinkableJsonlEvent —— //
  // 优先用 caller 提供的 hook（批量场景下一 session 缓存一次）；否则现读。
  const jsonlEvents =
    helpers.loadJsonlEvents?.(meta.call.sourceFile)
    ?? readSessionEventsForLinker(meta.call.sourceFile);

  // —— 跑归因 + jsonl link + audit —— //
  let snapshot: ParsedQuerySnapshot;
  let linkReport: LinkJsonlReport;
  let audit: { forward: ForwardAudit; reverse: ReverseAudit };
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
    audit = out.audit;
  } catch (err) {
    return {
      callId, sessionId, hasProxy: true,
      previousCallId: meta.prevCall?.id ?? null,
      snapshot: null, linkReport: null, audit: null, diff: null,
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
      meta.prevCall.apiRequestId,
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
    audit,
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
  /** Compaction-summary user event marker（compact.ts:621 注入）。与 isMeta 互斥
   *  使用：compact 注入的 user event 不打 isMeta 而是这一标志。 */
  isCompactSummary?: boolean;
  timestamp?: string;
  ts?: string;
  uuid?: string;
  parentUuid?: string;
  message?: {
    id?: string;
    content?: unknown;
  };
  attachment?: {
    type?: string;
    content?: unknown;
    prompt?: unknown;
    filename?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function isToolResultOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.length > 0 && (content as Array<{ type?: string }>).every((b) => b?.type === "tool_result");
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === "text" && typeof b?.text === "string")
    .map((b) => b.text ?? "")
    .join("");
}

/**
 * 抽取 assistant event 中的 extended thinking 块（type="thinking" / "redacted_thinking"）。
 *   thinking          → signature = block.signature, content = block.thinking ?? ""
 *   redacted_thinking → signature = block.data,      content = block.data ?? ""
 * 没有 signature/data 的块（理论上不应发生）跳过。
 */
function extractAssistantThinkingBlocks(
  content: unknown,
): Array<{ signature: string; content: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ signature: string; content: string }> = [];
  for (const b of content as Array<{ type?: string; thinking?: string; signature?: string; data?: string }>) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "thinking") {
      const sig = typeof b.signature === "string" ? b.signature : "";
      if (!sig) continue;
      out.push({ signature: sig, content: typeof b.thinking === "string" ? b.thinking : "" });
    } else if (b.type === "redacted_thinking") {
      const sig = typeof b.data === "string" ? b.data : "";
      if (!sig) continue;
      out.push({ signature: sig, content: sig });
    }
  }
  return out;
}

function extractAssistantToolUses(content: unknown): Array<{ id: string; name?: string }> {
  if (!Array.isArray(content)) return [];
  return (content as Array<{ type?: string; id?: string; name?: string }>)
    .filter((b) => b?.type === "tool_use" && typeof b?.id === "string")
    .map((b) => ({ id: b.id!, ...(b.name && { name: b.name }) }));
}

function extractToolResultsFromUser(
  content: unknown,
): Array<{ toolUseId: string; contentText: string; toolReferenceNames?: string[] }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; contentText: string; toolReferenceNames?: string[] }> = [];
  for (const b of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
    if (b?.type !== "tool_result" || !b?.tool_use_id) continue;
    let text = "";
    const toolReferenceNames: string[] = [];
    if (typeof b.content === "string") text = b.content;
    else if (Array.isArray(b.content)) {
      for (const c of b.content as Array<{ type?: string; text?: string; tool_name?: string }>) {
        if (c?.type === "text" && typeof c?.text === "string") {
          text += c.text;
        } else if (c?.type === "tool_reference" && typeof c?.tool_name === "string") {
          // ToolSearchTool 返回的 tool_reference 子块：每个对应一个被 defer-load
          // 进上下文的 MCP 工具名。Claude Code 在 API normalize 阶段会在同一条
          // user 消息末尾追加 `text:'Tool loaded.'`（restored-src/src/utils/messages.ts:2159），
          // jsonl-linker 用这里抽出的 tool_name 列表把那条合成文本回链回来。
          toolReferenceNames.push(c.tool_name);
        }
      }
    }
    out.push({
      toolUseId: b.tool_use_id,
      contentText: text,
      ...(toolReferenceNames.length > 0 && { toolReferenceNames }),
    });
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

/** 计算字符串的 sha256 前 16 位（与 rawHash 同口径），作为 image digest。 */
function digest16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** 从 user message content[] 提 image content blocks，输出供 jsonl-linker 索引的 digest 列表。
 *  base64 形态用 source.data 算 digest，url 形态用 source.url 算 digest（两者天然唯一）。 */
function extractUserImages(content: unknown): Array<{ digest: string; mediaType?: string; sourceType: "base64" | "url" }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ digest: string; mediaType?: string; sourceType: "base64" | "url" }> = [];
  for (const b of content as Array<{ type?: string; source?: { type?: string; media_type?: string; data?: string; url?: string } }>) {
    if (b?.type !== "image" || !b.source) continue;
    const src = b.source;
    if (src.type === "base64" && typeof src.data === "string") {
      out.push({ digest: digest16(src.data), sourceType: "base64", ...(src.media_type && { mediaType: src.media_type }) });
    } else if (src.type === "url" && typeof src.url === "string") {
      out.push({ digest: digest16(src.url), sourceType: "url", ...(src.media_type && { mediaType: src.media_type }) });
    }
  }
  return out;
}

export function readSessionEventsForLinker(sourceFile: string): LinkableJsonlEvent[] {
  if (!existsSync(sourceFile)) return [];
  const text = readFileSync(sourceFile, "utf-8");
  const lines = text.split("\n");
  const out: LinkableJsonlEvent[] = [];
  // 序贯扫描状态（用于识别 Skill harness 注入的触发链）：
  //   skillToolUseIds       — assistant 发过的 Skill tool_use id 集合
  //   lastToolResultUseId   — 紧邻当前事件的上一条 user.tool_result 的 tool_use_id
  //
  // 触发链：assistant.tool_use(name=Skill, id=X) → user.tool_result(X)="Launching skill: ..."
  //         → user.isMeta=true.text=<SKILL.md body>
  // 中间事件类型固定，且 isMeta=true text 事件不可能与 Skill 触发链交叉（jsonl
  // 总是按时间顺序写入）。lastToolResultUseId 只要被任一非 isMeta 事件打断就清空。
  const skillToolUseIds = new Set<string>();
  let lastToolResultUseId: string | null = null;
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
      // 0. compaction_summary：compact 后注入的 user event 用 isCompactSummary=true 标记
      //    （**不**走 isMeta；与 Skill 注入互斥）。content 通常是 string 形态。
      //    sourcemap: restored-src/src/services/compact/compact.ts:614-624 +
      //               restored-src/src/services/compact/prompt.ts:345
      if (ev.isCompactSummary === true && !ev.isSidechain) {
        const text =
          typeof ev.message?.content === "string"
            ? ev.message.content
            : extractUserPlainText(ev.message?.content);
        if (text) {
          out.push({
            ...base,
            harnessInjection: {
              mechanism: "compaction_summary",
              payload: "conversation_summary",
              rawText: text,
              // 没有 trigger tool_use_id —— compaction 不是 tool 调起的，是 autocompact /
              // 用户 /compact 命令触发；归因证据是 sourcemap + isCompactSummary 标记本身。
            },
          });
          continue;
        }
        out.push(base);
        continue;
      }
      // sidechain user（sub-agent 转录）不在主 session 的 call context 里 → base（skipped）。
      if (ev.isSidechain) {
        out.push(base);
        continue;
      }
      // isMeta 的 user 消息（local-command caveat / output-token 恢复提示 / 预算 nudge /
      // Skill 注入 …）**照样进 messages[] 发给模型** → 必须给 consumable 内容，否则会被
      // isConsumableEvent 误判为 skipped（"未进入 prompt"），但它们其实进 context（见
      // call 8 ground truth：caveat 在 reqBody.messages 里）。原实现把 isMeta 一律丢成
      // 裸 base 是误区——把"无 turn 关联"等同于"不进 context"。
      // 不重置 lastToolResultUseId —— Skill 注入可能跨多条 isMeta event。
      if (ev.isMeta) {
        const plain = extractUserPlainText(ev.message?.content);
        // Skill 注入的 SKILL.md body → harnessInjection（让 jsonl-linker 按内容相等 link 回 reqBody）。
        if (lastToolResultUseId !== null && skillToolUseIds.has(lastToolResultUseId) && plain) {
          out.push({
            ...base,
            harnessInjection: {
              mechanism: "skill_invocation",
              payload: "skill_md_body",
              rawText: plain,
              triggerToolUseId: lastToolResultUseId,
            },
          });
          continue;
        }
        // 其余 isMeta user：按 command-like / 自由文本 分流到 commandText / userText（与普通
        // user 同口径），caveat 这类 `<local-command-*>` → commandText → consumable。
        const metaImages = extractUserImages(ev.message?.content);
        const metaWithImages: Partial<LinkableJsonlEvent> = metaImages.length > 0 ? { userImages: metaImages } : {};
        if (plain) {
          out.push({ ...base, ...metaWithImages, ...(isCommandLikeText(plain) ? { commandText: plain } : { userText: plain }) });
        } else {
          out.push({ ...base, ...metaWithImages });
        }
        continue;
      }
      const content = ev.message?.content;
      const userImages = extractUserImages(content);
      const withImages: Partial<LinkableJsonlEvent> = userImages.length > 0 ? { userImages } : {};
      // tool_result-only user 事件 → toolResults。同时刷新 lastToolResultUseId
      // 以供下一条 isMeta text 判定（一条 user message 通常只有一个 tool_result，
      // 多个 tool_result 则取最后一个 —— Skill 注入序列里这一步永远是单 tool_result）。
      if (isToolResultOnlyContent(content)) {
        const toolResults = extractToolResultsFromUser(content);
        if (toolResults.length > 0) lastToolResultUseId = toolResults[toolResults.length - 1].toolUseId;
        out.push({ ...base, ...withImages, toolResults });
        continue;
      }
      // 非 tool_result-only 的 user 事件打断 lastToolResultUseId 状态。
      lastToolResultUseId = null;
      // user 事件的文本块分流：
      //   - 以 claude-code 固定 tag 起始（<command-name>/<local-command-*>/<bash-*>） → commandText 维度
      //   - 其它 → userText 维度（真正的人类自由输入）
      // 同一 event 不会同时有 userText 和 commandText —— 实际上每个 user 事件
      // 的 plain text 只有一种性质。
      const plain = extractUserPlainText(content);
      if (plain) {
        if (isCommandLikeText(plain)) {
          out.push({ ...base, ...withImages, commandText: plain });
        } else {
          out.push({ ...base, ...withImages, userText: plain });
        }
        continue;
      }
      // 纯 image 输入（无 text）：仍要让 userImages 被索引到
      if (userImages.length > 0) {
        out.push({ ...base, ...withImages });
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
      const thinkingBlocks = extractAssistantThinkingBlocks(content);
      // 登记 Skill tool_use id —— 下游 user.isMeta=true.text 事件用它判定
      // "这条 isMeta text 是 Skill harness 注入"。命名匹配 SkillTool 工具实际 name。
      for (const tu of toolUses) {
        if (tu.name === "Skill") skillToolUseIds.add(tu.id);
      }
      // assistant 事件也会打断 lastToolResultUseId 状态（注入序列中间不可能出现 assistant）。
      lastToolResultUseId = null;
      out.push({
        ...base,
        ...(assistantText && { assistantText }),
        ...(toolUses.length > 0 && { toolUses }),
        ...(thinkingBlocks.length > 0 && { thinkingBlocks }),
      });
    } else if (ev.type === "attachment" && ev.attachment && typeof ev.attachment.type === "string") {
      // SmooshContent 来源：task_reminder / queued_command / edited_text_file 等
      // attachment 类型记录，被 jsonl-linker 的 linkSmooshSegmentNode 用于把切出的
      // <system-reminder> 子段 link 到 jsonl 行。filename 兼容 edited_text_file 顶层位置。
      const att = ev.attachment;
      const attType = att.type as string; // 已被外层 typeof === "string" 守卫
      out.push({
        ...base,
        attachment: {
          type: attType,
          ...(att.content !== undefined && { content: att.content }),
          ...(att.prompt !== undefined && { prompt: att.prompt }),
          ...(typeof att.filename === "string" && { content: { filename: att.filename, ...(att.content as object ?? {}) } }),
          ...(ev.parentUuid && { parentUuid: ev.parentUuid }),
          ...(ev.uuid && { uuid: ev.uuid }),
        },
      });
    } else {
      out.push(base);
    }
  }
  return out;
}

// ─── ParsedQuerySnapshot → serializable ──────────────────────────────────────

/** 命中 corpus rule 的 leaf → 用户向展示元数据(displayName/summary/stability/dynamicSource)。
 *  wire fallback rule(wire.*)与非 rule origin 返回 undefined。 */
function ruleMetaOf(origin: SegmentNode["origin"]): SerializedNode["ruleMeta"] {
  if (origin?.kind !== "rule") return undefined;
  const rule = CORPUS_LEDGER_RULES_BY_ID[origin.ruleId];
  if (!rule) return undefined;
  const meta: NonNullable<SerializedNode["ruleMeta"]> = { stability: rule.stability };
  if (rule.displayName) meta.displayName = rule.displayName;
  if (rule.summary) meta.summary = rule.summary;
  if (rule.dynamicSource) meta.dynamicSource = rule.dynamicSource;
  return meta;
}

function serializeNode(node: SegmentNode): SerializedNode {
  const isLeaf = node.children.length === 0;
  const includeRawText = isLeaf || (node.slotType === "messages.inline.system-reminder" && node.children.length > 0);
  const redactedThinkingPreview = redactedThinkingPreviewOf(node);
  const previewText = redactedThinkingPreview
    ?? (node.rawText.length > 200
      ? node.rawText.replace(/\s+/g, " ").trim().slice(0, 197) + "..."
      : node.rawText);
  const ruleMeta = ruleMetaOf(node.origin);
  // 正交轴:rule 节点用其 ruleId 多路(system-reminder/system-message);其余靠 slotType。
  const axRuleId = node.origin && node.origin.kind === "rule" ? node.origin.ruleId : "";
  const ax = deriveAxes(node.slotType, axRuleId);
  return {
    id: node.id,
    slotType: node.slotType,
    jsonPath: node.jsonPath,
    charCount: node.charCount,
    rawHash: node.rawHash,
    preview: previewText,
    // 叶子保留完整 rawText；userContext reminder container 也保留,供后续 raw 高亮用。
    ...(includeRawText && { rawText: node.rawText }),
    ...(node.charRange && { charRange: node.charRange }),
    ...(node.visibility && node.visibility !== "default" && { visibility: node.visibility }),
    ...(node.parentId && { parentId: node.parentId }),
    origin: node.origin,
    // 派生字段：authorship + coverageState 由后端一次性 derive，前端只读。
    authorship: authorshipOf(node.origin),
    coverageState: coverageStateOf(node.origin),
    ...(node.wireMeta && { wireMeta: node.wireMeta }),
    ...(node.cachePolicy && { cachePolicy: node.cachePolicy }),
    ...(node.unknownMeta && { unknownMeta: node.unknownMeta }),
    ...(ruleMeta && { ruleMeta }),
    axes: {
      semantic: ax.kind,
      ...(ax.detail && { semanticDetail: ax.detail }),
      source: ax.source,
      sourceBucket: sourceBucket(ax.source),
    },
    children: node.children.map(serializeNode),
  };
}

function serializeSummary(node: SegmentNode): SerializedNodeSummary {
  const redactedThinkingPreview = redactedThinkingPreviewOf(node);
  return {
    id: node.id,
    slotType: node.slotType,
    charCount: node.charCount,
    preview: redactedThinkingPreview
      ?? (node.rawText.length > 80
        ? node.rawText.replace(/\s+/g, " ").trim().slice(0, 77) + "..."
        : node.rawText.replace(/\s+/g, " ").trim()),
    ...(node.parentId && { parentId: node.parentId }),
    origin: node.origin,
    authorship: authorshipOf(node.origin),
    coverageState: coverageStateOf(node.origin),
  };
}

// Opus 4.7 redacted thinking：matcher 把 signature 落进 rawText（让 charCount 反映
// 真实 wire 占用字节），但 signature 是 base64 密文，作为预览毫无可读性。
// 此处仅在 preview 字段把它替换为 "<redacted thinking · N bytes>" 状态描述；
// rawText 本身保持不变 —— 详情面板点开仍能看到完整 signature。
function redactedThinkingPreviewOf(node: SegmentNode): string | null {
  if (node.slotType !== "messages.thinking") return null;
  const sig = node.wireMeta?.thinkingSignature;
  if (!sig) return null;
  if (node.rawText !== sig) return null;
  return `<redacted thinking · ${sig.length} bytes>`;
}

function serializeSnapshot(snapshot: ParsedQuerySnapshot): SerializedSnapshot {
  const nodeSummaries: Record<string, SerializedNodeSummary> = {};
  for (const node of Object.values(snapshot.index)) {
    nodeSummaries[node.id] = serializeSummary(node);
  }
  const ctx = snapshot.attributionContext;
  const ccVersion = ctx.ok ? ctx.ctx.ccVersion : undefined;
  const report = checkVersionAgainstBaseline(ccVersion);
  return {
    queryKind: snapshot.queryKind,
    ...(ccVersion && { ccVersion }),
    versionDiag: {
      contextOk: ctx.ok,
      ...(!ctx.ok && { contextFailureKind: ctx.failure.kind }),
      ccVersion: report.proxy?.ccVersion ?? ccVersion ?? null,
      baseline: report.baseline?.ccVersion ?? null,
      matchLevel: report.matchLevel,
      message: report.message,
    },
    roots: snapshot.roots.map(serializeNode),
    nodeSummaries,
  };
}
