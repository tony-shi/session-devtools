/**
 * Context Fill Analysis — pure, CLI-agnostic.
 *
 * Decoupled from OTel/agent-prism: context traces model the *memory state*
 * (what is in the context window at each assistant turn), not the execution flow.
 *
 * Categories tracked:
 *   system_prompt      — base system prompt text (CLAUDE.md via Read tool)
 *   claude_md          — CLAUDE.md path references
 *   user_message       — plain human turns
 *   mentioned_file     — @path references in user messages
 *   tool_output        — tool_result content (per-tool breakdown available)
 *   thinking_text      — assistant thinking blocks
 *   task_coordination  — SendMessage / TeamCreate / TaskCreate / etc.
 *   skill_injection    — skill_listing / slash command expansions / task_reminder / permissions
 *   system_overhead    — measured gap: usage total minus all estimated categories
 *                        (tool schemas, base instructions — structurally unknowable from JSONL)
 */

// ── Public types ─────────────────────────────────────────────────────────────

export type ContextCategory =
  | "system_prompt"
  | "claude_md"
  | "user_message"
  | "mentioned_file"
  | "tool_output"
  | "thinking_text"
  | "task_coordination"
  | "skill_injection"
  | "system_overhead";

export interface ToolOutputBreakdown {
  toolName: string;
  tokens: number;
}

export interface InjectionEvent {
  category: ContextCategory;
  tokens: number;
  label: string;
}

export interface ContextSnapshot {
  agentId: string;
  agentName: string;
  turnIndex: number;
  timestamp: number;
  phase: number;

  tokensByCategory: Record<ContextCategory, number>;
  /** Sum of all estimated categories (excludes system_overhead) */
  estimatedTotal: number;
  /** system_overhead = measuredTotal - estimatedTotal (≥ 0) */
  systemOverhead: number;
  /** estimatedTotal + systemOverhead = measuredTotal (when usage available) */
  measuredTotal: number;

  measuredInputTokens?: number;
  measuredCacheRead?: number;
  measuredCacheCreation?: number;

  /** Per-tool breakdown of tool_output category */
  toolOutputByTool: ToolOutputBreakdown[];

  newInjections: InjectionEvent[];

  isCompactionBoundary?: boolean;
  compactionDelta?: { pre: number; post: number };
  compactionSummary?: string;
}

export interface AgentContextTrace {
  agentId: string;
  agentName: string;
  snapshots: ContextSnapshot[];
  totalPhases: number;
  contextLimit: number;
}

// ── Adapter interface ─────────────────────────────────────────────────────────

export interface ContextRecord {
  role: "user" | "assistant" | "injection";
  timestamp?: number;

  // assistant fields
  model?: string;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  assistantBlocks?: Array<{
    type: string;
    text?: string;
    toolName?: string;
    toolInput?: unknown;
  }>;
  isCompactSummary?: boolean;
  compactSummaryText?: string;

  // user fields
  userTextContent?: string;
  isSlashCommand?: boolean;   // user text that is a slash command expansion
  toolResults?: Array<{
    toolName?: string;
    content: string;
  }>;
  systemBlocks?: Array<{ text: string }>;

  // injection fields (attachment / system records)
  injectionCategory?: ContextCategory;
  injectionLabel?: string;
  injectionContent?: string;   // serialised text for token estimation
  injectionDynamic?: boolean;  // true = changes per turn (task_reminder)
}

export interface AgentInput {
  agentId: string;
  agentName: string;
  records: ContextRecord[];
}

// ── Token estimation ──────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Category helpers ──────────────────────────────────────────────────────────

const CLAUDE_MD_RE = /CLAUDE\.md$/i;
function isClaudeMdPath(p: string): boolean {
  return CLAUDE_MD_RE.test(p);
}

const MENTION_RE = /@([\w./~-]+)/g;
function extractMentionPaths(text: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) paths.push(m[1]);
  return paths;
}

const TASK_COORDINATION_TOOLS = new Set([
  "SendMessage", "TeamCreate", "TeamDelete",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
]);

// Slash command expansions are large user text blocks injected by Claude Code.
// Heuristic: user text > 500 chars that starts with a known pattern.
const SLASH_COMMAND_PREFIXES = [
  "Run a Codex review",
  "Run a security review",
  "Initialize a new CLAUDE.md",
  "Review a pull request",
];
function isSlashCommandExpansion(text: string): boolean {
  if (text.length < 300) return false;
  return SLASH_COMMAND_PREFIXES.some((p) => text.startsWith(p));
}

