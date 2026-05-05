// Proxy-first discovery
//
// 优先级：
//   1. 从 traffic.jsonl 扫描 kind=response 的 /v1/messages 记录（含 reqBody）
//   2. 对每条 proxy record 尝试找对应 JSONL session
//   3. JSONL-only sessions 仅进入 inventory，不进入主流程

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
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
  "task-reminder-smoosh",
  // billing + identity 正向 materialization 最小验证 fixture（side_query / session-title 类型）
  "billing-identity-materialization",
  // side-query-session-title 无 JSONL，进入 proxyWithoutJsonl 分支（--proxy-only 下走 attribution-only 路径）
  "side-query-session-title",
  // @file 首次 mention：session 首轮，attachment.type=file，验证 file-attachment rule 重建
  "file-attachment-first-mention",
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

// 枚举 traffic.jsonl 及同目录下所有 rotation 文件（traffic.jsonl.<timestamp>）
// 按文件名排序（rotation 文件名含 ISO 时间戳，字典序 = 时间序）
function listTrafficFiles(trafficFile: string): string[] {
  const dir = dirname(trafficFile);
  const base = basename(trafficFile);
  const files: string[] = [];

  if (!existsSync(dir)) return [];

  // rotation 文件：base.<timestamp>，如 traffic.jsonl.2026-05-01T07-11-35-020Z
  const rotated = readdirSync(dir)
    .filter((f) => f.startsWith(base + ".") && f !== base)
    .sort()  // ISO timestamp 字典序 = 时间序，旧 → 新
    .map((f) => join(dir, f));

  files.push(...rotated);

  // 当前活跃文件最后读（包含最新记录）
  if (existsSync(trafficFile)) files.push(trafficFile);

  return files;
}

// 从单个文件读取 proxy records，返回结果及最大行号（用于 lineNo 去重）
async function scanSingleFile(
  file: string,
  sinceTs: string | undefined,
  seenQueryHashes: Set<string>,
): Promise<DiscoveredProxyRecord[]> {
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

    // P0-3：同时保留原始字符串，供 proxy-snapshot-parser 计算 wire bytes hash。
    // rawReqBodyText 是 proxy 落盘的原始 UTF-8 字符串（未被 parse 修改）。
    const rawReqBodyText = reqBodyText;

    const ts = (record["ts"] as string | undefined) ?? new Date().toISOString();
    const startedAt = (record["startedAt"] as string | undefined) ?? ts;

    // sinceTs 过滤
    if (sinceTs && ts < sinceTs) continue;

    const headers = record["reqHeaders"] as Record<string, string> | undefined;
    const sessionId = extractSessionIdFromHeaders(headers) ?? "unknown";
    const agentKind = detectAgentKind(headers);

    // queryId 使用与 proxy-snapshot-parser 相同的算法
    // lineNo 在同一文件内唯一；跨文件用 file+lineNo 组合去重
    const tsDigits = startedAt.replace(/[^0-9]/g, "");
    const queryId = `query-${tsDigits}-${lineNo}`;
    const key: QueryKey = { agentKind, sessionId, queryId };
    const hash = queryKeyHash(key);

    // 跨 rotation 文件去重：相同 queryId（即相同时间戳+行号）只保留第一次出现
    if (seenQueryHashes.has(hash)) continue;
    seenQueryHashes.add(hash);

    results.push({
      queryKey: key,
      queryKeyHash: hash,
      proxySourceFile: file,
      trafficLine: lineNo,
      timestamp: startedAt,
      sessionId,
      agentKind,
      // P0-3：保留三层 body —— parsedReqBody（供 parser 使用）和 rawReqBodyText（供 wire hash 计算）
      raw: { ...record, reqBody, _rawReqBodyText: rawReqBodyText },
    });
  }

  return results;
}

