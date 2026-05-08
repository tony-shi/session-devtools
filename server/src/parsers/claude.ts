import { createHash } from "crypto";
import { readFile } from "fs/promises";
import type { ParseResult, Session, Turn } from "./index";

function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type !== "thinking" && b?.type !== "redacted_thinking")
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b?.type === "text") return b.text ?? "";
      if (b?.type === "tool_result") {
        const c = b.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) return c.map((x: any) => x?.text ?? "").join("\n");
      }
      return "";
    })
    .join("\n")
    .trim();
}

function makeTurnId(sessionId: string, index: number, role: string): string {
  return createHash("sha1")
    .update(`${sessionId}:${index}:${role}`)
    .digest("hex")
    .slice(0, 16);
}

export async function parseClaudeSession(filePath: string): Promise<ParseResult> {
  const text = await readFile(filePath, "utf-8");
  const lines = text.trim().split("\n").filter(Boolean);

  // Derive session ID from filename (stem)
  const sessionId = filePath.split("/").pop()!.replace(/\.jsonl$/, "");

  // Derive project from parent directory name
  const parts = filePath.split("/");
  const projectHash = parts[parts.length - 2] ?? "unknown";
  // Try to find a human-readable project name from the hash directory
  // Claude stores project dirs as URL-encoded paths like "-Users-foo-bar"
  const project = projectHash.replace(/^-/, "").replace(/-/g, "/").replace(/^Users\/[^/]+\//, "");

  let cwd = "";
  let model = "";
  let startedAt = "";
  let endedAt = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let toolCallCount = 0;
  const toolCallNames: Record<string, number> = {};
  const turns: Turn[] = [];
  let turnIndex = 0;
  // custom-title 优先于 ai-title（参考 sourcemap restored-src/src/utils/sessionStorage.ts）
  let aiTitle: string | null = null;
  let customTitle: string | null = null;

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip meta records
    if (rec.isMeta) continue;
    // Skip sidechain records
    if (rec.isSidechain) continue;

    // 解析 AI 生成标题（参考 sourcemap restored-src/src/types/logs.ts: AiTitleMessage）
    if (rec.type === "ai-title" && typeof rec.aiTitle === "string") {
      aiTitle = rec.aiTitle.trim() || null;
      continue;
    }
    // 解析用户自定义标题（参考 sourcemap restored-src/src/types/logs.ts: CustomTitleMessage）
    if (rec.type === "custom-title" && typeof rec.customTitle === "string") {
      customTitle = rec.customTitle.trim() || null;
      continue;
    }

    const ts: string = rec.timestamp ?? rec.ts ?? "";
    if (ts && !startedAt) startedAt = ts;
    if (ts) endedAt = ts;

    if (rec.type === "user") {
      const msg = rec.message;
      if (!msg) continue;

      // Extract cwd from first system message
      if (!cwd && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "tool_result") continue;
          if (typeof block === "object" && block?.type === "text") {
            const m = block.text?.match(/^<env>[\s\S]*?cwd:\s*(.+)/m);
            if (m) cwd = m[1].trim();
          }
        }
      }

      // Classify turn kind
      let turnKind: Turn["turn_kind"];
      if (rec.userType === "tool") {
        turnKind = "tool_result";
      } else {
        turnKind = "human_input";
      }

      const content = extractText(msg.content);
      if (!content && turnKind === "tool_result") continue; // skip empty tool results

      turns.push({
        id: makeTurnId(sessionId, turnIndex, "user"),
        session_id: sessionId,
        role: "user",
        turn_kind: turnKind,
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
    } else if (rec.type === "assistant") {
      const msg = rec.message;
      if (!msg) continue;

      if (msg.model && !model) model = msg.model;

      // Token usage
      const usage = msg.usage ?? {};
      const iTok = usage.input_tokens ?? 0;
      const oTok = usage.output_tokens ?? 0;
      const ccTok = usage.cache_creation_input_tokens ?? 0;
      const crTok = usage.cache_read_input_tokens ?? 0;
      inputTokens += iTok;
      outputTokens += oTok;
      cacheCreationTokens += ccTok;
      cacheReadTokens += crTok;

      // Tool use blocks
      const toolUseBlocks = Array.isArray(msg.content)
        ? msg.content.filter((b: any) => b?.type === "tool_use")
        : [];
      const toolNames = toolUseBlocks.map((b: any) => b.name as string);
      for (const name of toolNames) {
        toolCallNames[name] = (toolCallNames[name] ?? 0) + 1;
        toolCallCount++;
      }

      const hasToolUse = toolUseBlocks.length > 0;
      const turnKind: Turn["turn_kind"] = hasToolUse ? "assistant_tool" : "assistant";
      const content = extractText(msg.content);

      turns.push({
        id: makeTurnId(sessionId, turnIndex, "assistant"),
        session_id: sessionId,
        role: "assistant",
        turn_kind: turnKind,
        content,
        timestamp: ts,
        turn_index: turnIndex++,
        tool_calls: toolUseBlocks.length,
        tool_names: toolNames,
        input_tokens: iTok,
        output_tokens: oTok,
        cache_creation_tokens: ccTok,
        cache_read_tokens: crTok,
      });
    }
  }

  const humanTurnCount = turns.filter((t) => t.turn_kind === "human_input").length;
  // custom-title 优先；均无则 null
  const title = customTitle ?? aiTitle ?? null;

  const session: Session = {
    id: sessionId,
    tool: "claude",
    project: project || projectHash,
    cwd,
    started_at: startedAt,
    ended_at: endedAt,
    turn_count: turns.length,
    human_turn_count: humanTurnCount,
    model,
    source_file: filePath,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_read_tokens: cacheReadTokens,
    tool_call_count: toolCallCount,
    tool_call_names: toolCallNames,
    title,
  };

  return { session, turns };
}
