// char-diff.ts — Gate 3.5 Alignment Precision Audit
//
// Bypass / debug-only tool. NOT imported by any production path.
// Computes char-level diff between ExpectedQueryContext segments and
// ProxyQuerySnapshot segments as aligned by a ReconciliationReport.
//
// Design goals:
//   - Surface alignment gaps and char-count mismatches in human-readable form.
//   - Work directly from ReconciliationReport (no additional parsing needed).
//   - Performance-insensitive: correctness over speed.

import type {
  AlignmentRef,
  ContextSegment,
  ExpectedQueryContext,
  ProxyQuerySnapshot,
  ReconciliationFinding,
  ReconciliationReport,
  SegmentCategory,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Public output types
// ─────────────────────────────────────────────────────────────────────────────

export type DiffKind =
  | "matched_exact"        // rawHash / tool_use_id 精确匹配，chars 完全相同
  | "matched_char_diff"    // 有内容锚点匹配，但 char count 有差异（evidence-backed）
  | "suspect_match"        // 仅 category+role heuristic，无内容锚点，不计入 evidence-backed
  | "expected_only"        // expected segment 无对应 proxy
  | "proxy_only"           // proxy segment 未被任何 alignment 覆盖（unattributed）
  | "attribution_only"     // proxy segment 有 server-side attribution，无对应 expected（非 user-semantic）
  | "known_noise";         // 已知非用户语义的 server-side attribution（billing_noise 等）

export interface CharRange {
  start: number;  // inclusive char offset in the concatenated flat text
  end: number;    // exclusive
  chars: number;
}

export interface SegmentText {
  /** segment label for display */
  label: string;
  /** full text if available (contentRef.kind=inline) */
  text?: string;
  /** char count */
  chars: number;
  /** segment id */
  segmentId: string;
}

export interface SegmentDiffEntry {
  kind: DiffKind;
  category: SegmentCategory;
  label: string;
  /** char range in the "expected flat text" (undefined for proxy_only / attribution_only / known_noise) */
  expectedRange?: CharRange;
  /** char range in the "proxy flat text" (undefined for expected_only) */
  proxyRange?: CharRange;
  /** char count delta: expectedChars - proxyChars (0 for non-matched, undefined if not applicable) */
  charDelta?: number;
  /** absolute char delta as percentage of proxy chars (0..1) */
  charDeltaPct?: number;
  alignmentId?: string;
  expectedSegmentIds: string[];
  proxySegmentIds: string[];
  findingIds: string[];
  notes: string[];
  /** expandable text content, one entry per segment on each side */
  expectedTexts?: SegmentText[];
  proxyTexts?: SegmentText[];
}

export interface CharDiffReport {
  queryId: string;
  sessionId: string;
  generatedAt: string;
  entries: SegmentDiffEntry[];
  summary: CharDiffSummary;
  /** flat concatenation of all expected segment texts (by charCount) for range display */
  expectedFlatChars: number;
  /** flat concatenation of all proxy segment texts (by charCount) for range display */
  proxyFlatChars: number;
}

export interface CharDiffSummary {
  totalEntries: number;
  matchedExact: number;
  matchedWithCharDiff: number;
  // suspect_match：category+role heuristic，无内容锚点，不计入 evidence-backed
  suspectMatch: number;
  expectedOnly: number;
  // proxy_only：unattributed proxy segment，既无 alignment 也无 attribution
  proxyOnly: number;
  // attribution_only：server-side attribution 已识别（非 user-semantic），但无对应 expected
  attributionOnly: number;
  // known_noise：已知非用户语义的 server-side overhead（billing_noise 等），不宣称 token 节约
  knownNoise: number;
  totalExpectedChars: number;
  totalProxyChars: number;
  // unexplainedProxyChars：仅表示 unattributed proxy（proxy_only + suspect_match），
  // attribution_only 和 known_noise 不在此列
  unexplainedProxyChars: number;
  /** sum of |charDelta| across matched_char_diff entries */
  totalCharDriftAbsolute: number;
  /** totalCharDriftAbsolute / totalProxyChars (0..1)；仅表示 aligned 部分的 drift，=0 不代表 proxy==expected */
  charDriftPct: number;

  // ── 细化覆盖率拆分 ──────────────────────────────────────────────────────────
  /** proxy chars 中有 server-side attribution（含 evidence-backed），占 totalProxyChars 的比例 (0..1) */
  attributionCoverage: number;
  /** proxy chars 中有内容锚点证明（matched_exact + matched_char_diff），占 totalProxyChars 的比例 (0..1) */
  evidenceBackedCoverage: number;
  /** attributionCoverage - evidenceBackedCoverage：归因知晓但无 JSONL/ruleId 锚点的 gap (0..1) */
  attributionOnlyGap: number;
  /** suspect_match proxy chars（有 alignment 但无内容锚点），绝对值 */
  suspectMatchChars: number;
  /** evidence-backed matched 中 |expectedChars - proxyChars| 之和 / totalProxyChars；=0 仅代表 aligned 段无漂移 */
  alignedTextDrift: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export function computeCharDiff(report: ReconciliationReport): CharDiffReport {
  const { snapshot, expected, alignments, findings } = report;

  const expectedSegs = expected?.segments ?? [];
  const proxySegs = snapshot.segments;

  // Build lookup indices
  const expectedById = new Map<string, ContextSegment>(expectedSegs.map((s) => [s.id, s]));
  const proxyById = new Map<string, ContextSegment>(proxySegs.map((s) => [s.id, s]));
  const findingsByAlignId = buildFindingsByAlignId(findings);
  const findingsByExpectedId = buildFindingsBySegId(findings, "expected");
  const findingsByProxyId = buildFindingsBySegId(findings, "proxy");

  // Assign flat char offsets (ordered by segment.order, then insertion order)
  const expectedOffsets = buildFlatOffsets(expectedSegs);
  const proxyOffsets = buildFlatOffsets(proxySegs);

  const entries: SegmentDiffEntry[] = [];
  const coveredExpectedIds = new Set<string>();
  const coveredProxyIds = new Set<string>();

  // ── Process each alignment ─────────────────────────────────────────────────
  for (const align of alignments) {
    const relatedFindings = findingsByAlignId.get(align.id) ?? [];
    const findingIds = relatedFindings.map((f) => f.id);

    const eSegs = align.expectedSegmentIds.map((id) => expectedById.get(id)).filter(Boolean) as ContextSegment[];
    const pSegs = align.proxySegmentIds.map((id) => proxyById.get(id)).filter(Boolean) as ContextSegment[];

    for (const id of align.expectedSegmentIds) coveredExpectedIds.add(id);
    for (const id of align.proxySegmentIds) coveredProxyIds.add(id);

    const kind = classifyAlignmentKind(align, eSegs, pSegs, findings);
    const category = (eSegs[0] ?? pSegs[0])?.category ?? "unknown";
    const label = buildLabel(eSegs, pSegs, align);

    const expectedRange = eSegs.length > 0 ? mergeRanges(eSegs.map((s) => expectedOffsets.get(s.id)!)) : undefined;
    const proxyRange = pSegs.length > 0 ? mergeRanges(pSegs.map((s) => proxyOffsets.get(s.id)!)) : undefined;

    const expectedChars = eSegs.reduce((s, seg) => s + (seg.charCount ?? 0), 0);
    const proxyChars = pSegs.reduce((s, seg) => s + (seg.charCount ?? 0), 0);
    const charDelta = eSegs.length > 0 && pSegs.length > 0 ? expectedChars - proxyChars : undefined;
    const charDeltaPct =
      charDelta !== undefined && proxyChars > 0 ? Math.abs(charDelta) / proxyChars : undefined;

    const notes = buildNotes(align, relatedFindings);

    entries.push({
      kind,
      category,
      label,
      expectedRange,
      proxyRange,
      charDelta,
      charDeltaPct,
      alignmentId: align.id,
      expectedSegmentIds: align.expectedSegmentIds,
      proxySegmentIds: align.proxySegmentIds,
      findingIds,
      notes,
      expectedTexts: eSegs.length > 0 ? eSegs.map(segmentText) : undefined,
      proxyTexts: pSegs.length > 0 ? pSegs.map(segmentText) : undefined,
    });
  }

  // ── Unmatched expected segments ────────────────────────────────────────────
  for (const eseg of expectedSegs) {
    if (coveredExpectedIds.has(eseg.id)) continue;
    const relatedFindings = findingsByExpectedId.get(eseg.id) ?? [];
    entries.push({
      kind: "expected_only",
      category: eseg.category,
      label: eseg.label,
      expectedRange: expectedOffsets.get(eseg.id),
      charDelta: -(eseg.charCount ?? 0),
      expectedSegmentIds: [eseg.id],
      proxySegmentIds: [],
      findingIds: relatedFindings.map((f) => f.id),
      notes: [`expected segment not matched in proxy (${eseg.charCount ?? 0} chars)`],
      expectedTexts: [segmentText(eseg)],
    });
  }

  // ── Unmatched proxy segments (not covered by any alignment) ───────────────
  for (const pseg of proxySegs) {
    if (coveredProxyIds.has(pseg.id)) continue;
    const relatedFindings = findingsByProxyId.get(pseg.id) ?? [];
    entries.push({
      kind: "proxy_only",
      category: pseg.category,
      label: pseg.label,
      proxyRange: proxyOffsets.get(pseg.id),
      charDelta: pseg.charCount ?? 0,
      proxySegmentIds: [pseg.id],
      expectedSegmentIds: [],
      findingIds: relatedFindings.map((f) => f.id),
      notes: [`proxy segment not covered by any alignment (${pseg.charCount ?? 0} chars)`],
      proxyTexts: [segmentText(pseg)],
    });
  }

  // Sort entries by proxy range start, then expected range start
  entries.sort((a, b) => {
    const ap = a.proxyRange?.start ?? a.expectedRange?.start ?? Infinity;
    const bp = b.proxyRange?.start ?? b.expectedRange?.start ?? Infinity;
    return ap - bp;
  });

  const summary = computeSummary(entries, snapshot, expected);
  const expectedFlatChars = expectedSegs.reduce((s, seg) => s + (seg.charCount ?? 0), 0);
  const proxyFlatChars = proxySegs.reduce((s, seg) => s + (seg.charCount ?? 0), 0);

  return {
    queryId: report.queryId,
    sessionId: report.sessionId,
    generatedAt: new Date().toISOString(),
    entries,
    summary,
    expectedFlatChars,
    proxyFlatChars,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function segmentText(seg: ContextSegment): SegmentText {
  return {
    label: seg.label,
    text: seg.contentRef?.kind === "inline" ? seg.contentRef.text : undefined,
    chars: seg.charCount ?? 0,
    segmentId: seg.id,
  };
}

function buildFlatOffsets(segs: ContextSegment[]): Map<string, CharRange> {
  const sorted = [...segs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const m = new Map<string, CharRange>();
  let cursor = 0;
  for (const seg of sorted) {
    const chars = seg.charCount ?? 0;
    m.set(seg.id, { start: cursor, end: cursor + chars, chars });
    cursor += chars;
  }
  return m;
}

function mergeRanges(ranges: (CharRange | undefined)[]): CharRange | undefined {
  const valid = ranges.filter(Boolean) as CharRange[];
  if (valid.length === 0) return undefined;
  const start = Math.min(...valid.map((r) => r.start));
  const end = Math.max(...valid.map((r) => r.end));
  return { start, end, chars: end - start };
}

function classifyAlignmentKind(
  align: AlignmentRef,
  eSegs: ContextSegment[],
  pSegs: ContextSegment[],
  findings: ReconciliationFinding[],
): DiffKind {
  // known_noise: billing_noise proxy segments
  if (pSegs.length > 0 && pSegs.every((s) => s.category === "billing_noise")) {
    return "known_noise";
  }
  const alignFindings = findings.filter((f) => f.alignmentIds?.includes(align.id));
  if (alignFindings.some((f) => f.type === "known_noise")) {
    return "known_noise";
  }

  // attribution_only: proxy segment has attribution but no expected counterpart
  if (eSegs.length === 0 && pSegs.length > 0) {
    return "attribution_only";
  }

  // expected_only: no proxy segment
  if (pSegs.length === 0 && eSegs.length > 0) {
    return "expected_only";
  }

  // suspect_match：category+role heuristic（basis=category），无内容锚点，不算 evidence-backed
  if (align.basis === "category" || alignFindings.some((f) => f.type === "suspect_match")) {
    return "suspect_match";
  }

  // Both sides present with content anchor — check char diff
  const expectedChars = eSegs.reduce((s, seg) => s + (seg.charCount ?? 0), 0);
  const proxyChars = pSegs.reduce((s, seg) => s + (seg.charCount ?? 0), 0);
  const delta = Math.abs(expectedChars - proxyChars);
  const pct = proxyChars > 0 ? delta / proxyChars : 0;

  if (pct > 0.01 || delta > 10) {
    return "matched_char_diff";
  }
  return "matched_exact";
}

function buildLabel(
  eSegs: ContextSegment[],
  pSegs: ContextSegment[],
  align: AlignmentRef,
): string {
  const primary = eSegs[0] ?? pSegs[0];
  if (!primary) return `align:${align.id}`;
  const suffix = eSegs.length > 1 || pSegs.length > 1
    ? ` [${eSegs.length}E:${pSegs.length}P]`
    : "";
  return `${primary.label}${suffix}`;
}

function buildNotes(align: AlignmentRef, relatedFindings: ReconciliationFinding[]): string[] {
  const notes: string[] = [];
  if (align.note) notes.push(align.note);
  notes.push(`basis:${align.basis} confidence:${align.confidence} matchKind:${align.matchKind}`);
  for (const f of relatedFindings) {
    if (f.type !== "matched" && f.type !== "known_noise") {
      notes.push(`[${f.type}] ${f.message}`);
    }
  }
  return notes;
}

function buildFindingsByAlignId(
  findings: ReconciliationFinding[],
): Map<string, ReconciliationFinding[]> {
  const m = new Map<string, ReconciliationFinding[]>();
  for (const f of findings) {
    for (const id of f.alignmentIds ?? []) {
      const arr = m.get(id) ?? [];
      arr.push(f);
      m.set(id, arr);
    }
  }
  return m;
}

function buildFindingsBySegId(
  findings: ReconciliationFinding[],
  side: "expected" | "proxy",
): Map<string, ReconciliationFinding[]> {
  const m = new Map<string, ReconciliationFinding[]>();
  const key = side === "expected" ? "expectedSegmentIds" : "proxySegmentIds";
  for (const f of findings) {
    for (const id of f[key] ?? []) {
      const arr = m.get(id) ?? [];
      arr.push(f);
      m.set(id, arr);
    }
  }
  return m;
}

function computeSummary(
  entries: SegmentDiffEntry[],
  snapshot: ProxyQuerySnapshot,
  expected: ExpectedQueryContext | undefined,
): CharDiffSummary {
  let matchedExact = 0;
  let matchedWithCharDiff = 0;
  let suspectMatch = 0;
  let expectedOnly = 0;
  let proxyOnly = 0;
  let attributionOnly = 0;
  let knownNoise = 0;
  let totalCharDriftAbsolute = 0;

  // 用于细化覆盖率的字符累计
  let evidenceBackedChars = 0;   // matched_exact + matched_char_diff 的 proxy chars
  let attributionChars = 0;      // attribution_only + known_noise + evidence-backed 的 proxy chars
  let suspectMatchChars = 0;     // suspect_match 的 proxy chars

  for (const e of entries) {
    // proxyRange 是 bounding box（mergeRanges），多 segment 不连续时会包含中间无关字符；
    // 用 proxyTexts 逐段求和才是真实的 proxy chars
    const pChars = (e.proxyTexts ?? []).reduce((s, t) => s + t.chars, 0);
    switch (e.kind) {
      case "matched_exact":
        matchedExact++;
        evidenceBackedChars += pChars;
        attributionChars += pChars;
        break;
      case "matched_char_diff":
        matchedWithCharDiff++;
        totalCharDriftAbsolute += Math.abs(e.charDelta ?? 0);
        evidenceBackedChars += pChars;
        attributionChars += pChars;
        break;
      case "suspect_match":
        suspectMatch++;
        suspectMatchChars += pChars;
        // suspect 不计入 evidenceBackedChars，也不计入 attributionChars
        break;
      case "expected_only": expectedOnly++; break;
      case "proxy_only": proxyOnly++; break;
      case "attribution_only":
        // server-side attribution（非 user-semantic）：归因知晓但无 expected 对应
        attributionOnly++;
        attributionChars += pChars;
        break;
      case "known_noise":
        // 已知非用户语义的 server-side overhead，不宣称 token 节约
        knownNoise++;
        attributionChars += pChars;
        break;
    }
  }

  const totalExpectedChars = (expected?.segments ?? []).reduce((s, seg) => s + (seg.charCount ?? 0), 0);
  const totalProxyChars = snapshot.segments.reduce((s, seg) => s + (seg.charCount ?? 0), 0);

  // unexplainedProxyChars：仅 unattributed proxy（proxy_only + suspect_match）
  // attribution_only / known_noise 已有 server-side attribution，不算 unexplained
  const unexplainedProxyChars = entries
    .filter((e) => e.kind === "proxy_only" || e.kind === "suspect_match")
    .reduce((s, e) => s + (e.proxyTexts ?? []).reduce((t, seg) => t + seg.chars, 0), 0);

  const charDriftPct = totalProxyChars > 0 ? totalCharDriftAbsolute / totalProxyChars : 0;

  // 细化覆盖率（0..1）
  const evidenceBackedCoverage = totalProxyChars > 0 ? evidenceBackedChars / totalProxyChars : 0;
  const attributionCoverage = totalProxyChars > 0 ? attributionChars / totalProxyChars : 0;
  const attributionOnlyGap = Math.max(0, attributionCoverage - evidenceBackedCoverage);
  // alignedTextDrift：evidence-backed matched 中的文本漂移 / totalProxyChars
  // =0 仅表示已匹配段无漂移，不意味着 proxy == expected
  const alignedTextDrift = totalProxyChars > 0 ? totalCharDriftAbsolute / totalProxyChars : 0;

  return {
    totalEntries: entries.length,
    matchedExact,
    matchedWithCharDiff,
    suspectMatch,
    expectedOnly,
    proxyOnly,
    attributionOnly,
    knownNoise,
    totalExpectedChars,
    totalProxyChars,
    unexplainedProxyChars,
    totalCharDriftAbsolute,
    charDriftPct: Math.round(charDriftPct * 10000) / 10000,
    attributionCoverage: Math.round(attributionCoverage * 10000) / 10000,
    evidenceBackedCoverage: Math.round(evidenceBackedCoverage * 10000) / 10000,
    attributionOnlyGap: Math.round(attributionOnlyGap * 10000) / 10000,
    suspectMatchChars,
    alignedTextDrift: Math.round(alignedTextDrift * 10000) / 10000,
  };
}
