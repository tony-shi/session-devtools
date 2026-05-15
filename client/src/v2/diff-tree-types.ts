// 镜像 server/src/diff-tree-service.ts 的输出类型。

import type { SegmentOrigin } from "./attribution-tree-types";

export type DiffKind = "kept" | "added" | "removed" | "modified";
export type DiffSectionId = "system" | "tools" | "messages" | "other";

export interface DiffLeaf {
  id: string;
  slotType: string;
  rootSlotType: string;
  kind: DiffKind;
  newCharCount: number;
  oldCharCount?: number;
  preview: string;
  rawText?: string;
  oldRawText?: string;
  origin?: SegmentOrigin;
  wireMeta?: {
    messageRole?: "user" | "assistant" | "system";
    toolUseId?: string;
    toolName?: string;
    [k: string]: unknown;
  };
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
  sections: DiffSection[];
  summary: {
    addedCount: number;
    removedCount: number;
    modifiedCount: number;
    keptCount: number;
    netCharDelta: number;
    insertedChars: number;
    deletedChars: number;
  };
  error?: string;
}
