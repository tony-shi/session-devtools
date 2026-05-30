// Single source of truth for tool color palettes.
//
// Each tool has one palette consumed in three places:
//   - chip   ({ fg, bg, border })  → JSONL chain rows, transition bridges, etc.
//   - accent (solid)               → heatmap legend, ECharts series, list bars
//
// Tool names that share semantics (Task→Agent, MultiEdit→Edit, etc.) collapse
// through `classifyToolName` so callers never need to special-case aliases.

export interface ToolPalette {
  /** Solid accent color — used for heatmap legends, ECharts series, bar fills. */
  accent: string;
  /** Foreground text color for chip / label use. */
  fg: string;
  /** Soft background tint for chip. */
  bg: string;
  /** Border for chip. */
  border: string;
}

const PALETTES: Record<string, ToolPalette> = {
  // file-read
  Read:      { accent: "#2563eb", fg: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
  // file-create
  Write:     { accent: "#16a34a", fg: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
  // file-modify
  Edit:      { accent: "#ea580c", fg: "#ea580c", bg: "#fff7ed", border: "#fed7aa" },
  // exec
  Bash:      { accent: "#d97706", fg: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  // search (Grep / Glob share one bucket)
  Grep:      { accent: "#4f46e5", fg: "#4f46e5", bg: "#eef2ff", border: "#c7d2fe" },
  Glob:      { accent: "#4f46e5", fg: "#4f46e5", bg: "#eef2ff", border: "#c7d2fe" },
  // sub-agent (Agent / Task share the sub-agent semantic purple)
  Agent:     { accent: "#a855f7", fg: "#a855f7", bg: "#faf5ff", border: "#e9d5ff" },
  // web
  WebFetch:  { accent: "#0891b2", fg: "#0891b2", bg: "#ecfeff", border: "#a5f3fc" },
};

const FALLBACK: ToolPalette = { accent: "#64748b", fg: "#6b7280", bg: "#f9fafb", border: "#e5e7eb" };

/** Collapse aliases to their canonical bucket (Task → Agent, MultiEdit → Edit, etc.). */
export function classifyToolName(name: string): string {
  const base = name.trim().match(/^([A-Za-z_]+)/)?.[1] ?? name.split(/\s|\(/)[0] ?? name;
  if (base === "NotebookWrite") return "Write";
  if (base === "MultiEdit")     return "Edit";
  if (base === "Task")          return "Agent";
  if (base === "WebSearch")     return "WebFetch";
  if (base === "grep")          return "Grep";
  return base;
}

export function getToolPalette(name: string): ToolPalette {
  return PALETTES[classifyToolName(name)] ?? FALLBACK;
}
