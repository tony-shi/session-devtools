// Conditional regression test: compare the incremental vs legacy
// `computeSessionAttributionGraph` algorithms on a real session, and report
// any disagreements on firstSeenInCall / contextImpact.
//
// Why conditional? The real session lives in the user's local sessions DB
// (~/.api-dashboard/sessions.db) plus large proxy req-body files — it isn't
// reasonable to ship as a fixture. So this test only runs when the env var
// `FIXTURE_SESSION_ID=<uuid>` is set:
//
//     FIXTURE_SESSION_ID=32478a3f-c777-4e42-b603-630c82717371 \
//         npx vitest run attribution-algorithms-diff
//
// Output: a structured diff report classifying every event that has a
// different annotation between the two algorithms. Useful to:
//   • spot light-linker coverage gaps (incremental missing firstSeenInCall
//     that legacy found → uncovered match channel)
//   • spot severe correctness bugs (both algorithms found a value but they
//     disagree on which call it was)
//
// This file is the user-facing "is the new algorithm safe to ship?" probe.

import { describe, it, expect } from "vitest";
import { getDb } from "./db";
import { parseSessionDrilldown } from "./session-drilldown-parser";
import { readSessionEventsForLinker } from "./attribution-service";
import { findProxyRowForCall, readProxyRecord } from "./call-detail";
import { computeSessionAttributionGraph } from "./session-attribution-graph";
import type { LinkableJsonlEvent } from "./context-ledger/parser";
import type { JsonlEventAnnotation, SessionAttributionGraph } from "./session-attribution-graph";

const FIXTURE_SESSION_ID = process.env.FIXTURE_SESSION_ID;
const FIXTURE_LAST_N = process.env.FIXTURE_LAST_N ? parseInt(process.env.FIXTURE_LAST_N, 10) : 20;

// vitest's describe.skipIf would also work, but explicit conditional keeps
// the intent obvious in test output ("- skipped: no FIXTURE_SESSION_ID").
const maybeDescribe = FIXTURE_SESSION_ID ? describe : describe.skip;

