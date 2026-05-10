import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import type { Database } from "better-sqlite3";
import type { SessionDrilldown, UserTurn, LlmCall, ProxyCallData, ModelStats, SubAgentSummary } from "./session-drilldown-types.ts";
import { getContextWindowSize, normaliseModelName } from "./model-info.ts";

// ─── JSONL record shapes (loose, best-effort) ────────────────────────────────

interface JUserEvent {
  type: "user";
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: unknown };
  timestamp?: string;
  ts?: string;
  cwd?: string;
}

interface JAssistantEvent {
  type: "assistant";
  isSidechain?: boolean;
  message?: {
    id?: string;
    model?: string;
    stop_reason?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  timestamp?: string;
  ts?: string;
}

interface JSystemEvent {
  type: "system";
  subtype?: string;
  durationMs?: number;
  timestamp?: string;
  ts?: string;
}

type JEvent = JUserEvent | JAssistantEvent | JSystemEvent | { type: string; [k: string]: unknown };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.length > 0 && (content as Array<{ type?: string }>).every(b => b?.type === "tool_result");
}

function isCommandContent(content: unknown): boolean {
  if (typeof content !== "string") return false;
  return content.trimStart().startsWith("<command-name>");
}

function isHumanInput(ev: JUserEvent): boolean {
  if (ev.isMeta || ev.isSidechain) return false;
  const content = ev.message?.content;
  if (isToolResultOnly(content)) return false;
  if (isCommandContent(content)) return false;
  return true;
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 200);
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter(b => b?.type !== "thinking" && b?.type !== "redacted_thinking" && b?.type !== "tool_result")
    .map(b => {
      if (typeof b === "string") return b;
      if (b?.type === "text") return (b.text ?? "").slice(0, 200);
      return "";
    })
    .join(" ")
    .trim()
    .slice(0, 200);
}

function tsOf(ev: JEvent): string {
  const ts = ("timestamp" in ev ? (ev as { timestamp?: string }).timestamp : undefined)
    ?? ("ts" in ev ? (ev as { ts?: string }).ts : undefined);
  return ts ?? "";
}

// ─── Sub agent parser ─────────────────────────────────────────────────────────
// Scans the subagents/ directory next to the session JSONL.
// Each agent-{hash}.jsonl is an independent conversation; .meta.json has type+description.
// The linkage to the parent session is: subagents/ is a sibling directory of the session file,
// named after the session file (without .jsonl extension).