// ── Accumulator helpers ───────────────────────────────────────────────────────

function emptyByCategory(): Record<ContextCategory, number> {
  return {
    system_prompt: 0, claude_md: 0, user_message: 0, mentioned_file: 0,
    tool_output: 0, thinking_text: 0, task_coordination: 0,
    skill_injection: 0, system_overhead: 0,
  };
}

function totalOf(cats: Record<ContextCategory, number>): number {
  return Object.values(cats).reduce((a, b) => a + b, 0);
}

// ── Core trace builder ────────────────────────────────────────────────────────

function buildTrace(input: AgentInput, contextLimit: number): AgentContextTrace {
  const { agentId, agentName, records } = input;
  const snapshots: ContextSnapshot[] = [];

  let accumulated = emptyByCategory();
  let toolOutputByTool = new Map<string, number>();
  let phase = 1;
  let turnIndex = 0;

  for (const rec of records) {
    // ── Injection record (attachment / system) ────────────────────────────────
    if (rec.role === "injection") {
      const cat = rec.injectionCategory ?? "skill_injection";
      const tokens = estimateTokens(rec.injectionContent ?? "");
      if (rec.injectionDynamic) {
        // Dynamic injections (task_reminder) replace their previous value each turn.
        // We can't track the previous value precisely without per-injection history,
        // so we accumulate additively — this is a known approximation.
        accumulated[cat] += tokens;
      } else {
        // Static injections (skill_listing, command_permissions) are injected once.
        accumulated[cat] = Math.max(accumulated[cat], tokens);
      }
      continue;
    }

    // ── User turn ─────────────────────────────────────────────────────────────
    if (rec.role === "user") {
      if (rec.userTextContent) {
        const text = rec.userTextContent;
        if (rec.isSlashCommand) {
          accumulated.skill_injection += estimateTokens(text);
        } else {
          accumulated.user_message += estimateTokens(text);
          const mentionTokens = extractMentionPaths(text)
            .reduce((s, p) => s + estimateTokens(p), 0);
          accumulated.mentioned_file += mentionTokens;
        }
      }
      if (rec.toolResults) {
        for (const tr of rec.toolResults) {
          const tokens = estimateTokens(tr.content);
          const name = tr.toolName ?? "unknown";
          if (TASK_COORDINATION_TOOLS.has(name)) {
            accumulated.task_coordination += tokens;
          } else {
            accumulated.tool_output += tokens;
            toolOutputByTool.set(name, (toolOutputByTool.get(name) ?? 0) + tokens);
          }
        }
      }
      if (rec.systemBlocks) {
        for (const sb of rec.systemBlocks) {
          if (isClaudeMdPath(sb.text.slice(0, 200))) {
            accumulated.claude_md += estimateTokens(sb.text);
          } else {
            accumulated.system_prompt += estimateTokens(sb.text);
          }
        }
      }
      continue;
    }

    // ── Assistant turn ────────────────────────────────────────────────────────
    const prevAccumulated = { ...accumulated };
    const newInjections: InjectionEvent[] = [];

    // Compaction boundary
    if (rec.isCompactSummary) {
      const summaryText = rec.compactSummaryText ?? "";
      const measuredPre = computeMeasured(prevAccumulated, rec);
      const postTokens = estimateTokens(summaryText);

      accumulated = emptyByCategory();
      accumulated.system_prompt = postTokens;
      toolOutputByTool = new Map();

      const measuredPost = computeMeasuredFromUsage(rec);

      snapshots.push(makeSnapshot({
        agentId, agentName, turnIndex, timestamp: rec.timestamp ?? 0, phase,
        accumulated: { ...accumulated },
        toolOutputByTool: new Map(),
        newInjections: [{ category: "system_prompt", tokens: postTokens, label: "compaction summary" }],
        rec,
        isCompactionBoundary: true,
        compactionDelta: { pre: measuredPre, post: measuredPost || postTokens },
        compactionSummary: summaryText.slice(0, 500),
      }));

      phase += 1;
      turnIndex += 1;
      continue;
    }

    // Normal assistant turn
    if (rec.assistantBlocks) {
      for (const block of rec.assistantBlocks) {
        if ((block.type === "thinking" || block.type === "redacted_thinking") && block.text) {
          const tokens = estimateTokens(block.text);
          accumulated.thinking_text += tokens;
          newInjections.push({
            category: "thinking_text", tokens,
            label: block.text.slice(0, 60) + (block.text.length > 60 ? "…" : ""),
          });
        }
        if (block.type === "tool_use" && block.toolName) {
          const inputStr = typeof block.toolInput === "string"
            ? block.toolInput
            : JSON.stringify(block.toolInput ?? "");
          const tokens = estimateTokens(inputStr);
          if (TASK_COORDINATION_TOOLS.has(block.toolName)) {
            accumulated.task_coordination += tokens;
            newInjections.push({ category: "task_coordination", tokens, label: block.toolName });
          }
          // CLAUDE.md path in Read call
          const filePath = (block.toolInput as Record<string, unknown>)?.file_path;
          if (
            block.toolName === "Read" &&
            typeof filePath === "string" &&
            isClaudeMdPath(filePath)
          ) {
            accumulated.claude_md += estimateTokens(filePath);
            newInjections.push({ category: "claude_md", tokens: estimateTokens(filePath), label: filePath });
          }
        }
      }
    }

    // Emit delta injections for categories that grew (excluding ones already handled above)
    const ALREADY_HANDLED: ContextCategory[] = ["thinking_text", "task_coordination", "claude_md"];
    for (const cat of Object.keys(accumulated) as ContextCategory[]) {
      if (ALREADY_HANDLED.includes(cat)) continue;
      if (cat === "system_overhead") continue;
      const delta = accumulated[cat] - prevAccumulated[cat];
      if (delta > 0) {
        newInjections.push({ category: cat, tokens: delta, label: cat });
      }
    }

    snapshots.push(makeSnapshot({
      agentId, agentName, turnIndex, timestamp: rec.timestamp ?? 0, phase,
      accumulated: { ...accumulated },
      toolOutputByTool: new Map(toolOutputByTool),
      newInjections,
      rec,
    }));

    turnIndex += 1;
  }

  return { agentId, agentName, snapshots, totalPhases: phase, contextLimit };
}

