import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import type { SessionMetaV2 } from "./index.ts";
import { computeFingerprint } from "./fingerprint.ts";
import { decodeClaudeProjectHash } from "../parser-utils.ts";

const KNOWN_TYPES = new Set([
  "user", "assistant", "system", "last-prompt", "attachment",
  "file-history-snapshot", "queue-operation", "permission-mode",
  "worktree-state", "ai-title", "custom-title",
]);

function isCommandContent(content: unknown): boolean {
  const text = extractText(content).trimStart();
  return text.startsWith("<command-name>") || text.startsWith("<local-command-caveat>");
}

function isHumanInput(content: unknown): boolean {
  if (isCommandContent(content)) return false;
  if (!Array.isArray(content)) return typeof content === "string" && content.trim().length > 0;
  return !content.some((b: any) => b?.type === "tool_result");
}

export async function parseClaudeSessionV2(filePath: string): Promise<SessionMetaV2> {
  const text = await readFile(filePath, "utf-8");
  const lines = text.trim().split("\n").filter(Boolean);

  const parts = filePath.split("/");
  const sessionId = parts[parts.length - 1].replace(/\.jsonl$/, "");
  const projectHash = parts[parts.length - 2] ?? "unknown";
  const project = decodeClaudeProjectHash(projectHash);

  let firstEventAt = "";
  let lastEventAt = "";
  let cwd = "";
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  let firstUserMessage = "";
  let awaySummary: string | null = null;
  let lastAssistantText: string | null = null;
  let eventCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let toolCallCount = 0;
  // llm_call_count = number of *logical* LLM calls, deduplicated by message.id.
  // A single API response can be split across several JSONL assistant frames
  // (streaming) and — on some upstreams — an entire tool-calling turn shares one
  // message.id. Counting raw frames inflates the number (e.g. 34 frames → 7
  // real calls) and produces a false "N calls lack proxy tracking" badge when
  // compared against proxy_request_id_count. Mirror the drilldown parser, which
  // collapses frames per message.id. Frames without an id fall back to +1.
  const llmCallMsgIds = new Set<string>();
  let llmCallNoIdCount = 0;
  let humanInputCount = 0;
  let apiErrorCount = 0;
  const modelCounts = new Map<string, number>();
  const eventTypeSet = new Set<string>();
  const unknownTypes = new Set<string>();

  for (const line of lines) {
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }

    eventCount++;
    const t: string = rec.type ?? "";
    eventTypeSet.add(t || "?");
    if (t && !KNOWN_TYPES.has(t)) unknownTypes.add(t);

    const ts: string = rec.timestamp ?? rec.ts ?? "";
    if (ts) {
      if (!firstEventAt) firstEventAt = ts;
      lastEventAt = ts;
    }

    if (!cwd && rec.cwd) cwd = rec.cwd;

    if (t === "ai-title" && typeof rec.aiTitle === "string") {
      aiTitle = rec.aiTitle.trim() || null;
      continue;
    }
    if (t === "custom-title" && typeof rec.customTitle === "string") {
      customTitle = rec.customTitle.trim() || null;
      continue;
    }

    if (t === "user" && !rec.isMeta && !rec.isSidechain) { // Claude Code wrapper fields — best-effort; may drift silently
      const msg = rec.message;
      if (!msg) continue;
      const content = msg.content;
      if (!isHumanInput(content)) continue;
      humanInputCount++;
      if (!firstUserMessage) {
        const text = extractText(content);
        if (text) firstUserMessage = text.slice(0, 120);
      }
    }

    if (t === "assistant" && !rec.isSidechain) { // Claude Code wrapper field — best-effort; may drift silently
      const msg = rec.message;
      if (!msg) continue;
      // SYNTHETIC_MODEL = "<synthetic>" is a Claude Code internal constant (messages.ts:300).
      // It marks locally-generated assistant messages (API errors, interrupts, compaction
      // placeholders) that never went through the Anthropic API. Filtering by string literal
      // is intentional — we depend on this Claude Code implementation detail for now.
      // TODO: replace with Anthropic API contract check (msg.id?.startsWith("msg_")) once validated.
      if (msg.model && msg.model !== "<synthetic>") {
        const mid = typeof msg.id === "string" && msg.id ? msg.id : "";
        if (mid) llmCallMsgIds.add(mid);
        else llmCallNoIdCount++;
        modelCounts.set(msg.model, (modelCounts.get(msg.model) ?? 0) + 1);
        const text = extractText(msg.content);
        if (text) lastAssistantText = text.slice(0, 300);
      }
      const usage = msg.usage ?? {};
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b?.type === "tool_use") toolCallCount++;
        }
      }
    }

    if (t === "system") {
      if (rec.subtype === "api_error") { // Claude Code wrapper event; NOT HTTP error
        apiErrorCount++;
      }
      if (rec.subtype === "away_summary" && typeof rec.content === "string" && rec.content.trim()) {
        awaySummary = rec.content.trim();
      }
    }
  }

  const subAgentCount = await countSubAgents(filePath, sessionId);

  return {
    session_id: sessionId,
    tool: "claude",
    source_file: filePath,
    first_event_at: firstEventAt,
    last_event_at: lastEventAt,
    cwd,
    project: project || projectHash,
    custom_title: customTitle,
    ai_title: aiTitle,
    first_user_message: firstUserMessage,
    event_count: eventCount,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_read_tokens: cacheReadTokens,
    models: Array.from(modelCounts.entries()).sort((a, b) => b[1] - a[1]).map(([m]) => m),
    tool_call_count: toolCallCount,
    llm_call_count: llmCallMsgIds.size + llmCallNoIdCount,
    human_input_count: humanInputCount,
    sub_agent_count: subAgentCount,
    claude_code_api_error_count: apiErrorCount,
    parser_warnings: Array.from(unknownTypes),
    schema_fingerprint: computeFingerprint(eventTypeSet),
    away_summary: awaySummary,
    last_assistant_text: lastAssistantText,
  };
}

async function countSubAgents(filePath: string, sessionId: string): Promise<number> {
  const subagentsDir = join(dirname(filePath), sessionId, "subagents");
  if (!existsSync(subagentsDir)) return 0;
  try {
    const entries = await readdir(subagentsDir);
    return entries.filter(f => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type !== "thinking" && b?.type !== "redacted_thinking")
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b?.type === "text") return b.text ?? "";
      return "";
    })
    .join("\n")
    .trim();
}
