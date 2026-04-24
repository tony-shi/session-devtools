// Parse a raw Claude Code JSONL string into a flat array of AgentSpan (our
// OTel gen_ai superset). One pass; parent-child is expressed via parentId.
//
// Span shape produced (per Claude turn):
//   session span            parentId = undefined
//     assistant turn span   parentId = session            gen_ai.operation.name = chat
//       tool_call span      parentId = assistant turn     gen_ai.operation.name = execute_tool
//         (if Agent tool)   subagent invoke_agent span    parentId = tool_call
//           subagent turn   parentId = subagent root      gen_ai.operation.name = chat
//             ...nested sub-subagents supported via recursion
//     user turn span        parentId = session            (user_input)

import type { AgentSpan } from "./span";

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
  model?: string;
  content: string | RawContentBlock[];
  usage?: RawUsage;
}

interface RawRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  agentId?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: RawMessage;
}

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  name?: string;
}

export interface SubagentInput {
  jsonl: string;
  meta: SubagentMeta | null;
}

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

function stringifyMaybe(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function stringifyToolResult(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) {
          return String((b as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(b);
      })
      .join("\n")
      .trim();
    return texts || undefined;
  }
  return stringifyMaybe(content);
}

/**
 * Claude Code writes the launched subagent's internal id into the Agent tool's
 * result text for async agents: "Async agent launched successfully.\nagentId: aea56747a0b..."
 *
 * Synchronous / built-in subagent types (Explore, Plan, general-purpose, etc.)
 * return their output directly — no "agentId:" line. For those we fall back to
 * matching by tool_use_id against the subagents map (see call site).
 */
function extractAgentIdFromToolResult(output: unknown): string | undefined {
  const text = stringifyToolResult(output);
  if (!text) return undefined;
  const m = /agentId:\s*([A-Za-z0-9_-]+)/.exec(text);
  return m?.[1];
}

/**
 * For built-in subagent types (Explore, Plan, etc.) the tool_result contains
 * the agent's final answer, not an agentId line.  We identify the matching
 * subagent by looking for a subagent whose JSONL's last assistant record
 * has output that starts with the beginning of the tool_result text.
 * Simpler fallback: if there is exactly one unmatched subagent, use it.
 *
 * TODO: This matching is heuristic and has known gaps:
 *
 * 1. Single-unvisited shortcut assumes one Agent tool_use ↔ one subagent file,
 *    which breaks if Claude Code launches multiple sync subagents in the same
 *    turn (parallel built-in agents).
 *
 * 2. Content-prefix matching (60-char prefix of last assistant block) can
 *    collide when two subagents produce similar opening sentences, or fail
 *    when Claude Code truncates / reformats the tool_result before writing
 *    it to JSONL (observed with some Explore responses that get summarised).
 *
 * 3. There is no ground-truth binding between a tool_use block and its
 *    subagent file for sync agents — Claude Code only writes "agentId: <id>"
 *    for async agents. The only reliable fix is upstream: Claude Code should
 *    emit agentId for ALL agent types, not just async ones.
 *
 * 4. If matching fails silently (returns undefined), the subagent JSONL is
 *    dropped from the span tree with no warning. Consider emitting a synthetic
 *    "unmatched subagent" span so the gap is visible rather than invisible.
 */
function matchSubagentByContent(
  output: unknown,
  subagents: Record<string, SubagentInput>,
  visitedAgentIds: Set<string>,
): string | undefined {
  const unvisited = Object.keys(subagents).filter((id) => !visitedAgentIds.has(id));
  if (unvisited.length === 1) return unvisited[0];
  if (unvisited.length === 0) return undefined;

  // Multiple unvisited: try to match by checking if the subagent's last
  // assistant text block starts with the first 120 chars of the tool_result.
  const resultText = stringifyToolResult(output)?.slice(0, 120);
  if (!resultText) return undefined;

  for (const id of unvisited) {
    const jsonl = subagents[id].jsonl;
    for (const line of jsonl.split("\n").reverse()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const r = JSON.parse(trimmed) as { type?: string; message?: { role?: string; content?: unknown } };
        if (r.type !== "assistant") continue;
        const text = stringifyToolResult(r.message?.content)?.slice(0, 120) ?? "";
        if (text && resultText.startsWith(text.slice(0, 60))) return id;
      } catch { /* skip */ }
      break;
    }
  }
  return undefined;
}

export interface ClaudeParseOptions {
  /** Session id used for traceId and the synthetic root span id. */
  sessionId: string;
  /**
   * Keyed by agentId (as it appears in `subagents/agent-<id>.jsonl`). When
   * an Agent tool_use's result references such an id, its transcript is
   * parsed recursively and attached under the tool_call span.
   */
  subagents?: Record<string, SubagentInput>;
}

