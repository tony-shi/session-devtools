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

/** Wire-declared cache breakpoint (cache_control: ephemeral). Mirrors the
 *  server PinInfo — pure declarative, no claims about actual hit/miss. */
export interface PinInfo {
  slotType: string;
  ttl: "5m" | "1h";
  scope: "org" | "global";
  charCount: number;
  /** Chars from start of the Anthropic cache prefix (tools→system→messages)
   *  up to and including this pin's block. UI uses it for absolute positioning. */
  cumulativePrefixChars: number;
  /** Chars from start of this section (within section's own root ordering) up
   *  to and including this pin's block. Used by drill-in views. */
  cumulativeSectionChars: number;
  /** Wire jsonPath — e.g. "reqBody.system[3]" / "reqBody.messages[4].content[1]". */
  jsonPath: string;
}

export interface DiffSection {
  id: DiffSectionId;
  newTotal: number;
  oldTotal: number;
  delta: number;
  counts: { added: number; removed: number; modified: number; kept: number };
  leaves: DiffLeaf[];
  /** cache_control pins declared on top-level blocks in this section. */
  pins: PinInfo[];
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