export async function scanProxyRecords(opts?: {
  trafficFile?: string;
  sinceTs?: string;  // ISO 时间戳，只处理 >= sinceTs 的记录
}): Promise<DiscoveredProxyRecord[]> {
  const mainFile = opts?.trafficFile ?? TRAFFIC_LOG;
  // 扫描主文件 + 所有 rotation 备份（traffic.jsonl.<timestamp>）
  const files = listTrafficFiles(mainFile);
  if (files.length === 0) return [];

  const all: DiscoveredProxyRecord[] = [];
  const seenQueryHashes = new Set<string>();

  for (const file of files) {
    const records = await scanSingleFile(file, opts?.sinceTs, seenQueryHashes);
    all.push(...records);
  }

  // 按 timestamp 升序排列，保持与单文件时相同的时间顺序语义
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
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
  /** 只处理指定 sessionId 的 proxy records（用于聚焦单 session 调试） */
  sessionFilter?: string;
}): Promise<DiscoveryResult> {
  let proxyRecords = await scanProxyRecords(opts);
  if (opts?.sessionFilter) {
    proxyRecords = proxyRecords.filter((r) => r.sessionId === opts.sessionFilter);
  }

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
// Fixture 来源检测（T0 fixture matrix）
// ─────────────────────────────────────────────────────────────────────────────

export type FixtureSource = "ant-native" | "external" | "synthetic" | "unknown";

/**
 * 根据 proxy-request.json 的 sni/url 字段推断 fixture 录制来源。
 * ant-native：通过 Anthropic 内部代理（internal-proxy.example / api.internal-proxy.example / *.anthropic.com）录制。
 * external：通过外部公开 Claude Code 录制（api.anthropic.com + 非内部域名）。
 * synthetic：手写/合成的测试 fixture，通常无真实 sni 或 url。
 */
function detectFixtureSource(raw: Record<string, unknown>): FixtureSource {
  const sni = (raw["sni"] as string | undefined) ?? "";
  const url = (raw["url"] as string | undefined) ?? "";
  if (sni.includes("internal-proxy") || sni.includes("internal-proxy.example") || url.includes("internal-proxy") || url.includes("internal-proxy.example")) {
    return "ant-native";
  }
  if (sni.includes("anthropic.com") || url.includes("api.anthropic.com")) {
    return "external";
  }
  if (!sni && !url.startsWith("http")) {
    return "synthetic";
  }
  return "unknown";
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
    let proxyFileText: string;
    try {
      proxyFileText = readFileSync(proxyFile, "utf-8");
      raw = JSON.parse(proxyFileText) as Record<string, unknown>;
    } catch {
      continue;
    }

    const ts = (raw["ts"] as string | undefined) ?? new Date().toISOString();
    const tsDigits = ts.replace(/[^0-9]/g, "");
    const sessionId = `fixture-${name}`;
    const queryId = `query-${tsDigits}`;
    const key: QueryKey = { agentKind: "claude-code", sessionId, queryId };
    const hash = queryKeyHash(key);

    const fixtureSource = detectFixtureSource(raw);

    // P0-3：fixture 的 reqBody 内嵌在 proxy-request.json 的 "reqBody" 字段中。
    // 真实流量中 _rawReqBodyText 是 proxy 落盘的原始 UTF-8 字符串；fixture 场景下
    // 最接近的等价是把 reqBody 字段重新序列化，保证 rawRequestBytesHash 非 null。
    const fixtureReqBody = raw["reqBody"];
    const fixtureRawReqBodyText = fixtureReqBody !== undefined
      ? JSON.stringify(fixtureReqBody)
      : undefined;

    const proxy: DiscoveredProxyRecord = {
      queryKey: key,
      queryKeyHash: hash,
      proxySourceFile: proxyFile,
      trafficLine: 0,
      timestamp: ts,
      sessionId,
      agentKind: "claude-code",
      // _fixtureSource 元字段（不影响 pipeline，仅供 audit 报告的 fixture matrix 使用）
      // _rawReqBodyText 用于 proxy-snapshot-parser 计算 rawRequestBytesHash（P0-3）
      raw: { ...raw, _fixtureName: name, _fixtureSource: fixtureSource, _rawReqBodyText: fixtureRawReqBodyText },
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
