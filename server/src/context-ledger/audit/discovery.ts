// Proxy-first discovery
//
// 优先级：
//   1. 从 traffic.jsonl 扫描 kind=response 的 /v1/messages 记录（含 reqBody）
//   2. 对每条 proxy record 尝试找对应 JSONL session
//   3. JSONL-only sessions 仅进入 inventory，不进入主流程

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { queryKeyHash } from "./paths";
import type { AgentKind } from "../types";
import type {
  DiscoveredJsonlSession,
  DiscoveredProxyRecord,
  DiscoveryResult,
  QueryKey,
} from "./types";

// Claude JSONL 默认存放路径
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
// proxy traffic.jsonl
const TRAFFIC_LOG = join(homedir(), ".api-dashboard", "proxy", "traffic.jsonl");

// fixture 测试模式：从 server/test/fixtures/context-reconstruction 加载
// import.meta.dir = server/src/context-ledger/audit → 走 3 级到 server/ → test/...
const FIXTURE_BASE = resolve(
  import.meta.dir,
  "../../../test/fixtures/context-reconstruction",
);
export const VALID_FIXTURE_NAMES = [
  "single-tool-call",
  "large-tool-output",
  "multi-turn-human",
  "system-tools-overhead",
];

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：从 traffic record 提取 session ID
// ─────────────────────────────────────────────────────────────────────────────

function extractSessionIdFromHeaders(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;
  // Claude Code 注入的 session header（大小写不敏感查找）
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "x-claude-code-session-id" && v) return v;
  }
  return null;
}

