// ─── Model context window lookup ─────────────────────────────────────────────
// Maps known model name substrings to their context window sizes (in tokens).
// Match is done in order: first substring match wins.
// Source: Anthropic docs as of 2026-05.

const MODEL_CONTEXT_WINDOWS: Array<{ match: string; contextWindow: number }> = [
  // Claude 4 family
  { match: "claude-opus-4-7",    contextWindow: 200_000 },
  { match: "claude-opus-4-6",    contextWindow: 200_000 },
  { match: "claude-sonnet-4-6",  contextWindow: 200_000 },
  { match: "claude-haiku-4-5",   contextWindow: 200_000 },
  // Claude 3.7 / 3.5 family
  { match: "claude-3-7-sonnet",  contextWindow: 200_000 },
  { match: "claude-3-5-sonnet",  contextWindow: 200_000 },
  { match: "claude-3-5-haiku",   contextWindow: 200_000 },
  { match: "claude-3-opus",      contextWindow: 200_000 },
  { match: "claude-3-haiku",     contextWindow: 200_000 },
  // Bedrock / Vertex variant names
  { match: "claude-sonnet-4",    contextWindow: 200_000 },
  { match: "claude-opus-4",      contextWindow: 200_000 },
];

export function getContextWindowSize(model: string): number {
  if (!model) return 200_000; // conservative default for unknown Claude models
  const lower = model.toLowerCase();
  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (lower.includes(entry.match.toLowerCase())) return entry.contextWindow;
  }
  return 200_000;
}

// ─── Model display name normalisation ────────────────────────────────────────

export function normaliseModelName(model: string): string {
  if (!model || model === "<synthetic>") return "unknown";
  // Strip Bedrock/Vertex prefixes like "aws." or "gcp."
  return model.replace(/^(aws|gcp|azure)\./i, "");
}
