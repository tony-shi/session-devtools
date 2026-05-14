// response-attribution-service：把当前 LLM call 的 assistant message（即 wire response）
// 解析为可被前端 ResponseTreePanel 消费的归因树。
//
// 与 attribution-service 的关系：
//   - attribution-service 处理 *request* 端（proxy reqBody → segment tree）
//   - 本服务处理 *response* 端（assistant message content[] → response tree）
//   - 类型上复用 SerializedNode / SerializedNodeSummary 形态以便前端组件复用
//   - 不污染 attribution-service 的 parseQuery 链路（response wire 结构不同）
//
// 数据源策略（增量第一版）：
//   - 直接从 session JSONL 的 assistant message.content 读取
//   - JSONL 是 Claude Code 写出的 wire response 镜像，对 thinking/text/tool_use 而言充分
//   - 后续若需更严格 wire 对齐，可以扩展从 proxy resBody（SSE）重组
//
// linkedToolResult 字段：
//   - response 中的 tool_use 节点会附加一个"指针"，指向下游 call 的 tool_result
//   - 数据从 LlmCall.toolCalls（drilldown parser 已配对好）拿
//   - 前端点击此指针 → 触发右侧 LinkedContextPanel 跳转到下游 call

import { readFileSync, existsSync } from "fs";
import type { Database } from "better-sqlite3";

// ─── 输出类型（与 SerializedNode 同形态，扩展 linkedToolResult） ──────────────

/** 指针：response.tool_use 对应的执行结果落到了下游哪个 call */
export interface LinkedToolResult {
  toolUseId: string;
  /** 下游 call id（如果存在），前端用以触发右侧 drawer 跳转 */
  nextCallId: number | null;
  /** 结果短预览，UI 详情面板直接显示（不用再 fetch） */
  preview: string;
  /** 完整结果字符数（前端展示规模） */
  charCount: number;
  isError: boolean;
}

export type ResponseSlotType =
  | "response"
  | "response.thinking"
  | "response.text"
  | "response.tool_use";

export interface ResponseNode {
  id: string;
  slotType: ResponseSlotType;
  /** 该节点在 assistant content 数组中的位置，便于 UI 排序 */
  contentIdx: number;
  charCount: number;
  rawHash: string;
  preview: string;
  /** 完整 rawText — 叶子节点保留（thinking/text/tool_use 的 input json） */
  rawText?: string;
  parentId?: string;
  /** 仅 response.tool_use 节点携带：toolName、toolUseId */
  wireMeta?: {
    toolUseId?: string;
    toolName?: string;
  };
  /** 仅 response.tool_use 节点携带 */
  linkedToolResult?: LinkedToolResult;
  children: ResponseNode[];
}

export interface ResponseNodeSummary {
  id: string;
  slotType: ResponseSlotType;
  charCount: number;
  preview: string;
  parentId?: string;
}

export interface ResponseSnapshot {
  queryKind: "response";
  roots: ResponseNode[];
  /** id → 摘要（不含 children） */
  nodeSummaries: Record<string, ResponseNodeSummary>;
}

export interface ResponseTreeResult {
  callId: number;
  sessionId: string;
  /** 数据来源标识。增量第一版固定为 "jsonl"；后续可扩展 "proxy" */
  dataSource: "jsonl" | "proxy" | "none";
  snapshot: ResponseSnapshot | null;
  /** 当前 call 的 stop_reason / output_tokens（前端 header 用） */
  stopReason: string | null;
  outputTokens: number;
  error?: string;
}

// ─── 辅助 ─────────────────────────────────────────────────────────────────────

