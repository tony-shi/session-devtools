import { Controller, Get, Param, Query } from "@nestjs/common";
import { getDb } from "./db.ts";
import { runSyncV2 } from "./sync-v2.ts";
import { parseJsonField } from "./parser-utils.ts";
import { buildMockDrilldown } from "./session-drilldown-mock.ts";
import { parseSessionDrilldown, parseSubAgentDrilldown } from "./session-drilldown-parser.ts";
import { loadCallDetail, readProxyRecord } from "./call-detail.ts";
import { loadAttributionTree } from "./attribution-service.ts";

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

    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total_sessions,
        COALESCE(SUM(CASE WHEN last_event_at >= ? THEN 1 ELSE 0 END), 0) AS active_24h,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(tool_call_count), 0) AS tool_call_count,
        COALESCE(SUM(human_input_count), 0) AS human_input_count
      FROM sessions_meta_v2
      WHERE source_present = 1
    `).get(since24h) as {
      total_sessions: number;
      active_24h: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      tool_call_count: number;
      human_input_count: number;
    };

    const toolRows = db.prepare(`
      SELECT tool, COUNT(*) as cnt
      FROM sessions_meta_v2
      WHERE source_present = 1
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
      // Fallback to mock if JSONL is missing/corrupt — surface the error in response
      const msg = err instanceof Error ? err.message : String(err);
      const mock = buildMockDrilldown(id);
      return { ...mock, _parseError: msg };
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
    );
  }

  @Get("sessions/:id/calls/:callId/attribution-tree")
  async attributionTree(@Param("id") id: string, @Param("callId") callIdStr: string) {
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

    return loadAttributionTree(id, callId, db, {
      resolveCallMeta: (_sid, cid) => {
        const cur = allCalls.find((x) => x.call.id === cid);
        if (!cur) return null;
        const curIdx = allCalls.indexOf(cur);
        const prev = curIdx > 0 ? allCalls[curIdx - 1] : null;
        return {
          call: { id: cur.call.id, timestamp: cur.call.timestamp, turnId: cur.turnId, sourceFile },
          prevCall: prev ? { id: prev.call.id, timestamp: prev.call.timestamp } : null,
        };
      },
      fetchProxyReqBodyAt: async (sid, ts, excludeProxyId) => {
        const sql = excludeProxyId !== undefined
          ? `SELECT id, jsonl_file, jsonl_byte_offset, req_headers, started_at
             FROM proxy_requests
             WHERE session_id = ? AND COALESCE(started_at, ts) <= ? AND id != ?
             ORDER BY COALESCE(started_at, ts) DESC LIMIT 1`
          : `SELECT id, jsonl_file, jsonl_byte_offset, req_headers, started_at
             FROM proxy_requests
             WHERE session_id = ? AND COALESCE(started_at, ts) <= ?
             ORDER BY COALESCE(started_at, ts) DESC LIMIT 1`;
        const params: SqlParam[] = excludeProxyId !== undefined ? [sid, ts, excludeProxyId] : [sid, ts];
        const proxyRow = db.prepare(sql).get(...params) as {
          id: number; jsonl_file: string; jsonl_byte_offset: number;
          req_headers: string | null; started_at: string | null;
        } | undefined;
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
