import { describe, expect, test } from "bun:test";
import { computeCharDiff } from "./char-diff";
import { renderCharDiffHtml } from "./render-char-diff-html";
import { MOCK_RECONCILIATION_REPORT } from "../reconciliation/report";
import { reconcileClaudeContext } from "../reconciliation/engine";
import type {
  ContextSegment,
  ExpectedQueryContext,
  ProxyQuerySnapshot,
  ReconciliationReport,
  SourceRef,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fixture builder
// ─────────────────────────────────────────────────────────────────────────────

function proxyRef(jsonPath: string): Extract<SourceRef, { kind: "proxy" }> {
  return { kind: "proxy", proxy: { file: "mock.json", jsonPath } };
}

function jsonlRef(): Extract<SourceRef, { kind: "jsonl" }> {
  return { kind: "jsonl", jsonl: { file: "mock.jsonl" } };
}

function makePseg(
  id: string,
  category: ContextSegment["category"],
  charCount: number,
  order: number,
  extra: Partial<ContextSegment> = {},
): ContextSegment {
  return {
    id,
    section: "messages",
    category,
    label: `${category}/${id}`,
    sourceRefs: [proxyRef(`reqBody.messages[${order}]`)],
    role: "user",
    charCount,
    order,
    ...extra,
  };
}

function makeEseg(
  id: string,
  category: ContextSegment["category"],
  charCount: number,
  order: number,
  extra: Partial<ContextSegment> = {},
): ContextSegment {
  return {
    id,
    section: "messages",
    category,
    label: `${category}/${id}`,
    sourceRefs: [jsonlRef()],
    role: "user",
    charCount,
    order,
    ...extra,
  };
}

function makeMinimalReport(
  pSegs: ContextSegment[],
  eSegs: ContextSegment[],
  alignments: ReconciliationReport["alignments"],
  findings: ReconciliationReport["findings"],
): ReconciliationReport {
  const snapshot: ProxyQuerySnapshot = {
    id: "snap-1",
    agentKind: "claude-code",
    sessionId: "sess-1",
    queryId: "q-1",
    timestamp: "2026-01-01T00:00:00Z",
    sourceRef: proxyRef("reqBody"),
    segments: pSegs,
    rawRequestHash: "sha256:mock",
  };

  const expected: ExpectedQueryContext = {
    id: "exp-1",
    agentKind: "claude-code",
    sessionId: "sess-1",
    queryId: "q-1",
    mutationIds: [],
    segments: eSegs,
    rulesApplied: [],
    generatedAt: "2026-01-01T00:00:00Z",
  };

  return {
    schemaVersion: "context-ledger.report.v1",
    id: "recon-q-1",
    agentKind: "claude-code",
    sessionId: "sess-1",
    queryId: "q-1",
    snapshot,
    proxyAttributions: [],
    expected,
    alignments,
    findings,
    coverage: {
      proxySegmentCount: pSegs.length,
      matchedProxySegmentCount: 0,
      unmatchedProxySegmentCount: pSegs.length,
      proxyChars: pSegs.reduce((s, seg) => s + (seg.charCount ?? 0), 0),
      wireExactChars: 0, canonicalExactChars: 0, templateChars: 0,
      regexChars: 0, presenceChars: 0, serverSideChars: 0,
      attributionOnlyChars: 0,
      unexplainedChars: pSegs.reduce((s, seg) => s + (seg.charCount ?? 0), 0),
      wireExactCoverage: 0, canonicalExactCoverage: 0, templateCoverage: 0,
      regexCoverage: 0, presenceCoverage: 0, serverSideCoverage: 0,
      attributionOnlyCoverage: 0, unexplainedCoverage: 1,
      regexOverreachRisk: 0, alignedTextDrift: 0,
      suspectMatchChars: 0, suspectMatchCount: 0, alignedTextDriftChars: 0,
    },
    generatedAt: "2026-01-01T00:00:00Z",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: computeCharDiff
// ─────────────────────────────────────────────────────────────────────────────

describe("computeCharDiff: empty report", () => {
  const report = makeMinimalReport([], [], [], []);
  const diff = computeCharDiff(report);

  test("produces no entries", () => {
    expect(diff.entries).toHaveLength(0);
  });

  test("summary zeros", () => {
    expect(diff.summary.totalEntries).toBe(0);
    expect(diff.summary.totalProxyChars).toBe(0);
    expect(diff.summary.totalExpectedChars).toBe(0);
  });
});

describe("computeCharDiff: exact match", () => {
  const pseg = makePseg("p1", "user_message", 100, 0, { rawHash: "sha256:abc" });
  const eseg = makeEseg("e1", "user_message", 100, 0, { rawHash: "sha256:abc" });
  const alignment: ReconciliationReport["alignments"][0] = {
    id: "align-1",
    comparisonGrade: "exact",
    confidence: "exact",
    expectedSegmentIds: ["e1"],
    proxySegmentIds: ["p1"],
    basis: "raw_hash",
  };
  const report = makeMinimalReport([pseg], [eseg], [alignment], []);
  const diff = computeCharDiff(report);

  test("one entry, matched kind", () => {
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].kind).toBe("matched");
  });

  test("charDelta is 0", () => {
    expect(diff.entries[0].charDelta).toBe(0);
  });

  test("expectedRange and proxyRange set", () => {
    expect(diff.entries[0].expectedRange).toEqual({ start: 0, end: 100, chars: 100 });
    expect(diff.entries[0].proxyRange).toEqual({ start: 0, end: 100, chars: 100 });
  });

  test("summary: 1 matched", () => {
    expect(diff.summary.matched).toBe(1);
    expect(diff.summary.approximateMatch).toBe(0);
  });
});

describe("computeCharDiff: char diff match (evidence-backed, char count differs)", () => {
  const pseg = makePseg("p1", "user_message", 200, 0);
  const eseg = makeEseg("e1", "user_message", 100, 0);
  // 用 raw_hash basis：有内容锚点，才应分类为 approximate_match
  const alignment: ReconciliationReport["alignments"][0] = {
    id: "align-1",
    comparisonGrade: "normalized",
    confidence: "estimated",
    expectedSegmentIds: ["e1"],
    proxySegmentIds: ["p1"],
    basis: "normalized_hash",
  };
  const report = makeMinimalReport([pseg], [eseg], [alignment], []);
  const diff = computeCharDiff(report);

  test("entry kind is approximate_match", () => {
    expect(diff.entries[0].kind).toBe("approximate_match");
  });

  test("charDelta = expectedChars - proxyChars = -100", () => {
    expect(diff.entries[0].charDelta).toBe(-100);
  });

  test("charDeltaPct = 0.5", () => {
    expect(diff.entries[0].charDeltaPct).toBeCloseTo(0.5);
  });

  test("summary: 1 approximateMatch, drift = 100/200", () => {
    expect(diff.summary.approximateMatch).toBe(1);
    expect(diff.summary.totalCharDriftAbsolute).toBe(100);
    expect(diff.summary.charDriftPct).toBeCloseTo(0.5);
  });
});

describe("computeCharDiff: suspect_match (category+role heuristic only)", () => {
  const pseg = makePseg("p1", "user_message", 200, 0);
  const eseg = makeEseg("e1", "user_message", 100, 0);
  // basis: "category" → suspect_match，不计入 evidence-backed
  const alignment: ReconciliationReport["alignments"][0] = {
    id: "align-1",
    comparisonGrade: "presence",
    confidence: "inferred",
    expectedSegmentIds: ["e1"],
    proxySegmentIds: ["p1"],
    basis: "category",
  };
  const report = makeMinimalReport([pseg], [eseg], [alignment], []);
  const diff = computeCharDiff(report);

  test("entry kind is suspect_match", () => {
    expect(diff.entries[0].kind).toBe("suspect_match");
  });

  test("charDelta still computed for display", () => {
    expect(diff.entries[0].charDelta).toBe(-100);
  });

  test("summary: 1 suspectMatch, 0 approximateMatch", () => {
    expect(diff.summary.suspectMatch).toBe(1);
    expect(diff.summary.approximateMatch).toBe(0);
  });

  test("suspect chars counted in unexplainedProxyChars", () => {
    // suspect_match 的 proxy chars 应算入 unexplained（未有内容锚点证明）
    expect(diff.summary.unexplainedProxyChars).toBe(200);
  });
});

describe("computeCharDiff: server_side_attribution", () => {
  const pseg = makePseg("p-noise", "billing_noise", 50, 0);
  const alignment: ReconciliationReport["alignments"][0] = {
    id: "align-noise",
    comparisonGrade: "presence",
    confidence: "exact",
    expectedSegmentIds: [],
    proxySegmentIds: ["p-noise"],
    basis: "server_side_attribution",
    note: "billing_noise: known harness overhead",
  };
  const finding: ReconciliationReport["findings"][0] = {
    id: "f-noise",
    type: "server_side_attribution",
    severity: "info",
    message: "known noise",
    proxySegmentIds: ["p-noise"],
    alignmentIds: ["align-noise"],
  };
  const report = makeMinimalReport([pseg], [], [alignment], [finding]);
  const diff = computeCharDiff(report);

  test("entry kind is server_side_attribution", () => {
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].kind).toBe("server_side_attribution");
  });

  test("summary: 1 serverSideAttribution", () => {
    expect(diff.summary.serverSideAttribution).toBe(1);
  });
});