interface SnapshotArgs {
  agentId: string;
  agentName: string;
  turnIndex: number;
  timestamp: number;
  phase: number;
  accumulated: Record<ContextCategory, number>;
  toolOutputByTool: Map<string, number>;
  newInjections: InjectionEvent[];
  rec: ContextRecord;
  isCompactionBoundary?: boolean;
  compactionDelta?: { pre: number; post: number };
  compactionSummary?: string;
}

function computeMeasuredFromUsage(rec: ContextRecord): number {
  if (!rec.usage) return 0;
  return (rec.usage.input_tokens ?? 0)
    + (rec.usage.cache_read_input_tokens ?? 0)
    + (rec.usage.cache_creation_input_tokens ?? 0);
}

function computeMeasured(
  accumulated: Record<ContextCategory, number>,
  rec: ContextRecord,
): number {
  const fromUsage = computeMeasuredFromUsage(rec);
  return fromUsage || totalOf(accumulated);
}

function makeSnapshot(args: SnapshotArgs): ContextSnapshot {
  const {
    agentId, agentName, turnIndex, timestamp, phase,
    accumulated, toolOutputByTool, newInjections, rec,
    isCompactionBoundary, compactionDelta, compactionSummary,
  } = args;

  const estimatedTotal = Object.entries(accumulated)
    .filter(([k]) => k !== "system_overhead")
    .reduce((s, [, v]) => s + v, 0);

  const measuredTotal = computeMeasuredFromUsage(rec);

  // system_overhead = measured - estimated (clamped to 0)
  // This represents tool schemas + base system prompt that are never in JSONL.
  const systemOverhead = measuredTotal > 0
    ? Math.max(0, measuredTotal - estimatedTotal)
    : 0;

  const finalAccumulated = { ...accumulated, system_overhead: systemOverhead };

  const toolOutputBreakdown: ToolOutputBreakdown[] = Array.from(toolOutputByTool.entries())
    .map(([toolName, tokens]) => ({ toolName, tokens }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    agentId, agentName, turnIndex, timestamp, phase,
    tokensByCategory: finalAccumulated,
    estimatedTotal,
    systemOverhead,
    measuredTotal: measuredTotal || estimatedTotal,
    measuredInputTokens: rec.usage?.input_tokens,
    measuredCacheRead: rec.usage?.cache_read_input_tokens,
    measuredCacheCreation: rec.usage?.cache_creation_input_tokens,
    toolOutputByTool: toolOutputBreakdown,
    newInjections,
    isCompactionBoundary,
    compactionDelta,
    compactionSummary,
  };
}

// ── Claude JSONL adapter ──────────────────────────────────────────────────────

interface ClaudeRawBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ClaudeRawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ClaudeRawMessage {
  role: "user" | "assistant";
  model?: string;
  content: string | ClaudeRawBlock[];
  usage?: ClaudeRawUsage;
}

interface ClaudeRawAttachment {
  type: string;
  content?: unknown;
  allowedTools?: string[];
  addedNames?: string[];
}

interface ClaudeRawRecord {
  type: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: ClaudeRawMessage;
  // attachment record
  attachment?: ClaudeRawAttachment;
  // system record
  content?: string;
}

function toMs(ts?: string): number {
  if (!ts) return 0;
  const n = Date.parse(ts);
  return isNaN(n) ? 0 : n;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (typeof b === "string") return b;
      if (b && typeof b === "object" && "text" in b) return String((b as { text?: unknown }).text ?? "");
      return JSON.stringify(b);
    }).join("\n");
  }
  return JSON.stringify(content ?? "");
}

