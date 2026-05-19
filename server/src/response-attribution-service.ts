// response-attribution-service：把当前 LLM call 的 assistant message（即 wire response）
// 解析为可被前端 ResponseTreePanel 消费的归因树。
//
// 与 attribution-service 的关系：
//   - attribution-service 处理 *request* 端（proxy reqBody → segment tree）
//   - 本服务处理 *response* 端（assistant message content[] → response tree）
//   - 类型上复用 SerializedNode / SerializedNodeSummary 形态以便前端组件复用
//   - 不污染 attribution-service 的 parseQuery 链路（response wire 结构不同）
//
// 数据源策略（B6）：
//   **只走 proxy SSE，不做 JSONL 反向渲染。**
//   通过 proxy_requests 表按 requestId 精确匹配，读 resBody（完整 SSE 文本），
//   通过 parseSseText + reconstructAssistantMessage 重组成 wire 等价的 assistant message。
//   这是"右侧 = HTTP response 原始信息"的唯一可信路径。
//
//   当 proxy 数据缺失（旧 session、无 request-id、proxy 未启用等）时：
//     - 返回 dataSource="none" + 明确的 error 字段说明缺失原因
//     - **不**回落到 JSONL —— JSONL 是 agent harness 自己拼的镜像，不是 wire response。
//       用 jsonl 渲染会让用户误以为这就是 LLM 真正吐出的内容，造成严重的归因误判
//       （SSE frame 边界、partial tool_use input、stop_reason 时序差异都会丢）。
//     - 前端 UI 看到 "none" 应显示明确的"未存储 proxy response 数据"占位，
//       而不是反向用 jsonl 内容假装。
//
// linkedToolResult 字段：
//   - response 中的 tool_use 节点会附加一个"指针"，指向下游 call 的 tool_result
//   - 数据从 LlmCall.toolCalls（drilldown parser 已配对好）拿
//   - 前端点击此指针 → 触发右侧 LinkedContextPanel 跳转到下游 call

import type { Database } from "better-sqlite3";
import { findProxyRowForCall, readProxyRecord, type ProxyMatchHint } from "./call-detail.ts";
import {
  parseSseText,
  reconstructAssistantMessage,
  type ReconstructedContentBlock,
} from "./sse-response-reconstructor.ts";

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
  /**
   * 叶子节点的"原始数据"字符串形态。
   *   - thinking: 完整 thinking 文本（不包 type/signature，因为 thinking 块的语义就是文本）
   *   - text:     完整文本
   *   - tool_use: **完整 content block 序列化** `JSON.stringify({type, id, name, input}, null, 2)`
   *               这里特意包含 type/id/name，而非只 input 子对象 —— 让原始 JSON tab 看到
   *               wire 真容、不丢字段。
   */
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

/**
 * 数据来源透明度：前端据此在 META 行透出本视图基于哪种 proxy 形态。
 *   - "proxy-sse":  从 proxy 抓取的 SSE 流重组，最严格 wire 对齐
 *   - "proxy-json": 从 proxy 非流式 response body 读取（少见，stream=false 的 API 调用）
 *   - "none":       proxy 数据未存储或不可读 —— 不渲染内容，仅展示缺失说明
 *
 * 注意：不存在 "jsonl" 来源。jsonl 是 agent 落盘镜像，用它渲染 response 会造成
 * 归因误判，因此 proxy 缺失时宁可显示"无数据"也不回落 jsonl。
 */
export type ResponseTreeDataSource = "proxy-sse" | "proxy-json" | "none";

