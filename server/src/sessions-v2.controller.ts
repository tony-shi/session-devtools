import { Controller, Get, Param, Query } from "@nestjs/common";
import { getDb } from "./db.ts";
import { runSyncV2 } from "./sync-v2.ts";
import { parseJsonField } from "./parser-utils.ts";

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