function detectAgentKind(headers: Record<string, string> | undefined): AgentKind {
  if (!headers) return "unknown";
  const ua = headers["User-Agent"] || headers["user-agent"] || "";
  if (ua.includes("claude-cli") || ua.includes("claude-code")) return "claude-code";
  if (ua.includes("codex")) return "codex";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// 核心：扫描 traffic.jsonl 提取 proxy records
// ─────────────────────────────────────────────────────────────────────────────

export async function scanProxyRecords(opts?: {
  trafficFile?: string;
  sinceTs?: string;  // ISO 时间戳，只处理 >= sinceTs 的记录
}): Promise<DiscoveredProxyRecord[]> {
  const file = opts?.trafficFile ?? TRAFFIC_LOG;
  if (!existsSync(file)) return [];

  const results: DiscoveredProxyRecord[] = [];
  let lineNo = 0;

  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // 只处理 kind=response 的 /v1/messages 记录（reqBody 在 response 记录里）
    const url = (record["url"] as string | undefined) ?? "";
    const kind = record["kind"] as string | undefined;
    if (kind !== "response") continue;
    if (!url.includes("/v1/messages")) continue;

    const reqBodyRaw = record["reqBody"];
    if (!reqBodyRaw) continue;

    // B1.3: 兼容 base64 编码的 reqBody（proxy 落盘时若是二进制走 base64 分支）
    const reqBodyEncoding = (record["reqBodyEncoding"] as string | undefined) ?? "utf8";
    let reqBodyText: string | null = null;
    if (typeof reqBodyRaw === "string") {
      if (reqBodyEncoding === "base64") {
        try { reqBodyText = Buffer.from(reqBodyRaw, "base64").toString("utf8"); }
        catch { continue; }
      } else {
        reqBodyText = reqBodyRaw;
      }
    }

    let reqBody: Record<string, unknown>;
    try {
      reqBody = reqBodyText !== null
        ? (JSON.parse(reqBodyText) as Record<string, unknown>)
        : (reqBodyRaw as Record<string, unknown>);
    } catch {
      continue;
    }

    const ts = (record["ts"] as string | undefined) ?? new Date().toISOString();
    const startedAt = (record["startedAt"] as string | undefined) ?? ts;

    // 过滤旧记录
    if (opts?.sinceTs && ts < opts.sinceTs) continue;

    const headers = record["reqHeaders"] as Record<string, string> | undefined;
    const sessionId = extractSessionIdFromHeaders(headers) ?? "unknown";
    const agentKind = detectAgentKind(headers);

    // queryId 使用与 proxy-snapshot-parser 相同的算法
    const tsDigits = startedAt.replace(/[^0-9]/g, "");
    const queryId = `query-${tsDigits}-${lineNo}`;

    const key: QueryKey = { agentKind, sessionId, queryId };
    const hash = queryKeyHash(key);

    results.push({
      queryKey: key,
      queryKeyHash: hash,
      proxySourceFile: file,
      trafficLine: lineNo,
      timestamp: startedAt,
      sessionId,
      agentKind,
      raw: { ...record, reqBody },
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 匹配：为每个 proxy record 找对应 JSONL 文件
// ─────────────────────────────────────────────────────────────────────────────

function findJsonlForSession(sessionId: string): string | null {
  if (sessionId === "unknown") return null;

  // ~/.claude/projects/<sanitized-path>/<sessionId>.jsonl
  // 扫描所有 project 子目录
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;

  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(CLAUDE_PROJECTS_DIR, e.name));

  for (const dir of projectDirs) {
    const candidate = join(dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONL-only sessions 枚举
// ─────────────────────────────────────────────────────────────────────────────

function countJsonlCandidateQueries(jsonlFile: string): number {
  try {
    const lines = readFileSync(jsonlFile, "utf-8").split("\n");
    let count = 0;
    const seenQueryIds = new Set<string>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        // promptId 出现一次 = 一次 query boundary
        const pid = rec["promptId"] as string | undefined;
        if (pid && !seenQueryIds.has(pid)) {
          seenQueryIds.add(pid);
          count++;
        }
      } catch { /* skip */ }
    }
    return count;
  } catch {
    return 0;
  }
}

function scanJsonlOnlySessions(proxySessionIds: Set<string>): DiscoveredJsonlSession[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const result: DiscoveredJsonlSession[] = [];
  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(CLAUDE_PROJECTS_DIR, e.name));

  for (const dir of projectDirs) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    for (const f of files) {
      const sessionId = f.replace(/\.jsonl$/, "");
      if (proxySessionIds.has(sessionId)) continue;  // 已被 proxy 覆盖
      const jsonlFile = join(dir, f);
      const candidateQueryCount = countJsonlCandidateQueries(jsonlFile);
      result.push({
        sessionId,
        jsonlFile,
        agentKind: "claude-code",  // 默认假设，后续可从 JSONL 推断
        candidateQueryCount,
      });
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主入口：普通本地模式 discovery
// ─────────────────────────────────────────────────────────────────────────────

export async function discoverLocal(opts?: {
  trafficFile?: string;
  sinceTs?: string;
}): Promise<DiscoveryResult> {
  const proxyRecords = await scanProxyRecords(opts);

  const matchedProxyJsonl: DiscoveryResult["matchedProxyJsonl"] = [];
  const proxyWithoutJsonl: DiscoveredProxyRecord[] = [];
  const proxySessionIds = new Set<string>();

  for (const proxy of proxyRecords) {
    proxySessionIds.add(proxy.sessionId);
    const jsonlFile = findJsonlForSession(proxy.sessionId);
    if (jsonlFile) {
      matchedProxyJsonl.push({ proxy, jsonlFile });
    } else {
      proxyWithoutJsonl.push(proxy);
    }
  }

  const jsonlOnlySessions = scanJsonlOnlySessions(proxySessionIds);
  const jsonlOnlyCandidateQueries = jsonlOnlySessions.reduce(
    (s, x) => s + x.candidateQueryCount, 0,
  );

  return {
    discoveredProxyQueries: proxyRecords,
    proxyWithoutJsonl,
    matchedProxyJsonl,
    jsonlOnlySessions,
    jsonlOnlyCandidateQueries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 模式 discovery（用 server/test/fixtures 数据）
// ─────────────────────────────────────────────────────────────────────────────

export function discoverFixtures(fixtureNames?: string[]): DiscoveryResult {
  const names = fixtureNames ?? VALID_FIXTURE_NAMES;
  const matchedProxyJsonl: DiscoveryResult["matchedProxyJsonl"] = [];
  const proxyWithoutJsonl: DiscoveredProxyRecord[] = [];

  for (const name of names) {
    const proxyFile = join(FIXTURE_BASE, name, "proxy-request.json");
    const jsonlFile = join(FIXTURE_BASE, name, "session.jsonl");

    if (!existsSync(proxyFile)) continue;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(proxyFile, "utf-8")) as Record<string, unknown>;
    } catch {
      continue;
    }

    const ts = (raw["ts"] as string | undefined) ?? new Date().toISOString();
    const tsDigits = ts.replace(/[^0-9]/g, "");
    const sessionId = `fixture-${name}`;
    const queryId = `query-${tsDigits}`;
    const key: QueryKey = { agentKind: "claude-code", sessionId, queryId };
    const hash = queryKeyHash(key);

    const proxy: DiscoveredProxyRecord = {
      queryKey: key,
      queryKeyHash: hash,
      proxySourceFile: proxyFile,
      trafficLine: 0,
      timestamp: ts,
      sessionId,
      agentKind: "claude-code",
      raw,
    };

    if (existsSync(jsonlFile)) {
      matchedProxyJsonl.push({ proxy, jsonlFile });
    } else {
      proxyWithoutJsonl.push(proxy);
    }
  }

  return {
    discoveredProxyQueries: [
      ...matchedProxyJsonl.map((m) => m.proxy),
      ...proxyWithoutJsonl,
    ],
    proxyWithoutJsonl,
    matchedProxyJsonl,
    jsonlOnlySessions: [],
    jsonlOnlyCandidateQueries: 0,
  };
}