export interface ResponseTreeResult {
  callId: number;
  sessionId: string;
  dataSource: ResponseTreeDataSource;
  snapshot: ResponseSnapshot | null;
  /** 当前 call 的 stop_reason / output_tokens（前端 header 用） */
  stopReason: string | null;
  outputTokens: number;
  /**
   * SSE 流是否中断（仅 dataSource="proxy-sse" 时有意义）。
   * true 表示没有收到 message_stop —— content 可能不完整。
   */
  truncated?: boolean;
  /** 数据源加载过程中遇到的非致命问题，前端可选择性展示 */
  warnings?: string[];
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
  /** 拿到 call 元信息。proxy 是唯一数据源，所以 helpers 只暴露 proxy 查询主键 +
   *  linkedToolResult 所需的下游 call 元信息。 */
  resolveCallContext: (sessionId: string, callId: number) => {
    /**
     * Anthropic API request-id（来自 JSONL assistant 事件顶层 `requestId`）。
     * 用作 proxy_requests.request_id 的精确匹配键。
     * 旧 session / 无 proxy / Claude Code 旧版本不透传 request-id 时为 null，
     * loadResponseTree 此时返回 dataSource="none"。
     */
    apiRequestId?: string | null;
    /**
     * 用于 proxy_requests 查询的 session id。一般等于路由 sessionId，
     * 但 sub-agent 路由会传合成 id（`${parent}::subagent::...`），此时这里要传
     * 真实的 sessionId（与 proxy_requests.session_id 对齐）。null/undefined 跳过 proxy。
     */
    proxySessionId?: string | null;
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
    /** JSONL assistant.timestamp。无 requestId 时供 proxy time-window 匹配用。 */
    callTimestamp: string;
  } | null;
}

// ─── 树构建：与数据源无关 ────────────────────────────────────────────────────

/**
 * Anthropic content block 的统一形态。两个来源都归一到这里：
 *   - proxy SSE 重组：reconstructAssistantMessage 输出的 ReconstructedContentBlock
 *   - jsonl 读取：assistant.message.content[i]（结构相同）
 */
type WireContentBlock =
  | { type: "thinking"; thinking?: string; signature?: string }
  | { type: "text"; text?: string }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  | { type?: string; [k: string]: unknown };

interface BuildContext {
  callId: number;
  toolCalls: Array<{
    toolUseId: string;
    name: string;
    outputPreview: string;
    outputSize: number;
    isError: boolean;
  }>;
  nextCallId: number | null;
}

