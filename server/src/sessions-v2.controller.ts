import { Controller, Get, Param, Query } from "@nestjs/common";
import { getDb } from "./db.ts";
import { runSyncV2 } from "./sync-v2.ts";
import { parseJsonField } from "./parser-utils.ts";
import { parseSessionDrilldown, parseSubAgentDrilldown } from "./session-drilldown-parser.ts";
import { loadCallDetail, readProxyRecord, findProxyRowForCall } from "./call-detail.ts";
import { loadAttributionTree, readSessionEventsForLinker } from "./attribution-service.ts";
import { computeSessionAttributionGraph, type JsonlEventAnnotation, type SessionAttributionGraph } from "./session-attribution-graph.ts";
import { enrichTreeWithGraph } from "./attribution-tree-enrich.ts";
import type { LinkableJsonlEvent } from "./context-ledger/parser";

// ─── Session graph cache ────────────────────────────────────────────────────
// computeSessionAttributionGraph is expensive (~1-2s for lastN=20, ~13s
// full-session). attribution-tree calls it on every per-call request when
// the front-end passes graphLastN — without a cache, browsing N calls in a
// session would cost N × 1.7s. The cache shares the computed graph across:
//   - subsequent attribution-tree calls in the same session (any callId)
//   - the standalone attribution-graph endpoint
// TTL is 5 minutes — long enough to span a typical "open session, click
// around" workflow, short enough to not staledatasets if the user loads a
// session that's still being written to.
interface CachedGraph {
  graph: SessionAttributionGraph;
  lastN: number | "full";  // "full" = no lastN cap (the whole session)
  computedAt: number;
}
const sessionGraphCache = new Map<string, CachedGraph>();
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedGraph(sessionId: string, requestedLastN: number | "full"): SessionAttributionGraph | null {
  const cached = sessionGraphCache.get(sessionId);
  if (!cached) {
    console.log(`[graph-cache] MISS session=${sessionId.slice(0, 8)} requested=${requestedLastN} (empty cache)`);
    return null;
  }
  const ageMs = Date.now() - cached.computedAt;
  if (ageMs > GRAPH_CACHE_TTL_MS) {
    console.log(`[graph-cache] MISS session=${sessionId.slice(0, 8)} requested=${requestedLastN} (expired ${(ageMs/1000).toFixed(1)}s)`);
    return null;
  }
  // A cached "full" graph satisfies any window request; a cached lastN
  // satisfies only equal-or-tighter windows. We're conservative: serve only
  // when the cached window is ≥ requested (so the answer is at least as
  // complete as asked for).
  if (cached.lastN === "full") {
    console.log(`[graph-cache] HIT  session=${sessionId.slice(0, 8)} requested=${requestedLastN} (served from full · age=${(ageMs/1000).toFixed(1)}s)`);
    return cached.graph;
  }
  if (requestedLastN === "full") {
    console.log(`[graph-cache] MISS session=${sessionId.slice(0, 8)} requested=full (cache has only lastN=${cached.lastN})`);
    return null;
  }
  if (cached.lastN >= requestedLastN) {
    console.log(`[graph-cache] HIT  session=${sessionId.slice(0, 8)} requested=${requestedLastN} (served from lastN=${cached.lastN} · age=${(ageMs/1000).toFixed(1)}s)`);
    return cached.graph;
  }
  console.log(`[graph-cache] MISS session=${sessionId.slice(0, 8)} requested=${requestedLastN} (cache has tighter lastN=${cached.lastN})`);
  return null;
}

function setCachedGraph(sessionId: string, lastN: number | "full", graph: SessionAttributionGraph) {
  sessionGraphCache.set(sessionId, { graph, lastN, computedAt: Date.now() });
  console.log(`[graph-cache] STORE session=${sessionId.slice(0, 8)} lastN=${lastN} events=${graph.events.length} audited=${graph.auditedCallIds.length}`);
}
import { loadDiffTree } from "./diff-tree-service.ts";
import { loadResponseTree } from "./response-attribution-service.ts";

type SqlParam = string | number | bigint | boolean | null | Uint8Array;

@Controller("api/v2")
export class SessionsV2Controller {
  @Get("sessions/sync")
  async sync() {
    return runSyncV2();
  }