/**
 * Convert a raw Claude JSONL string into normalised ContextRecord[].
 * Now also parses attachment and system records for dynamic injections.
 */
export function claudeJsonlToContextRecords(
  raw: string,
  keepSidechain = false,
): ContextRecord[] {
  const records: ContextRecord[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let r: ClaudeRawRecord;
    try {
      r = JSON.parse(trimmed) as ClaudeRawRecord;
    } catch {
      continue;
    }
    if (r.isMeta) continue;
    if (r.isSidechain && !keepSidechain) continue;

    const timestamp = toMs(r.timestamp);

    // ── attachment records — dynamic injections ───────────────────────────────
    if (r.type === "attachment" && r.attachment) {
      const att = r.attachment;
      switch (att.type) {
        case "skill_listing": {
          const content = typeof att.content === "string" ? att.content : JSON.stringify(att.content ?? "");
          records.push({
            role: "injection", timestamp,
            injectionCategory: "skill_injection",
            injectionLabel: "skill_listing",
            injectionContent: content,
            injectionDynamic: false,
          });
          break;
        }
        case "task_reminder": {
          const content = JSON.stringify(att.content ?? []);
          records.push({
            role: "injection", timestamp,
            injectionCategory: "skill_injection",
            injectionLabel: "task_reminder",
            injectionContent: content,
            injectionDynamic: true,
          });
          break;
        }
        case "command_permissions": {
          const content = JSON.stringify(att);
          records.push({
            role: "injection", timestamp,
            injectionCategory: "skill_injection",
            injectionLabel: "command_permissions",
            injectionContent: content,
            injectionDynamic: false,
          });
          break;
        }
        case "deferred_tools_delta": {
          const names: string[] = att.addedNames ?? [];
          if (names.length > 0) {
            records.push({
              role: "injection", timestamp,
              injectionCategory: "skill_injection",
              injectionLabel: "deferred_tools",
              injectionContent: names.join(", "),
              injectionDynamic: false,
            });
          }
          break;
        }
      }
      continue;
    }

    // ── system records — away_summary etc. ────────────────────────────────────
    if (r.type === "system" && r.subtype === "away_summary" && r.content) {
      records.push({
        role: "injection", timestamp,
        injectionCategory: "system_prompt",
        injectionLabel: "away_summary",
        injectionContent: r.content,
        injectionDynamic: false,
      });
      continue;
    }

    // Skip non-message records
    if (r.type !== "user" && r.type !== "assistant") continue;
    if (!r.message) continue;

    const { message } = r;

    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];

      if (r.isCompactSummary) {
        const summaryText = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
        records.push({
          role: "assistant", timestamp, model: message.model,
          usage: {
            input_tokens: message.usage?.input_tokens,
            cache_read_input_tokens: message.usage?.cache_read_input_tokens,
            cache_creation_input_tokens: message.usage?.cache_creation_input_tokens,
          },
          isCompactSummary: true,
          compactSummaryText: summaryText,
          assistantBlocks: [],
        });
        continue;
      }

      records.push({
        role: "assistant", timestamp, model: message.model,
        usage: {
          input_tokens: message.usage?.input_tokens,
          cache_read_input_tokens: message.usage?.cache_read_input_tokens,
          cache_creation_input_tokens: message.usage?.cache_creation_input_tokens,
        },
        assistantBlocks: blocks
          .filter((b) => ["text", "thinking", "redacted_thinking", "tool_use"].includes(b.type))
          .map((b) => ({ type: b.type, text: b.text, toolName: b.name, toolInput: b.input })),
      });

    } else {
      // user
      const blocks = Array.isArray(message.content) ? message.content : [];
      const hasToolResults = blocks.some((b) => b.type === "tool_result");

      if (hasToolResults) {
        records.push({
          role: "user", timestamp,
          toolResults: blocks
            .filter((b) => b.type === "tool_result")
            .map((b) => ({ toolName: undefined as string | undefined, content: stringifyContent(b.content) })),
        });
      } else {
        const text = typeof message.content === "string"
          ? message.content
          : blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
        records.push({
          role: "user", timestamp,
          userTextContent: text,
          isSlashCommand: isSlashCommandExpansion(text),
        });
      }
    }
  }

  return records;
}

