// Shared types mirroring packages/agent-viz/src/ir/context.ts
// (imported via API response — no direct package import needed here)

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

// TODO-1 (proxy integration): When proxy dump data is available, this field
// will be populated by the server /context endpoint after merging
// ~/.api-dashboard/proxy-dumps/<session-id>/calls/*.json and snapshots/*.json.
// See token_tracking.md §TODO-1 for the full field spec.
export interface ProxySystemBlock {
  label: string;       // "base_instructions" | "main_system_prompt" | "billing_header" | ...
  text: string;        // full original text — enables display, search, annotation
  tokens: number;
  hasCache: boolean;
  changed: boolean;    // differs from previous call
}

export interface ProxyData {
  // system[] complete text (from snapshots/*.json)
  systemBlocks: ProxySystemBlock[];
  // tools[] name list and token count (from calls/*.json)
  tools: {
    count: number;
    tokensEstimate: number;
    names: string[];
    changed: boolean;
  };
  // raw usage direct from API response (more precise than JSONL)
  rawUsage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
  };
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
  /** system_overhead = measuredTotal - estimatedTotal */
  systemOverhead: number;
  /** estimatedTotal + systemOverhead */
  measuredTotal: number;
  measuredInputTokens?: number;
  measuredCacheRead?: number;
  measuredCacheCreation?: number;
  toolOutputByTool: ToolOutputBreakdown[];
  newInjections: InjectionEvent[];
  isCompactionBoundary?: boolean;
  compactionDelta?: { pre: number; post: number };
  compactionSummary?: string;
  // TODO-1: populated when proxy dump is available for this session/turn
  proxyData?: ProxyData;
}

export interface AgentContextTrace {
  agentId: string;
  agentName: string;
  snapshots: ContextSnapshot[];
  totalPhases: number;
  contextLimit: number;
}

export const CATEGORY_COLORS: Record<ContextCategory, string> = {
  system_prompt:    "#6366f1", // indigo
  claude_md:        "#8b5cf6", // violet
  user_message:     "#3b82f6", // blue
  mentioned_file:   "#06b6d4", // cyan
  tool_output:      "#f59e0b", // amber
  thinking_text:    "#10b981", // emerald
  task_coordination:"#ec4899", // pink
  skill_injection:  "#f97316", // orange
  system_overhead:  "#d1d5db", // gray — unknowable gap
};

export const CATEGORY_LABELS: Record<ContextCategory, string> = {
  system_prompt:    "System",
  claude_md:        "CLAUDE.md",
  user_message:     "User msgs",
  mentioned_file:   "@Files",
  tool_output:      "Tool output",
  thinking_text:    "Thinking",
  task_coordination:"Task coord",
  skill_injection:  "Skills/Tasks",
  system_overhead:  "System overhead",
};

/** Categories shown in the stacked area (system_overhead rendered separately as hatched top) */
export const ALL_CATEGORIES: ContextCategory[] = [
  "system_prompt",
  "claude_md",
  "user_message",
  "mentioned_file",
  "tool_output",
  "thinking_text",
  "task_coordination",
  "skill_injection",
];

/** All categories including overhead, for legend/fill bar */
export const ALL_CATEGORIES_WITH_OVERHEAD: ContextCategory[] = [
  ...ALL_CATEGORIES,
  "system_overhead",
];