  @Get("sessions")
  sessionList(
    @Query("tool") tool?: string,
    @Query("last_active_date") lastActiveDate?: string,
    @Query("active_since_hours") activeSinceHoursParam?: string,
    @Query("project") project?: string,
    @Query("limit") limitParam?: string,
    @Query("offset") offsetParam?: string,
    @Query("include_deleted") includeDeleted?: string,
    @Query("search") search?: string,
  ) {
    const limit = Math.min(parseInt(limitParam ?? "50"), 200);
    const offset = parseInt(offsetParam ?? "0");
    const db = getDb();

    const conds: string[] = [];
    const params: SqlParam[] = [];

    if (includeDeleted !== "1") conds.push("source_present = 1");
    conds.push("(input_tokens > 0 OR output_tokens > 0)");
    if (tool) { conds.push("tool = ?"); params.push(tool); }
    if (project) { conds.push("project = ?"); params.push(project); }
    if (search) {
      const like = `%${search}%`;
      conds.push("(session_id LIKE ? OR custom_title LIKE ? OR ai_title LIKE ? OR cwd LIKE ? OR first_user_message LIKE ?)");
      params.push(like, like, like, like, like);
    }

    // Optional: filter by last active date (date the session was last active)
    if (lastActiveDate) {
      conds.push("date(last_event_at) = ?");
      params.push(lastActiveDate);
    }

    // Optional: filter sessions active within the last N hours
    if (activeSinceHoursParam) {
      const hours = parseInt(activeSinceHoursParam);
      if (!isNaN(hours)) {
        const since = new Date(Date.now() - hours * 3_600_000).toISOString();
        conds.push("last_event_at >= ?");
        params.push(since);
      }
    }

    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM sessions_meta_v2 ${where}`)
      .get(params) as { cnt: number }).cnt;

    const rows = db.prepare(
      `SELECT s.*,
         (SELECT COUNT(*) FROM proxy_requests p WHERE p.session_id = s.session_id) AS proxy_count
       FROM sessions_meta_v2 s ${where} ORDER BY last_event_at DESC LIMIT ? OFFSET ?`,
    ).all([...params, limit, offset]) as Record<string, unknown>[];

    const sessions = rows.map((r) => ({
      ...r,
      models: parseJsonField(r.models as string, []),
      parser_warnings: parseJsonField(r.parser_warnings as string, []),
    }));

    return { sessions, total, limit, offset };
  }

  @Get("summary")
  summary() {
    const db = getDb();

    const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString();

    // Match the list query's "has LLM activity" filter so the headline
    // "会话 N" count agrees with the "会话列表 N · 仅含 LLM 交互" count
    // shown below. Sessions with zero token movement (never produced any LLM
    // call — usually aborted before the first round-trip) are excluded here
    // exactly as they are in the list. Other aggregates (tokens, llm_call_count,
    // tool_call_count) are unaffected since those sessions contribute zero
    // anyway; human_input_count drops slightly because aborted sessions can
    // carry a human input that never reached the model.
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total_sessions,
        COALESCE(SUM(CASE WHEN last_event_at >= ? THEN 1 ELSE 0 END), 0) AS active_24h,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(tool_call_count), 0) AS tool_call_count,
        COALESCE(SUM(llm_call_count), 0) AS llm_call_count,
        COALESCE(SUM(human_input_count), 0) AS human_input_count
      FROM sessions_meta_v2
      WHERE source_present = 1
        AND (input_tokens > 0 OR output_tokens > 0)
    `).get(since24h) as {
      total_sessions: number;
      active_24h: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      tool_call_count: number;
      llm_call_count: number;
      human_input_count: number;
    };

    const toolRows = db.prepare(`
      SELECT tool, COUNT(*) as cnt
      FROM sessions_meta_v2
      WHERE source_present = 1
        AND (input_tokens > 0 OR output_tokens > 0)
      GROUP BY tool
    `).all() as { tool: string; cnt: number }[];

    const byTool: Record<string, number> = {};
    for (const r of toolRows) byTool[r.tool] = r.cnt;

