// attribution-tree-enrich — write reverse-attribution facts (firstSeenInCall
// / consumedByCallIds) onto every jsonl-origin leaf in an
// AttributionTreeResult, in-place.
//
// Front-end can then use `leaf.origin.firstSeenInCall` as a direct jump
// target — no cross-endpoint join.
//
// Two correctness guards (logical invariants):
//
//   G1. firstSeenInCall ≤ currentCallId — by definition you can't "first see"
//       content in a *future* call when *this* call already reads it. When
//       this trips we drop firstSeenInCall rather than ship a wrong value;
//       UI degrades gracefully (no jump chip).
//
//   G2. consumedByCallIds is filtered to ids ≤ currentCallId for the same
//       reason — a call can't be consuming this event "before this call
//       exists".

import type { AttributionTreeResult, SerializedNode } from "./attribution-service.ts";
import type { JsonlEventAnnotation } from "./session-attribution-graph.ts";

export interface EnrichSummary {
  /** How many jsonl-origin leaves received a `firstSeenInCall` value. */
  written: number;
  /** How many had a candidate from the graph but were dropped by G1
   *  (firstSeenInCall > currentCallId) — useful to surface "this call is
   *  outside the audit window" diagnostics to the caller. */
  droppedByGuard: number;
  /** How many were untouched because the graph had no annotation for them
   *  (line not in audit window at all). */
  noAnnotation: number;
}

export function enrichTreeWithGraph(
  tree: AttributionTreeResult,
  eventByLine: Map<number, JsonlEventAnnotation>,
  currentCallId: number,
): EnrichSummary {
  const summary: EnrichSummary = { written: 0, droppedByGuard: 0, noAnnotation: 0 };
  if (!tree.snapshot) return summary;

  // nodeSummaries usually share origin refs with the roots tree; to make
  // counters honest we de-dup by reference so each origin is processed once.
  const seen = new WeakSet<object>();

  const apply = (origin: SerializedNode["origin"]) => {
    if (seen.has(origin)) return;
    seen.add(origin);
    if (origin.kind !== "jsonl") return;
    const ann = eventByLine.get(origin.jsonlLineIdx);
    if (!ann) { summary.noAnnotation += 1; return; }

    // G1: firstSeenInCall ≤ currentCallId
    if (ann.firstSeenInCall != null) {
      if (ann.firstSeenInCall <= currentCallId) {
        origin.firstSeenInCall = ann.firstSeenInCall;
        summary.written += 1;
      } else {
        summary.droppedByGuard += 1;
      }
    }
    // G2: filter consumedByCallIds to ≤ currentCallId
    if (ann.consumedByCallIds.length > 0) {
      const past = ann.consumedByCallIds.filter(c => c <= currentCallId);
      if (past.length > 0) origin.consumedByCallIds = past;
    }
  };

  const visit = (node: SerializedNode) => {
    apply(node.origin);
    for (const c of node.children) visit(c);
  };
  for (const root of tree.snapshot.roots) visit(root);
  // Defensive pass for summaries that might carry distinct origin refs
  // (the WeakSet skips refs we already processed above).
  for (const s of Object.values(tree.snapshot.nodeSummaries)) {
    apply(s.origin);
  }
  return summary;
}
