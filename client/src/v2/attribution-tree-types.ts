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
  | { kind: "rule"; ruleId: string; matchMode: "exact" | "regex" | "prefix"; confidence: Confidence; fullyCovered: boolean; dynamicFields?: DynamicField[] }
  | { kind: "jsonl"; eventKind: string; jsonlLineIdx: number; sourceCallId?: number; sourceTurnId?: number; toolUseId?: string; confidence: Confidence; fullyCovered: boolean }
  | { kind: "structural"; slotId: string; reason: "container_node" | "no_rule_matched" }
  | { kind: "unknown"; reason: string };

/**
 * 叶子节点归因覆盖完整性。与后端 origin.ts 中 CoverageState 同步。
 *   - "full"    rule/jsonl origin 且 fullyCovered=true
 *   - "partial" rule/jsonl origin 且 fullyCovered=false（动态注入未覆盖 / 内容近似）
 *   - "none"    structural 或 unknown origin
 */
export type CoverageState = "full" | "partial" | "none";

export function coverageStateOf(origin: SegmentOrigin): CoverageState {
  if (origin.kind === "rule" || origin.kind === "jsonl") {
    return origin.fullyCovered ? "full" : "partial";
  }
  return "none";
}

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

// ─── Audit (PR6) ────────────────────────────────────────────────────────────

export type PartialReason =
  | "rule.regex.partial_match"
  | "rule.prefix.anchor_only"
  | "jsonl.user_input.inferred"
  | "jsonl.assistant_text.substring"
  | "jsonl.attachment.fingerprint"
  | "rule.unknown"
  | "jsonl.unknown";

export interface ForwardAudit {
  totals: {
    leafCount: number;
    full: number;
    partial: number;
    none: number;
  };
  full: {
    segmentIds: string[];
    byOrigin: { rule: string[]; jsonl: string[] };
  };
  partial: {
    segmentIds: string[];
    byReason: Record<PartialReason, string[]>;
  };
  none: {
    segmentIds: string[];
    byKind: { structural_no_rule: string[]; unknown: string[] };
  };
}

export type ReverseEventKind =
  | "user_input"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "attachment";

export interface ReverseAuditBucket {
  total: number;
  linked: number;
  missing: number;
}

export interface MissingJsonlUnit {
  jsonlLineIdx: number;
  eventKind: ReverseEventKind;
  callId?: number;
  turnId?: number;
  toolUseId?: string;
  preview?: string;
  reason: "no_segment_linked" | "no_matching_slot";
  expectedSlotHint?: string;
}

export interface ReverseAudit {
  byKind: Record<ReverseEventKind, ReverseAuditBucket>;
  missing: MissingJsonlUnit[];
}

export interface AuditEnvelope {
  forward: ForwardAudit;
  reverse: ReverseAudit;
}

export interface AttributionTreeResult {
  callId: number;
  sessionId: string;
  hasProxy: boolean;
  previousCallId: number | null;
  snapshot: SerializedSnapshot | null;
  linkReport: LinkJsonlReport | null;
  /** Audit 双视角（PR6 起）：前向覆盖度 + 反向 jsonl missing。 */
  audit: AuditEnvelope | null;
  diff: AttributionTreeDiff | null;
  /** previous snapshot 的叶子（用于双行 strip 上一行）；首个 call 时不存在 */
  previousLeaves?: PreviousLeafLite[];
  error?: string;
}
