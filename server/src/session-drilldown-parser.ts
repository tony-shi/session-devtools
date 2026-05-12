import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import type { Database } from "better-sqlite3";
import type { SessionDrilldown, UserTurn, LlmCall, ProxyCallData, ModelStats, SubAgentSummary, InterTurnBlock, IntervalEvent } from "./session-drilldown-types.ts";
import { normaliseModelName } from "./model-info.ts";

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
  const text = typeof content === "string" ? content : extractUserText(content);
  const trimmed = text.trimStart();
  return trimmed.startsWith("<command-name>")
    || trimmed.startsWith("<local-command-caveat>")
    || trimmed.startsWith("<local-command-stdout>")
    || trimmed.startsWith("<local-command-stderr>")
    || trimmed.startsWith("<bash-input>")
    || trimmed.startsWith("<bash-stdout>")
    || trimmed.startsWith("<bash-stderr>");
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

function makeIntervalEvent(iev: JEvent, lineIdx: number): IntervalEvent {
  const ts  = tsOf(iev);
  const raw = JSON.stringify(iev);
  let kind: IntervalEvent["kind"] = "unknown";
  let preview = "";
  let size = raw.length;

  if (iev.type === "user") {
    const uev = iev as JUserEvent;
    const content = uev.message?.content;
    if (isToolResultOnly(content)) {
      kind = "user:tool_result";
      const blocks = content as Array<{ type?: string; content?: unknown }>;
      for (const b of blocks) {
        if (b.type === "tool_result") {
          const rc = b.content;
          const text = typeof rc === "string" ? rc
            : Array.isArray(rc) ? rc.map((c: { text?: string }) => c?.text ?? "").join("") : "";
          preview = text.slice(0, 300);
          size = text.length;
          break;
        }
      }
    } else if (isCommandContent(content)) {
      kind = "user:command";
      preview = (typeof content === "string" ? content : extractUserText(content)).slice(0, 300);
    } else {
      kind = "user:human";
      preview = (typeof content === "string" ? content : extractUserText(content)).slice(0, 300);
    }
  } else if (iev.type === "system") {
    const sub = (iev as JSystemEvent).subtype ?? "";
    if (sub === "api_error") {
      kind = "system:api_error";
      preview = JSON.stringify((iev as { error?: unknown }).error ?? {}).slice(0, 300);
    } else if (sub === "local_command") {
      kind = "system:local_command";
      preview = ((iev as { content?: string }).content ?? "").slice(0, 300);
    } else if (sub === "turn_duration") {
      kind = "system:turn_duration";
      preview = `durationMs: ${(iev as { durationMs?: number }).durationMs ?? 0}`;
    } else if (sub === "stop_hook_summary") {
      kind = "system:stop_hook_summary";
      preview = JSON.stringify((iev as { hookInfos?: unknown }).hookInfos ?? {}).slice(0, 300);
    } else if (sub === "away_summary") {
      kind = "system:away_summary";
      preview = ((iev as { content?: string }).content ?? "").slice(0, 300);
    } else {
      kind = "unknown";
      preview = raw.slice(0, 300);
    }
  } else if (iev.type === "attachment") {
    const att = (iev as { attachment?: { type?: string; content?: unknown; itemCount?: number } }).attachment ?? {};
    const attType = att.type ?? "";
    if (attType === "skill_listing") { kind = "attachment:skill_listing"; preview = String(att.content ?? "").slice(0, 300); }
    else if (attType === "task_reminder") { kind = "attachment:task_reminder"; preview = `itemCount: ${att.itemCount ?? 0}`; }
    else if (attType === "file") { kind = "attachment:file"; preview = String(att.content ?? "").slice(0, 300); }
    else { kind = "unknown"; preview = raw.slice(0, 300); }
  } else if (iev.type === "file-history-snapshot") {
    kind = "file-history-snapshot";
    const snap = (iev as { snapshot?: { timestamp?: string } }).snapshot ?? {};
    preview = `snapshot timestamp: ${snap.timestamp ?? ""}`;
  } else if (iev.type === "last-prompt") {
    kind = "last-prompt";
    preview = ((iev as { lastPrompt?: string }).lastPrompt ?? "").slice(0, 300);
  } else {
    kind = "unknown";
    preview = raw.slice(0, 300);
  }

  return { kind, lineIdx, timestamp: ts, contentPreview: preview, contentSize: size, rawJson: raw };
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
    let peakContext = 0;
    let lastContext = 0;
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
        const ctx = fi + cr + cw;
        if (ctx > peakContext) peakContext = ctx;
        lastContext = ctx;
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
      peakContext,
      lastContext,
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
  // Claude Code streams responses by writing multiple events per message:
  //   Frame 1 (phantom, usage=0): text block — the AI's spoken text
  //   Frame 2 (phantom, usage=0): tool_use block — tool dispatch decision
  //   Frame N (real, usage>0):    final tool_use + full usage — text block ABSENT
  //
  // We keep the LAST frame (canonical, has usage) but must also preserve the
  // text from earlier frames since it disappears in the real frame.
  const lastAssistantByMsgId = new Map<string, number>();
  // Collect the first non-empty text seen for each message.id across all frames.
  const textByMsgId = new Map<string, string>();
  events.forEach((ev, idx) => {
    if (ev.type !== "assistant" || (ev as JAssistantEvent).isSidechain) return;
    const aev = ev as JAssistantEvent;
    const msgId = aev.message?.id;
    if (msgId) {
      lastAssistantByMsgId.set(msgId, idx);
      // Collect text from any frame (phantoms carry the text that the real frame drops)
      if (!textByMsgId.has(msgId)) {
        for (const b of aev.message?.content ?? []) {
          const bc = b as { type?: string; text?: string };
          if (bc.type === "text" && bc.text && bc.text.trim()) {
            textByMsgId.set(msgId, bc.text);
            break;
          }
        }
      }
    }
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

    // Collect deduplicated assistant events until end_turn.
    // Also capture any human-input user events that arrive mid-turn
    // (user typed while LLM was executing tool calls).
    const rawCalls: Array<{ ev: JAssistantEvent; lineIdx: number }> = [];
    const midTurnInjections: Array<{ text: string; timestamp: string; afterCallIndex: number }> = [];
    let turnErrorCount = 0;
    let j = i + 1;
    while (j < events.length) {
      const jev = events[j];
      if (jev.type === "user" && isHumanInput(jev as JUserEvent)) {
        midTurnInjections.push({
          text: extractUserText((jev as JUserEvent).message?.content),
          timestamp: tsOf(jev),
          afterCallIndex: rawCalls.length,
        });
      } else if (jev.type === "system") {
        if (((jev as JSystemEvent).subtype ?? "") === "api_error") turnErrorCount++;
      } else if (jev.type === "assistant" && !(jev as JAssistantEvent).isSidechain) {
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

      // Collect ALL Agent tool_use ids in this call (parallel spawn supported).
      const agentToolUseIds: string[] = [];
      for (const b of content) {
        const bc = b as { type?: string; name?: string; id?: string };
        if (bc.type === "tool_use" && bc.name === "Agent" && bc.id) {
          agentToolUseIds.push(bc.id);
        }
      }

      // Collect all tool_use names dispatched in this call
      const toolNames: string[] = [];
      for (const b of content) {
        const bc = b as { type?: string; name?: string };
        if (bc.type === "tool_use" && bc.name) toolNames.push(bc.name);
      }

      // Extract assistant text: prefer the cross-frame text collected from phantom
      // streaming frames (where the AI's spoken text lives), since the real final
      // frame drops the text block and only keeps tool_use + usage.
      const msgId = aev.message?.id ?? "";
      const assistantText = (() => {
        // First try textByMsgId (from phantom frames — most reliable)
        const fromPhantom = msgId ? (textByMsgId.get(msgId) ?? "") : "";
        if (fromPhantom) return fromPhantom.slice(0, 500) + (fromPhantom.length > 500 ? "…" : "");
        // Fallback: text in the real frame itself (end_turn calls often have text here)
        const parts: string[] = [];
        for (const b of content) {
          const bc = b as { type?: string; text?: string };
          if (bc.type === "text" && bc.text) parts.push(bc.text);
        }
        const joined = parts.join("\n").trim();
        return joined.slice(0, 500) + (joined.length > 500 ? "…" : "");
      })();

      // Build ToolCallSlot list: pair tool_use blocks with tool_result from next user event
      // Scan forward in events from lineIdx+1 to find the user event(s) with tool_results
      const toolUseMap = new Map<string, {
        name: string;
        inputPreview: string;
        inputSize: number;
      }>();
      for (const b of content) {
        const bc = b as { type?: string; name?: string; id?: string; input?: unknown };
        if (bc.type === "tool_use" && bc.id) {
          const inputStr = bc.input != null ? JSON.stringify(bc.input) : "";
          toolUseMap.set(bc.id, {
            name: bc.name ?? "unknown",
            inputPreview: inputStr.slice(0, 300),
            inputSize: inputStr.length,
          });
        }
      }

      // Scan subsequent events (up to next assistant event) for tool_results
      const toolCallSlots: import("./session-drilldown-types.ts").ToolCallSlot[] = [];
      if (toolUseMap.size > 0) {
        const startIdx = rawCalls[callIdx].lineIdx + 1;
        const endIdx = callIdx + 1 < rawCalls.length ? rawCalls[callIdx + 1].lineIdx : events.length;
        for (let ei = startIdx; ei < endIdx; ei++) {
          const uev = events[ei];
          if (uev.type !== "user") continue;
          const ucontent = (uev as JUserEvent).message?.content;
          if (!Array.isArray(ucontent)) continue;
          for (const rb of ucontent) {
            const rbc = rb as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
            if (rbc.type !== "tool_result" || !rbc.tool_use_id) continue;
            const tu = toolUseMap.get(rbc.tool_use_id);
            if (!tu) continue;
            const rawOut = rbc.content;
            let outStr = "";
            if (typeof rawOut === "string") outStr = rawOut;
            else if (Array.isArray(rawOut)) outStr = rawOut.map((c: { text?: string }) => c?.text ?? "").join("");
            else if (rawOut != null) outStr = JSON.stringify(rawOut);
            toolCallSlots.push({
              toolUseId: rbc.tool_use_id,
              name: tu.name,
              inputPreview: tu.inputPreview,
              inputSize: tu.inputSize,
              outputPreview: outStr.slice(0, 300),
              outputSize: outStr.length,
              isError: rbc.is_error === true,
            });
            toolUseMap.delete(rbc.tool_use_id); // matched
          }
        }
        // Any unmatched tool_use (no tool_result found yet — still pending)
        for (const [id, tu] of toolUseMap) {
          toolCallSlots.push({
            toolUseId: id,
            name: tu.name,
            inputPreview: tu.inputPreview,
            inputSize: tu.inputSize,
            outputPreview: "",
            outputSize: 0,
            isError: false,
          });
        }
      }

      // ── Collect all interval events between this call and the next ───────────
      // For non-final calls: scan up to (but not including) the next call's lineIdx.
      // For the FINAL call in the turn: scan up to the turn boundary (j), NOT
      // beyond — otherwise we'd leak events from the next turn.
      // Also skip phantom assistant events (usage=0, same msg.id as a real event).
      const intervalEvents: import("./session-drilldown-types.ts").IntervalEvent[] = [];
      {
        const isLastCall = callIdx === rawCalls.length - 1;
        const startEi = rawCalls[callIdx].lineIdx + 1;
        // For non-final calls: scan up to the next call's lineIdx.
        // For the final call: scan forward but stop at the first human input
        // event (start of next turn) or end of file.
        let endEi: number;
        if (!isLastCall) {
          endEi = rawCalls[callIdx + 1].lineIdx;
        } else {
          endEi = events.length;
          for (let ei2 = startEi; ei2 < events.length; ei2++) {
            if (events[ei2].type === "user" && isHumanInput(events[ei2] as JUserEvent)) {
              endEi = ei2; // stop before next turn's human input
              break;
            }
          }
        }
        for (let ei = startEi; ei < endEi; ei++) {
          const iev = events[ei];

          // Skip phantom assistant events (streaming frames with usage=0).
          // The real event has the same msg.id but non-zero usage and is the
          // canonical call already captured in rawCalls.
          if (iev.type === "assistant") {
            const aev = iev as JAssistantEvent;
            const msgId = aev.message?.id;
            // If this is NOT the canonical (last-seen) event for this id, skip it.
            if (msgId && lastAssistantByMsgId.get(msgId) !== ei) continue;
            // If canonical but zero usage, it's a phantom streaming frame — skip.
            const u = aev.message?.usage ?? {};
            const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
              + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
            if (total === 0) continue;
            // A real assistant event here means this is an end_turn for the same call —
            // it's already represented as the call card itself, skip.
            continue;
          }

          intervalEvents.push(makeIntervalEvent(iev, ei));
        }
      }

      // Context size proxy: sum of all token sources at this call
      const contextSize = freshIn + cacheRead + cacheWrite;
      // Delta vs previous call (across the whole session, not just within turn)
      const prevCall = callIdx > 0 ? rawCalls[callIdx - 1].ev : null;
      const prevUsage = prevCall?.message?.usage ?? {};
      const prevContext = (prevUsage.input_tokens ?? 0)
        + (prevUsage.cache_read_input_tokens ?? 0)
        + (prevUsage.cache_creation_input_tokens ?? 0);
      const significantDelta = contextSize - prevContext;
      // freshIn per-call = context growth since previous call.
      // API input_tokens only counts non-cached tokens; here we want the actual
      // new content injected (user turn + prev assistant output), regardless of
      // whether it was served from cache or written fresh.
      const callFreshIn = callIdx === 0 ? contextSize : Math.max(0, contextSize - prevContext);

      return {
        id: globalCallIndex,
        indexInTurn: callIdx + 1,
        contextSize,
        outputTokens: freshOut,
        cacheRead,
        cacheWrite,
        timestamp: tsOf(aev),
        model,
        stopReason,
        isCompaction,
        freshIn: callFreshIn,
        isUnknownHeavy: false,
        isSignificant: Math.abs(significantDelta) > 2000,
        significantDelta,
        proxy: null,
        subAgents: [], // filled below after parsing sub agents
        incomingDiff: [],
        toolNames,
        toolCalls: toolCallSlots,
        assistantText,
        intervalEvents,
        _agentToolUseIds: agentToolUseIds, // temp field for join
      } as LlmCall & { _agentToolUseIds: string[] };
    });

    // Turn-level aggregates
    const llmCallCount = calls.length;
    // Tool calls = assistant events with tool_use content blocks; collect names
    let toolCallCount = 0;
    const turnToolNames: string[] = [];
    for (const { ev: aev } of rawCalls) {
      for (const b of aev.message?.content ?? []) {
        const bc = b as { type?: string; name?: string };
        if (bc.type === "tool_use") {
          toolCallCount++;
          if (bc.name) turnToolNames.push(bc.name);
        }
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
      midTurnInjections,
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
      errorCount: turnErrorCount,
      calls,
      _toolNames: turnToolNames,
    } as UserTurn & { _toolNames: string[] });

    i = j + 1;
  }

  // ── 5b. Build inter-turn blocks ───────────────────────────────────────────
  // Scan for runs of command-only user events (and related system events) that
  // appear between two turns or after the last turn.
  // Strategy: for each gap between turn[k].endLineIdx and turn[k+1].startLineIdx
  // (and after the last turn), collect any events that are command content.
  // We track the end-of-turn line as the `j` value from each turn's inner loop.
  // Simpler: re-scan events, noting which line each turn started/ended at.

  // Record the JSONL line index of each turn's first human user event and last assistant
  // event, so we can find gaps between turns.
  interface TurnBoundary { turnId: number; startLine: number; endLine: number }
  const turnBoundaries: TurnBoundary[] = [];
  {
    let ti = 0;
    let k = 0;
    while (k < events.length) {
      if (events[k].type !== "user" || !isHumanInput(events[k] as JUserEvent)) { k++; continue; }
      const startLine = k;
      // Find end: scan forward until end_turn assistant (same logic as above)
      let endLine = k;
      let m = k + 1;
      while (m < events.length) {
        const mev = events[m];
        if (mev.type === "user" && isHumanInput(mev as JUserEvent)) {
          // mid-turn injection — keep scanning
        } else if (mev.type === "assistant" && !(mev as JAssistantEvent).isSidechain) {
          const aev = mev as JAssistantEvent;
          const msgId = aev.message?.id;
          const isCanonical = msgId ? lastAssistantByMsgId.get(msgId) === m : true;
          if (isCanonical) {
            const sr = aev.message?.stop_reason ?? "";
            if (sr && sr !== "tool_use") { endLine = m; break; }
          }
        }
        m++;
      }
      if (ti < turns.length) {
        turnBoundaries.push({ turnId: turns[ti].id, startLine, endLine });
        ti++;
      }
      k = m + 1;
    }
  }

  // Build inter-turn blocks: command events in gaps between turns (or after last turn)
  const interTurnBlocks: InterTurnBlock[] = [];
  {
    // Gaps to scan: [afterLine, beforeLine, prevTurnId, nextTurnId]
    type Gap = { afterLine: number; beforeLine: number; prevTurnId: number | null; nextTurnId: number | null };
    const gaps: Gap[] = [];

    if (turnBoundaries.length === 0) {
      // No turns at all — whole file is one gap
      gaps.push({ afterLine: -1, beforeLine: events.length, prevTurnId: null, nextTurnId: null });
    } else {
      // Before first turn
      gaps.push({ afterLine: -1, beforeLine: turnBoundaries[0].startLine, prevTurnId: null, nextTurnId: turnBoundaries[0].turnId });
      // Between turns
      for (let gi = 0; gi < turnBoundaries.length - 1; gi++) {
        gaps.push({
          afterLine: turnBoundaries[gi].endLine,
          beforeLine: turnBoundaries[gi + 1].startLine,
          prevTurnId: turnBoundaries[gi].turnId,
          nextTurnId: turnBoundaries[gi + 1].turnId,
        });
      }
      // After last turn
      gaps.push({
        afterLine: turnBoundaries[turnBoundaries.length - 1].endLine,
        beforeLine: events.length,
        prevTurnId: turnBoundaries[turnBoundaries.length - 1].turnId,
        nextTurnId: null,
      });
    }

    for (const gap of gaps) {
      const blockEvents: IntervalEvent[] = [];
      for (let gi = gap.afterLine + 1; gi < gap.beforeLine; gi++) {
        const gev = events[gi];
        // Include command user events and system:local_command events; skip noise
        const isCmd = gev.type === "user" && isCommandContent((gev as JUserEvent).message?.content);
        const isSysCmd = gev.type === "system" && ((gev as JSystemEvent).subtype ?? "") === "local_command";
        const isMeta = gev.type === "user" && (gev as JUserEvent).isMeta;
        if (isCmd || isSysCmd || isMeta) {
          blockEvents.push(makeIntervalEvent(gev, gi));
        }
      }
      if (blockEvents.length === 0) continue;

      // Build a label summarising what happened
      const cmdNames: string[] = [];
      for (const ev of blockEvents) {
        if (ev.kind === "user:command" || ev.kind === "system:local_command") {
          const raw = ev.contentPreview;
          // Extract <command-name>/exit</command-name>
          const cmdMatch = raw.match(/<command-name>([^<]+)<\/command-name>/);
          if (cmdMatch) { cmdNames.push(cmdMatch[1].trim()); continue; }
          // bash-input
          const bashMatch = raw.match(/<bash-input>([^<\n]{0,40})/);
          if (bashMatch) { cmdNames.push(`!${bashMatch[1].trim()}`); continue; }
          // local-command-stdout (e.g. Bye!)
          const stdoutMatch = raw.match(/<local-command-stdout>([^<\n]{0,40})/);
          if (stdoutMatch) { cmdNames.push(stdoutMatch[1].trim()); }
        }
      }
      const label = cmdNames.length > 0
        ? [...new Set(cmdNames)].slice(0, 3).join(", ")
        : `${blockEvents.length} event${blockEvents.length > 1 ? "s" : ""}`;

      interTurnBlocks.push({
        index: interTurnBlocks.length,
        prevTurnId: gap.prevTurnId,
        nextTurnId: gap.nextTurnId,
        timestamp: blockEvents[0].timestamp,
        label,
        enteredContext: gap.nextTurnId !== null,
        events: blockEvents,
      });
    }
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
      const c = call as LlmCall & { _agentToolUseIds?: string[] };
      for (const id of c._agentToolUseIds ?? []) {
        const sa = subAgentByToolUseId.get(id);
        if (sa) c.subAgents.push(sa);
      }
      delete c._agentToolUseIds;
    }
  }

  // ── 7. Session-level aggregates ──────────────────────────────────────────
  const allCalls = turns.flatMap(t => t.calls);
  const totalLlmCalls = allCalls.length;
  const totalToolCalls = turns.reduce((s, t) => s + t.toolCallCount, 0);
  const peakContext = allCalls.length ? Math.max(...allCalls.map(c => c.contextSize)) : 0;
  const totalCacheRead = allCalls.reduce((s, c) => s + c.cacheRead, 0);
  const totalCacheWrite = allCalls.reduce((s, c) => s + c.cacheWrite, 0);
  // totalFreshIn = sum of per-call context deltas (new content injected each call)
  const totalFreshIn = allCalls.reduce((s, c) => s + c.freshIn, 0);
  const totalFreshOut = allCalls.reduce((s, c) => s + c.outputTokens, 0);
  const lastContext = allCalls.length ? allCalls[allCalls.length - 1].contextSize : 0;
  const compactionCount = turns.filter(t => t.hasCompaction).length;

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
    s.freshIn += call.freshIn;
  }

  // Tool distribution: count by name, sort descending, top 8
  const toolNameCounts = new Map<string, number>();
  for (const turn of turns) {
    const t = turn as UserTurn & { _toolNames?: string[] };
    for (const name of t._toolNames ?? []) {
      toolNameCounts.set(name, (toolNameCounts.get(name) ?? 0) + 1);
    }
    delete t._toolNames;
  }
  const toolDistribution = [...toolNameCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  // ── 8. Proxy data availability ───────────────────────────────────────────
  // Stubbed DBs (e.g. sub-agent drilldown) return undefined here — treat as no proxy.
  const proxyRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM proxy_requests WHERE session_id = ?",
  ).get(sessionId) as { cnt: number } | undefined;
  const hasProxyData = (proxyRow?.cnt ?? 0) > 0;

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
    lastContext,
    systemErrorCount,
    compactionCount,
    modelBreakdown,
    toolDistribution,

    hasProxyData,
    hasJsonlSource: true,

    subAgentCount: subAgents.length,
    subAgents,

    turns,
    interTurnBlocks,
  };
}

