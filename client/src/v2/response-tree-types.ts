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

export interface ResponseTreeResult {
  callId: number;
  sessionId: string;
  dataSource: "jsonl" | "proxy" | "none";
  snapshot: ResponseSnapshot | null;
  stopReason: string | null;
  outputTokens: number;
  error?: string;
}
