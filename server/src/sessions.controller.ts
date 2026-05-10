import { Controller, Get, Param, Query } from "@nestjs/common";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getDb } from "./db.ts";
import { backfillDigests, findDatesMissingDigest, generateDigest } from "./digest.ts";
import { runSync, runSyncForDate } from "./sync.ts";
import { parseJsonField } from "./parser-utils.ts";

type SqlParam = string | number | bigint | boolean | null | Uint8Array;

// Track dates currently being generated to avoid duplicate LLM calls
const _generatingDates = new Set<string>();

@Controller("api")
export class SessionsController {
  // ── Manual sync ──────────────────────────────────────────────────────────────
  @Get("sessions/sync")
  async sync(@Query("date") date?: string) {
    return date ? runSyncForDate(date) : runSync();
  }

  // ── Digest list ──────────────────────────────────────────────────────────────
  @Get("sessions/digest/list")
  digestList() {
    const db = getDb();
    const rows = db
      .prepare("SELECT date, pair_count, model, mock, generated_at, stale FROM daily_digest ORDER BY date DESC")
      .all();
    return { digests: rows };
  }

  // ── Digest missing ───────────────────────────────────────────────────────────
  @Get("sessions/digest/missing")
  digestMissing() {
    const dates = findDatesMissingDigest();
    return { missing_dates: dates, count: dates.length };
  }

  // ── Digest backfill ──────────────────────────────────────────────────────────
  @Get("sessions/digest/backfill")
  async digestBackfill(@Query("force") force?: string) {
    return backfillDigests(force === "true");
  }

  // ── Digest for date ──────────────────────────────────────────────────────────
  @Get("sessions/digest")
  async digest(
    @Query("date") dateParam?: string,
    @Query("force") forceParam?: string,
  ) {
    const date = dateParam ?? new Date().toISOString().slice(0, 10);
    const force = forceParam === "true";

    if (!force) {
      const db = getDb();
      const cached = db
        .prepare("SELECT * FROM daily_digest WHERE date = ? AND stale = 0")
        .get(date) as { summary: string; pair_count: number; model: string; mock: number; generated_at: string; stale: number } | undefined;
      if (cached) {
        return {
          date,
          summary: cached.summary,
          pair_count: cached.pair_count,
          model: cached.model,
          mock: cached.mock === 1,
          generated_at: cached.generated_at,
          stale: false,
          cached: true,
          generating: false,
        };
      }
    }

    if (_generatingDates.has(date)) {
      return { date, summary: null, pair_count: 0, model: "", mock: true, generated_at: null, stale: false, cached: false, generating: true };
    }

    _generatingDates.add(date);
    generateDigest(date, force)
      .catch((e: unknown) => console.warn(`[digest] Background generation failed for ${date}: ${(e as Error)?.message}`))
      .finally(() => _generatingDates.delete(date));

    return { date, summary: null, pair_count: 0, model: "", mock: true, generated_at: null, stale: false, cached: false, generating: true };
  }

  // ── Daily summary ─────────────────────────────────────────────────────────────
  @Get("sessions/summary")
  summary(@Query("date") dateParam?: string) {
    const date = dateParam ?? new Date().toISOString().slice(0, 10);
    const dateStart = `${date}T00:00:00`;
    const dateEnd = `${date}T23:59:59`;

    const db = getDb();
    const rows = db.prepare(`
      SELECT tool,
             COUNT(*)                       AS session_count,
             SUM(human_turn_count)          AS human_turn_count,
             SUM(input_tokens)              AS input_tokens,
             SUM(output_tokens)             AS output_tokens,
             SUM(cache_creation_tokens)     AS cache_creation_tokens,
             SUM(cache_read_tokens)         AS cache_read_tokens,
             GROUP_CONCAT(DISTINCT project) AS projects
      FROM sessions
      WHERE started_at BETWEEN ? AND ?
      GROUP BY tool
    `).all(dateStart, dateEnd) as {
      tool: string; session_count: number; human_turn_count: number;
      input_tokens: number; output_tokens: number;
      cache_creation_tokens: number; cache_read_tokens: number; projects: string;
    }[];

    const byTool: Record<string, { sessions: number; human_turns: number; projects: string[] }> = {};
    for (const r of rows) {
      byTool[r.tool] = {
        sessions: r.session_count,
        human_turns: r.human_turn_count ?? 0,
        projects: (r.projects ?? "").split(",").filter(Boolean),
      };
    }

    return {
      date,
      total_sessions:    rows.reduce((s, r) => s + r.session_count, 0),
      total_human_turns: rows.reduce((s, r) => s + (r.human_turn_count ?? 0), 0),
      tokens: {
        input:          rows.reduce((s, r) => s + (r.input_tokens ?? 0), 0),
        output:         rows.reduce((s, r) => s + (r.output_tokens ?? 0), 0),
        cache_creation: rows.reduce((s, r) => s + (r.cache_creation_tokens ?? 0), 0),
        cache_read:     rows.reduce((s, r) => s + (r.cache_read_tokens ?? 0), 0),
      },
      by_tool: byTool,
    };
  }