describe("computeCharDiff: proxy_only (unmatched proxy segment)", () => {
  const pseg = makePseg("p-unknown", "unknown", 300, 0);
  const report = makeMinimalReport([pseg], [], [], []);
  const diff = computeCharDiff(report);

  test("entry kind is proxy_only", () => {
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].kind).toBe("proxy_only");
  });

  test("proxyRange is set", () => {
    expect(diff.entries[0].proxyRange).toEqual({ start: 0, end: 300, chars: 300 });
  });

  test("unexplainedProxyChars = 300", () => {
    expect(diff.summary.unexplainedProxyChars).toBe(300);
  });
});

describe("computeCharDiff: expected_only (unmatched expected segment)", () => {
  const eseg = makeEseg("e-only", "user_message", 150, 0);
  const report = makeMinimalReport([], [eseg], [], []);
  const diff = computeCharDiff(report);

  test("entry kind is expected_only", () => {
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].kind).toBe("expected_only");
  });

  test("expectedRange is set", () => {
    expect(diff.entries[0].expectedRange).toEqual({ start: 0, end: 150, chars: 150 });
  });

  test("charDelta is negative (missing from proxy)", () => {
    expect(diff.entries[0].charDelta).toBe(-150);
  });
});

describe("computeCharDiff: attribution_only", () => {
  const pseg = makePseg("p-attr", "system_prompt", 1800, 0);
  const alignment: ReconciliationReport["alignments"][0] = {
    id: "align-attr",
    comparisonGrade: "presence",
    confidence: "estimated",
    expectedSegmentIds: [],
    proxySegmentIds: ["p-attr"],
    basis: "attribution_only",
    note: "attribution-only: system_prompt_pattern",
  };
  const report = makeMinimalReport([pseg], [], [alignment], []);
  const diff = computeCharDiff(report);

  test("entry kind is attribution_only", () => {
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].kind).toBe("attribution_only");
  });

  test("summary: 1 attributionOnly", () => {
    expect(diff.summary.attributionOnly).toBe(1);
  });
});