// ─── Sub-agent drilldown ──────────────────────────────────────────────────────
// Parses a sub-agent JSONL as a standalone SessionDrilldown so the frontend
// can display it with the same components as a regular session.

export function parseSubAgentDrilldown(
  parentSourceFile: string,
  agentFileId: string,
): SessionDrilldown {
  const sessionBase = basename(parentSourceFile, ".jsonl");
  const subagentsDir = join(dirname(parentSourceFile), sessionBase, "subagents");
  const agentPath = join(subagentsDir, `agent-${agentFileId}.jsonl`);
  const metaPath  = join(subagentsDir, `agent-${agentFileId}.meta.json`);

  if (!existsSync(agentPath)) {
    throw Object.assign(new Error(`sub-agent file not found: agent-${agentFileId}.jsonl`), { status: 404 });
  }

  let agentType = "unknown";
  let description = "";
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { agentType?: string; description?: string };
      agentType   = meta.agentType   ?? "unknown";
      description = meta.description ?? "";
    } catch { /* ignore */ }
  }

  // Re-use the core parser with a synthetic sessionRow.
  // The sub-agent JSONL is in the same format as the parent session JSONL.
  const fakeRow: Record<string, unknown> = {
    tool:             "claude",
    project:          description || agentType,
    cwd:              "",
    custom_title:     description || null,
    ai_title:         agentType !== "unknown" ? agentType : null,
    first_event_at:   "",
    last_event_at:    "",
    system_error_count: 0,
  };

  // parseSessionDrilldown expects a DB for proxy lookups; sub-agents have none.
  // We pass a minimal stub — proxy will be empty (null for every call).
  const stubDb = {
    prepare: () => ({ all: () => [], get: () => undefined }),
  } as unknown as import("better-sqlite3").Database;

  return parseSessionDrilldown(agentPath, `subagent:${agentFileId}`, fakeRow, stubDb);
}