  // ── Session list ──────────────────────────────────────────────────────────────
  @Get("sessions")
  sessionList(
    @Query("tool") tool?: string,
    @Query("date") date?: string,
    @Query("project") project?: string,
    @Query("limit") limitParam?: string,
    @Query("offset") offsetParam?: string,
  ) {
    const limit = Math.min(parseInt(limitParam ?? "50"), 200);
    const offset = parseInt(offsetParam ?? "0");
    const db = getDb();

    const filterConds: string[] = [];
    const filterParams: SqlParam[] = [];
    if (tool) { filterConds.push("s.tool = ?"); filterParams.push(tool); }
    if (project) { filterConds.push("s.project = ?"); filterParams.push(project); }
    const filterSql = filterConds.length ? "AND " + filterConds.join(" AND ") : "";

    const lastInputSql = `(
      SELECT substr(t.content, 1, 40)
      FROM turns t
      WHERE t.session_id = s.id AND t.turn_kind = 'human_input'
      ORDER BY t.turn_index DESC LIMIT 1
    ) AS last_input_preview`;

    let rows: unknown[], total: number;

    if (date) {
      const dateParams = [...filterParams, date, `${date}T00:00:00`, `${date}T23:59:59`];
      const whereSql = `
        WHERE 1=1 ${filterSql}
          AND (
            date(s.started_at) = ?
            OR EXISTS (
              SELECT 1 FROM turns t
              WHERE t.session_id = s.id
                AND t.timestamp BETWEEN ? AND ?
            )
          )
      `;
      total = ((db.prepare(`SELECT COUNT(DISTINCT s.id) as cnt FROM sessions s ${whereSql}`).get(dateParams)) as { cnt: number })?.cnt ?? 0;
      rows = db.prepare(`SELECT DISTINCT s.*, ${lastInputSql} FROM sessions s ${whereSql} ORDER BY COALESCE(s.ended_at, s.started_at) DESC LIMIT ? OFFSET ?`).all([...dateParams, limit, offset]);
    } else {
      const where = filterConds.length
        ? "WHERE " + filterConds.map((c) => c.replace("s.", "")).join(" AND ")
        : "";
      total = ((db.prepare(`SELECT COUNT(*) as cnt FROM sessions ${where}`).get(filterParams)) as { cnt: number })?.cnt ?? 0;
      rows = db.prepare(`SELECT s.*, ${lastInputSql} FROM sessions s ${where} ORDER BY COALESCE(s.ended_at, s.started_at) DESC LIMIT ? OFFSET ?`).all([...filterParams, limit, offset]);
    }

    const sessions = (rows as Record<string, unknown>[]).map((r) => ({
      ...r,
      tool_call_names: parseJsonField(r.tool_call_names as string, {}),
    }));

    return { sessions, total, limit, offset };
  }

  // ── Session turns ─────────────────────────────────────────────────────────────
  @Get("sessions/:sessionId/turns")
  sessionTurns(
    @Param("sessionId") sessionId: string,
    @Query("date") date?: string,
  ) {
    const db = getDb();
    const sessionRow = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Record<string, unknown> | undefined;
    if (!sessionRow) throw Object.assign(new Error("session not found"), { status: 404 });

    const turns = date
      ? db.prepare("SELECT * FROM turns WHERE session_id = ? AND date(timestamp) = ? ORDER BY turn_index").all(sessionId, date)
      : db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index").all(sessionId);

    const session = { ...sessionRow, tool_call_names: parseJsonField(sessionRow.tool_call_names as string, {}) };
    const turnsOut = (turns as Record<string, unknown>[]).map((t) => ({
      ...t,
      tool_names: parseJsonField(t.tool_names as string, []),
    }));

    return { session, turns: turnsOut, date_filter: date };
  }

