export function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function decodeClaudeProjectHash(hash: string): string {
  return hash.replace(/^-/, "").replace(/-/g, "/").replace(/^Users\/[^/]+\//, "");
}
