import { createHash } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import type { ParseResult, Session, Turn } from "./index";

function makeTurnId(sessionId: string, index: number, role: string): string {
  return createHash("sha1")
    .update(`${sessionId}:${index}:${role}`)
    .digest("hex")
    .slice(0, 16);
}

async function readProjectRoot(projectHash: string): Promise<string> {
  const historyDir = join(process.env.HOME ?? "~", ".gemini", "history", projectHash);
  const rootFile = join(historyDir, ".project_root");
  if (existsSync(rootFile)) {
    try {
      return (await Bun.file(rootFile).text()).trim();
    } catch {
      return "";
    }
  }
  return "";
}

export async function parseGeminiSession(filePath: string): Promise<ParseResult> {
  const text = await Bun.file(filePath).text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse Gemini session JSON: ${filePath}`);
  }

  // Derive session ID from filename
  const sessionId = filePath.split("/").pop()!.replace(/\.json$/, "");

  // Project hash is in the parent directory
  const parts = filePath.split("/");
  const projectHash = parts[parts.length - 2] ?? "";
  const projectRoot = await readProjectRoot(projectHash);
  const project = projectRoot
    ? projectRoot.replace(/^\/Users\/[^/]+\//, "")
    : projectHash;
  const cwd = projectRoot;

  const model = data.model ?? "";
  const messages: any[] = data.messages ?? data.conversation ?? [];

  let startedAt = "";
  let endedAt = "";
  let toolCallCount = 0;
  const toolCallNames: Record<string, number> = {};
  const turns: Turn[] = [];
  let turnIndex = 0;

  for (const msg of messages) {
    const role: string = msg.role ?? "";
    const ts: string = msg.timestamp ?? msg.createTime ?? "";
    if (ts && !startedAt) startedAt = ts;
    if (ts) endedAt = ts;

    // Extract text content
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.parts)) {
      content = msg.parts
        .filter((p: any) => p?.text)
        .map((p: any) => p.text)
        .join("\n");
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((p: any) => p?.text)
        .map((p: any) => p.text)
        .join("\n");
    }

    // Count tool calls
    const toolCalls: any[] = msg.toolCalls ?? msg.tool_calls ?? [];
    const toolNames = toolCalls.map((tc: any) => tc.name ?? tc.function?.name ?? "");
    for (const name of toolNames) {
      if (name) {
        toolCallNames[name] = (toolCallNames[name] ?? 0) + 1;
        toolCallCount++;
      }
    }

    if (role === "user") {
      turns.push({
        id: makeTurnId(sessionId, turnIndex, "user"),
        session_id: sessionId,
        role: "user",
        turn_kind: "human_input",
        content,
        timestamp: ts,
        turn_index: turnIndex++,
        tool_calls: 0,
        tool_names: [],
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
      });
    } else if (role === "gemini" || role === "model" || role === "assistant") {
      turns.push({
        id: makeTurnId(sessionId, turnIndex, "assistant"),
        session_id: sessionId,
        role: "assistant",
        turn_kind: toolCalls.length > 0 ? "assistant_tool" : "assistant",
        content,
        timestamp: ts,
        turn_index: turnIndex++,
        tool_calls: toolCalls.length,
        tool_names: toolNames.filter(Boolean),
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
      });
    }
  }

  const humanTurnCount = turns.filter((t) => t.turn_kind === "human_input").length;

  const session: Session = {
    id: sessionId,
    tool: "gemini",
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