maybeDescribe(`attribution algorithms diff: ${FIXTURE_SESSION_ID ?? "(skipped)"}`, () => {
  it(`incremental vs legacy on lastN=${FIXTURE_LAST_N}`, async () => {
    const sessionId = FIXTURE_SESSION_ID!;
    const db = getDb();

    // ── Resolve session + helpers (mirrors sessions-v2.controller wiring) ──
    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`session ${sessionId} not in sessions_meta_v2`);
    const sourceFile = row.source_file as string;

    const drilldown = parseSessionDrilldown(sourceFile, sessionId, row, db);
    const allCalls = drilldown.turns.flatMap((t) => t.calls.map((c) => ({ call: c, turnId: t.id })));
    const targetCalls = allCalls.slice(-FIXTURE_LAST_N);

    // Shared jsonl events cache to avoid each algorithm re-reading the file.
    let cachedEvents: LinkableJsonlEvent[] | null = null;
    const loadJsonlEvents = (file: string): LinkableJsonlEvent[] | null => {
      if (file !== sourceFile) return null;
      if (cachedEvents === null) cachedEvents = readSessionEventsForLinker(file);
      return cachedEvents;
    };

    const helpers = {
      listCalls: () => targetCalls.map((x) => ({ callId: x.call.id, sourceFile })),
      loadCallHelpers: {
        resolveCallMeta: (_sid: string, cid: number) => {
          const cur = allCalls.find((x) => x.call.id === cid);
          if (!cur) return null;
          const curIdx = allCalls.indexOf(cur);
          const prev = curIdx > 0 ? allCalls[curIdx - 1] : null;
          return {
            call: {
              id: cur.call.id, timestamp: cur.call.timestamp,
              turnId: cur.turnId, sourceFile, apiRequestId: cur.call.apiRequestId,
            },
            prevCall: prev
              ? { id: prev.call.id, timestamp: prev.call.timestamp, apiRequestId: prev.call.apiRequestId }
              : null,
          };
        },
        fetchProxyReqBodyAt: async (sid: string, ts: string, excludeProxyId?: number, apiRequestId?: string | null) => {
          const proxyRow = findProxyRowForCall(db, sid, apiRequestId ?? undefined, ts, excludeProxyId);
          if (!proxyRow) return null;
          const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
          const reqBodyStr = rec?.reqBody as string | undefined;
          if (typeof reqBodyStr !== "string") return null;
          let reqBody: Record<string, unknown> | null = null;
          try { reqBody = JSON.parse(reqBodyStr) as Record<string, unknown>; } catch { return null; }
          let reqHeaders: Record<string, string> = {};
          try { reqHeaders = JSON.parse(proxyRow.req_headers ?? "{}") as Record<string, string>; }
          catch { /* default empty */ }
          return {
            reqBody, reqHeaders,
            proxyRequestId: proxyRow.id,
            startedAt: proxyRow.started_at ?? ts,
          };
        },
        loadJsonlEvents,
      },
    };

    // ── Run both algorithms ──
    const tInc0 = Date.now();
    const incremental = await computeSessionAttributionGraph(sessionId, db, helpers, { algorithm: "incremental" });
    const tInc = Date.now() - tInc0;

    const tLeg0 = Date.now();
    const legacy = await computeSessionAttributionGraph(sessionId, db, helpers, { algorithm: "legacy" });
    const tLeg = Date.now() - tLeg0;

    // ── Diff ──
    const report = diffGraphs(legacy, incremental);

    // ── Print diagnostic report regardless of pass/fail ──
    /* eslint-disable no-console */
    console.log("");
    console.log("┌─────────────────────────────────────────────────────────────");
    console.log(`│ Attribution algo diff — session ${sessionId.slice(0, 8)} lastN=${FIXTURE_LAST_N}`);
    console.log("├─────────────────────────────────────────────────────────────");
    console.log(`│ Timing                  legacy ${tLeg} ms    incremental ${tInc} ms    speedup ${(tLeg / Math.max(tInc, 1)).toFixed(1)}x`);
    console.log(`│ Total events            ${report.totalEvents}`);
    console.log(`│ Both agree              ${report.agree}  (${pct(report.agree, report.totalEvents)})`);
    console.log(`│ Both indexed, diff call ${report.differentCall.length}  ← severe`);
    console.log(`│ Legacy indexed, inc miss ${report.incMissing.length}  ← light-linker coverage gap`);
    console.log(`│ Inc indexed, legacy miss ${report.legMissing.length}  ← legacy missed (unexpected)`);
    console.log(`│ Both pending/skipped    ${report.bothNonIndexed}`);
    console.log("├─────────────────────────────────────────────────────────────");
    if (report.differentCall.length > 0) {
      console.log(`│ Severe samples (different firstSeenInCall):`);
      for (const d of report.differentCall.slice(0, 10)) {
        console.log(`│   line=${d.lineIdx}  legacy=${d.legacyCall}  inc=${d.incCall}  source=${d.source}`);
      }
    }
    if (report.incMissing.length > 0) {
      console.log(`│ Light linker coverage gap samples (by source):`);
      const byKind = bucketBy(report.incMissing, (d) => d.source);
      for (const [k, items] of byKind) {
        console.log(`│   ${k.padEnd(20)} ${items.length} miss(es); e.g. line=${items[0].lineIdx} legacy→#${items[0].legacyCall}`);
      }
      // Diagnostic: for the first 3 miss events, show their raw shape.
      // Helps debug "why did light linker miss this".
      const events = cachedEvents!;
      console.log(`│ Diagnostic — first few miss events:`);
      for (const m of report.incMissing.slice(0, 5)) {
        const ev = events.find(e => e.lineIdx === m.lineIdx);
        if (!ev) continue;
        const summary = {
          line: ev.lineIdx, type: ev.type, source: m.source,
          hasUserText: !!ev.userText, hasAssistantText: !!ev.assistantText,
          hasToolUses: !!(ev.toolUses?.length),
          hasToolResults: !!(ev.toolResults?.length),
          hasUserImages: !!(ev.userImages?.length),
          imageDigests: ev.userImages?.map(i => i.digest),
          hasAttachment: !!ev.attachment,
          hasHarnessInjection: !!ev.harnessInjection,
          hasCommandText: !!ev.commandText,
        };
        console.log(`│   ${JSON.stringify(summary)}`);
      }
    }
    if (report.legMissing.length > 0) {
      console.log(`│ Legacy-miss samples (incremental matched but legacy didn't):`);
      for (const d of report.legMissing.slice(0, 10)) {
        console.log(`│   line=${d.lineIdx}  inc=${d.incCall}  source=${d.source}`);
      }
    }
    console.log("└─────────────────────────────────────────────────────────────");
    console.log("");
    /* eslint-enable no-console */

    // ── Assertions ──
    //
    // I1 — zero severe disagreement. Both algorithms might miss an event,
    // but if BOTH found one and they disagree on which call, that's a bug.
    //
    // I2 — light linker must not invent matches that legacy doesn't see.
    // legacy uses the full segment tree + canonical linker, so an extra
    // incremental hit suggests light linker false positive (hash collision
    // / over-eager match).
    //
    // I3 — light linker coverage ≥ 98%. Empirically on 32478a3f session
    // we hit 98.9%, the remaining miss is attachment (substring matching,
    // intentionally not covered) + a handful of harness-wrapped user_input
    // edge cases. Regressions below 98% would indicate a broken match
    // channel.
    expect(
      report.differentCall.map(d => ({ line: d.lineIdx, legacy: d.legacyCall, inc: d.incCall })),
    ).toEqual([]);  // I1

    expect(report.legMissing.length).toBe(0);  // I2

    const incCoverage = (report.totalIndexedInLegacy - report.incMissing.length)
      / Math.max(report.totalIndexedInLegacy, 1);
    expect(incCoverage).toBeGreaterThanOrEqual(0.98);  // I3
  }, 5 * 60 * 1000);  // 5 min timeout — legacy on big sessions is slow
});

