// Scans proxy traffic.jsonl (and compressed archives) to determine which
// sessions have dump coverage, and what SSE event types were captured.
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";

const PROXY_DIR = join(homedir(), ".api-dashboard", "proxy");

export interface ProxyFileSummary {
  filePath: string;
  // ISO timestamp embedded in filename (for archives) or file mtime
  ts: string;
  recordCount: number;
  responseCount: number;
  sseEventCount: number;
  // session IDs found (from reqBody claude-session-id header)
  sessionIds: Set<string>;
  sseEventTypes: Set<string>;
}

export interface ProxyScanResult {
  files: ProxyFileSummary[];
  allSessionIds: Set<string>;
  allSseEventTypes: Set<string>;
  totalSseEvents: number;
  // Which recent sessions have >= 1 response record?
  coveredSessionIds: Set<string>;
}

async function streamLines(filePath: string): Promise<readline.Interface> {
  let inputStream: Readable;
  if (filePath.endsWith(".gz")) {
    const raw = createReadStream(filePath);
    inputStream = raw.pipe(createGunzip()) as unknown as Readable;
  } else {
    inputStream = createReadStream(filePath, { encoding: "utf8" });
  }
  return readline.createInterface({ input: inputStream, crlfDelay: Infinity });
}

async function scanProxyFile(filePath: string): Promise<ProxyFileSummary | null> {
  try {
    statSync(filePath);
  } catch {
    return null;
  }

  // Extract timestamp from filename if it looks like traffic.jsonl.2026-05-09T...
  const tsMatch = filePath.match(/traffic\.jsonl\.(\d{4}-\d{2}-\d{2}T[\d-]+Z)/);
  const ts = tsMatch ? tsMatch[1].replace(/-(\d{2})-(\d{2})-(\d{2})Z$/, ":$1:$2:$3Z") : new Date(statSync(filePath).mtimeMs).toISOString();

  let recordCount = 0;
  let responseCount = 0;
  let sseEventCount = 0;
  const sessionIds = new Set<string>();
  const sseEventTypes = new Set<string>();

  let rl: readline.Interface;
  try {
    rl = await streamLines(filePath);
  } catch {
    return null;
  }

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    recordCount++;

    const kind = obj.kind as string;
    if (kind === "response") responseCount++;
    if (kind === "sse_event") {
      sseEventCount++;
      const et = (obj.sseEventType as string) ?? "unknown";
      sseEventTypes.add(et);
    }

    // Extract session ID from reqHeaders if present
    const reqHeaders = obj.reqHeaders as Record<string, string> | undefined;
    if (reqHeaders) {
      const sid =
        reqHeaders["x-session-id"] ??
        reqHeaders["claude-session-id"] ??
        reqHeaders["x-claude-session-id"];
      if (sid) sessionIds.add(sid);
    }
    // Also check meta.sessionId written by the extractor
    const meta = obj.meta as Record<string, unknown> | undefined;
    if (meta?.sessionId && typeof meta.sessionId === "string") {
      sessionIds.add(meta.sessionId);
    }
  }

  return { filePath, ts, recordCount, responseCount, sseEventCount, sessionIds, sseEventTypes };
}

function getProxyFiles(): string[] {
  if (!existsSync(PROXY_DIR)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(PROXY_DIR)) {
    if (entry === "traffic.jsonl" || (entry.startsWith("traffic.jsonl.") && !entry.endsWith(".pid"))) {
      files.push(join(PROXY_DIR, entry));
    }
  }
  // Sort so current file last
  files.sort();
  return files;
}

export async function scanProxyTraffic(): Promise<ProxyScanResult> {
  const proxyFiles = getProxyFiles();
  const summaries: ProxyFileSummary[] = [];
  const allSessionIds = new Set<string>();
  const allSseEventTypes = new Set<string>();
  let totalSseEvents = 0;

  for (const f of proxyFiles) {
    const summary = await scanProxyFile(f);
    if (!summary) continue;
    summaries.push(summary);
    for (const s of summary.sessionIds) allSessionIds.add(s);
    for (const et of summary.sseEventTypes) allSseEventTypes.add(et);
    totalSseEvents += summary.sseEventCount;
  }

  return {
    files: summaries,
    allSessionIds,
    allSseEventTypes,
    totalSseEvents,
    coveredSessionIds: allSessionIds,
  };
}