describe("computeCharDiff: flat char offsets are contiguous", () => {
  const segs = [
    makePseg("p0", "user_message", 100, 0),
    makePseg("p1", "tool_use", 200, 1),
    makePseg("p2", "tool_result", 300, 2),
  ];
  const report = makeMinimalReport(segs, [], [], []);
  const diff = computeCharDiff(report);

  test("proxyFlatChars = 600", () => {
    expect(diff.proxyFlatChars).toBe(600);
  });

  // All unmatched → proxy_only entries, ranges should be contiguous
  test("proxy_only entries have contiguous non-overlapping ranges", () => {
    const ranges = diff.entries
      .filter((e) => e.kind === "proxy_only" && e.proxyRange)
      .map((e) => e.proxyRange!)
      .sort((a, b) => a.start - b.start);

    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBe(ranges[i - 1].end);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: mock report integration
// ─────────────────────────────────────────────────────────────────────────────

describe("computeCharDiff: mock report", () => {
  const mock = MOCK_RECONCILIATION_REPORT;
  const diff = computeCharDiff(mock);

  test("produces entries", () => {
    expect(diff.entries.length).toBeGreaterThan(0);
  });

  test("summary totals are consistent", () => {
    const s = diff.summary;
    const kindSum =
      s.matched +
      s.approximateMatch +
      s.suspectMatch +
      s.expectedOnly +
      s.proxyOnly +
      s.attributionOnly +
      s.serverSideAttribution;
    expect(kindSum).toBe(s.totalEntries);
  });

  test("proxyFlatChars matches sum of proxy segment charCounts", () => {
    const expected = mock.snapshot.segments.reduce((s, seg) => s + (seg.charCount ?? 0), 0);
    expect(diff.proxyFlatChars).toBe(expected);
  });

  test("expectedFlatChars matches sum of expected segment charCounts", () => {
    const expected = (mock.expected?.segments ?? []).reduce((s, seg) => s + (seg.charCount ?? 0), 0);
    expect(diff.expectedFlatChars).toBe(expected);
  });

  test("evidenceBackedCoverage <= attributionCoverage (evidence is subset of attribution)", () => {
    const s = diff.summary;
    expect(s.evidenceBackedCoverage).toBeLessThanOrEqual(s.attributionCoverage);
  });

  test("attributionOnlyGap = attributionCoverage - evidenceBackedCoverage", () => {
    const s = diff.summary;
    expect(s.attributionOnlyGap).toBeCloseTo(s.attributionCoverage - s.evidenceBackedCoverage, 4);
  });

  test("unexplainedProxyChars 仅含 proxy_only + suspect_match（不含 attribution_only/server_side_attribution）", () => {
    const s = diff.summary;
    const manualUnattributed = diff.entries
      .filter((e) => e.kind === "proxy_only" || e.kind === "suspect_match")
      .reduce((acc, e) => acc + (e.proxyRange?.chars ?? 0), 0);
    expect(s.unexplainedProxyChars).toBe(manualUnattributed);
  });

  test("suspectMatchChars matches entries with kind=suspect_match", () => {
    const s = diff.summary;
    const manualSuspect = diff.entries
      .filter((e) => e.kind === "suspect_match")
      .reduce((acc, e) => acc + (e.proxyRange?.chars ?? 0), 0);
    expect(s.suspectMatchChars).toBe(manualSuspect);
  });

  // 验证验收条件：proxy 129k / expected 6k 场景下不会显示"全都解释完"
  // mock 数字较小，但逻辑一致：proxy 16970 >> expected ~17170，evidence-backed 应 < 1.0
  test("evidenceBackedCoverage < 1.0（proxy >> expected 时不宣称全解释完）", () => {
    expect(diff.summary.evidenceBackedCoverage).toBeLessThan(1.0);
  });
});

describe("computeCharDiff: live reconciliation on mock", () => {
  const mock = MOCK_RECONCILIATION_REPORT;
  const liveReport = reconcileClaudeContext({
    snapshot: mock.snapshot,
    attributions: mock.proxyAttributions,
    expected: mock.expected,
    fixtureName: "mock",
  });
  const diff = computeCharDiff(liveReport);

  test("no entry has both expectedRange and proxyRange undefined", () => {
    for (const e of diff.entries) {
      expect(e.expectedRange !== undefined || e.proxyRange !== undefined).toBe(true);
    }
  });

  test("server_side_attribution entries exist (billing_noise in mock)", () => {
    expect(diff.entries.some((e) => e.kind === "server_side_attribution")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: renderCharDiffHtml
// ─────────────────────────────────────────────────────────────────────────────

describe("renderCharDiffHtml: basic", () => {
  const mock = MOCK_RECONCILIATION_REPORT;
  const diff = computeCharDiff(mock);
  const html = renderCharDiffHtml(diff);

  test("returns a non-empty HTML string", () => {
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(500);
  });

  test("contains DOCTYPE and html tag", () => {
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
  });

  test("contains queryId in title", () => {
    expect(html).toContain(mock.queryId);
  });

  test("contains char range values", () => {
    // The HTML should contain bracket range notation
    expect(html).toMatch(/\[\d+…\d+\)/);
  });

  test("contains coverage bar", () => {
    expect(html).toContain("Proxy Char Coverage");
  });

  test("contains summary stat cards", () => {
    expect(html).toContain("Total Entries");
    expect(html).toContain("Matched Exact");
    expect(html).toContain("Proxy Chars");
  });

  test("no unescaped < or > in segment labels", () => {
    // All user-visible text should be HTML-escaped; no raw angle brackets outside tags
    const stripped = html.replace(/<[^>]+>/g, "");
    expect(stripped).not.toMatch(/<[a-z]/);
  });
});

describe("renderCharDiffHtml: minimal empty report", () => {
  const report = makeMinimalReport([], [], [], []);
  const diff = computeCharDiff(report);
  const html = renderCharDiffHtml(diff);

  test("renders without error", () => {
    expect(html).toContain("<!DOCTYPE html>");
  });

  test("shows no entries message", () => {
    expect(html).toContain("No entries");
  });
});