function parseSubAgents(sourceFile: string, mainEvents: JEvent[]): SubAgentSummary[] {
  const sessionBase = basename(sourceFile, ".jsonl");
  const subagentsDir = join(dirname(sourceFile), sessionBase, "subagents");
  if (!existsSync(subagentsDir)) return [];

  // Build a map: tool_use_id → tool_result content (from main JSONL)
  // so we can attach the result preview to each sub agent.
  // We match by order: the Nth Agent tool_result in the main chain corresponds
  // to the Nth sub agent (by start time, since ordering is not always guaranteed).
  // Better approach: use subagent file start time to order, and match sequentially.
  const agentToolUses: Array<{ id: string; name: string; resultPreview: string }> = [];
  for (const ev of mainEvents) {
    if (ev.type !== "assistant") continue;
    const aev = ev as JAssistantEvent;
    for (const b of aev.message?.content ?? []) {
      if (b.type === "tool_use" && (b as { name?: string }).name === "Agent") {
        agentToolUses.push({ id: (b as { id?: string }).id ?? "", name: "Agent", resultPreview: "" });
      }
    }
  }
  // Collect tool_results for Agent calls
  let agentResultIdx = 0;
  for (const ev of mainEvents) {
    if (ev.type !== "user") continue;
    const uev = ev as JUserEvent;
    const content = uev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const bc = b as { type?: string; tool_use_id?: string; content?: unknown };
      if (bc.type !== "tool_result") continue;
      // Check if this tool_result matches one of the Agent tool_use ids
      const matchIdx = agentToolUses.findIndex(tu => tu.id === bc.tool_use_id);
      if (matchIdx !== -1 && agentToolUses[matchIdx].resultPreview === "") {
        const rawContent = bc.content;
        let preview = "";
        if (typeof rawContent === "string") {
          preview = rawContent.slice(0, 300);
        } else if (Array.isArray(rawContent)) {
          preview = rawContent.map((c: { text?: string }) => c?.text ?? "").join("").slice(0, 300);
        }
        agentToolUses[matchIdx].resultPreview = preview;
      }
    }
  }

  // Read all sub agent files
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir).filter(f => f.endsWith(".jsonl"));
  } catch { return []; }

  const summaries: SubAgentSummary[] = [];
  let agentIdx = 0;

  for (const entry of entries.sort()) {
    const agentFileId = entry.replace(".jsonl", "").replace("agent-", "");
    const agentPath  = join(subagentsDir, entry);
    const metaPath   = join(subagentsDir, `agent-${agentFileId}.meta.json`);

    let agentType = "unknown";
    let description = "";
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { agentType?: string; description?: string };
        agentType   = meta.agentType   ?? "unknown";
        description = meta.description ?? "";
      } catch { /* ignore */ }
    }

    // Parse the sub agent JSONL
    let agentLines: string[];
    try {
      agentLines = readFileSync(agentPath, "utf-8").trim().split("\n").filter(Boolean);
    } catch { continue; }

    let llmCallCount = 0;
    let toolCallCount = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalFreshIn = 0;
    let totalOutputTokens = 0;
    let startedAt = "";
    let endedAt = "";

    // Parse all events first, then dedup by msg.id keeping the LAST occurrence
    // (same logic as main parser — thinking event has usage=0, real tool_use event has the data)
    const agentEvents: JEvent[] = [];
    for (const line of agentLines) {
      try { agentEvents.push(JSON.parse(line)); } catch { /* skip */ }
    }

    // Sub agent JSONL: all events are isSidechain=true (it's a sidechain branch
    // of the main session). So we do NOT filter by isSidechain here.
    const lastIdxByMsgId = new Map<string, number>();
    agentEvents.forEach((ev, i) => {
      if (ev.type !== "assistant") return;
      const mid = (ev as JAssistantEvent).message?.id;
      if (mid) lastIdxByMsgId.set(mid, i);
    });

    agentEvents.forEach((rec, i) => {
      const ts = tsOf(rec);
      if (ts && !startedAt) startedAt = ts;
      if (ts) endedAt = ts;

      if (rec.type !== "assistant") return;
      const aev = rec as JAssistantEvent;
      const msgId = aev.message?.id;
      const isCanonical = msgId ? lastIdxByMsgId.get(msgId) === i : true;
      if (!isCanonical) return;

      const usage = aev.message?.usage ?? {};
      const fi  = usage.input_tokens ?? 0;
      const cr  = usage.cache_read_input_tokens ?? 0;
      const cw  = usage.cache_creation_input_tokens ?? 0;
      const out = usage.output_tokens ?? 0;
      if (fi + cr + cw + out > 0) {
        llmCallCount++;
        totalCacheRead  += cr;
        totalCacheWrite += cw;
        totalFreshIn    += fi;
        totalOutputTokens += out;
      }
      for (const b of aev.message?.content ?? []) {
        if (b.type === "tool_use") toolCallCount++;
      }
    });

    const durationMs = startedAt && endedAt
      ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
      : 0;

    // Try to match to an Agent tool_use in the parent
    const tu = agentToolUses[agentIdx] ?? { id: "", name: "Agent", resultPreview: "" };
    agentIdx++;

    summaries.push({
      agentFileId,
      agentType,
      description,
      toolUseId: tu.id,
      toolUseName: tu.name,
      llmCallCount,
      toolCallCount,
      totalCacheRead,
      totalCacheWrite,
      totalFreshIn,
      totalOutputTokens,
      startedAt,
      endedAt,
      durationMs,
      resultPreview: tu.resultPreview,
    });
  }

  return summaries;
}