interface WorkerOptions {
  traceId: string;
  /** Parent id for any root-level (parentUuid=null) span we emit. */
  rootParentId?: string;
  /** Synthetic root span id to emit, or undefined to skip emitting a root. */
  emitRoot?: {
    id: string;
    name: string;
    agentName: string;
    agentId?: string;
    isSubagent: boolean;
  };
  /** Look-up for subagent transcripts keyed by agentId. */
  subagents?: Record<string, SubagentInput>;
  /** Guards against cycles in case of self-referential subagent files. */
  visitedAgentIds: Set<string>;
  /**
   * Subagent JSONL records are entirely `isSidechain:true`. When parsing a
   * subagent we must NOT skip them.
   */
  keepSidechain: boolean;
  /** Attribute overlay applied to every emitted span (e.g. subagent tagging). */
  attributeOverlay?: Record<string, string | number | boolean | undefined>;
}

/**
 * Core record walker, shared between top-level parsing and subagent recursion.
 * Returns the flat list of spans (without a session root unless emitRoot set).
 */
function walkRecords(
  raw: string,
  opts: WorkerOptions,
): { spans: AgentSpan[]; firstTs: number; lastTs: number } {
  const {
    traceId,
    rootParentId,
    emitRoot,
    subagents,
    visitedAgentIds,
    keepSidechain,
    attributeOverlay,
  } = opts;

  const records: RawRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as RawRecord);
    } catch {
      // skip malformed
    }
  }

  const recordByUuid = new Map<string, RawRecord>();
  for (const r of records) {
    if (r.uuid) recordByUuid.set(r.uuid, r);
  }

  const spans: AgentSpan[] = [];
  const toolUseById = new Map<string, AgentSpan>();
  const turnOrder: AgentSpan[] = [];
  const emittedTurnUuids = new Set<string>();

  // Fallback parent for any span whose parentUuid chain terminates without
  // hitting an emitted turn. For top-level: the session root. For subagents:
  // the anchor tool_call span.
  const fallbackParent = emitRoot?.id ?? rootParentId;

  function resolveParentId(parentUuid: string | null | undefined): string | undefined {
    let cursor = parentUuid ?? undefined;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      if (emittedTurnUuids.has(cursor)) return cursor;
      const prev = recordByUuid.get(cursor);
      cursor = prev?.parentUuid ?? undefined;
    }
    return fallbackParent;
  }

  function applyOverlay(attrs: AgentSpan["attributes"]): AgentSpan["attributes"] {
    if (!attributeOverlay) return attrs;
    return { ...attrs, ...attributeOverlay };
  }

  let sessionStart = Infinity;
  let sessionEnd = 0;
  let detectedModel: string | undefined;

  for (const r of records) {
    if (r.isMeta) continue;
    if (r.isSidechain && !keepSidechain) continue;
    if (r.type !== "user" && r.type !== "assistant") continue;
    if (!r.message || !r.uuid) continue;

    const { message, uuid, parentUuid, timestamp } = r;
    const startTime = toMs(timestamp);
    if (startTime && startTime < sessionStart) sessionStart = startTime;
    if (startTime && startTime > sessionEnd) sessionEnd = startTime;

    const parentId = resolveParentId(parentUuid);

    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const usage = message.usage ?? {};
      const thinking = extractThinking(blocks);
      const assistantText = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      const totalTokens =
        (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      if (message.model) detectedModel = message.model;

      const turnSpan: AgentSpan = {
        id: uuid,
        traceId,
        parentId,
        kind: "turn",
        name: `chat ${message.model ?? "claude"}`,
        startTime,
        status: "ok",
        attributes: applyOverlay({
          "gen_ai.system": "anthropic",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": message.model,
          "gen_ai.usage.input_tokens": usage.input_tokens,
          "gen_ai.usage.output_tokens": usage.output_tokens,
          "gen_ai.usage.total_tokens": totalTokens || undefined,
          "gen_ai.usage.cache_creation_input_tokens":
            usage.cache_creation_input_tokens,
          "gen_ai.usage.cache_read_input_tokens":
            usage.cache_read_input_tokens,
          "output.value": assistantText || undefined,
          "claude.thinking.text": thinking,
          "claude.parent_uuid": parentUuid ?? undefined,
        }),
      };
      spans.push(turnSpan);
      turnOrder.push(turnSpan);
      emittedTurnUuids.add(uuid);

      for (const block of blocks) {
        if (block.type !== "tool_use" || !block.id || !block.name) continue;
        const toolSpan: AgentSpan = {
          id: block.id,
          traceId,
          parentId: uuid,
          kind: "tool_call",
          name: `execute_tool ${block.name}`,
          startTime,
          status: "pending",
          attributes: applyOverlay({
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": block.name,
            "gen_ai.tool.call.id": block.id,
            "input.value": stringifyMaybe(block.input),
          }),
        };
        spans.push(toolSpan);
        toolUseById.set(block.id, toolSpan);
      }
    } else {
      // user
      const blocks = Array.isArray(message.content) ? message.content : [];
      const hasToolResults = blocks.some((b) => b.type === "tool_result");

      if (hasToolResults) {
        const endMs = toMs(timestamp);
        for (const block of blocks) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const toolSpan = toolUseById.get(block.tool_use_id);
          if (!toolSpan) continue;
          toolSpan.endTime = endMs;
          toolSpan.status = block.is_error ? "error" : "ok";
          toolSpan.attributes["output.value"] = stringifyToolResult(
            block.content,
          );

          // Stitch in subagent transcript if this tool_use is an Agent
          // invocation and we have its jsonl.
          if (
            toolSpan.attributes["gen_ai.tool.name"] === "Agent" &&
            subagents
          ) {
            // Async agents write "agentId: xxx" into their result.
            // Sync/built-in agents (Explore, Plan, etc.) return their output
            // directly — fall back to content-based matching.
            const subAgentId =
              extractAgentIdFromToolResult(block.content) ??
              matchSubagentByContent(block.content, subagents, visitedAgentIds);
            if (
              subAgentId &&
              subagents[subAgentId] &&
              !visitedAgentIds.has(subAgentId)
            ) {
              visitedAgentIds.add(subAgentId);
              const sub = subagents[subAgentId];
              const description =
                sub.meta?.description ?? "subagent";
              const agentName =
                sub.meta?.name ?? sub.meta?.description ?? subAgentId.slice(0, 8);
              const subRootId = `subagent:${subAgentId}`;
              const { spans: subSpans } = walkRecords(sub.jsonl, {
                traceId,
                rootParentId: toolSpan.id,
                emitRoot: {
                  id: subRootId,
                  name: `invoke_agent ${agentName}`,
                  agentName,
                  agentId: subAgentId,
                  isSubagent: true,
                },
                subagents,
                visitedAgentIds,
                keepSidechain: true,
                attributeOverlay: {
                  "claude.subagent.id": subAgentId,
                  "claude.subagent.name": agentName,
                  "claude.subagent.type": sub.meta?.agentType,
                  "claude.subagent.description": description,
                  "gen_ai.agent.name": agentName,
                  "gen_ai.agent.id": subAgentId,
                },
              });
              spans.push(...subSpans);
            }
          }
        }
        // no separate user-turn span for pure tool_result wrappers
      } else {
        const text = extractUserText(message.content);
        const turnSpan: AgentSpan = {
          id: uuid,
          traceId,
          parentId,
          kind: "turn",
          name: "user_input",
          startTime,
          status: "ok",
          attributes: applyOverlay({
            "gen_ai.operation.name": "user_input",
            "input.value": text || undefined,
            "claude.parent_uuid": parentUuid ?? undefined,
          }),
        };
        spans.push(turnSpan);
        turnOrder.push(turnSpan);
        emittedTurnUuids.add(uuid);
      }
    }
  }

  // Fill endTime on turn spans by using the next turn's startTime.
  for (let i = 0; i < turnOrder.length - 1; i++) {
    if (turnOrder[i].endTime === undefined) {
      turnOrder[i].endTime = turnOrder[i + 1].startTime;
    }
  }
  for (const s of spans) {
    if (s.kind === "tool_call" && s.endTime === undefined) {
      s.endTime = s.startTime;
    }
  }

  if (!isFinite(sessionStart)) sessionStart = 0;

  if (emitRoot) {
    const root: AgentSpan = {
      id: emitRoot.id,
      traceId,
      parentId: rootParentId,
      kind: emitRoot.isSubagent ? "turn" : "session",
      name: emitRoot.name,
      startTime: sessionStart,
      endTime: sessionEnd || sessionStart,
      status: "ok",
      attributes: applyOverlay({
        "gen_ai.system": "anthropic",
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": emitRoot.agentName,
        "gen_ai.agent.id": emitRoot.agentId,
        "gen_ai.request.model": detectedModel,
      }),
    };
    return { spans: [root, ...spans], firstTs: sessionStart, lastTs: sessionEnd };
  }
  return { spans, firstTs: sessionStart, lastTs: sessionEnd };
}

export function parseClaudeJsonlToIR(
  raw: string,
  opts: ClaudeParseOptions,
): AgentSpan[] {
  const { sessionId, subagents } = opts;
  const rootId = `session:${sessionId}`;
  const { spans } = walkRecords(raw, {
    traceId: sessionId,
    emitRoot: {
      id: rootId,
      name: "invoke_agent claude-code",
      agentName: "claude-code",
      isSubagent: false,
    },
    subagents,
    visitedAgentIds: new Set<string>(),
    keepSidechain: false,
  });
  return spans;
}