  // ── Session stats ─────────────────────────────────────────────────────────────
  @Get("sessions/:sessionId/stats")
  sessionStats(
    @Param("sessionId") sessionId: string,
    @Query("date") date?: string,
  ) {
    const db = getDb();
    const sessionRow = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Record<string, unknown> | undefined;
    if (!sessionRow) throw Object.assign(new Error("session not found"), { status: 404 });

    let humanTurns: unknown[];
    let tokRow: Record<string, number> | null = null;

    if (date) {
      humanTurns = db.prepare(`
        SELECT id, content, timestamp, turn_index FROM turns
        WHERE session_id = ? AND turn_kind = 'human_input' AND date(timestamp) = ?
        ORDER BY turn_index
      `).all(sessionId, date);
      tokRow = db.prepare(`
        SELECT
          SUM(input_tokens) as input, SUM(output_tokens) as output,
          SUM(cache_creation_tokens) as cache_creation, SUM(cache_read_tokens) as cache_read,
          COUNT(CASE WHEN tool_calls > 0 THEN 1 END) as tool_call_turns,
          SUM(tool_calls) as total_tool_calls
        FROM turns WHERE session_id = ? AND date(timestamp) = ?
      `).get(sessionId, date) as Record<string, number>;
    } else {
      humanTurns = db.prepare(`
        SELECT id, content, timestamp, turn_index FROM turns
        WHERE session_id = ? AND turn_kind = 'human_input'
        ORDER BY turn_index
      `).all(sessionId);
    }

    const toolCallNames = parseJsonField<Record<string, number>>(sessionRow.tool_call_names as string, {});

    const tokens = tokRow && date
      ? { input: tokRow.input ?? 0, output: tokRow.output ?? 0, cache_creation: tokRow.cache_creation ?? 0, cache_read: tokRow.cache_read ?? 0 }
      : { input: (sessionRow.input_tokens as number) ?? 0, output: (sessionRow.output_tokens as number) ?? 0, cache_creation: (sessionRow.cache_creation_tokens as number) ?? 0, cache_read: (sessionRow.cache_read_tokens as number) ?? 0 };

    const toolTotal = tokRow && date ? (tokRow.total_tool_calls ?? 0) : ((sessionRow.tool_call_count as number) ?? 0);

    return {
      session_id: sessionId,
      tokens,
      tool_calls: { total: toolTotal, by_name: toolCallNames },
      human_turns: (humanTurns as { id: unknown; turn_index: unknown; timestamp: unknown; content: unknown }[]).map((t) => ({
        id: t.id, turn_index: t.turn_index, timestamp: t.timestamp, content: t.content,
      })),
    };
  }

  // ── Session context traces ────────────────────────────────────────────────────
  @Get("sessions/:sessionId/context")
  async sessionContext(@Param("sessionId") sessionId: string) {
    const db = getDb();
    const sessionRow = db.prepare("SELECT source_file, tool FROM sessions WHERE id = ?")
      .get(sessionId) as { source_file: string; tool: string } | undefined;
    if (!sessionRow) throw Object.assign(new Error("session not found"), { status: 404 });
    if (sessionRow.tool !== "claude") return { traces: [] };

    if (!existsSync(sessionRow.source_file)) throw Object.assign(new Error("source file not found"), { status: 404 });
    const raw = await readFile(sessionRow.source_file, "utf8");

    const subagents: Record<string, { jsonl: string; meta: unknown }> = {};
    try {
      const subDir = join(dirname(sessionRow.source_file), basename(sessionRow.source_file, ".jsonl"), "subagents");
      const entries = await readdir(subDir).catch(() => [] as string[]);
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const agentId = name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
        const jsonl = await readFile(join(subDir, name), "utf8").catch(() => "");
        if (!jsonl) continue;
        const metaRaw = await readFile(join(subDir, `agent-${agentId}.meta.json`), "utf8").catch(() => "");
        let meta: unknown = null;
        if (metaRaw) { try { meta = JSON.parse(metaRaw); } catch { /* ignore */ } }
        subagents[agentId] = { jsonl, meta };
      }
    } catch { /* no subagents */ }

    const { computeAgentContextTraces } = await import("./context.ts");
    const tracesMap = computeAgentContextTraces(
      raw,
      subagents as Record<string, { jsonl: string; meta: { agentType?: string; description?: string; name?: string } | null }>,
      sessionId,
    );
    return { traces: Array.from(tracesMap.values()) };
  }

  // ── Session raw JSONL ─────────────────────────────────────────────────────────
  @Get("sessions/:sessionId/raw")
  async sessionRaw(@Param("sessionId") sessionId: string) {
    const db = getDb();
    const sessionRow = db.prepare("SELECT source_file FROM sessions WHERE id = ?")
      .get(sessionId) as { source_file: string } | undefined;
    if (!sessionRow) throw Object.assign(new Error("session not found"), { status: 404 });

    if (!existsSync(sessionRow.source_file)) throw Object.assign(new Error("source file not found"), { status: 404 });
    const raw = await readFile(sessionRow.source_file, "utf8");

    const subagents: Record<string, { jsonl: string; meta: unknown }> = {};
    try {
      const srcPath = sessionRow.source_file;
      const subDir = join(dirname(srcPath), basename(srcPath, ".jsonl"), "subagents");
      const entries = await readdir(subDir).catch(() => [] as string[]);
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const agentId = name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
        const jsonl = await readFile(join(subDir, name), "utf8").catch(() => "");
        if (!jsonl) continue;
        const metaRaw = await readFile(join(subDir, `agent-${agentId}.meta.json`), "utf8").catch(() => "").catch(() => "");
        let meta: unknown = null;
        if (metaRaw) { try { meta = JSON.parse(metaRaw); } catch { /* ignore */ } }
        subagents[agentId] = { jsonl, meta };
      }
    } catch { /* no subagents dir */ }

    return { raw, subagents };
  }
}
