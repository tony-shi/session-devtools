import { Controller, Get, Query } from "@nestjs/common";
import { getDb } from "./db.ts";
import { runSyncV2 } from "./sync-v2.ts";
import { getDaySlice, type DaySliceValue } from "./day-slice.ts";
import { parseJsonField } from "./parser-utils.ts";

type SqlParam = string | number | bigint | boolean | null | Uint8Array;

async function pMap<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    results.push(...settled);
  }
  return results;
}

@Controller("api/v2")
export class SessionsV2Controller {
  @Get("sessions/sync")
  async sync() {
    return runSyncV2();
  }

  @Get("sessions")
  sessionList(
    @Query("tool") tool?: string,
    @Query("date") date?: string,
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
    if (date) {
      conds.push("first_event_at <= ? AND last_event_at >= ?");
      params.push(`${date}T23:59:59`, `${date}T00:00:00`);
    }

    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM sessions_meta_v2 ${where}`)
      .get(params) as { cnt: number }).cnt;

    const rows = db.prepare(
      `SELECT * FROM sessions_meta_v2 ${where} ORDER BY last_event_at DESC LIMIT ? OFFSET ?`,
    ).all([...params, limit, offset]) as Record<string, unknown>[];

    const sessions = rows.map((r) => ({
      ...r,
      models: parseJsonField(r.models as string, []),
      parser_warnings: parseJsonField(r.parser_warnings as string, []),
    }));

    return { sessions, total, limit, offset };
  }

  @Get("dashboard")
  async dashboard(@Query("date") dateParam?: string) {
    const date = dateParam ?? new Date().toISOString().slice(0, 10);
    const db = getDb();

    const rows = db.prepare(`
      SELECT session_id, source_file, file_mtime, tool
      FROM sessions_meta_v2
      WHERE source_present = 1
        AND first_event_at <= ?
        AND last_event_at  >= ?
    `).all(`${date}T23:59:59`, `${date}T00:00:00`) as {
      session_id: string;
      source_file: string;
      file_mtime: number;
      tool: string;
    }[];

    const byTool: Record<string, number> = {};
    for (const r of rows) byTool[r.tool] = (byTool[r.tool] ?? 0) + 1;

    const totals: DaySliceValue = {
      events: 0, input_tokens: 0, output_tokens: 0,
      cache_creation_tokens: 0, cache_read_tokens: 0,
      tool_call_count: 0, human_input_count: 0,
    };

    // Cap concurrent JSONL file opens to avoid fd/memory spikes on cache-cold requests
    const sliceResults = await pMap(rows, 12, (r) =>
      getDaySlice(date, r.session_id, r.source_file, r.file_mtime),
    );

    for (const result of sliceResults) {
      if (result.status !== "fulfilled") continue;
      const s = result.value;
      totals.events += s.events;
      totals.input_tokens += s.input_tokens;
      totals.output_tokens += s.output_tokens;
      totals.cache_creation_tokens += s.cache_creation_tokens;
      totals.cache_read_tokens += s.cache_read_tokens;
      totals.tool_call_count += s.tool_call_count;
      totals.human_input_count += s.human_input_count;
    }

    return { date, session_count: rows.length, by_tool: byTool, ...totals };
  }
}
