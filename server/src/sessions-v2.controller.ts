import { Controller, Get, Param, Query } from "@nestjs/common";
import { getDb } from "./db.ts";
import { runSyncV2 } from "./sync-v2.ts";
import { parseJsonField } from "./parser-utils.ts";
import { parseSessionDrilldown, parseSubAgentDrilldown, resolveSubAgentPaths } from "./session-drilldown-parser.ts";
import { readWorkflowRunJson, readWorkflowRunsFromDisk, firstAssistantRequestId, transcriptFirstPrompt } from "./workflow-runs.ts";
import { readTeamDomain } from "./team-domain.ts";
import { loadCallDetail, readProxyRecord, findProxyRowForCall, computeCallProxyMatchModes } from "./call-detail.ts";
import { resolveSideCallLinks, type GhostQueryKind } from "./ghost-attribution.ts";
import { ensureSessionScanned } from "./side-call/enricher.ts";
import { readFileSync } from "node:fs";
import { loadAttributionTree, readSessionEventsForLinker } from "./attribution-service.ts";
import { computeSessionAttributionGraph, type JsonlEventAnnotation, type SessionAttributionGraph } from "./session-attribution-graph.ts";
import { enrichTreeWithGraph } from "./attribution-tree-enrich.ts";
import type { LinkableJsonlEvent } from "./context-ledger/parser";

// ─── Session graph cache ────────────────────────────────────────────────────
// computeSessionAttributionGraph runs over the whole session (~3-15s on
// large sessions with the incremental algorithm). Both the standalone
// attribution-graph endpoint and the per-call attribution-tree enrichment
// path read from this cache, so opening a session and browsing calls only
// pays the cost once. TTL is 5 minutes.
interface CachedGraph {
  graph: SessionAttributionGraph;
  computedAt: number;
}
const sessionGraphCache = new Map<string, CachedGraph>();
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedGraph(sessionId: string): SessionAttributionGraph | null {
  const cached = sessionGraphCache.get(sessionId);
  if (!cached) {
    console.log(`[graph-cache] MISS session=${sessionId.slice(0, 8)} (empty cache)`);
    return null;
  }
  const ageMs = Date.now() - cached.computedAt;
  if (ageMs > GRAPH_CACHE_TTL_MS) {
    console.log(`[graph-cache] MISS session=${sessionId.slice(0, 8)} (expired ${(ageMs/1000).toFixed(1)}s)`);
    return null;
  }
  console.log(`[graph-cache] HIT  session=${sessionId.slice(0, 8)} (age=${(ageMs/1000).toFixed(1)}s)`);
  return cached.graph;
}

