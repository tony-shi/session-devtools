// reconstruct2 / index
//
// 第一层 Mutation View 的统一入口：
//
//   raw JSONL string
//     -> decodeClaudeJsonl     (jsonl/event-decoder)
//     -> normalizeMutations    (mutation/mutation-normalizer)
//     -> buildFrames           (mutation/frame-builder)
//     -> finalizeRuntimeSnapshot (jsonl/runtime-snapshot)
//   = MutationView
//
// 这条链路只读 JSONL；不依赖 proxy snapshot、不依赖旧 reconstruction/*。

import { decodeClaudeJsonl } from "./jsonl/event-decoder";
import { finalizeRuntimeSnapshot } from "./jsonl/runtime-snapshot";
import type { MutationDiagnostic, MutationView } from "./jsonl/event-types";
import { normalizeMutations } from "./mutation/mutation-normalizer";
import { buildFrames } from "./mutation/frame-builder";

export type {
  ClaudeJsonlEvent,
  ClaudeJsonlEventKind,
  ContextFrame,
  ContextFrameBoundary,
  ContextFrameBoundaryConfidence,
  ContextFrameQueryKind,
  JsonlLineDisposition,
  JsonlLineLedgerEntry,
  MutationDiagnostic,
  MutationView,
} from "./jsonl/event-types";

export interface BuildMutationViewOptions {
  jsonlFile: string;
  sessionId?: string;
}

export function buildMutationView(
  rawJsonl: string,
  opts: BuildMutationViewOptions,
): MutationView {
  const decoded = decodeClaudeJsonl(rawJsonl, {
    jsonlFile: opts.jsonlFile,
    sessionId: opts.sessionId,
  });

  const normalized = normalizeMutations({
    events: decoded.events,
    rawRecords: decoded.rawRecords,
    ledger: decoded.ledger,
    jsonlFile: opts.jsonlFile,
    sessionId: decoded.sessionId,
  });

  const runtimeSnapshot = finalizeRuntimeSnapshot({
    facts: decoded.runtimeFacts,
    sessionId: decoded.sessionId,
    jsonlFile: opts.jsonlFile,
    inferredModel: normalized.inferredModel,
    permissionMode: normalized.lastPermissionMode,
    firstTimestamp: normalized.firstTimestamp,
  });

  const { frames } = buildFrames({
    events: decoded.events,
    mutations: normalized.mutations,
    sidechainMutations: normalized.sidechainMutations,
    eventToMutations: normalized.eventToMutations,
    ledger: decoded.ledger,
    sessionId: decoded.sessionId,
    runtimeSnapshot,
  });

  const diagnostics: MutationDiagnostic[] = [];
  // 第一阶段：仅给一个跨行诊断——sidechain 数量。其余跨行问题留待 layer 2。
  const sidechainCount = decoded.events.filter((e) => e.isSidechain).length;
  if (sidechainCount > 0) {
    diagnostics.push({
      code: "sidechain_present",
      severity: "info",
      message: `sidechain events=${sidechainCount}`,
      metadata: { count: sidechainCount },
    });
  }

  return {
    sessionId: decoded.sessionId,
    jsonlFile: opts.jsonlFile,
    events: decoded.events,
    mutations: normalized.mutations,
    sidechainMutations: normalized.sidechainMutations,
    frames,
    lineLedger: decoded.ledger,
    runtimeSnapshot,
    inferredModel: normalized.inferredModel,
    diagnostics,
  };
}