function buildResponseTree(
  blocks: ReadonlyArray<WireContentBlock>,
  ctx: BuildContext,
): ResponseSnapshot {
  const toolCallMap = new Map<string, BuildContext["toolCalls"][number]>();
  for (const tc of ctx.toolCalls) toolCallMap.set(tc.toolUseId, tc);

  const rootId = `resp-${ctx.callId}`;
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

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as WireContentBlock;
    const bType = (block as { type?: string }).type;
    const nodeId = `${rootId}-${i}`;

    if (bType === "thinking") {
      const text = (block as { thinking?: string }).thinking ?? "";
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
      const text = (block as { text?: string }).text ?? "";
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
      const tu = block as { id?: string; name?: string; input?: unknown };
      const toolUseId = tu.id ?? "";
      const toolName  = tu.name ?? "unknown";
      // 完整 wire 形态序列化 —— 前端 raw JSON tab 直接消费此字符串
      const rawText = JSON.stringify(
        { type: "tool_use", id: toolUseId, name: toolName, input: tu.input ?? {} },
        null,
        2,
      );
      // 短预览仍只看 input —— preview 是给列表行用的，加上 wire 包装会变成噪音
      const inputJson = tu.input != null ? JSON.stringify(tu.input) : "";
      const charCount = rawText.length;
      totalChars += charCount;
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
        charCount, rawHash: sha1(rawText),
        preview: shortPreview(inputJson, 120), rawText,
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

  return { queryKind: "response", roots: [root], nodeSummaries: summaries };
}

// ─── 数据源加载器 ────────────────────────────────────────────────────────────

interface ProxyLoadOk {
  ok: true;
  blocks: ReconstructedContentBlock[];
  dataSource: "proxy-sse" | "proxy-json";
  stopReason: string | null;
  outputTokens: number | null;
  truncated: boolean;
  warnings: string[];
}
interface ProxyLoadMiss {
  ok: false;
  reason: string;
}

async function tryLoadFromProxy(
  db: Database,
  proxySessionId: string | null | undefined,
  hint: ProxyMatchHint,
): Promise<ProxyLoadOk | ProxyLoadMiss> {
  if (!proxySessionId) return { ok: false, reason: "missing proxySessionId" };
  // exact requestId 优先；缺失时 findProxyRowForCall 会用 callTimestamp +
  // callOutputTokens 走 time-window 兜底（代理站剥掉 request-id 的常见场景）。
  if (!hint.apiRequestId && !hint.callTimestamp) {
    return { ok: false, reason: "no usable proxy match hint (apiRequestId + callTimestamp 都缺)" };
  }
  const row = findProxyRowForCall(db, proxySessionId, hint);
  if (!row) return { ok: false, reason: "no proxy row matches hint" };

  const rec = await readProxyRecord(row.jsonl_file, row.jsonl_byte_offset);
  if (!rec) return { ok: false, reason: "proxy record unreadable at offset" };

  const meta = (rec.meta as Record<string, unknown>) ?? {};
  const isStream = !!meta.isStream;
  const resBody = typeof rec.resBody === "string" ? rec.resBody : "";

  if (!resBody) return { ok: false, reason: "proxy resBody empty" };

  if (isStream) {
    const events = parseSseText(resBody);
    const r = reconstructAssistantMessage(events);
    if (!r.message) {
      return { ok: false, reason: `SSE reconstruction failed (no message_start). errors: ${r.errors.join("; ")}` };
    }
    return {
      ok: true,
      blocks: r.message.content,
      dataSource: "proxy-sse",
      stopReason: r.message.stop_reason,
      outputTokens: r.message.usage.output_tokens,
      truncated: r.truncated,
      warnings: r.errors,
    };
  }

  // 非流式 JSON response（少见，但 Anthropic API 支持 stream=false）
  try {
    const parsed = JSON.parse(resBody) as {
      content?: ReconstructedContentBlock[];
      stop_reason?: string | null;
      usage?: { output_tokens?: number };
    };
    if (!Array.isArray(parsed.content)) {
      return { ok: false, reason: "proxy non-stream resBody missing content[]" };
    }
    return {
      ok: true,
      blocks: parsed.content,
      dataSource: "proxy-json",
      stopReason: parsed.stop_reason ?? null,
      outputTokens: parsed.usage?.output_tokens ?? null,
      truncated: false,
      warnings: [],
    };
  } catch {
    return { ok: false, reason: "proxy non-stream resBody not valid JSON" };
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

export async function loadResponseTree(
  sessionId: string,
  callId: number,
  db: Database,
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

  const buildCtx: BuildContext = {
    callId,
    toolCalls: ctx.toolCalls,
    nextCallId: ctx.nextCallId,
  };

  // 只走 proxy。缺数据直接返回 none + 原因，不做 jsonl 反向渲染。
  const proxyResult = await tryLoadFromProxy(db, ctx.proxySessionId, {
    apiRequestId: ctx.apiRequestId,
    callTimestamp: ctx.callTimestamp,
    callOutputTokens: ctx.outputTokens,
  });
  if (!proxyResult.ok) {
    return {
      callId, sessionId,
      dataSource: "none",
      snapshot: null,
      stopReason: ctx.stopReason,
      outputTokens: ctx.outputTokens,
      error: `proxy response 未存储：${proxyResult.reason}`,
    };
  }

  const snapshot = buildResponseTree(proxyResult.blocks, buildCtx);
  return {
    callId, sessionId,
    dataSource: proxyResult.dataSource,
    snapshot,
    stopReason: proxyResult.stopReason ?? ctx.stopReason,
    outputTokens: proxyResult.outputTokens ?? ctx.outputTokens,
    truncated: proxyResult.truncated,
    warnings: proxyResult.warnings.length ? proxyResult.warnings : undefined,
  };
}