function setCachedGraph(sessionId: string, graph: SessionAttributionGraph) {
  sessionGraphCache.set(sessionId, { graph, computedAt: Date.now() });
  console.log(`[graph-cache] STORE session=${sessionId.slice(0, 8)} events=${graph.events.length} audited=${graph.auditedCallIds.length}`);
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
         (SELECT COUNT(*) FROM proxy_requests p WHERE p.session_id = s.session_id) AS proxy_count,
         (SELECT COUNT(*) FROM proxy_requests p WHERE p.session_id = s.session_id AND p.request_id IS NOT NULL) AS proxy_request_id_count
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
  async sessionDrilldown(@Param("id") id: string) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    const sourceFile = row.source_file as string;
    // [perf] 本地开发用：定位 drilldown 加载各阶段耗时。约定同 [attribution-tree] 等。
    const tStart = Date.now();
    let drilldown;
    try {
      drilldown = await parseSessionDrilldown(sourceFile, id, row, db);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`Failed to parse session: ${msg}`), { status: 500 });
    }
    const tParsed = Date.now();

    // Enrich each call with proxyMatchMode (single batch query, not N+1).
    // The drilldown parser leaves matchMode = "unmatched" by default; we
    // overwrite here so the front-end nav can show per-call status dots
    // without an extra round-trip per call.
    const flatCalls = drilldown.turns.flatMap((t) =>
      t.calls.map((c) => ({ id: c.id, apiRequestId: c.apiRequestId }))
    );
    const modes = computeCallProxyMatchModes(db, id, flatCalls);
    for (const turn of drilldown.turns) {
      for (const call of turn.calls) {
        const m = modes.get(call.id);
        if (m) call.proxyMatchMode = m;
      }
    }

    // 协同归因（残差指纹）：把后台 side call 回填到对应的 JSONL 锚点行，让前端能从
    // 该行跳到生成它的后台请求。直接读 side_call_facts 派生索引（不解压 body，~几 ms）。
    //   ai-title           ↔ generate_session_title：aiTitle === link_fact（精确）
    //   system:away_summary ↔ away_summary：content 含 link_fact（JSONL content 末尾多一段
    //                         " (disable recaps in /config)" UI 提示，故用 includes 而非等值）
    const tEnrichStart = Date.now();
    const titleLinks = resolveSideCallLinks(db, id, "generate_session_title");
    const awayLinks = resolveSideCallLinks(db, id, "away_summary");
    const enrichMs = Date.now() - tEnrichStart;
    // Fire-and-forget：触发存量 session 的一次性回扫填充索引，不阻塞本次响应；
    // 下次加载即可命中。绝不 await。
    void ensureSessionScanned(db, id).catch(() => {});
    if (titleLinks.length > 0 || awayLinks.length > 0) {
      const byTitle = new Map<string, number>();
      for (const l of titleLinks) if (!byTitle.has(l.linkFact)) byTitle.set(l.linkFact, l.proxyRequestId);
      const backfill = (ev: { kind: string; rawJson: string; generatedByProxyRequestId?: number }) => {
        if (ev.kind === "ai-title") {
          let aiTitle: string | undefined;
          try { aiTitle = (JSON.parse(ev.rawJson) as { aiTitle?: string }).aiTitle; } catch { /* skip */ }
          if (!aiTitle) return;
          const pid = byTitle.get(aiTitle);
          if (pid != null) ev.generatedByProxyRequestId = pid;
        } else if (ev.kind === "system:away_summary") {
          let content: string | undefined;
          try { content = (JSON.parse(ev.rawJson) as { content?: string }).content; } catch { /* skip */ }
          if (typeof content !== "string") return;
          const c = content.trim();
          const hit = awayLinks.find((l) => c.includes(l.linkFact));
          if (hit) ev.generatedByProxyRequestId = hit.proxyRequestId;
        }
      };
      for (const turn of drilldown.turns) {
        turn.leadingEvents.forEach(backfill);
        for (const call of turn.calls) call.intervalEvents.forEach(backfill);
      }
    }

    console.log(
      `[drilldown] session=${id.slice(0, 8)} parse=${tParsed - tStart}ms ` +
      `sidecall-enrich=${enrichMs}ms total=${Date.now() - tStart}ms ` +
      `turns=${drilldown.turns.length} titleLinks=${titleLinks.length} awayLinks=${awayLinks.length}`,
    );

    return drilldown;
  }

  @Get("sessions/:id/subagent/:agentFileId/drilldown")
  async subAgentDrilldown(@Param("id") id: string, @Param("agentFileId") agentFileId: string) {
    const db = getDb();
    const row = db.prepare(`SELECT source_file FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as { source_file: string } | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });
    const drilldown = await parseSubAgentDrilldown(row.source_file, agentFileId);

    // Sub-agent jsonl events have their own Anthropic request-ids, but the
    // proxy_requests rows landed under the *parent* session_id. So we match
    // against the parent id, not the synthetic "subagent:..." id the parser
    // assigned. Without this, every sub-agent call defaults to "unmatched"
    // and the UI fills the left nav with gray dots — falsely implying the
    // session's proxy coverage is broken.
    const flatCalls = drilldown.turns.flatMap((t) =>
      t.calls.map((c) => ({ id: c.id, apiRequestId: c.apiRequestId }))
    );
    const modes = computeCallProxyMatchModes(db, id, flatCalls);
    for (const turn of drilldown.turns) {
      for (const call of turn.calls) {
        const m = modes.get(call.id);
        if (m) call.proxyMatchMode = m;
      }
    }

    return drilldown;
  }

  // Workflow run 的脚本源码。脚本全文（17KB+ 常见）不进 drilldown payload
  // （WorkflowRunSummary 只带 scriptLength/scriptPath），前端 Script tab 按需取。
  // 数据源是 wf json 内嵌的 script 字段（与 scripts/ 目录下的 .js 文件逐字节冗余，
  // 但 json 是终止时一次性写出的权威副本）。
  @Get("sessions/:id/workflows/:runId/script")
  async workflowScript(@Param("id") id: string, @Param("runId") runId: string) {
    // runId 直接进 path join —— 白名单格式校验挡路径穿越
    if (!/^wf_[A-Za-z0-9-]+$/.test(runId)) {
      throw Object.assign(new Error(`invalid runId: ${runId}`), { status: 400 });
    }
    const db = getDb();
    const row = db.prepare(`SELECT source_file FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as { source_file: string } | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    const { dirname, basename, join } = await import("node:path");
    const sessionDir = join(dirname(row.source_file), basename(row.source_file, ".jsonl"));
    const wfJson = readWorkflowRunJson(sessionDir, runId);
    if (!wfJson) throw Object.assign(new Error(`workflow run not found: ${runId}`), { status: 404 });

    return {
      runId,
      workflowName: typeof wfJson.workflowName === "string" ? wfJson.workflowName : "",
      scriptPath: typeof wfJson.scriptPath === "string" ? wfJson.scriptPath : "",
      script: typeof wfJson.script === "string" ? wfJson.script : "",
    };
  }

  // agent teams 域：输入任一成员 session，返回该 team 的成员列表 + 消息时间线
  // （成员发现走 meta team_name 列；消息从各成员转录重建——见 team-domain.ts
  // 头注释的数据模型与明确不支持清单）。非 team 会话 → 404（显式，不猜）。
  @Get("sessions/:id/team")
  async sessionTeam(@Param("id") id: string) {
    const db = getDb();
    const row = db.prepare(`SELECT team_name FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as { team_name: string | null } | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });
    if (!row.team_name) throw Object.assign(new Error("not a team session"), { status: 404 });
    return readTeamDomain(db, row.team_name);
  }

  // Workflow run 内各 agent 的 StructuredOutput schema —— 真值来自 proxy dump：
  // agent 请求的 tools[] 含发送到 API 的完整 schema（脚本里的 schema 是任意 JS
  // 运行时构造，不可靠静态提取；proxy 是逐字节确定的）。per-agent 取转录任一
  // requestId → proxy join → reqBody.tools[StructuredOutput].input_schema。
  // 取不到时显式 reason，不伪造：no-request（转录无 assistant 行）/
  // proxy-missing（proxy 未捕获）/ no-structured-output（schema-less agent）。
  @Get("sessions/:id/workflows/:runId/schemas")
  async workflowSchemas(@Param("id") id: string, @Param("runId") runId: string) {
    if (!/^wf_[A-Za-z0-9-]+$/.test(runId)) {
      throw Object.assign(new Error(`invalid runId: ${runId}`), { status: 400 });
    }
    const db = getDb();
    const row = db.prepare(`SELECT source_file FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as { source_file: string } | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    const { dirname, basename, join } = await import("node:path");
    const sessionDir = join(dirname(row.source_file), basename(row.source_file, ".jsonl"));
    const run = readWorkflowRunsFromDisk(sessionDir).find((r) => r.runId === runId);
    if (!run) throw Object.assign(new Error(`workflow run not found: ${runId}`), { status: 404 });

    const schemas: Record<string, { schema: Record<string, unknown> | null; reason?: string }> = {};
    for (const agent of run.agents) {
      const agentPath = join(run.agentsDir, `agent-${agent.agentId}.jsonl`);
      const reqId = firstAssistantRequestId(agentPath);
      if (!reqId) {
        schemas[agent.agentId] = { schema: null, reason: "no-request" };
        continue;
      }
      const proxyRow = findProxyRowForCall(db, id, { apiRequestId: reqId });
      if (!proxyRow) {
        schemas[agent.agentId] = { schema: null, reason: "proxy-missing" };
        continue;
      }
      const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
      let tools: Array<{ name?: string; input_schema?: Record<string, unknown> }> = [];
      try {
        const reqBody = JSON.parse((rec?.reqBody as string) ?? "") as { tools?: Array<{ name?: string; input_schema?: Record<string, unknown> }> };
        tools = Array.isArray(reqBody.tools) ? reqBody.tools : [];
      } catch { /* body 不可解 → 按无 schema 处理 */ }
      const so = tools.find((t) => t?.name === "StructuredOutput");
      schemas[agent.agentId] = so?.input_schema
        ? { schema: so.input_schema }
        : { schema: null, reason: "no-structured-output" };
    }
    return { runId, schemas };
  }

  // Workflow run 内的数据流（F）+ 结果回流主线（G）。两者都是**确定性验证**，
  // 不是概率归因（05 文档 §5）：
  //   F：脚本把上游 agent 的 result 经 JSON.stringify/模板插值逐字节内联进下游
  //      prompt —— 验证手段是文本包含检查，命中即 100% 确定；脚本若加工过
  //      （slice/摘要）则不命中，如实不列（"未确认" ≠ "无数据流"）。
  //      因果序约束：journal 物理行序（上游 result 行 < 下游 started 行）。
  //   G：主 agent 收到 notification 后自己 Bash 读 wf json/tmp，常带 jq/head
  //      加工 —— 两级置信：exact（result 全文出现在某 tool_result）/
  //      field（对象 result 的某顶层 string 字段全文出现，覆盖 jq 提取场景）。
  //      前缀/模糊匹配不做（任意阈值易误报）。
  @Get("sessions/:id/workflows/:runId/dataflow")
  async workflowDataflow(@Param("id") id: string, @Param("runId") runId: string) {
    if (!/^wf_[A-Za-z0-9-]+$/.test(runId)) {
      throw Object.assign(new Error(`invalid runId: ${runId}`), { status: 400 });
    }
    const db = getDb();
    const row = db.prepare(`SELECT source_file FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as { source_file: string } | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    const { dirname, basename, join } = await import("node:path");
    const sessionDir = join(dirname(row.source_file), basename(row.source_file, ".jsonl"));
    const run = readWorkflowRunsFromDisk(sessionDir).find((r) => r.runId === runId);
    if (!run) throw Object.assign(new Error(`workflow run not found: ${runId}`), { status: 404 });

    // result 太短的包含检查会误命中（"ok" 在任何 prompt 里都可能出现）—— 跳过，
    // 不出边也不报错（短 result 的真实依赖无法用包含法确认）。
    const MIN_RESULT_CHARS = 100;

    // ── F: agent → agent ──
    const edges: Array<{ fromAgentId: string; fromLabel: string; toAgentId: string; toLabel: string; matchedChars: number }> = [];
    for (const down of run.agents) {
      const downStarted = run.journalStartedLine.get(down.agentId);
      if (downStarted === undefined) continue;
      const prompt = transcriptFirstPrompt(join(run.agentsDir, `agent-${down.agentId}.jsonl`));
      if (!prompt) continue;
      for (const up of run.agents) {
        if (up.agentId === down.agentId) continue;
        const upResultLine = run.journalResultLine.get(up.agentId);
        if (upResultLine === undefined || upResultLine > downStarted) continue;
        const result = run.journalResults.get(up.agentId);
        if (!result || result.length < MIN_RESULT_CHARS) continue;
        if (prompt.includes(result)) {
          edges.push({
            fromAgentId: up.agentId, fromLabel: up.label,
            toAgentId: down.agentId, toLabel: down.label,
            matchedChars: result.length,
          });
        }
      }
    }

    // ── G: 回流主线 ──
    // 主 JSONL 全量 user tool_result 行（0-based 文件行号，与 IntervalEvent.lineIdx
    // 同口径），对每个 agent result 找首个 exact / field 命中。
    const mainline: Array<{ agentId: string; label: string; lineIdx: number; confidence: "exact" | "field"; matchedField?: string }> = [];
    let mainLines: string[];
    try {
      mainLines = readFileSync(row.source_file, "utf-8").split("\n");
    } catch {
      mainLines = [];
    }
    const toolResultTexts: Array<{ lineIdx: number; text: string }> = [];
    for (let i = 0; i < mainLines.length; i++) {
      if (!mainLines[i].trim()) continue;
      let rec: { type?: string; message?: { content?: unknown } };
      try { rec = JSON.parse(mainLines[i]) as typeof rec; } catch { continue; }
      if (rec.type !== "user" || !Array.isArray(rec.message?.content)) continue;
      const text = (rec.message!.content as Array<{ type?: string; content?: unknown }>)
        .filter((b) => b?.type === "tool_result")
        .map((b) => typeof b.content === "string" ? b.content
          : Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map((c) => c?.text ?? "").join("") : "")
        .join("");
      if (text) toolResultTexts.push({ lineIdx: i, text });
    }
    for (const agent of run.agents) {
      const result = run.journalResults.get(agent.agentId);
      if (!result || result.length < MIN_RESULT_CHARS) continue;
      let hit: (typeof mainline)[number] | null = null;
      for (const { lineIdx, text } of toolResultTexts) {
        if (text.includes(result)) {
          hit = { agentId: agent.agentId, label: agent.label, lineIdx, confidence: "exact" };
          break;
        }
      }
      if (!hit) {
        // field 级：对象 result 的顶层 string 字段全文（jq '.findings' 提取场景）
        let obj: Record<string, unknown> | null = null;
        try {
          const v = JSON.parse(result) as unknown;
          if (v !== null && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>;
        } catch { /* string result 无字段级 */ }
        if (obj) {
          outer: for (const [k, v] of Object.entries(obj)) {
            if (typeof v !== "string" || v.length < MIN_RESULT_CHARS) continue;
            for (const { lineIdx, text } of toolResultTexts) {
              if (text.includes(v)) {
                hit = { agentId: agent.agentId, label: agent.label, lineIdx, confidence: "field", matchedField: k };
                break outer;
              }
            }
          }
        }
      }
      if (hit) mainline.push(hit);
    }

    return { runId, edges, mainline };
  }

  // Side calls：本 session 在对话主线之外发起的后台 LLM 请求（生成标题 / quota /
  // prompt suggestion / agent summary 等）。它们带正确的 session_id 但不在 transcript
  // turn/call 结构里。这里把它们集中列出供 Background tab 消费。
  //
  // 数据两路 union：
  //   (1) proxy 捕获到的 —— classifyResidualProxies（对全部 proxy 行分类；transcript
  //       call 的 prompt 不会命中任何 ghost 前缀，故空 exclude 集即安全）。带 tokens。
  //   (2) JSONL 锚定但 proxy 未捕获的 ai-title —— 即使没开 proxy，JSONL 里仍有 ai-title
  //       行证明标题生成过；这类标 captured=false（无 req/res、无 tokens）。
  @Get("sessions/:id/side-calls")
  async sideCalls(@Param("id") id: string) {
    const db = getDb();
    const row = db.prepare(`SELECT source_file FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as { source_file: string } | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    interface SideCall {
      proxyRequestId: number | null;
      kind: GhostQueryKind;
      model: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      startedAt: string | null;
      title?: string;
      anchored: boolean; // 在 JSONL transcript 里有锚点行（目前仅 ai-title）
      captured: boolean; // proxy 抓到了 req/res
    }

    // 一次性回扫填充 side_call_facts（Background tab 可接受首次阻塞扫描）；
    // 之后从派生表 JOIN proxy_requests 取 kind/model/tokens/time/title，无需解压 body。
    await ensureSessionScanned(db, id);
    const factRows = db.prepare(`
      SELECT p.id AS proxyRequestId, f.query_kind AS kind, f.link_fact AS title,
             p.model AS model, p.res_input_tokens AS inputTokens,
             p.res_output_tokens AS outputTokens, p.started_at AS startedAt
      FROM side_call_facts f
      JOIN proxy_requests p ON p.session_id = f.session_id AND p.request_id = f.request_id
      WHERE f.session_id = ?
      ORDER BY p.started_at
    `).all(id) as {
      proxyRequestId: number;
      kind: GhostQueryKind;
      title: string | null;
      model: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      startedAt: string | null;
    }[];

    const rows: SideCall[] = factRows.map((g) => ({
      proxyRequestId: g.proxyRequestId,
      kind: g.kind,
      model: g.model,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      startedAt: g.startedAt,
      ...(g.title ? { title: g.title } : {}),
      anchored: g.kind === "generate_session_title",
      captured: true,
    }));

    // (2) JSONL-anchored ai-title 未被 proxy 捕获的：轻量扫 source_file 取 distinct
    // aiTitle 值，凡不在已捕获标题集里的，补一条 captured=false。
    const capturedTitles = new Set(
      factRows.filter((g) => g.kind === "generate_session_title" && g.title).map((g) => g.title!),
    );
    try {
      const text = readFileSync(row.source_file, "utf8");
      const seen = new Set<string>();
      for (const line of text.split("\n")) {
        if (!line.startsWith('{"type":"ai-title"')) continue;
        try {
          const t = (JSON.parse(line) as { aiTitle?: string }).aiTitle;
          if (t && !seen.has(t)) {
            seen.add(t);
            if (!capturedTitles.has(t)) {
              rows.push({
                proxyRequestId: null,
                kind: "generate_session_title",
                model: null,
                inputTokens: null,
                outputTokens: null,
                startedAt: null,
                title: t,
                anchored: true,
                captured: false,
              });
            }
          }
        } catch { /* skip malformed line */ }
      }
    } catch { /* source file gone — only proxy-captured rows */ }

    // 时间升序；未捕获（无 startedAt）排末尾。
    rows.sort((a, b) => (a.startedAt ?? "~").localeCompare(b.startedAt ?? "~"));

    const tokenTotals = rows.reduce(
      (acc, r) => ({ input: acc.input + (r.inputTokens ?? 0), output: acc.output + (r.outputTokens ?? 0) }),
      { input: 0, output: 0 },
    );
    return { sideCalls: rows, tokenTotals };
  }

  // Sub-agent call-detail mirrors the main session endpoint. A sub-agent is
  // an independent SessionDrilldown (parseSubAgentDrilldown), but its proxy
  // rows live under the **parent** session_id (Claude Code sends the parent
  // session id in X-Claude-Code-Session-Id for all sub-agent requests), so
  // loadCallDetail is invoked with the parent id rather than the synthetic
  // "subagent:..." id.
  @Get("sessions/:id/subagent/:agentFileId/calls/:callId/detail")
  async subAgentCallDetail(
    @Param("id") id: string,
    @Param("agentFileId") agentFileId: string,
    @Param("callId") callIdStr: string,
  ) {
    const db = getDb();
    const row = db.prepare(`SELECT source_file FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as { source_file: string } | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    const drilldown = await parseSubAgentDrilldown(row.source_file, agentFileId);
    const callId = parseInt(callIdStr, 10);
    const allCalls = drilldown.turns.flatMap((t) => t.calls);
    const callIdx = allCalls.findIndex((c) => c.id === callId);
    if (callIdx === -1) throw Object.assign(new Error("call not found"), { status: 404 });
    const call = allCalls[callIdx];
    const prevCall = callIdx > 0 ? allCalls[callIdx - 1] : undefined;

    return loadCallDetail(
      id, // parent session_id for proxy lookup
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

  // Sub-agent attribution-tree. Same structure as the main session endpoint,
  // but sourceFile is the sub-agent JSONL and proxy lookups use the parent
  // session_id. Reverse-attribution enrichment is intentionally skipped here
  // — the session-level attribution graph is keyed on a single sessionId and
  // the sub-agent's calls form an independent scope; running it for every
  // sub-agent navigation would be wasteful and isn't needed for the current
  // UI (the sub-agent view is a drilldown, not a graph).
  @Get("sessions/:id/subagent/:agentFileId/calls/:callId/attribution-tree")
  async subAgentAttributionTree(
    @Param("id") id: string,
    @Param("agentFileId") agentFileId: string,
    @Param("callId") callIdStr: string,
  ) {
    const db = getDb();
    const row = db.prepare(`SELECT source_file FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as { source_file: string } | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    // Resolve the sub-agent JSONL path the same way parseSubAgentDrilldown does
    // (single source of truth — handles flat and workflow-composite ids alike).
    const subAgentFile = resolveSubAgentPaths(row.source_file, agentFileId).agentPath;

    const drilldown = await parseSubAgentDrilldown(row.source_file, agentFileId);
    const callId = parseInt(callIdStr, 10);
    const allCalls = drilldown.turns.flatMap((t) => t.calls.map((c) => ({ call: c, turnId: t.id })));
    const idx = allCalls.findIndex((x) => x.call.id === callId);
    if (idx === -1) throw Object.assign(new Error("call not found"), { status: 404 });

    let cachedEvents: LinkableJsonlEvent[] | null = null;
    const loadJsonlEvents = (file: string): LinkableJsonlEvent[] | null => {
      if (file !== subAgentFile) return null;
      if (cachedEvents === null) cachedEvents = readSessionEventsForLinker(file);
      return cachedEvents;
    };

    const resolveCallMeta = (_sid: string, cid: number) => {
      const cur = allCalls.find((x) => x.call.id === cid);
      if (!cur) return null;
      const curIdx = allCalls.indexOf(cur);
      const prev = curIdx > 0 ? allCalls[curIdx - 1] : null;
      return {
        call: { id: cur.call.id, timestamp: cur.call.timestamp, turnId: cur.turnId, sourceFile: subAgentFile, apiRequestId: cur.call.apiRequestId },
        prevCall: prev ? { id: prev.call.id, timestamp: prev.call.timestamp, apiRequestId: prev.call.apiRequestId } : null,
      };
    };
    const fetchProxyReqBodyAt = async (
      _sid: string,
      ts: string,
      excludeProxyId?: number,
      apiRequestId?: string | null,
    ) => {
      // Always use the parent session id for proxy lookup — sub-agent proxy
      // rows landed under the parent session_id.
      const proxyRow = findProxyRowForCall(db, id, { apiRequestId, excludeProxyId });
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

    // loadAttributionTree's first arg is the sessionId used as a cache key
    // and threaded through helpers. We pass a synthetic id scoping the cache
    // to (parentSessionId, agentFileId, callId) so different sub-agents don't
    // collide.
    return loadAttributionTree(`${id}::subagent::${agentFileId}`, callId, db, {
      resolveCallMeta,
      fetchProxyReqBodyAt,
      loadJsonlEvents,
    });
  }

  // Sub-agent diff-tree — mirror of the main session endpoint with
  // parseSubAgentDrilldown + parent-session_id proxy lookup.
  @Get("sessions/:id/subagent/:agentFileId/calls/:callId/diff-tree")
  async subAgentDiffTree(
    @Param("id") id: string,
    @Param("agentFileId") agentFileId: string,
    @Param("callId") callIdStr: string,
  ) {
    const db = getDb();
    const row = db.prepare(`SELECT source_file FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as { source_file: string } | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    const subAgentFile = resolveSubAgentPaths(row.source_file, agentFileId).agentPath;

    const drilldown = await parseSubAgentDrilldown(row.source_file, agentFileId);
    const callId = parseInt(callIdStr, 10);
    const allCalls = drilldown.turns.flatMap((t) => t.calls.map((c) => ({ call: c, turnId: t.id })));
    const idx = allCalls.findIndex((x) => x.call.id === callId);
    if (idx === -1) throw Object.assign(new Error("call not found"), { status: 404 });

    return loadDiffTree(`${id}::subagent::${agentFileId}`, callId, db, {
      resolveCallMeta: (_sid, cid) => {
        const cur = allCalls.find((x) => x.call.id === cid);
        if (!cur) return null;
        const curIdx = allCalls.indexOf(cur);
        const prev = curIdx > 0 ? allCalls[curIdx - 1] : null;
        return {
          call: { id: cur.call.id, timestamp: cur.call.timestamp, turnId: cur.turnId, sourceFile: subAgentFile, apiRequestId: cur.call.apiRequestId },
          prevCall: prev ? { id: prev.call.id, timestamp: prev.call.timestamp, apiRequestId: prev.call.apiRequestId } : null,
        };
      },
      fetchProxyReqBodyAt: async (_sid, ts, excludeProxyId, apiRequestId) => {
        const proxyRow = findProxyRowForCall(db, id, { apiRequestId, excludeProxyId });
        if (!proxyRow) return null;
        const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
        const reqBodyStr = rec?.reqBody as string | undefined;
        if (typeof reqBodyStr !== "string") return null;
        let reqBody: Record<string, unknown> | null = null;
        try { reqBody = JSON.parse(reqBodyStr) as Record<string, unknown>; } catch { return null; }
        let reqHeaders: Record<string, string> = {};
        try { reqHeaders = JSON.parse(proxyRow.req_headers ?? "{}") as Record<string, string>; } catch { /* default */ }
        return {
          reqBody, reqHeaders,
          proxyRequestId: proxyRow.id,
          startedAt: proxyRow.started_at ?? ts,
        };
      },
    });
  }

  // Sub-agent response-tree — mirror of the main session endpoint.
  @Get("sessions/:id/subagent/:agentFileId/calls/:callId/response-tree")
  async subAgentResponseTree(
    @Param("id") id: string,
    @Param("agentFileId") agentFileId: string,
    @Param("callId") callIdStr: string,
  ) {
    const db = getDb();
    const row = db.prepare(`SELECT source_file FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as { source_file: string } | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    const drilldown = await parseSubAgentDrilldown(row.source_file, agentFileId);
    const callId = parseInt(callIdStr, 10);
    const allCalls = drilldown.turns.flatMap((t) => t.calls);
    const idx = allCalls.findIndex((c) => c.id === callId);
    if (idx === -1) throw Object.assign(new Error("call not found"), { status: 404 });

    return loadResponseTree(`${id}::subagent::${agentFileId}`, callId, db, {
      resolveCallContext: (_sid, cid) => {
        const curIdx = allCalls.findIndex((c) => c.id === cid);
        if (curIdx === -1) return null;
        const cur = allCalls[curIdx];
        const next = curIdx + 1 < allCalls.length ? allCalls[curIdx + 1] : null;
        return {
          apiRequestId: cur.apiRequestId,
          // 子代理 proxy 查询用真实 sessionId（与 proxy_requests.session_id 对齐），
          // 而非合成的 `${id}::subagent::...`
          proxySessionId: id,
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

  @Get("sessions/:id/calls/:callId/detail")
  async callDetail(@Param("id") id: string, @Param("callId") callIdStr: string) {
    const db = getDb();

    // Re-parse the session drilldown to find the call and its predecessor
    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    let drilldown;
    try {
      drilldown = await parseSessionDrilldown(row.source_file as string, id, row, db);
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
  ) {
    const db = getDb();

    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });
    const sourceFile = row.source_file as string;

    let drilldown;
    try {
      drilldown = await parseSessionDrilldown(sourceFile, id, row, db);
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
      const proxyRow = findProxyRowForCall(db, sid, { apiRequestId, excludeProxyId });
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

    // Reverse-attribution enrichment: every jsonl-origin leaf is annotated
    // with firstSeenInCall / consumedByCallIds so the front-end can use the
    // leaf directly as a jump target (no cross-endpoint join). Always runs
    // a full-session graph; the module cache amortizes across calls in the
    // same session.
    let graph = getCachedGraph(id);
    if (!graph) {
      const t0 = Date.now();
      console.log(`[attribution-tree] computing graph for enrichment session=${id.slice(0,8)} call=${callId} calls=${allCalls.length}`);
      graph = await computeSessionAttributionGraph(id, db, {
        listCalls: () => allCalls.map((x) => ({ callId: x.call.id, sourceFile })),
        loadCallHelpers: { resolveCallMeta, fetchProxyReqBodyAt, loadJsonlEvents },
      });
      console.log(`[attribution-tree] graph computed session=${id.slice(0,8)} call=${callId} took=${Date.now()-t0}ms events=${graph.events.length}`);
      setCachedGraph(id, graph);
    }
    const eventByLine = new Map<number, JsonlEventAnnotation>();
    for (const ev of graph.events) eventByLine.set(ev.lineIdx, ev);
    const summary = enrichTreeWithGraph(treeResult, eventByLine, callId);
    if (summary.droppedByGuard > 0) {
      console.log(`[enrich-tree] session=${id.slice(0,8)} call=${callId} dropped=${summary.droppedByGuard} firstSeenInCall annotations (>currentCallId)`);
    }

    return treeResult;
  }

  /**
   * Session-level attribution graph：把整 session 跑过的 per-call snapshot 反向
   * 聚合成"每个 jsonl event 在哪些 call 里被消费"。配合 per-call attribution-tree
   * 一起，前端就能做双向归因（leaf → jsonl line ↔ event → consuming calls）。
   *
   * 永远跑全 session，结果按 sessionId 模块级缓存（5min TTL），与 attribution-tree
   * 的 enrichment 路径共享同一份 cache。
   */
  @Get("sessions/:id/attribution-graph")
  async attributionGraph(@Param("id") id: string) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });
    const sourceFile = row.source_file as string;

    let drilldown;
    try {
      drilldown = await parseSessionDrilldown(sourceFile, id, row, db);
    } catch {
      throw Object.assign(new Error("drilldown parse failed"), { status: 500 });
    }

    const allCalls = drilldown.turns.flatMap((t) => t.calls.map((c) => ({ call: c, turnId: t.id })));

    const cached = getCachedGraph(id);
    if (cached) return cached;
    const tStart = Date.now();
    console.log(`[attribution-graph] computing session=${id.slice(0,8)} calls=${allCalls.length}`);

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
      listCalls: () => allCalls.map((x) => ({ callId: x.call.id, sourceFile })),
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
          const proxyRow = findProxyRowForCall(db, sid, { apiRequestId, excludeProxyId });
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
    console.log(`[attribution-graph] computed session=${id.slice(0,8)} took=${Date.now()-tStart}ms events=${computed.events.length} audited=${computed.auditedCallIds.length}`);
    setCachedGraph(id, computed);
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
      drilldown = await parseSessionDrilldown(sourceFile, id, row, db);
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
        const proxyRow = findProxyRowForCall(db, sid, { apiRequestId, excludeProxyId });
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
      drilldown = await parseSessionDrilldown(sourceFile, id, row, db);
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
          apiRequestId: cur.apiRequestId,
          proxySessionId: id,
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

  // ── Compact-as-call endpoints ─────────────────────────────────────────────
  // compact_boundary 实际上是一次独立的 summarization LLM call，但 JSONL 端没有
  // assistant 事件，没法走 :callId 路由（合成 call id 是负 sentinel）。这里独占
  // 一组 :idx 寻址的端点，CallDetail-shape 输出的 callId 仍是 `-(idx+1)` 与
  // frontend synthesizeCompactTurn 那侧约定一致。详见 docs/inner/claude-take.md。

  @Get("sessions/:id/compact/:idx/detail")
  async compactDetail(@Param("id") id: string, @Param("idx") idxStr: string) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    let drilldown;
    try {
      drilldown = await parseSessionDrilldown(row.source_file as string, id, row, db);
    } catch {
      throw Object.assign(new Error("drilldown parse failed"), { status: 500 });
    }

    const idx = parseInt(idxStr, 10);
    const ev = drilldown.compactEvents?.[idx];
    if (!ev) throw Object.assign(new Error("compact event not found"), { status: 404 });

    const syntheticCallId = -(ev.index + 1);
    const tokens = {
      contextSize: ev.preTokens,
      cacheRead: ev.proxy?.cacheReadTokens ?? 0,
      cacheWrite: 0,
      freshIn: ev.proxy?.inputTokens ?? 0,
      outputTokens: ev.proxy?.outputTokens ?? 0,
    };
    const base = {
      callId: syntheticCallId,
      sessionId: id,
      model: ev.proxy?.model ?? "",
      stopReason: "end_turn",
      timestamp: ev.proxy?.startedAt ?? ev.timestamp,
      tokens,
    };
    if (!ev.proxy) {
      return { ...base, proxyRequestId: null, proxyMatchMode: "unmatched" as const, rawRequestJson: null };
    }
    // ev.proxy.requestId 是 Anthropic 的 request-id（或 proxy 注入的 synthetic
    // proxy-<uuid>），与普通 call 的 apiRequestId 同义，findProxyRowForCall 直接吃。
    const proxyRow = findProxyRowForCall(db, id, { apiRequestId: ev.proxy.requestId });
    if (!proxyRow) {
      return { ...base, proxyRequestId: ev.proxy.proxyRequestId, proxyMatchMode: "exact" as const, rawRequestJson: null };
    }
    const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
    let rawRequestJson: Record<string, unknown> | null = null;
    if (rec && typeof rec.reqBody === "string") {
      try { rawRequestJson = JSON.parse(rec.reqBody) as Record<string, unknown>; }
      catch { /* not JSON */ }
    }
    return { ...base, proxyRequestId: proxyRow.id, proxyMatchMode: "exact" as const, rawRequestJson };
  }

  @Get("sessions/:id/compact/:idx/response-tree")
  async compactResponseTree(@Param("id") id: string, @Param("idx") idxStr: string) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });

    let drilldown;
    try {
      drilldown = await parseSessionDrilldown(row.source_file as string, id, row, db);
    } catch {
      throw Object.assign(new Error("drilldown parse failed"), { status: 500 });
    }

    const idx = parseInt(idxStr, 10);
    const ev = drilldown.compactEvents?.[idx];
    if (!ev) throw Object.assign(new Error("compact event not found"), { status: 404 });

    const syntheticCallId = -(ev.index + 1);
    // loadResponseTree 走 helpers.resolveCallContext —— 我们用 ev.proxy.requestId
    // 当作 apiRequestId 喂下去，proxy 那边的 resBody 解析路径完全复用。
    return loadResponseTree(id, syntheticCallId, db, {
      resolveCallContext: (_sid, _cid) => ({
        apiRequestId: ev.proxy?.requestId ?? null,
        proxySessionId: id,
        // compact prompt 强制 NO_TOOLS，response 一定没有 tool_use 块
        toolCalls: [],
        nextCallId: null,
        stopReason: "end_turn",
        outputTokens: ev.proxy?.outputTokens ?? 0,
      }),
    });
  }

  @Get("sessions/:id/compact/:idx/attribution-tree")
  async compactAttributionTree(@Param("id") id: string, @Param("idx") idxStr: string) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { status: 404 });
    const sourceFile = row.source_file as string;

    let drilldown;
    try {
      drilldown = await parseSessionDrilldown(sourceFile, id, row, db);
    } catch {
      throw Object.assign(new Error("drilldown parse failed"), { status: 500 });
    }

    const idx = parseInt(idxStr, 10);
    const ev = drilldown.compactEvents?.[idx];
    if (!ev) throw Object.assign(new Error("compact event not found"), { status: 404 });

    const syntheticCallId = -(ev.index + 1);

    // prevCall = compact_boundary 之前最后一条真实 LLM call。loadAttributionTree
    // 用它做 diff（cur reqBody vs prev reqBody）—— 对 compact 而言这个 diff 大体
    // 是 "整个 NO_TOOLS_PREAMBLE 段都是 added"，符合直觉。
    const boundaryTsMs = Date.parse(ev.timestamp);
    const allCalls = drilldown.turns.flatMap((t) => t.calls.map((c) => ({ call: c, turnId: t.id })));
    let prevReal: typeof allCalls[number] | null = null;
    for (const x of allCalls) {
      const ts = Date.parse(x.call.timestamp);
      if (Number.isFinite(ts) && ts < boundaryTsMs) prevReal = x;
      else break; // calls 按 timestamp 升序，碰到第一个 >= 直接停
    }

    let cachedEvents: LinkableJsonlEvent[] | null = null;
    const loadJsonlEvents = (file: string): LinkableJsonlEvent[] | null => {
      if (file !== sourceFile) return null;
      if (cachedEvents === null) cachedEvents = readSessionEventsForLinker(file);
      return cachedEvents;
    };

    const resolveCallMeta = (_sid: string, cid: number) => {
      // 只服务合成的 compact callId；任何别的 id 都不该到这条端点
      if (cid !== syntheticCallId) return null;
      return {
        call: {
          id: syntheticCallId,
          timestamp: ev.proxy?.startedAt ?? ev.timestamp,
          // turnId 没有真正的 turn 归属 —— 用 belonging.afterTurnId 当锚
          turnId: ev.belonging.kind === "between-turns" || ev.belonging.kind === "post-session"
            ? ev.belonging.afterTurnId
            : -1,
          sourceFile,
          apiRequestId: ev.proxy?.requestId ?? null,
        },
        prevCall: prevReal
          ? { id: prevReal.call.id, timestamp: prevReal.call.timestamp, apiRequestId: prevReal.call.apiRequestId }
          : null,
      };
    };

    const fetchProxyReqBodyAt = async (
      sid: string,
      ts: string,
      excludeProxyId?: number,
      apiRequestId?: string | null,
    ) => {
      const proxyRow = findProxyRowForCall(db, sid, { apiRequestId, excludeProxyId });
      if (!proxyRow) return null;
      const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
      const reqBodyStr = rec?.reqBody as string | undefined;
      if (typeof reqBodyStr !== "string") return null;
      let reqBody: Record<string, unknown> | null = null;
      try { reqBody = JSON.parse(reqBodyStr) as Record<string, unknown>; }
      catch { return null; }
      let reqHeaders: Record<string, string> = {};
      try { reqHeaders = JSON.parse(proxyRow.req_headers ?? "{}") as Record<string, string>; }
      catch { /* default */ }
      return { reqBody, reqHeaders, proxyRequestId: proxyRow.id, startedAt: proxyRow.started_at ?? ts };
    };

    const treeResult = await loadAttributionTree(id, syntheticCallId, db, {
      resolveCallMeta,
      fetchProxyReqBodyAt,
      loadJsonlEvents,
    });

    // attribution graph enrichment：跟 attributionTree 端点同款。graph 用整 session
    // 的 calls 计算，compact 的叶子 reverse-attribution 也走同一份 lineIdx → call 的
    // 索引，无需特殊路径。
    let graph = getCachedGraph(id);
    if (!graph) {
      graph = await computeSessionAttributionGraph(id, db, {
        listCalls: () => allCalls.map((x) => ({ callId: x.call.id, sourceFile })),
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
          fetchProxyReqBodyAt,
          loadJsonlEvents,
        },
      });
      setCachedGraph(id, graph);
    }
    const eventByLine = new Map<number, JsonlEventAnnotation>();
    for (const ev2 of graph.events) eventByLine.set(ev2.lineIdx, ev2);
    enrichTreeWithGraph(treeResult, eventByLine, syntheticCallId);

    return treeResult;
  }

  // ── Side-call-as-call endpoints ───────────────────────────────────────────
  // A side call 是对话主线之外的后台 LLM 请求（标题 / quota / agent summary …），
  // 只由 proxy_requests.id 寻址 —— 没有 JSONL transcript turn、没有 prev call、
  // 没有可归因的 jsonl 坐标。这组端点镜像 compact 端点，但 attribution 走"空 jsonl
  // + 无 prevCall"的退化路径（无 diff），response 直接用 proxy row 的 request_id
  // 解析 resBody。callId 用负 sentinel `-(proxyRequestId)`，仅作内部占位，前端
  // side-call 模式不依赖它做展示。

  private sideCallProxyRow(db: ReturnType<typeof getDb>, id: string, proxyRequestId: number) {
    return db.prepare(`
      SELECT id, request_id, jsonl_file, jsonl_byte_offset, req_headers, model, started_at,
             res_input_tokens, res_output_tokens,
             res_cache_read_tokens, res_cache_creation_tokens, res_stop_reason
      FROM proxy_requests
      WHERE session_id = ? AND id = ?
    `).get(id, proxyRequestId) as {
      id: number;
      request_id: string | null;
      jsonl_file: string | null;
      jsonl_byte_offset: number | null;
      req_headers: string | null;
      model: string | null;
      started_at: string | null;
      res_input_tokens: number | null;
      res_output_tokens: number | null;
      res_cache_read_tokens: number | null;
      res_cache_creation_tokens: number | null;
      res_stop_reason: string | null;
    } | undefined;
  }

  @Get("sessions/:id/side-call/:proxyRequestId/detail")
  async sideCallDetail(@Param("id") id: string, @Param("proxyRequestId") proxyRequestIdStr: string) {
    const db = getDb();
    const proxyRequestId = parseInt(proxyRequestIdStr, 10);
    const proxyRow = this.sideCallProxyRow(db, id, proxyRequestId);
    if (!proxyRow) throw Object.assign(new Error("side call proxy row not found"), { status: 404 });

    const freshIn = proxyRow.res_input_tokens ?? 0;
    const tokens = {
      contextSize: freshIn,
      cacheRead: proxyRow.res_cache_read_tokens ?? 0,
      cacheWrite: proxyRow.res_cache_creation_tokens ?? 0,
      freshIn,
      outputTokens: proxyRow.res_output_tokens ?? 0,
    };

    let rawRequestJson: Record<string, unknown> | null = null;
    if (proxyRow.jsonl_file != null && proxyRow.jsonl_byte_offset != null) {
      const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
      if (rec && typeof rec.reqBody === "string") {
        try { rawRequestJson = JSON.parse(rec.reqBody) as Record<string, unknown>; }
        catch { /* not JSON */ }
      }
    }

    return {
      // 负 sentinel callId —— 仅占位，side-call 模式不据它寻址/展示。
      callId: -proxyRequestId,
      sessionId: id,
      model: proxyRow.model ?? "",
      stopReason: proxyRow.res_stop_reason ?? "end_turn",
      timestamp: proxyRow.started_at ?? "",
      tokens,
      proxyRequestId: proxyRow.id,
      proxyMatchMode: "exact" as const,
      rawRequestJson,
    };
  }

  @Get("sessions/:id/side-call/:proxyRequestId/response-tree")
  async sideCallResponseTree(@Param("id") id: string, @Param("proxyRequestId") proxyRequestIdStr: string) {
    const db = getDb();
    const proxyRequestId = parseInt(proxyRequestIdStr, 10);
    const proxyRow = this.sideCallProxyRow(db, id, proxyRequestId);
    if (!proxyRow) throw Object.assign(new Error("side call proxy row not found"), { status: 404 });

    const syntheticCallId = -proxyRequestId;
    // loadResponseTree 走 resolveCallContext —— 用 proxy row 的 request_id 当作
    // apiRequestId，resBody 解析路径完全复用普通/compact call 那条。side call 没有
    // tool_use（也无下游 call），toolCalls / nextCallId 都给空。
    return loadResponseTree(id, syntheticCallId, db, {
      resolveCallContext: () => ({
        apiRequestId: proxyRow.request_id,
        proxySessionId: id,
        toolCalls: [],
        nextCallId: null,
        stopReason: proxyRow.res_stop_reason ?? "end_turn",
        outputTokens: proxyRow.res_output_tokens ?? 0,
      }),
    });
  }

  @Get("sessions/:id/side-call/:proxyRequestId/attribution-tree")
  async sideCallAttributionTree(@Param("id") id: string, @Param("proxyRequestId") proxyRequestIdStr: string) {
    const db = getDb();
    const proxyRequestId = parseInt(proxyRequestIdStr, 10);
    const proxyRow = this.sideCallProxyRow(db, id, proxyRequestId);
    if (!proxyRow) throw Object.assign(new Error("side call proxy row not found"), { status: 404 });

    const syntheticCallId = -proxyRequestId;

    // loadAttributionTree 退化驱动：
    //   • resolveCallMeta 返回 prevCall=null → 不跑 prev snapshot → diff 为 null。
    //   • loadJsonlEvents 永远返回空数组 → attributeWithJsonl 用空 jsonl 归因
    //     （叶子保持 structural/rule origin，没有 jsonl-origin 反向链接）。
    //   • 不做 attribution-graph enrichment（side call 不在 session 的 call 图里）。
    const resolveCallMeta = (_sid: string, cid: number) => {
      if (cid !== syntheticCallId) return null;
      return {
        call: {
          id: syntheticCallId,
          timestamp: proxyRow.started_at ?? "",
          turnId: -1,
          // sourceFile 仅作为 loadJsonlEvents 的 key；我们强制返回 [] 所以值无关紧要。
          sourceFile: proxyRow.jsonl_file ?? `side-call:${proxyRequestId}`,
          apiRequestId: proxyRow.request_id,
        },
        prevCall: null,
      };
    };

    const fetchProxyReqBodyAt = async () => {
      if (proxyRow.jsonl_file == null || proxyRow.jsonl_byte_offset == null) return null;
      const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
      const reqBodyStr = rec?.reqBody as string | undefined;
      if (typeof reqBodyStr !== "string") return null;
      let reqBody: Record<string, unknown> | null = null;
      try { reqBody = JSON.parse(reqBodyStr) as Record<string, unknown>; }
      catch { return null; }
      let reqHeaders: Record<string, string> = {};
      try { reqHeaders = JSON.parse(proxyRow.req_headers ?? "{}") as Record<string, string>; }
      catch { /* default empty */ }
      return { reqBody, reqHeaders, proxyRequestId: proxyRow.id, startedAt: proxyRow.started_at ?? "" };
    };

    return loadAttributionTree(id, syntheticCallId, db, {
      resolveCallMeta,
      fetchProxyReqBodyAt,
      // empty jsonl — side call 没有 transcript 锚点
      loadJsonlEvents: () => [],
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
