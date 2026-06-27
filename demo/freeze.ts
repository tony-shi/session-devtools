// demo/freeze.ts
//
// Freeze a few real Claude Code sessions into static JSON for the offline demo.
//
// Strategy: instead of re-implementing the server's per-request parse/enrich
// orchestration in a standalone script (fragile, drifts from the controllers),
// we crawl the *live* dashboard server over HTTP and walk the exact call graph
// the UI walks, saving each 200 response to demo/data/<url-without-/api>.json.
// The client demo bypass (client/src/demo-mode) maps /api/* -> /demo/data/*.json
// by the same rule, so the captured bytes are exactly what the UI expects.
//
// Usage (with `npm run server:dev` running locally against your real data):
//   npm run demo:freeze
//   DEMO_SERVER=http://localhost:5051 npx tsx demo/freeze.ts
//
// Output: demo/data/** (one file per endpoint) + demo/data/manifest.json.
// NOTE: the captured data is verbatim (no redaction) — review before publishing.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "data");
const CONFIG_PATH = join(HERE, "sessions.config.json");
const BASE = process.env.DEMO_SERVER ?? "http://localhost:5051";

type ConfigSession = string | { id: string; title?: string };
interface Config {
  sessions: ConfigSession[];
  options?: {
    /** Also freeze diff-tree for sub-agent calls (heavy). Default false —
     *  sub-agent calls dominate the bundle and the Diff lens fails soft. */
    diffSubagents?: boolean;
  };
}

const enc = encodeURIComponent;
let DIFF_SUBAGENT = false;

let okCount = 0;
let skipCount = 0;
const seen = new Set<string>();

/** Map an /api path (query stripped) to its on-disk demo file. */
function fileFor(apiPath: string): string {
  const rel = apiPath.replace(/^\/api/, "").split("?")[0];
  return join(DATA_DIR, rel + ".json");
}

/**
 * GET an API path from the live server. On 200, persist the JSON to the
 * mirrored demo file and return it. On any non-200 (many endpoints 404 by
 * design — first-call diff-tree, non-team sessions, …) log and return null.
 */
async function saveGet<T = any>(apiPath: string): Promise<T | null> {
  if (seen.has(apiPath)) return null; // de-dupe (e.g. a proxy body shared by calls)
  seen.add(apiPath);
  let res: Response;
  try {
    res = await fetch(BASE + apiPath);
  } catch (err) {
    console.warn(`  ✗ ${apiPath} — fetch failed: ${(err as Error).message}`);
    skipCount++;
    return null;
  }
  if (!res.ok) {
    console.warn(`  · skip ${apiPath} (${res.status})`);
    skipCount++;
    return null;
  }
  const json = (await res.json()) as T;
  const file = fileFor(apiPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(json));
  okCount++;
  return json;
}

/** Save a synthesized payload at an /api path (not crawled from the server). */
async function savePayload(apiPath: string, payload: unknown): Promise<void> {
  const file = fileFor(apiPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(payload));
  okCount++;
}

function callIdsOf(drill: any): number[] {
  return (drill?.turns ?? []).flatMap((t: any) => (t.calls ?? []).map((c: any) => c.id));
}

/**
 * Crawl the per-call endpoints the UI actually consumes for one call URL prefix.
 *  - detail / attribution-tree / response-tree: always (the three call tabs).
 *  - diff-tree: only when `diff` — fetched eagerly by the Attribution panel but
 *    fails soft (Diff lens just loses its overlay). Heavy, so default off for
 *    sub-agent calls (size).
 *  - proxy body: only when `body` — ONLY the side-call panel reads proxyBody;
 *    main/sub-agent/compact panels render from detail.rawRequestJson, so their
 *    bodies are dead weight (~150 KB each).
 */
async function crawlCallEndpoints(prefix: string, opts: { diff: boolean; body: boolean }) {
  const detail = await saveGet<any>(`${prefix}/detail`);
  await saveGet(`${prefix}/attribution-tree`);
  await saveGet(`${prefix}/response-tree`);
  if (opts.diff) await saveGet(`${prefix}/diff-tree`);
  const pid = detail?.proxyRequestId;
  if (opts.body && typeof pid === "number") await saveGet(`/api/proxy/requests/${pid}/body`);
}

