// 前端镜像 server/src/attribution-service.ts 的输出类型。
// 保持与后端结构一致，方便直接 JSON.parse 后消费。

export type OriginKind = "rule" | "jsonl" | "structural" | "unknown";

export type Confidence = "definitive" | "estimated" | "inferred" | "unknown";

export interface DynamicField {
  name: string;
  valuePreview: string;
  charStart: number;
  charEnd: number;
  charCount: number;
  source: "env" | "memory" | "runtime" | "user" | "unknown";
  evidence?: Evidence;
}

export type Evidence =
  | { kind: "jsonl"; jsonlLineIdx: number; sourceCallId?: number; sourceTurnId?: number; eventKind?: string }
  | { kind: "runtime"; key: string }
  | { kind: "file"; path: string; section?: string }
  | { kind: "memory"; memoryFile: string; memoryName?: string }
  | { kind: "unknown" };

export type SegmentOrigin =
  | { kind: "rule"; ruleId: string; matchMode: "exact" | "regex" | "prefix"; confidence: Confidence; dynamicFields?: DynamicField[] }
  | { kind: "jsonl"; eventKind: string; jsonlLineIdx: number; sourceCallId?: number; sourceTurnId?: number; toolUseId?: string; confidence: Confidence }
  | { kind: "structural"; slotId: string; reason: "container_node" | "no_rule_matched" }
  | { kind: "unknown"; reason: string };

export interface SerializedNode {
  id: string;
  slotType: string;
  jsonPath: string;
  charCount: number;
  rawHash: string;
  preview: string;
  rawText?: string;
  parentId?: string;
  origin: SegmentOrigin;
  wireMeta?: {
    toolUseId?: string;
    toolName?: string;
    messageRole?: "user" | "assistant" | "system";
    messageIdx?: number;
  };
  cachePolicy?: { ttl: "5m" | "1h"; scope: "org" | "global" };
  unknownMeta?: { originalType?: string; sectionHeader?: string; reason?: string };
  children: SerializedNode[];
}

export interface SerializedNodeSummary {
  id: string;
  slotType: string;
  charCount: number;
  preview: string;
  parentId?: string;
  origin: SegmentOrigin;
}

export interface SerializedSnapshot {
  queryKind: string;
  roots: SerializedNode[];
  nodeSummaries: Record<string, SerializedNodeSummary>;
}

export type LeafDiffStatus = "added" | "unchanged";

export interface RemovedLeaf {
  nodeId: string;
  slotType: string;
  rawHash: string;
  preview: string;
  charCount: number;
  jsonPath: string;
}

export type PrevLeafDiffStatus = "unchanged" | "removed";

export interface AttributionTreeDiff {
  leafStatus: Record<string, LeafDiffStatus>;
  previousLeafStatus?: Record<string, PrevLeafDiffStatus>;
  removedFromPrevious: RemovedLeaf[];
  summary: {
    currentLeaves: number;
    addedLeaves: number;
    unchangedLeaves: number;
    removedLeaves: number;
    netCharDelta: number;
    addedChars: number;
    removedChars: number;
  };
}

export interface PreviousLeafLite {
  nodeId: string;
  slotType: string;
  charCount: number;
  rawHash: string;
  preview: string;
  jsonPath: string;
  rootSlotType: string;
  diffStatus: "unchanged" | "removed";
}

export interface LinkJsonlReport {
  matched: { toolUse: number; toolResult: number; userInput: number; assistantText: number };
  totalLeaves: number;
}

export interface AttributionTreeResult {
  callId: number;
  sessionId: string;
  hasProxy: boolean;
  previousCallId: number | null;
  snapshot: SerializedSnapshot | null;
  linkReport: LinkJsonlReport | null;
  diff: AttributionTreeDiff | null;
  /** previous snapshot 的叶子（用于双行 strip 上一行）；首个 call 时不存在 */
  previousLeaves?: PreviousLeafLite[];
  error?: string;
}
