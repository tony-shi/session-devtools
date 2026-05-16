import { describe, it, expect } from "vitest";
import { enrichTreeWithGraph } from "./attribution-tree-enrich.ts";
import type { AttributionTreeResult, SerializedNode } from "./attribution-service.ts";
import type { JsonlEventAnnotation } from "./session-attribution-graph.ts";

// ─── Test helpers ────────────────────────────────────────────────────────────

function mkJsonlLeaf(id: string, jsonlLineIdx: number, extra?: Partial<SerializedNode["origin"]>): SerializedNode {
  return {
    id,
    slotType: "messages.user_input",
    jsonPath: `$.messages[${id}]`,
    charCount: 100,
    rawHash: "h",
    preview: "...",
    origin: {
      kind: "jsonl",
      eventKind: { source: "user_input", contentType: "text" },
      jsonlLineIdx,
      sourceCallId: 50,
      confidence: "definitive",
      fullyCovered: true,
      ...(extra ?? {}),
    } as SerializedNode["origin"],
    authorship: "human",
    coverageState: "full",
    children: [],
  };
}

function mkTree(leaves: SerializedNode[]): AttributionTreeResult {
  return {
    callId: 100,
    sessionId: "s",
    hasProxy: true,
    snapshot: {
      roots: leaves,
      nodeSummaries: Object.fromEntries(leaves.map(l => [l.id, {
        id: l.id, slotType: l.slotType, charCount: l.charCount, preview: l.preview,
        origin: l.origin, authorship: l.authorship, coverageState: l.coverageState,
      }])),
    },
  } as unknown as AttributionTreeResult;
}

function mkAnnotation(lineIdx: number, firstSeen: number | null, consumed: number[]): JsonlEventAnnotation {
  return {
    lineIdx,
    source: "user_input",
    authorship: "human",
    firstSeenInCall: firstSeen,
    consumedByCallIds: consumed,
    contextImpact: firstSeen != null ? "indexed" : "pending",
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("enrichTreeWithGraph", () => {
  it("writes firstSeenInCall when graph value ≤ currentCallId", () => {
    const tree = mkTree([mkJsonlLeaf("a", 5)]);
    const eventByLine = new Map([[5, mkAnnotation(5, 80, [80, 90, 100])]]);
    const summary = enrichTreeWithGraph(tree, eventByLine, false, 100);

    expect(summary.written).toBe(1);
    expect(summary.droppedByGuard).toBe(0);
    const origin = tree.snapshot!.roots[0].origin as { firstSeenInCall?: number };
    expect(origin.firstSeenInCall).toBe(80);
  });

  it("G1: drops firstSeenInCall when graph value > currentCallId", () => {
    // The pathological case from session 32478a3f / Call 337:
    // leaf is in call 337's prompt, but audit window only covered later
    // calls. Graph reports firstSeen=475 — that's logically impossible
    // (337 already consumes this line), so it must be dropped.
    const tree = mkTree([mkJsonlLeaf("a", 5)]);
    const eventByLine = new Map([[5, mkAnnotation(5, 475, [475, 476])]]);
    const summary = enrichTreeWithGraph(tree, eventByLine, true, 337);

    expect(summary.droppedByGuard).toBe(1);
    expect(summary.written).toBe(0);
    const origin = tree.snapshot!.roots[0].origin as { firstSeenInCall?: number; firstSeenIsWindowBounded?: boolean };
    expect(origin.firstSeenInCall).toBeUndefined();
    // Window qualifier must also stay off when we didn't write a value —
    // otherwise the UI would print "(审计窗口内)" with no chip to qualify.
    expect(origin.firstSeenIsWindowBounded).toBeUndefined();
  });

  it("G2: filters consumedByCallIds to ids ≤ currentCallId", () => {
    const tree = mkTree([mkJsonlLeaf("a", 5)]);
    const eventByLine = new Map([[5, mkAnnotation(5, 80, [80, 100, 200, 337])]]);
    const summary = enrichTreeWithGraph(tree, eventByLine, false, 150);

    expect(summary.written).toBe(1);
    const origin = tree.snapshot!.roots[0].origin as { consumedByCallIds?: number[] };
    expect(origin.consumedByCallIds).toEqual([80, 100]);  // 200, 337 dropped
  });

  it("writes firstSeenIsWindowBounded only when isWindowBounded AND a value was written", () => {
    const tree = mkTree([mkJsonlLeaf("a", 5), mkJsonlLeaf("b", 6)]);
    const eventByLine = new Map([
      [5, mkAnnotation(5, 80, [80])],     // valid → writes, marks bounded
      [6, mkAnnotation(6, 999, [999])],   // > current → dropped, no bounded mark
    ]);
    enrichTreeWithGraph(tree, eventByLine, true, 100);

    const a = tree.snapshot!.roots[0].origin as { firstSeenIsWindowBounded?: boolean };
    const b = tree.snapshot!.roots[1].origin as { firstSeenIsWindowBounded?: boolean };
    expect(a.firstSeenIsWindowBounded).toBe(true);
    expect(b.firstSeenIsWindowBounded).toBeUndefined();
  });

  it("noAnnotation counter: leaves whose line isn't in the graph at all", () => {
    const tree = mkTree([mkJsonlLeaf("a", 5), mkJsonlLeaf("b", 99)]);
    const eventByLine = new Map([[5, mkAnnotation(5, 80, [80])]]);
    // line 99 has no annotation
    const summary = enrichTreeWithGraph(tree, eventByLine, false, 100);

    expect(summary.written).toBe(1);
    expect(summary.noAnnotation).toBeGreaterThanOrEqual(1);
  });

  it("non-jsonl origins are untouched", () => {
    const tree = mkTree([{
      ...mkJsonlLeaf("a", 5),
      origin: { kind: "rule", ruleId: "wire.foo", matchMode: "exact", confidence: "definitive", fullyCovered: true } as SerializedNode["origin"],
    }]);
    const eventByLine = new Map([[5, mkAnnotation(5, 80, [80])]]);
    const summary = enrichTreeWithGraph(tree, eventByLine, false, 100);

    expect(summary.written).toBe(0);
    expect(summary.droppedByGuard).toBe(0);
    expect((tree.snapshot!.roots[0].origin as { kind: string }).kind).toBe("rule");
  });

  it("treats firstSeenInCall === currentCallId as valid (boundary)", () => {
    // The leaf IS in call N's prompt, and graph says first-seen is also N.
    // That's the common case: the call that introduces an event is the
    // first to "see" it. Must NOT drop.
    const tree = mkTree([mkJsonlLeaf("a", 5)]);
    const eventByLine = new Map([[5, mkAnnotation(5, 100, [100, 101, 102])]]);
    const summary = enrichTreeWithGraph(tree, eventByLine, false, 100);

    expect(summary.written).toBe(1);
    expect(summary.droppedByGuard).toBe(0);
    const origin = tree.snapshot!.roots[0].origin as { firstSeenInCall?: number };
    expect(origin.firstSeenInCall).toBe(100);
  });
});