async function crawlSession(id: string) {
  const s = `/api/v2/sessions/${enc(id)}`;
  console.log(`\n=== session ${id} ===`);

  const drill = await saveGet<any>(`${s}/drilldown`);
  if (!drill) {
    console.warn(`  ! drilldown missing — session skipped`);
    return;
  }
  const sideCalls = await saveGet<any>(`${s}/side-calls`);
  await saveGet(`${s}/team`); // 404 for non-team sessions — fine
  await saveGet(`${s}/attribution-graph`); // warms server graph cache for the call loop
  await saveGet(`${s}/proxy`);

  // Main-session calls.
  const calls = callIdsOf(drill);
  console.log(`  calls: ${calls.length}`);
  for (const cid of calls) {
    await crawlCallEndpoints(`${s}/calls/${cid}`, { diff: true, body: false });
  }

  // Sub-agents (Task agents + workflow agents are both flattened into subAgents).
  const subs: any[] = drill.subAgents ?? [];
  console.log(`  subAgents: ${subs.length}`);
  for (const sa of subs) {
    const afId = sa.agentFileId;
    if (!afId) continue;
    const sub = await saveGet<any>(`${s}/subagent/${enc(afId)}/drilldown`);
    if (!sub) continue;
    for (const cid of callIdsOf(sub)) {
      await crawlCallEndpoints(`${s}/subagent/${enc(afId)}/calls/${cid}`, { diff: DIFF_SUBAGENT, body: false });
    }
  }

  // Compaction calls (synthetic; no diff endpoint).
  const compacts: any[] = drill.compactEvents ?? [];
  if (compacts.length) console.log(`  compactEvents: ${compacts.length}`);
  for (const ce of compacts) {
    await crawlCallEndpoints(`${s}/compact/${ce.index}`, { diff: false, body: false });
  }

  // Dynamic workflow runs (run-level artifacts).
  const wfRuns: any[] = drill.workflowRuns ?? [];
  if (wfRuns.length) console.log(`  workflowRuns: ${wfRuns.length}`);
  for (const wf of wfRuns) {
    await saveGet(`${s}/workflows/${enc(wf.runId)}/script`);
    await saveGet(`${s}/workflows/${enc(wf.runId)}/schemas`);
    await saveGet(`${s}/workflows/${enc(wf.runId)}/dataflow`);
  }

  // Side calls (background LLM requests). Only captured ones have a proxy body.
  const sc: any[] = sideCalls?.sideCalls ?? [];
  const captured = sc.filter((x) => x.captured && x.proxyRequestId != null);
  if (captured.length) console.log(`  side-calls (captured): ${captured.length}`);
  for (const x of captured) {
    await crawlCallEndpoints(`${s}/side-call/${x.proxyRequestId}`, { diff: false, body: true });
  }
}

async function main() {
  const config: Config = JSON.parse(await readConfig());
  DIFF_SUBAGENT = config.options?.diffSubagents ?? false;
  const ids = config.sessions.map((x) => (typeof x === "string" ? x : x.id));
  const titleOverride = new Map<string, string>();
  for (const x of config.sessions) {
    if (typeof x !== "string" && x.title) titleOverride.set(x.id, x.title);
  }
  if (ids.length === 0) {
    console.error("No sessions configured in demo/sessions.config.json — nothing to freeze.");
    process.exit(2);
  }

  console.log(`Freezing ${ids.length} session(s) from ${BASE}`);
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });

  // Full session list once, then keep only the configured rows (in config order).
  const fullList = await fetch(`${BASE}/api/v2/sessions?limit=500`).then((r) => r.json());
  const byId = new Map<string, any>((fullList.sessions ?? []).map((r: any) => [r.session_id, r]));
  const rows: any[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      console.warn(`! configured session not found in server list: ${id}`);
      continue;
    }
    if (titleOverride.has(id)) row.custom_title = titleOverride.get(id);
    rows.push(row);
  }
  await savePayload(`/api/v2/sessions`, {
    sessions: rows,
    total: rows.length,
    limit: rows.length || 1,
    offset: 0,
  });
  // Demo summary recomputed over the frozen rows only (avoids leaking global totals).
  await savePayload(`/api/v2/summary`, demoSummary(rows));
  // sync() is a no-op in the demo.
  await savePayload(`/api/v2/sessions/sync`, { synced: 0, skipped: 0, errors: 0 });

  for (const id of ids) {
    if (byId.has(id)) await crawlSession(id);
  }

  // Stamp the PARSER_VERSION the data was frozen under so `demo:check` can flag
  // a stale freeze (parser output shape changed → frozen JSON would mis-render).
  const parserVersion = Math.max(0, ...rows.map((r) => Number(r.parser_version) || 0));
  await savePayload(`/demo-manifest` /* not under /api */, {
    generatedAt: new Date().toISOString(),
    server: BASE,
    parserVersion,
    sessions: rows.map((r) => ({
      id: r.session_id,
      title: r.custom_title ?? r.ai_title ?? r.first_user_message ?? r.session_id,
    })),
  });

  console.log(`\nDone. ${okCount} files written, ${skipCount} endpoints skipped.`);
  console.log(`Output: ${DATA_DIR}`);
}

function demoSummary(rows: any[]) {
  const n = (k: string) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const byTool: Record<string, number> = {};
  for (const r of rows) byTool[r.tool ?? "claude"] = (byTool[r.tool ?? "claude"] ?? 0) + 1;
  return {
    total_sessions: rows.length,
    active_24h: rows.length,
    input_tokens: n("input_tokens"),
    output_tokens: n("output_tokens"),
    cache_creation_tokens: n("cache_creation_tokens"),
    cache_read_tokens: n("cache_read_tokens"),
    tool_call_count: n("tool_call_count"),
    llm_call_count: n("llm_call_count"),
    human_input_count: n("human_input_count"),
    by_tool: byTool,
  };
}

async function readConfig(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(CONFIG_PATH, "utf8");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
