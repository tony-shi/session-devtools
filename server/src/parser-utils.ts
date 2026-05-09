import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

export function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function decodeClaudeProjectHash(hash: string): string {
  return hash.replace(/^-/, "").replace(/-/g, "/").replace(/^Users\/[^/]+\//, "");
}

export async function readGeminiProjectRoot(projectHash: string): Promise<string> {
  const rootFile = join(process.env.HOME ?? "~", ".gemini", "history", projectHash, ".project_root");
  if (existsSync(rootFile)) {
    try { return (await readFile(rootFile, "utf-8")).trim(); } catch {}
  }
  return "";
}