// ─── Helpers ────────────────────────────────────────────────────────────────

interface DiffRecord {
  lineIdx: number;
  source: string;
  legacyCall: number | null;
  incCall: number | null;
}

interface DiffReport {
  totalEvents: number;
  totalIndexedInLegacy: number;
  agree: number;
  differentCall: DiffRecord[];   // both indexed but callIds differ — severe
  incMissing: DiffRecord[];      // legacy found, incremental didn't
  legMissing: DiffRecord[];      // incremental found, legacy didn't
  bothNonIndexed: number;        // both pending / skipped (boring agreement)
}

function diffGraphs(legacy: SessionAttributionGraph, incremental: SessionAttributionGraph): DiffReport {
  const incByLine = new Map<number, JsonlEventAnnotation>();
  for (const ev of incremental.events) incByLine.set(ev.lineIdx, ev);

  const r: DiffReport = {
    totalEvents: legacy.events.length,
    totalIndexedInLegacy: 0,
    agree: 0,
    differentCall: [],
    incMissing: [],
    legMissing: [],
    bothNonIndexed: 0,
  };

  for (const leg of legacy.events) {
    const inc = incByLine.get(leg.lineIdx);
    if (!inc) continue;  // shouldn't happen — both algorithms see same events
    const legFirst = leg.firstSeenInCall;
    const incFirst = inc.firstSeenInCall;
    if (legFirst != null) r.totalIndexedInLegacy += 1;

    if (legFirst === incFirst) {
      if (legFirst != null) r.agree += 1;
      else r.bothNonIndexed += 1;
    } else if (legFirst != null && incFirst != null) {
      r.differentCall.push({ lineIdx: leg.lineIdx, source: leg.source, legacyCall: legFirst, incCall: incFirst });
    } else if (legFirst != null && incFirst == null) {
      r.incMissing.push({ lineIdx: leg.lineIdx, source: leg.source, legacyCall: legFirst, incCall: null });
    } else if (legFirst == null && incFirst != null) {
      r.legMissing.push({ lineIdx: leg.lineIdx, source: leg.source, legacyCall: null, incCall: incFirst });
    }
  }
  return r;
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return ((n / total) * 100).toFixed(1) + "%";
}

function bucketBy<T, K>(items: T[], keyOf: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}
