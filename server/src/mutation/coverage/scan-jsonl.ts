// Scans all Claude Code JSONL files to collect event type distributions and
// per-session coverage info. Used by the coverage report script.
import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import type { EventTypeInfo, SessionCoverageInfo } from "./types";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface ScanResult {
  globalTypeCounts: Map<string, number>; // key = "type" or "type::subKey::subVal"
  examples: Map<string, string>; // key -> example JSON snippet
  sessions: SessionCoverageInfo[];
  allFiles: string[];
}

function makeKey(type: string, sub?: string, val?: string): string {
  if (sub && val) return `${type}::${sub}::${val}`;
  return type;
}

async function scanFile(
  filePath: string,
  globalTypeCounts: Map<string, number>,
  examples: Map<string, string>,
): Promise<SessionCoverageInfo | null> {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }

  const sessionId = filePath.split("/").pop()!.replace(/\.jsonl$/, "");
  const typesPresent = new Set<string>();
  const subTypesPresent = new Set<string>();

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const type = (obj.type as string) ?? "UNKNOWN";
    const typeKey = type;
    globalTypeCounts.set(typeKey, (globalTypeCounts.get(typeKey) ?? 0) + 1);
    typesPresent.add(typeKey);

    if (!examples.has(typeKey)) {
      // Build a minimal example that excludes large fields
      const mini: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "message" || k === "snapshot" || k === "fileStates" || k === "replacements") {
          mini[k] = Array.isArray(v) ? "[...]" : typeof v === "object" ? "{...}" : v;
        } else if (k === "attachment" && typeof v === "object" && v !== null) {
          mini[k] = { type: (v as Record<string, unknown>).type };
        } else {
          const str = JSON.stringify(v);
          mini[k] = str && str.length > 200 ? str.slice(0, 197) + "…" : v;
        }
      }
      examples.set(typeKey, JSON.stringify(mini, null, 2).slice(0, 600));
    }

    // Drill into system.subtype
    if (type === "system" && typeof obj.subtype === "string") {
      const sub = obj.subtype;
      const subKey = makeKey("system", "subtype", sub);
      globalTypeCounts.set(subKey, (globalTypeCounts.get(subKey) ?? 0) + 1);
      subTypesPresent.add(subKey);
      if (!examples.has(subKey)) {
        const mini: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k === "message") continue;
          const str = JSON.stringify(v);
          mini[k] = str && str.length > 200 ? str.slice(0, 197) + "…" : v;
        }
        examples.set(subKey, JSON.stringify(mini, null, 2).slice(0, 600));
      }
    }

    // Drill into attachment.type
    if (type === "attachment" && typeof obj.attachment === "object" && obj.attachment !== null) {
      const att = obj.attachment as Record<string, unknown>;
      if (typeof att.type === "string") {
        const sub = att.type;
        const subKey = makeKey("attachment", "type", sub);
        globalTypeCounts.set(subKey, (globalTypeCounts.get(subKey) ?? 0) + 1);
        subTypesPresent.add(subKey);
        if (!examples.has(subKey)) {
          examples.set(
            subKey,
            JSON.stringify({ type: "attachment", attachment: { type: sub } }, null, 2),
          );
        }
      }
    }
  }

  const score = typesPresent.size + subTypesPresent.size;
  return {
    sessionId,
    filePath,
    modifiedAt: stat.mtimeMs,
    sizeBytes: stat.size,
    typesPresent: [...typesPresent],
    subTypesPresent: [...subTypesPresent],
    score,
  };
}

function collectJsonlFiles(dir: string, results: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectJsonlFiles(full, results);
    } else if (entry.endsWith(".jsonl")) {
      results.push(full);
    }
  }
  return results;
}

export async function scanAllJsonl(): Promise<ScanResult> {
  const globalTypeCounts = new Map<string, number>();
  const examples = new Map<string, string>();
  const sessions: SessionCoverageInfo[] = [];

  const allFiles = collectJsonlFiles(CLAUDE_PROJECTS_DIR);
  // history.jsonl is not a session file
  const sessionFiles = allFiles.filter((f) => !f.endsWith("history.jsonl"));

  for (const f of sessionFiles) {
    const session = await scanFile(f, globalTypeCounts, examples);
    if (session) sessions.push(session);
  }

  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);

  return { globalTypeCounts, examples, sessions, allFiles: sessionFiles };
}
