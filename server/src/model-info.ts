// ─── Model display name normalisation ────────────────────────────────────────

export function normaliseModelName(model: string): string {
  if (!model || model === "<synthetic>") return "unknown";
  // Strip Bedrock/Vertex prefixes like "aws." or "gcp."
  return model.replace(/^(aws|gcp|azure)\./i, "");
}