// ── Tool name stitching ───────────────────────────────────────────────────────

export function stitchToolNames(
  raw: string,
  records: ContextRecord[],
  keepSidechain = false,
): void {
  const toolNameById = new Map<string, string>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let r: ClaudeRawRecord;
    try { r = JSON.parse(trimmed) as ClaudeRawRecord; } catch { continue; }
    if (r.isMeta || (r.isSidechain && !keepSidechain)) continue;
    if (r.type !== "assistant" || !r.message) continue;
    const blocks = Array.isArray(r.message.content) ? r.message.content : [];
    for (const b of blocks) {
      if (b.type === "tool_use" && b.id && b.name) toolNameById.set(b.id, b.name);
    }
  }

  // Collect tool_result id sequence in order
  const toolResultIds: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let r: ClaudeRawRecord;
    try { r = JSON.parse(trimmed) as ClaudeRawRecord; } catch { continue; }
    if (r.isMeta || (r.isSidechain && !keepSidechain)) continue;
    if (r.type !== "user" || !r.message) continue;
    const blocks = Array.isArray(r.message.content) ? r.message.content : [];
    for (const b of blocks) {
      if (b.type === "tool_result" && b.tool_use_id) toolResultIds.push(b.tool_use_id);
    }
  }

  let idx = 0;
  for (const rec of records) {
    if (rec.role !== "user" || !rec.toolResults) continue;
    for (const tr of rec.toolResults) {
      if (idx < toolResultIds.length) {
        tr.toolName = toolNameById.get(toolResultIds[idx]) || undefined;
        idx++;
      }
    }
  }
}

// ── Main public API ───────────────────────────────────────────────────────────

export interface SubagentContextInput {
  jsonl: string;
  meta: { agentType?: string; description?: string; name?: string } | null;
}

export function computeAgentContextTraces(
  mainJsonl: string,
  subagents: Record<string, SubagentContextInput> = {},
  _sessionId = "",
  contextLimit = 200_000,
): Map<string, AgentContextTrace> {
  const result = new Map<string, AgentContextTrace>();

  const mainRecords = claudeJsonlToContextRecords(mainJsonl, false);
  stitchToolNames(mainJsonl, mainRecords, false);
  result.set("main", buildTrace({ agentId: "main", agentName: "claude-code", records: mainRecords }, contextLimit));

  for (const [agentId, sub] of Object.entries(subagents)) {
    if (!sub.jsonl) continue;
    const agentName = sub.meta?.name ?? sub.meta?.description ?? agentId.slice(0, 8);
    const records = claudeJsonlToContextRecords(sub.jsonl, true);
    stitchToolNames(sub.jsonl, records, true);
    result.set(agentId, buildTrace({ agentId, agentName, records }, contextLimit));
  }

  return result;
}
