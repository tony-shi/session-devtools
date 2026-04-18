import type { AgentSpan, SpanStatus } from "../types";

// ── Raw JSONL record shapes ──────────────────────────────────────────────────

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface RawContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface RawMessage {
  role: "user" | "assistant";
  content: string | RawContentBlock[];
  usage?: RawUsage;
  stop_reason?: string;
}

interface RawRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: RawMessage;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toMs(ts?: string): number {
  if (!ts) return 0;
  const n = Date.parse(ts);
  return isNaN(n) ? 0 : n;
}

function extractThinking(blocks: RawContentBlock[]): string | undefined {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "thinking" && typeof b.text === "string") parts.push(b.text);
    if (b.type === "redacted_thinking") parts.push("[redacted thinking]");
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractUserText(content: string | RawContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
}

// ── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parse a raw Claude Code JSONL string into a flat list of AgentSpan.
 *
 * Structure produced:
 *   turn span (kind="turn", name="user"|"assistant")
 *     └── tool_use span (kind="tool_use", name=toolName)
 *
 * tool_result content is attached to the corresponding tool_use span as .output.
 * Thinking blocks are preserved (not filtered).
 */
export function parseClaudeJsonl(raw: string): AgentSpan[] {
  const records: RawRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as RawRecord);
    } catch {
      // skip malformed lines
    }
  }

  // Index records by uuid for parentUuid linking
  const byUuid = new Map<string, RawRecord>();
  for (const r of records) {
    if (r.uuid) byUuid.set(r.uuid, r);
  }

  // Map from tool_use id → tool_use AgentSpan (to attach tool_result later)
  const toolUseById = new Map<string, AgentSpan>();

  // Top-level spans (turns) in order
  const turnSpans: AgentSpan[] = [];

  for (const r of records) {
    if (r.isMeta || r.isSidechain) continue;
    if (r.type !== "user" && r.type !== "assistant") continue;
    if (!r.message || !r.uuid) continue;

    const { message, uuid, parentUuid, timestamp } = r;
    const startTime = toMs(timestamp);

    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const usage = message.usage ?? {};
      const thinking = extractThinking(blocks);

      const turnSpan: AgentSpan = {
        id: uuid,
        parentId: parentUuid ?? undefined,
        kind: "turn",
        name: "assistant",
        startTime,
        status: "ok",
        thinking,
        tokens: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheCreation: usage.cache_creation_input_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
        },
        children: [],
      };

      // Create a child span for each tool_use block
      for (const block of blocks) {
        if (block.type !== "tool_use" || !block.id || !block.name) continue;

        const toolSpan: AgentSpan = {
          id: block.id,
          parentId: uuid,
          kind: "tool_use",
          name: block.name,
          startTime,
          status: "pending",
          input: block.input,
          children: [],
        };

        turnSpan.children.push(toolSpan);
        toolUseById.set(block.id, toolSpan);
      }

      turnSpans.push(turnSpan);
    } else {
      // user message — check for tool_result blocks
      const blocks = Array.isArray(message.content) ? message.content : [];
      const hasToolResults = blocks.some((b) => b.type === "tool_result");

      if (hasToolResults) {
        // Attach results to the corresponding tool_use spans
        for (const block of blocks) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const toolSpan = toolUseById.get(block.tool_use_id);
          if (!toolSpan) continue;

          toolSpan.output = block.content;
          toolSpan.endTime = toMs(timestamp);
          const status: SpanStatus = block.is_error ? "error" : "ok";
          toolSpan.status = status;
        }
        // Don't emit a separate turn span for pure tool_result messages
      } else {
        // Human input turn
        const text = extractUserText(message.content);
        const turnSpan: AgentSpan = {
          id: uuid,
          parentId: parentUuid ?? undefined,
          kind: "turn",
          name: "user",
          startTime,
          status: "ok",
          input: text,
          children: [],
        };
        turnSpans.push(turnSpan);
      }
    }
  }

  // Fill endTime for assistant turns: use the startTime of the next turn
  for (let i = 0; i < turnSpans.length - 1; i++) {
    if (!turnSpans[i].endTime) {
      turnSpans[i].endTime = turnSpans[i + 1].startTime;
    }
  }

  return turnSpans;
}
