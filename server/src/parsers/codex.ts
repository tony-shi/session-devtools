import { createHash } from "crypto";
import type { ParseResult, Session, Turn } from "./index";

function makeTurnId(sessionId: string, index: number, role: string): string {
  return createHash("sha1")
    .update(`${sessionId}:${index}:${role}`)
    .digest("hex")
    .slice(0, 16);
}

export async function parseCodexSession(filePath: string): Promise<ParseResult> {
  const text = await Bun.file(filePath).text();
  const lines = text.trim().split("\n").filter(Boolean);

  const sessionId = filePath.split("/").pop()!.replace(/\.jsonl$/, "");
  let cwd = "";
  let model = "";
  let startedAt = "";
  let endedAt = "";
  let toolCallCount = 0;
  const toolCallNames: Record<string, number> = {};
  const turns: Turn[] = [];
  let turnIndex = 0;

  // State machine for buffering turns
  let pendingUserContent = "";
  let pendingUserTs = "";
  let pendingAssistantContent = "";
  let pendingAssistantTs = "";
  let pendingToolCalls = 0;
  let pendingToolNames: string[] = [];

  function flushAssistant() {
    if (!pendingAssistantContent && pendingToolCalls === 0) return;
    turns.push({
      id: makeTurnId(sessionId, turnIndex, "assistant"),
      session_id: sessionId,
      role: "assistant",
      turn_kind: pendingToolCalls > 0 ? "assistant_tool" : "assistant",
      content: pendingAssistantContent,
      timestamp: pendingAssistantTs,
      turn_index: turnIndex++,
      tool_calls: pendingToolCalls,
      tool_names: pendingToolNames,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
    pendingAssistantContent = "";
    pendingAssistantTs = "";
    pendingToolCalls = 0;
    pendingToolNames = [];
  }

  function flushUser() {
    if (!pendingUserContent) return;
    turns.push({
      id: makeTurnId(sessionId, turnIndex, "user"),
      session_id: sessionId,
      role: "user",
      turn_kind: "human_input",
      content: pendingUserContent,
      timestamp: pendingUserTs,
      turn_index: turnIndex++,
      tool_calls: 0,
      tool_names: [],
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
    pendingUserContent = "";
    pendingUserTs = "";
  }

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    const ts: string = rec.timestamp ?? rec.ts ?? "";
    if (ts && !startedAt) startedAt = ts;
    if (ts) endedAt = ts;

    const evType: string = rec.type ?? rec.event ?? "";

    if (evType === "session_meta" || evType === "meta") {
      cwd = rec.cwd ?? rec.workdir ?? cwd;
      model = rec.model ?? model;
    } else if (evType === "turn_context" || evType === "user_message") {
      flushAssistant();
      flushUser();
      pendingUserContent = rec.content ?? rec.text ?? "";
      pendingUserTs = ts;
    } else if (evType === "response_item" || evType === "assistant_message") {
      pendingAssistantTs = pendingAssistantTs || ts;
      const content = rec.content ?? rec.text ?? "";
      if (content) pendingAssistantContent += (pendingAssistantContent ? "\n" : "") + content;
    } else if (evType === "event_msg") {
      // Tool call events
      const toolName = rec.tool ?? rec.tool_name ?? "";
      if (toolName) {
        pendingToolCalls++;
        pendingToolNames.push(toolName);
        toolCallNames[toolName] = (toolCallNames[toolName] ?? 0) + 1;
        toolCallCount++;
      }
      pendingAssistantTs = pendingAssistantTs || ts;
    }
  }

  flushUser();
  flushAssistant();

  const humanTurnCount = turns.filter((t) => t.turn_kind === "human_input").length;

  // Derive project from file path
  const parts = filePath.split("/");
  const project = parts[parts.length - 2] ?? "unknown";

  const session: Session = {
    id: sessionId,
    tool: "codex",
    project,
    cwd,
    started_at: startedAt,
    ended_at: endedAt,
    turn_count: turns.length,
    human_turn_count: humanTurnCount,
    model,
    source_file: filePath,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    tool_call_count: toolCallCount,
    tool_call_names: toolCallNames,
  };

  return { session, turns };
}