    return { ...totals, by_tool: byTool };
  }

  @Get("sessions/:id/drilldown")
  sessionDrilldown(@Param("id") id: string) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    const sourceFile = row.source_file as string;
    try {
      return parseSessionDrilldown(sourceFile, id, row, db);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`Failed to parse session: ${msg}`), { status: 500 });
    }
  }

  @Get("sessions/:id/subagent/:agentFileId/drilldown")
  subAgentDrilldown(@Param("id") id: string, @Param("agentFileId") agentFileId: string) {
    const db = getDb();
    const row = db.prepare(`SELECT source_file FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as { source_file: string } | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });
    return parseSubAgentDrilldown(row.source_file, agentFileId);
  }

  @Get("sessions/:id/calls/:callId/detail")
  async callDetail(@Param("id") id: string, @Param("callId") callIdStr: string) {
    const db = getDb();

    // Re-parse the session drilldown to find the call and its predecessor
    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    let drilldown;
    try {
      drilldown = parseSessionDrilldown(row.source_file as string, id, row, db);
    } catch (err: unknown) {
      throw Object.assign(new Error("drilldown parse failed"), { status: 500 });
    }

    const callId = parseInt(callIdStr, 10);
    const allCalls = drilldown.turns.flatMap(t => t.calls);
    const callIdx = allCalls.findIndex(c => c.id === callId);
    if (callIdx === -1) throw Object.assign(new Error("call not found"), { status: 404 });

    const call = allCalls[callIdx];
    const prevCall = callIdx > 0 ? allCalls[callIdx - 1] : undefined;

    return loadCallDetail(
      id,
      call.timestamp,
      call.model,
      {
        contextSize: call.contextSize,
        cacheRead: call.cacheRead,
        cacheWrite: call.cacheWrite,
        freshIn: call.freshIn,
        outputTokens: call.outputTokens,
      },
      call.stopReason,
      db,
      callId,
      prevCall?.timestamp,
      call.apiRequestId,
      prevCall?.apiRequestId,
    );
  }

  @Get("sessions/:id/calls/:callId/attribution-tree")
  async attributionTree(
    @Param("id") id: string,
    @Param("callId") callIdStr: string,
    /**
     * Reverse-attribution audit window. When provided, the endpoint also
     * runs `computeSessionAttributionGraph` on the most recent N calls and
     * writes the resulting `firstSeenInCall` / `consumedByCallIds` /
     * `firstSeenIsWindowBounded` into every jsonl-origin leaf — front-end
     * can then read `leaf.origin.firstSeenInCall` directly as the jump
     * target without doing its own join. Pass 0 / negative / omitted to
     * skip enrichment (faster, original behavior).
     */
    @Query("graphLastN") graphLastNParam?: string,
  ) {
    const db = getDb();

    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });
    const sourceFile = row.source_file as string;

    let drilldown;
    try {
      drilldown = parseSessionDrilldown(sourceFile, id, row, db);
    } catch (err: unknown) {
      throw Object.assign(new Error("drilldown parse failed"), { status: 500 });
    }

    const callId = parseInt(callIdStr, 10);
    const allCalls = drilldown.turns.flatMap((t) => t.calls.map((c) => ({ call: c, turnId: t.id })));
    const idx = allCalls.findIndex((x) => x.call.id === callId);
    if (idx === -1) throw Object.assign(new Error("call not found"), { status: 404 });

    // Session-scope jsonl events: parse once, share between the tree and
    // (optional) graph computations so the file isn't read N+1 times.
    let cachedEvents: LinkableJsonlEvent[] | null = null;
    const loadJsonlEvents = (file: string): LinkableJsonlEvent[] | null => {
      if (file !== sourceFile) return null;
      if (cachedEvents === null) cachedEvents = readSessionEventsForLinker(file);
      return cachedEvents;
    };

    const resolveCallMeta = (_sid: string, cid: number) => {
      const cur = allCalls.find((x) => x.call.id === cid);
      if (!cur) return null;
      const curIdx = allCalls.indexOf(cur);
      const prev = curIdx > 0 ? allCalls[curIdx - 1] : null;
      return {
        call: { id: cur.call.id, timestamp: cur.call.timestamp, turnId: cur.turnId, sourceFile, apiRequestId: cur.call.apiRequestId },
        prevCall: prev ? { id: prev.call.id, timestamp: prev.call.timestamp, apiRequestId: prev.call.apiRequestId } : null,
      };
    };
    const fetchProxyReqBodyAt = async (
      sid: string,
      ts: string,
      excludeProxyId?: number,
      apiRequestId?: string | null,
    ): Promise<{
      reqBody: Record<string, unknown> | null;
      reqHeaders: Record<string, string>;
      proxyRequestId: number | null;
      startedAt: string;
    } | null> => {
      const proxyRow = findProxyRowForCall(db, sid, apiRequestId ?? undefined, ts, excludeProxyId);
      if (!proxyRow) return null;
      const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
      const reqBodyStr = rec?.reqBody as string | undefined;
      if (typeof reqBodyStr !== "string") return null;
      let reqBody: Record<string, unknown> | null = null;
      try { reqBody = JSON.parse(reqBodyStr) as Record<string, unknown>; }
      catch { return null; }
      let reqHeaders: Record<string, string> = {};
      try { reqHeaders = JSON.parse(proxyRow.req_headers ?? "{}") as Record<string, string>; }
      catch { /* default empty */ }
      return {
        reqBody,
        reqHeaders,
        proxyRequestId: proxyRow.id,
        startedAt: proxyRow.started_at ?? ts,
      };
    };

    const treeResult = await loadAttributionTree(id, callId, db, {
      resolveCallMeta,
      fetchProxyReqBodyAt,
      loadJsonlEvents,
    });

    // Optional reverse-attribution enrichment. The graph drives the
    // jump-target field on every jsonl leaf so the front-end can stay
    // dumb (no cross-endpoint join). Cache the graph at module level so
    // browsing multiple calls in a session amortizes the cost (≈1.7s
    // first call, ≈50ms subsequent calls).
    const graphLastN = graphLastNParam ? parseInt(graphLastNParam, 10) : NaN;
    if (Number.isFinite(graphLastN) && graphLastN > 0) {
      let graph = getCachedGraph(id, graphLastN);
      if (!graph) {
        const targetCalls = allCalls.slice(-graphLastN);
        const t0 = Date.now();
        console.log(`[attribution-tree] computing graph for enrichment session=${id.slice(0,8)} call=${callId} lastN=${graphLastN} calls=${targetCalls.length}`);
        graph = await computeSessionAttributionGraph(id, db, {
          listCalls: () => targetCalls.map((x) => ({ callId: x.call.id, sourceFile })),
          loadCallHelpers: { resolveCallMeta, fetchProxyReqBodyAt, loadJsonlEvents },
        });
        console.log(`[attribution-tree] graph computed session=${id.slice(0,8)} call=${callId} took=${Date.now()-t0}ms events=${graph.events.length}`);
        setCachedGraph(id, graphLastN, graph);
      }
      const eventByLine = new Map<number, JsonlEventAnnotation>();
      for (const ev of graph.events) eventByLine.set(ev.lineIdx, ev);
      // The audit window is bounded iff lastN < total session call count.
      const isWindowBounded = graphLastN < allCalls.length;
      const summary = enrichTreeWithGraph(treeResult, eventByLine, isWindowBounded, callId);
      if (summary.droppedByGuard > 0) {
        console.log(`[enrich-tree] session=${id.slice(0,8)} call=${callId} dropped=${summary.droppedByGuard} firstSeenInCall annotations (>currentCallId) — call is outside audit window`);
      }
    }

    return treeResult;
  }

  /**
   * Session-level attribution graph：把整 session 跑过的 per-call snapshot 反向
   * 聚合成"每个 jsonl event 在哪些 call 里被消费"。配合 per-call attribution-tree
   * 一起，前端就能做双向归因（leaf → jsonl line ↔ event → consuming calls）。
   *
   * - 无 query 参数 → 跑整 session 所有 call（大 session 会慢，O(N) call × O(K) leaves）
   * - `?lastN=K` → 只跑最后 K 个 call（用于 hot path 快速预览；与 audit 脚本同语义）
   *
   * 性能：session 内 jsonl events 单次解析，loadAttributionTree 内部走同款缓存；
   * proxy reqBody 仍按 call 现读（与 attributionTree endpoint 一致，未做 LRU）。
   */
  @Get("sessions/:id/attribution-graph")
  async attributionGraph(
    @Param("id") id: string,
    @Query("lastN") lastNParam?: string,
  ) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });
    const sourceFile = row.source_file as string;

    let drilldown;
    try {
      drilldown = parseSessionDrilldown(sourceFile, id, row, db);
    } catch {
      throw Object.assign(new Error("drilldown parse failed"), { status: 500 });
    }

    const allCalls = drilldown.turns.flatMap((t) => t.calls.map((c) => ({ call: c, turnId: t.id })));
    const lastN = lastNParam ? Math.max(1, parseInt(lastNParam, 10)) : undefined;
    const targetCalls = lastN ? allCalls.slice(-lastN) : allCalls;

    // Shared module-level cache: a graph computed for this same window
    // (or a superset window) gets served without recomputation. attribution
    // -tree's graphLastN parameter also writes here so the two endpoints
    // don't double-pay the ~1-2s cost.
    const cacheKey: number | "full" = lastN ?? "full";
    const cached = getCachedGraph(id, cacheKey);
    if (cached) return cached;
    const tStart = Date.now();
    console.log(`[attribution-graph] computing session=${id.slice(0,8)} lastN=${cacheKey} calls=${targetCalls.length}`);

    // session 级 events 缓存：computeSessionAttributionGraph 顶层读一次；
    // 每个 call 的 loadAttributionTree 内部也复用这一份（通过 loadJsonlEvents hook）。
    // 避免 (N+1) 次解析整 jsonl 文件。
    let cachedEvents: LinkableJsonlEvent[] | null = null;
    const loadJsonlEvents = (file: string): LinkableJsonlEvent[] | null => {
      if (file !== sourceFile) return null;
      if (cachedEvents === null) cachedEvents = readSessionEventsForLinker(file);
      return cachedEvents;
    };

    const computed = await computeSessionAttributionGraph(id, db, {
      listCalls: () => targetCalls.map((x) => ({ callId: x.call.id, sourceFile })),
      loadCallHelpers: {
        resolveCallMeta: (_sid, cid) => {
          const cur = allCalls.find((x) => x.call.id === cid);
          if (!cur) return null;
          const curIdx = allCalls.indexOf(cur);
          const prev = curIdx > 0 ? allCalls[curIdx - 1] : null;
          return {
            call: { id: cur.call.id, timestamp: cur.call.timestamp, turnId: cur.turnId, sourceFile, apiRequestId: cur.call.apiRequestId },
            prevCall: prev ? { id: prev.call.id, timestamp: prev.call.timestamp, apiRequestId: prev.call.apiRequestId } : null,
          };
        },
        fetchProxyReqBodyAt: async (sid, ts, excludeProxyId, apiRequestId) => {
          const proxyRow = findProxyRowForCall(db, sid, apiRequestId, ts, excludeProxyId);
          if (!proxyRow) return null;
          const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
          const reqBodyStr = rec?.reqBody as string | undefined;
          if (typeof reqBodyStr !== "string") return null;
          let reqBody: Record<string, unknown> | null = null;
          try { reqBody = JSON.parse(reqBodyStr) as Record<string, unknown>; }
          catch { return null; }
          let reqHeaders: Record<string, string> = {};
          try { reqHeaders = JSON.parse(proxyRow.req_headers ?? "{}") as Record<string, string>; }
          catch { /* default empty */ }
          return {
            reqBody,
            reqHeaders,
            proxyRequestId: proxyRow.id,
            startedAt: proxyRow.started_at ?? ts,
          };
        },
        loadJsonlEvents,
      },
    });
    console.log(`[attribution-graph] computed session=${id.slice(0,8)} lastN=${cacheKey} took=${Date.now()-tStart}ms events=${computed.events.length} audited=${computed.auditedCallIds.length}`);
    setCachedGraph(id, cacheKey, computed);
    return computed;
  }

  @Get("sessions/:id/calls/:callId/diff-tree")
  async diffTree(@Param("id") id: string, @Param("callId") callIdStr: string) {
    const db = getDb();

    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });
    const sourceFile = row.source_file as string;

    let drilldown;
    try {
      drilldown = parseSessionDrilldown(sourceFile, id, row, db);
    } catch {
      throw Object.assign(new Error("drilldown parse failed"), { status: 500 });
    }

    const callId = parseInt(callIdStr, 10);
    const allCalls = drilldown.turns.flatMap((t) => t.calls.map((c) => ({ call: c, turnId: t.id })));
    const idx = allCalls.findIndex((x) => x.call.id === callId);
    if (idx === -1) throw Object.assign(new Error("call not found"), { status: 404 });

    return loadDiffTree(id, callId, db, {
      resolveCallMeta: (_sid, cid) => {
        const cur = allCalls.find((x) => x.call.id === cid);
        if (!cur) return null;
        const curIdx = allCalls.indexOf(cur);
        const prev = curIdx > 0 ? allCalls[curIdx - 1] : null;
        return {
          call: { id: cur.call.id, timestamp: cur.call.timestamp, turnId: cur.turnId, sourceFile, apiRequestId: cur.call.apiRequestId },
          prevCall: prev ? { id: prev.call.id, timestamp: prev.call.timestamp, apiRequestId: prev.call.apiRequestId } : null,
        };
      },
      fetchProxyReqBodyAt: async (sid, ts, excludeProxyId, apiRequestId) => {
        const proxyRow = findProxyRowForCall(db, sid, apiRequestId, ts, excludeProxyId);
        if (!proxyRow) return null;

        const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
        const reqBodyStr = rec?.reqBody as string | undefined;
        if (typeof reqBodyStr !== "string") return null;
        let reqBody: Record<string, unknown> | null = null;
        try { reqBody = JSON.parse(reqBodyStr) as Record<string, unknown>; }
        catch { return null; }

        let reqHeaders: Record<string, string> = {};
        try { reqHeaders = JSON.parse(proxyRow.req_headers ?? "{}") as Record<string, string>; }
        catch { /* default empty */ }

        return {
          reqBody,
          reqHeaders,
          proxyRequestId: proxyRow.id,
          startedAt: proxyRow.started_at ?? ts,
        };
      },
    });
  }

  @Get("sessions/:id/calls/:callId/response-tree")
  async responseTree(@Param("id") id: string, @Param("callId") callIdStr: string) {
    const db = getDb();

    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });
    const sourceFile = row.source_file as string;

    let drilldown;
    try {
      drilldown = parseSessionDrilldown(sourceFile, id, row, db);
    } catch (err: unknown) {
      throw Object.assign(new Error("drilldown parse failed"), { status: 500 });
    }

    const callId = parseInt(callIdStr, 10);
    const allCalls = drilldown.turns.flatMap((t) => t.calls);
    const idx = allCalls.findIndex((c) => c.id === callId);
    if (idx === -1) throw Object.assign(new Error("call not found"), { status: 404 });

    return loadResponseTree(id, callId, db, {
      resolveCallContext: (_sid, cid) => {
        const curIdx = allCalls.findIndex((c) => c.id === cid);
        if (curIdx === -1) return null;
        const cur = allCalls[curIdx];
        const next = curIdx + 1 < allCalls.length ? allCalls[curIdx + 1] : null;
        return {
          sourceFile,
          callTimestamp: cur.timestamp,
          toolCalls: cur.toolCalls.map((tc) => ({
            toolUseId: tc.toolUseId,
            name: tc.name,
            outputPreview: tc.outputPreview,
            outputSize: tc.outputSize,
            isError: tc.isError,
          })),
          nextCallId: next ? next.id : null,
          stopReason: cur.stopReason,
          outputTokens: cur.outputTokens,
        };
      },
    });
  }

  @Get("sessions/:id/proxy")
  sessionProxy(@Param("id") id: string) {
    const rows = getDb().prepare(`
      SELECT id, started_at, method, url, status,
             model, req_message_count, req_has_tools,
             res_input_tokens, res_output_tokens,
             res_cache_creation_tokens, res_cache_read_tokens,
             res_stop_reason, error_class, duration_ms, is_stream, sse_event_count
      FROM proxy_requests
      WHERE session_id = ?
      ORDER BY started_at
    `).all(id);
    return { session_id: id, requests: rows, total: (rows as unknown[]).length };
  }
}

// enrichTreeWithGraph moved to ./attribution-tree-enrich.ts so it can be
// unit-tested without spinning up the Nest controller.