function sha1(text: string): string {
  // 简单 hash：不依赖 crypto 模块（保持与 SerializedNode rawHash 字段对齐风格即可）
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function shortPreview(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

export interface LoadResponseTreeHelpers {
  /** 拿到 call 元信息：sourceFile、timestamp、turn id、下游 call id（用于 linkedToolResult） */
  resolveCallContext: (sessionId: string, callId: number) => {
    sourceFile: string;
    callTimestamp: string;
    /** drilldown parser 已经从 JSONL 解析好的 tool_use ↔ tool_result 配对 */
    toolCalls: Array<{
      toolUseId: string;
      name: string;
      outputPreview: string;
      outputSize: number;
      isError: boolean;
    }>;
    /** 紧邻的下游 call id（若有），用于前端 drawer 跳转 */
    nextCallId: number | null;
    stopReason: string | null;
    outputTokens: number;
  } | null;
}

export async function loadResponseTree(
  sessionId: string,
  callId: number,
  _db: Database,
  helpers: LoadResponseTreeHelpers,
): Promise<ResponseTreeResult> {
  const ctx = helpers.resolveCallContext(sessionId, callId);
  if (!ctx) {
    return {
      callId, sessionId,
      dataSource: "none",
      snapshot: null,
      stopReason: null, outputTokens: 0,
      error: "call not found in session drilldown",
    };
  }

  if (!existsSync(ctx.sourceFile)) {
    return {
      callId, sessionId,
      dataSource: "none",
      snapshot: null,
      stopReason: ctx.stopReason, outputTokens: ctx.outputTokens,
      error: "session jsonl file unavailable",
    };
  }

  // 找到对应 callId 的 assistant 事件（按时间戳就近匹配）
  const lines = readFileSync(ctx.sourceFile, "utf-8").split("\n");
  let bestContent: unknown = null;
  for (const line of lines) {
    if (!line) continue;
    let ev: { type?: string; timestamp?: string; ts?: string; isSidechain?: boolean; message?: { content?: unknown; usage?: { output_tokens?: number } } };
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== "assistant") continue;
    if (ev.isSidechain) continue;
    const ts = ev.timestamp ?? ev.ts;
    if (ts !== ctx.callTimestamp) continue;
    // 优先选有非零 output_tokens 的事件（避免 streaming 占位行）
    const out = ev.message?.usage?.output_tokens ?? 0;
    if (out > 0 && Array.isArray(ev.message?.content)) {
      bestContent = ev.message.content;
      break;
    }
    // fallback：第一条同时间戳的 assistant
    if (bestContent === null && Array.isArray(ev.message?.content)) {
      bestContent = ev.message.content;
    }
  }

  if (!Array.isArray(bestContent)) {
    return {
      callId, sessionId,
      dataSource: "none",
      snapshot: null,
      stopReason: ctx.stopReason, outputTokens: ctx.outputTokens,
      error: "no assistant message content found for this call",
    };
  }

  // ── 构建树 ──
  const toolCallMap = new Map<string, typeof ctx.toolCalls[number]>();
  for (const tc of ctx.toolCalls) toolCallMap.set(tc.toolUseId, tc);

  const rootId = `resp-${callId}`;
  const root: ResponseNode = {
    id: rootId,
    slotType: "response",
    contentIdx: -1,
    charCount: 0,
    rawHash: "",
    preview: "",
    children: [],
  };

  const summaries: Record<string, ResponseNodeSummary> = {};
  let totalChars = 0;

  for (let i = 0; i < bestContent.length; i++) {
    const block = bestContent[i] as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
    const bType = block?.type;
    const nodeId = `${rootId}-${i}`;

    if (bType === "thinking") {
      const text = (block.thinking ?? "");
      const charCount = text.length;
      totalChars += charCount;
      const node: ResponseNode = {
        id: nodeId, slotType: "response.thinking", contentIdx: i,
        charCount, rawHash: sha1(text),
        preview: shortPreview(text), rawText: text,
        parentId: rootId, children: [],
      };
      root.children.push(node);
      summaries[nodeId] = { id: nodeId, slotType: node.slotType, charCount, preview: node.preview, parentId: rootId };
    } else if (bType === "text") {
      const text = block.text ?? "";
      const charCount = text.length;
      totalChars += charCount;
      const node: ResponseNode = {
        id: nodeId, slotType: "response.text", contentIdx: i,
        charCount, rawHash: sha1(text),
        preview: shortPreview(text), rawText: text,
        parentId: rootId, children: [],
      };
      root.children.push(node);
      summaries[nodeId] = { id: nodeId, slotType: node.slotType, charCount, preview: node.preview, parentId: rootId };
    } else if (bType === "tool_use") {
      const inputJson = block.input != null ? JSON.stringify(block.input) : "";
      const charCount = inputJson.length;
      totalChars += charCount;
      const toolUseId = block.id ?? "";
      const toolName = block.name ?? "unknown";
      const matched = toolUseId ? toolCallMap.get(toolUseId) : undefined;

      let linkedToolResult: LinkedToolResult | undefined;
      if (matched) {
        linkedToolResult = {
          toolUseId,
          nextCallId: ctx.nextCallId,
          preview: matched.outputPreview,
          charCount: matched.outputSize,
          isError: matched.isError,
        };
      }

      const node: ResponseNode = {
        id: nodeId, slotType: "response.tool_use", contentIdx: i,
        charCount, rawHash: sha1(inputJson),
        preview: shortPreview(inputJson, 120), rawText: inputJson,
        parentId: rootId,
        wireMeta: { toolUseId, toolName },
        ...(linkedToolResult && { linkedToolResult }),
        children: [],
      };
      root.children.push(node);
      summaries[nodeId] = { id: nodeId, slotType: node.slotType, charCount, preview: node.preview, parentId: rootId };
    }
    // 其他 block 类型（image, document, redacted_thinking）暂不支持，跳过
  }

  root.charCount = totalChars;
  root.rawHash = sha1(root.children.map((c) => c.rawHash).join("|"));
  root.preview = `${root.children.length} block${root.children.length !== 1 ? "s" : ""}`;
  summaries[rootId] = { id: rootId, slotType: "response", charCount: totalChars, preview: root.preview };

  return {
    callId, sessionId,
    dataSource: "jsonl",
    snapshot: { queryKind: "response", roots: [root], nodeSummaries: summaries },
    stopReason: ctx.stopReason,
    outputTokens: ctx.outputTokens,
  };
}