// ─── Core parser ─────────────────────────────────────────────────────────────

export function parseSessionDrilldown(
  sourceFile: string,
  sessionId: string,
  sessionRow: Record<string, unknown>,
  db: Database,
): SessionDrilldown {
  // ── 1. Title (same multi-fallback as SessionListV2) ──────────────────────
  const title = (sessionRow.custom_title as string | null)
    ?? (sessionRow.ai_title as string | null)
    ?? null;

  // ── 2. Parse JSONL ───────────────────────────────────────────────────────
  if (!existsSync(sourceFile)) {
    throw Object.assign(new Error("source file not found"), { status: 404 });
  }

  const lines = readFileSync(sourceFile, "utf-8").trim().split("\n").filter(Boolean);
  const events: JEvent[] = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }

  // ── 3. Deduplicate assistant events (same msg.id → keep the LAST one) ───
  // Claude Code writes two events per assistant message when extended thinking
  // is enabled: one with content=['thinking'] and one with content=['tool_use'/'text'].
  // Both share the same msg.id. We keep the last occurrence which has the
  // actionable content (tool calls / text) and the definitive stop_reason.
  const lastAssistantByMsgId = new Map<string, number>();
  events.forEach((ev, idx) => {
    if (ev.type !== "assistant" || (ev as JAssistantEvent).isSidechain) return;
    const msgId = (ev as JAssistantEvent).message?.id;
    if (msgId) lastAssistantByMsgId.set(msgId, idx);
  });

  // ── 4. Identify all system errors ────────────────────────────────────────
  let systemErrorCount = 0;
  for (const ev of events) {
    if (ev.type === "system") {
      const sub = (ev as JSystemEvent).subtype ?? "";
      // api_error = Claude Code's own retry signal (network/rate-limit); treat as error
      if (sub === "api_error") systemErrorCount++;
    }
  }

  // ── 5. Build turns ───────────────────────────────────────────────────────
  // Algorithm:
  //   - Scan forward; when we find a human-input user event, start a new turn
  //   - Accumulate all subsequent (deduplicated) assistant events until one has
  //     stop_reason !== "tool_use" (i.e. end_turn / max_tokens / stop_sequence)
  //   - If another human-input event appears BEFORE the turn ends (user typed while
  //     LLM was running), we do NOT split the turn; per spec, turns end at LLM stop.

  const turns: UserTurn[] = [];
  let globalCallIndex = 0; // 1-based across the whole session

  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.type !== "user" || !isHumanInput(ev as JUserEvent)) { i++; continue; }

    const userEv = ev as JUserEvent;
    const userText = extractUserText(userEv.message?.content);
    const turnStartTs = tsOf(ev);

    // Collect deduplicated assistant events until end_turn
    const rawCalls: Array<{ ev: JAssistantEvent; lineIdx: number }> = [];
    let j = i + 1;
    while (j < events.length) {
      const jev = events[j];
      if (jev.type === "assistant" && !(jev as JAssistantEvent).isSidechain) {
        const aev = jev as JAssistantEvent;
        const msgId = aev.message?.id;
        const isCanonical = msgId
          ? lastAssistantByMsgId.get(msgId) === j
          : true; // no id → always include
        if (isCanonical) {
          rawCalls.push({ ev: aev, lineIdx: j });
          const stopReason = aev.message?.stop_reason ?? "";
          if (stopReason && stopReason !== "tool_use") break; // turn ends
        }
      }
      j++;
    }

    const turnEndTs = rawCalls.length
      ? tsOf(rawCalls[rawCalls.length - 1].ev)
      : turnStartTs;

    // Build LlmCall objects
    const calls: LlmCall[] = rawCalls.map(({ ev: aev }, callIdx) => {
      globalCallIndex++;
      const usage = aev.message?.usage ?? {};
      const freshIn   = usage.input_tokens ?? 0;
      const freshOut  = usage.output_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      const stopReason = aev.message?.stop_reason ?? null;
      const rawModel = aev.message?.model ?? "";
      const model = rawModel === "<synthetic>" ? "" : normaliseModelName(rawModel);

      // isCompaction: heuristic — assistant content is only a compaction summary
      const content = aev.message?.content ?? [];
      const isCompaction = content.some(b =>
        b.type === "text" && (b.text ?? "").includes("<compaction_summary>")
      );

      // Detect Agent (sub agent) tool_use in this call's content
      // The tool name is "Agent" in Claude Code; record the tool_use_id for later join.
      const agentToolUseId = (() => {
        for (const b of content) {
          const bc = b as { type?: string; name?: string; id?: string };
          if (bc.type === "tool_use" && bc.name === "Agent") return bc.id ?? null;
        }
        return null;
      })();

      // Context size proxy: sum of all token sources at this call
      const contextSize = freshIn + cacheRead + cacheWrite;
      const contextWindowSize = getContextWindowSize(model);
      // Delta vs previous call in turn
      const prevCall = callIdx > 0 ? rawCalls[callIdx - 1].ev : null;
      const prevUsage = prevCall?.message?.usage ?? {};
      const prevContext = (prevUsage.input_tokens ?? 0)
        + (prevUsage.cache_read_input_tokens ?? 0)
        + (prevUsage.cache_creation_input_tokens ?? 0);
      const significantDelta = contextSize - prevContext;

      return {
        id: globalCallIndex,
        indexInTurn: callIdx + 1,
        contextSize,
        contextWindowSize,
        outputTokens: freshOut,
        cacheRead,
        cacheWrite,
        timestamp: tsOf(aev),
        model,
        stopReason,
        isCompaction,
        isUnknownHeavy: false,
        isSignificant: Math.abs(significantDelta) > 2000,
        significantDelta,
        proxy: null,
        subAgent: null, // filled below after parsing sub agents
        incomingDiff: [],
        _agentToolUseId: agentToolUseId, // temp field for join
      } as LlmCall & { _agentToolUseId: string | null };
    });

    // Turn-level aggregates
    const llmCallCount = calls.length;
    // Tool calls = assistant events with tool_use content blocks
    let toolCallCount = 0;
    for (const { ev: aev } of rawCalls) {
      for (const b of aev.message?.content ?? []) {
        if (b.type === "tool_use") toolCallCount++;
      }
    }
    const totalCacheRead = calls.reduce((s, c) => s + c.cacheRead, 0);
    const totalCacheWrite = calls.reduce((s, c) => s + c.cacheWrite, 0);
    const peakContext = calls.length ? Math.max(...calls.map(c => c.contextSize)) : 0;
    const firstContext = calls.length ? calls[0].contextSize : 0;
    const lastContext = calls.length ? calls[calls.length - 1].contextSize : 0;
    const netContextDelta = lastContext - firstContext;

    // finalOutput: text from the last end_turn assistant message
    // The canonical end_turn event is the last entry in rawCalls (stop_reason != tool_use).
    const finalCall = rawCalls.length > 0 ? rawCalls[rawCalls.length - 1].ev : null;
    let finalOutput: string | null = null;
    if (finalCall && finalCall.message?.stop_reason !== "tool_use") {
      const textBlocks = (finalCall.message?.content ?? [])
        .filter(b => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0);
      if (textBlocks.length > 0) {
        finalOutput = textBlocks.map(b => b.text ?? "").join("\n").trim();
      }
    }

    // durationMs: wall-clock from first user event to last assistant event
    const durationMs = (turnStartTs && turnEndTs)
      ? Math.max(0, new Date(turnEndTs).getTime() - new Date(turnStartTs).getTime())
      : 0;

    turns.push({
      id: turns.length + 1,
      userInput: userText,
      finalOutput,
      startedAt: turnStartTs,
      endedAt: turnEndTs,
      durationMs,
      llmCallCount,
      toolCallCount,
      netContextDelta,
      peakContext,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      unknownDelta: 0,
      hasCompaction: calls.some(c => c.isCompaction),
      hasUnknownSpike: false,
      calls,
    });

    i = j + 1;
  }

  // ── 6. Parse sub agents and join to LlmCalls ─────────────────────────────
  const subAgents = parseSubAgents(sourceFile, events);
  // Build lookup: toolUseId → SubAgentSummary
  const subAgentByToolUseId = new Map<string, typeof subAgents[number]>();
  for (const sa of subAgents) {
    if (sa.toolUseId) subAgentByToolUseId.set(sa.toolUseId, sa);
  }
  // Attach sub agents to matching LlmCalls, then strip temp field
  for (const turn of turns) {
    for (const call of turn.calls) {
      const c = call as LlmCall & { _agentToolUseId?: string | null };
      if (c._agentToolUseId) {
        c.subAgent = subAgentByToolUseId.get(c._agentToolUseId) ?? null;
      }
      delete c._agentToolUseId;
    }
  }

  // ── 7. Session-level aggregates ──────────────────────────────────────────
  const allCalls = turns.flatMap(t => t.calls);
  const totalLlmCalls = allCalls.length;
  const totalToolCalls = turns.reduce((s, t) => s + t.toolCallCount, 0);
  const peakContext = allCalls.length ? Math.max(...allCalls.map(c => c.contextSize)) : 0;
  const totalCacheRead = allCalls.reduce((s, c) => s + c.cacheRead, 0);
  const totalCacheWrite = allCalls.reduce((s, c) => s + c.cacheWrite, 0);
  const totalFreshIn = allCalls.reduce((s, c) => s + c.contextSize - c.cacheRead - c.cacheWrite, 0);
  const totalFreshOut = allCalls.reduce((s, c) => s + c.outputTokens, 0);

  // Per-model breakdown
  const modelBreakdown: Record<string, ModelStats> = {};
  for (const call of allCalls) {
    const m = call.model || "unknown";
    if (!modelBreakdown[m]) {
      modelBreakdown[m] = { calls: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, freshIn: 0 };
    }
    const s = modelBreakdown[m];
    s.calls++;
    s.outputTokens += call.outputTokens;
    s.cacheRead += call.cacheRead;
    s.cacheWrite += call.cacheWrite;
    s.freshIn += call.contextSize - call.cacheRead - call.cacheWrite;
  }

  // Session context window = the ceiling of the most-used model
  // (if multiple models, pick the one with most calls)
  const dominantModel = Object.entries(modelBreakdown)
    .sort((a, b) => b[1].calls - a[1].calls)[0]?.[0] ?? "";
  const contextWindowSize = getContextWindowSize(dominantModel);

  // ── 7. Proxy data availability ───────────────────────────────────────────
  const proxyRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM proxy_requests WHERE session_id = ?",
  ).get(sessionId) as { cnt: number };
  const hasProxyData = proxyRow.cnt > 0;

  return {
    sessionId,
    tool: (sessionRow.tool as string) ?? "claude",
    project: (sessionRow.project as string) ?? "",
    cwd: (sessionRow.cwd as string) ?? "",
    title,
    firstEventAt: (sessionRow.first_event_at as string) ?? "",
    lastEventAt: (sessionRow.last_event_at as string) ?? "",

    totalLlmCalls,
    totalToolCalls,
    peakContext,
    totalCacheRead,
    totalCacheWrite,
    totalFreshIn,
    totalFreshOut,
    systemErrorCount,
    modelBreakdown,
    contextWindowSize,

    hasProxyData,
    hasJsonlSource: true,

    subAgentCount: subAgents.length,
    subAgents,

    turns,
  };
}
