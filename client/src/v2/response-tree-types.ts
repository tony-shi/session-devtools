// 镜像 server/src/response-attribution-service.ts 的输出类型。

export type ResponseSlotType =
  | "response"
  | "response.thinking"
  | "response.text"
  | "response.tool_use";

export interface LinkedToolResult {
  toolUseId: string;
  nextCallId: number | null;
  preview: string;
  charCount: number;
  isError: boolean;
}

export interface ResponseNode {
  id: string;
  slotType: ResponseSlotType;
  contentIdx: number;
  charCount: number;
  rawHash: string;
  preview: string;
  rawText?: string;
  parentId?: string;
  wireMeta?: {
    toolUseId?: string;
    toolName?: string;
  };
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
  nodeSummaries: Record<string, ResponseNodeSummary>;
}

/**
 * 数据来源。Response 视图只接受 proxy 抓取的原始 HTTP response。
 *   - "proxy-sse":  从 proxy 抓取的 SSE 流重组
 *   - "proxy-json": 从 proxy 非流式 response body 读取
 *   - "none":       proxy 未存储该 call 的 response —— UI 显示明确的占位，
 *                   绝不用 jsonl 反向渲染冒充原始数据
 */
export type ResponseTreeDataSource = "proxy-sse" | "proxy-json" | "none";

export interface ResponseTreeResult {
  callId: number;
  sessionId: string;
  dataSource: ResponseTreeDataSource;
  snapshot: ResponseSnapshot | null;
  stopReason: string | null;
  outputTokens: number;
  /** SSE 流是否中断（仅 dataSource="proxy-sse" 时有意义） */
  truncated?: boolean;
  /** 加载过程中的非致命问题（前端可选择性展示） */
  warnings?: string[];
  error?: string;
}
