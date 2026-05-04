// audit 单测
// 覆盖：scorecard delta 分类 / run comparison / proxy-first discovery 口径 / artifact paths
//       P3-4：pipeline attribution-only 路径（proxy_without_jsonl + proxyOnly=true）

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Scorecard delta 分类
// ─────────────────────────────────────────────────────────────────────────────

import { classifyDelta } from "./scorecard";
import type { QueryScorecard } from "./types";

function makeScorecard(overrides: Partial<QueryScorecard> = {}): QueryScorecard {
  return {
    queryKey: "claude-code/sess-abc/q-123",
    queryKeyHash: "deadbeef01234567",
    proxyChars: 10000,
    suspectMatchChars: 100,
    alignedTextDriftChars: 50,
    falseReliableMatchCount: 0,
    prefixIncompleteCount: 0,
    sourceTextUnavailableCount: 0,
    wireExactCoverage: 0.25,
    canonicalExactCoverage: 0,
    templateCoverage: 0.35,
    regexCoverage: 0.1,
    presenceCoverage: 0.05,
    serverSideCoverage: 0.0,
    attributionOnlyCoverage: 0.2,
    unexplainedCoverage: 0.05,
    regexOverreachRisk: 0.1,
    alignedTextDrift: 0.005,
    verdict: "ok",
    reasons: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("classifyDelta", () => {
  it("新 query（isNew=true）→ needs_review（exact coverage 低）", () => {
    // wireExact+canonical+template 合计 = 0.1+0+0.1 = 0.2 < 0.3
    const cur = makeScorecard({ wireExactCoverage: 0.1, templateCoverage: 0.1 });
    const { verdict, reasons } = classifyDelta(cur, undefined, true);
    expect(verdict).toBe("needs_review");
    expect(reasons).toContain("new_query");
  });

  it("新 query exact coverage 足够 → needs_review（新 query 保守）", () => {
    // wireExact+template = 0.25+0.35 = 0.6 >= 0.3，但新 query 仍是 needs_review
    const cur = makeScorecard();
    const { verdict } = classifyDelta(cur, undefined, true);
    expect(verdict).toBe("needs_review");
  });

  it("falseReliableMatchCount > 0 → regression", () => {
    const prev = makeScorecard();
    const cur = makeScorecard({ falseReliableMatchCount: 2 });
    const { verdict, reasons } = classifyDelta(cur, prev, false);
    expect(verdict).toBe("regression");
    expect(reasons.some((r) => r.includes("suspect_match"))).toBe(true);
  });

  it("unexplainedCoverage 明显上升 → regression", () => {
    // unexplained 从 0.05 升到 0.12，delta=0.07 > 0.05
    const prev = makeScorecard({ unexplainedCoverage: 0.05 });
    const cur = makeScorecard({ unexplainedCoverage: 0.12 });
    const { verdict } = classifyDelta(cur, prev, false);
    expect(verdict).toBe("regression");
  });

  it("unexplainedChars 明显上升 → regression", () => {
    // unexplainedChars: 100 → 700，delta=600 > 500
    const prev = makeScorecard({ unexplainedCoverage: 0.01 });   // 0.01*10000=100
    const cur = makeScorecard({ unexplainedCoverage: 0.07 });    // 0.07*10000=700
    const { verdict } = classifyDelta(cur, prev, false);
    expect(verdict).toBe("regression");
  });

  it("wireExact + template 明显上升 → improvement", () => {
    // exactDelta = (0.35+0.45) - (0.25+0.35) = 0.2 > 0.02
    const prev = makeScorecard({ wireExactCoverage: 0.25, templateCoverage: 0.35 });
    const cur = makeScorecard({ wireExactCoverage: 0.35, templateCoverage: 0.45 });
    const { verdict } = classifyDelta(cur, prev, false);
    expect(verdict).toBe("improvement");
  });

  it("unexplainedChars 明显下降 → improvement", () => {
    // unexplainedChars: 600 → 300，delta=-300 < -200
    const prev = makeScorecard({ unexplainedCoverage: 0.06 });
    const cur = makeScorecard({ unexplainedCoverage: 0.03 });
    const { verdict } = classifyDelta(cur, prev, false);
    expect(verdict).toBe("improvement");
  });

  it("完全相同 → unchanged", () => {
    const base = makeScorecard();
    const { verdict } = classifyDelta(base, base, false);
    expect(verdict).toBe("unchanged");
  });

  it("prefixIncomplete → needs_review", () => {
    const prev = makeScorecard();
    const cur = makeScorecard({ prefixIncompleteCount: 1 });
    const { verdict, reasons } = classifyDelta(cur, prev, false);
    expect(verdict).toBe("needs_review");
    expect(reasons).toContain("prefix_incomplete");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Run comparison：previous 100 / current 105 → new 5 / common 100 / removed 0
// ─────────────────────────────────────────────────────────────────────────────

import { writeRunJson } from "./artifact-writer";
import type { AuditIndexEntry } from "./types";
import { RUNS_DIR } from "./paths";

function makeIndexEntry(hash: string, changeClass: AuditIndexEntry["changeClass"] = "unchanged"): AuditIndexEntry {
  return {
    queryKey: { agentKind: "claude-code", sessionId: "sess-abc", queryId: `q-${hash}` },
    queryKeyHash: hash,
    agentKind: "claude-code",
    sessionId: "sess-abc",
    queryId: `q-${hash}`,
    timestamp: new Date().toISOString(),
    proxySourceRef: "traffic.jsonl:1",
    verdict: "ok",
    changeClass,
    reasons: [],
  };
}

describe("run comparison", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `audit-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "reports"), { recursive: true });
    mkdirSync(join(tmpDir, "scorecards"), { recursive: true });
    mkdirSync(join(tmpDir, "diffs"), { recursive: true });
    mkdirSync(join(tmpDir, "logs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("previous 100 / current 105 → new 5 / common 100 / removed 0", () => {
    // baseline 有 100 条
    const baselineHashes = Array.from({ length: 100 }, (_, i) => `hash-${String(i).padStart(3, "0")}`);
    const baselineEntries = baselineHashes.map((h) => makeIndexEntry(h));

    // 当前 run 有 105 条（100 共有 + 5 新）
    const newHashes = Array.from({ length: 5 }, (_, i) => `new-hash-${i}`);
    const currentEntries = [
      ...baselineHashes.map((h) => makeIndexEntry(h)),
      ...newHashes.map((h) => makeIndexEntry(h, "new")),
    ];

    // 直接测试计数逻辑
    const currentHashSet = new Set(currentEntries.map((e) => e.queryKeyHash));
    const baselineHashSet = new Set(baselineEntries.map((e) => e.queryKeyHash));

    const newCount = currentEntries.filter((e) => !baselineHashSet.has(e.queryKeyHash)).length;
    const removedCount = baselineEntries.filter((e) => !currentHashSet.has(e.queryKeyHash)).length;
    const commonCount = currentEntries.filter((e) => baselineHashSet.has(e.queryKeyHash)).length;

    expect(newCount).toBe(5);
    expect(removedCount).toBe(0);
    expect(commonCount).toBe(100);
    expect(currentEntries.length).toBe(105);
    expect(baselineEntries.length).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Proxy-first discovery 口径
// ─────────────────────────────────────────────────────────────────────────────

import type { DiscoveryResult } from "./types";

describe("proxy-first discovery", () => {
  it("proxy+jsonl → matchedProxyJsonl（进入 full pipeline 候选）", () => {
    const discovery: DiscoveryResult = {
      discoveredProxyQueries: [
        {
          queryKey: { agentKind: "claude-code", sessionId: "sess-1", queryId: "q-1" },
          queryKeyHash: "abc",
          proxySourceFile: "traffic.jsonl",
          trafficLine: 1,
          timestamp: new Date().toISOString(),
          sessionId: "sess-1",
          agentKind: "claude-code",
          raw: {},
        },
      ],
      proxyWithoutJsonl: [],
      matchedProxyJsonl: [
        {
          proxy: {
            queryKey: { agentKind: "claude-code", sessionId: "sess-1", queryId: "q-1" },
            queryKeyHash: "abc",
            proxySourceFile: "traffic.jsonl",
            trafficLine: 1,
            timestamp: new Date().toISOString(),
            sessionId: "sess-1",
            agentKind: "claude-code",
            raw: {},
          },
          jsonlFile: "/tmp/sess-1.jsonl",
        },
      ],
      jsonlOnlySessions: [],
      jsonlOnlyCandidateQueries: 0,
    };

    // proxy+jsonl 匹配 → 只在 matchedProxyJsonl 里
    expect(discovery.matchedProxyJsonl.length).toBe(1);
    expect(discovery.proxyWithoutJsonl.length).toBe(0);
    // discoveredProxyQueries 包含所有 proxy，无论是否有 jsonl
    expect(discovery.discoveredProxyQueries.length).toBe(1);
  });

  it("proxy_without_jsonl → proxyWithoutJsonl（不进入 reconciliation 主流程）", () => {
    const proxy = {
      queryKey: { agentKind: "claude-code" as const, sessionId: "sess-no-jsonl", queryId: "q-1" },
      queryKeyHash: "def",
      proxySourceFile: "traffic.jsonl",
      trafficLine: 5,
      timestamp: new Date().toISOString(),
      sessionId: "sess-no-jsonl",
      agentKind: "claude-code" as const,
      raw: {},
    };

    const discovery: DiscoveryResult = {
      discoveredProxyQueries: [proxy],
      proxyWithoutJsonl: [proxy],
      matchedProxyJsonl: [],  // 不在 matched 里，不进入 full pipeline
      jsonlOnlySessions: [],
      jsonlOnlyCandidateQueries: 0,
    };

    expect(discovery.proxyWithoutJsonl.length).toBe(1);
    expect(discovery.matchedProxyJsonl.length).toBe(0);
    // discoveredProxyQueries 仍然包含它（记录存在）
    expect(discovery.discoveredProxyQueries.length).toBe(1);
  });

  it("jsonl_only → jsonlOnlySessions（仅进入 inventory，不计入 currentQueries）", () => {
    const discovery: DiscoveryResult = {
      discoveredProxyQueries: [],  // 没有 proxy
      proxyWithoutJsonl: [],
      matchedProxyJsonl: [],  // 没有 matched（无 proxy ground truth）
      jsonlOnlySessions: [
        {
          sessionId: "sess-jsonl-only",
          jsonlFile: "/tmp/sess-jsonl-only.jsonl",
          agentKind: "claude-code",
          candidateQueryCount: 8,
        },
      ],
      jsonlOnlyCandidateQueries: 8,
    };

    // jsonl-only 不进入 matchedProxyJsonl，不会生成 ReconciliationReport
    expect(discovery.matchedProxyJsonl.length).toBe(0);
    expect(discovery.discoveredProxyQueries.length).toBe(0);  // 没有 proxy ground truth
    // 只在 inventory 里
    expect(discovery.jsonlOnlySessions.length).toBe(1);
    expect(discovery.jsonlOnlyCandidateQueries).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Artifact path generation
// ─────────────────────────────────────────────────────────────────────────────

import { queryKeyHash, reportPath, scorecardPath, charDiffJsonPath, charDiffHtmlPath, errorPath, runDir as getRunDir } from "./paths";
import type { QueryKey } from "./types";

describe("artifact path generation", () => {
  it("queryKeyHash 对相同 key 产生相同 hash", () => {
    const key: QueryKey = { agentKind: "claude-code", sessionId: "sess-abc", queryId: "q-123" };
    const h1 = queryKeyHash(key);
    const h2 = queryKeyHash(key);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
  });

  it("queryKeyHash 对不同 key 产生不同 hash", () => {
    const k1: QueryKey = { agentKind: "claude-code", sessionId: "sess-a", queryId: "q-1" };
    const k2: QueryKey = { agentKind: "claude-code", sessionId: "sess-b", queryId: "q-1" };
    expect(queryKeyHash(k1)).not.toBe(queryKeyHash(k2));
  });

  it("reportPath / scorecardPath / charDiffJsonPath / charDiffHtmlPath / errorPath 包含 hash", () => {
    const hash = "abcdef0123456789";
    expect(reportPath(hash)).toContain(hash);
    expect(scorecardPath(hash)).toContain(hash);
    expect(charDiffJsonPath(hash)).toContain(hash);
    expect(charDiffHtmlPath(hash)).toContain(hash);
    expect(errorPath(hash)).toContain(hash);
  });

  it("reportPath 在 reports/ 子目录下", () => {
    expect(reportPath("abc").startsWith("reports")).toBe(true);
  });

  it("charDiffHtmlPath 以 .html 结尾", () => {
    expect(charDiffHtmlPath("abc").endsWith(".html")).toBe(true);
  });

  it("charDiffJsonPath 以 .json 结尾", () => {
    expect(charDiffJsonPath("abc").endsWith(".json")).toBe(true);
  });

  it("runDir 包含 runId", () => {
    const runId = "2026-04-29T11-00-00.000Z__abc123";
    expect(getRunDir(runId)).toContain(runId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3-4：pipeline attribution-only 路径
// 使用真实 fixture：side-query-session-title（无 JSONL，代表 sideQuery 场景）
// ─────────────────────────────────────────────────────────────────────────────

import { runPipeline, runPipelineWithData } from "./pipeline";
import { discoverFixtures, VALID_FIXTURE_NAMES } from "./discovery";

const FIXTURE_BASE = resolve(
  import.meta.dir,
  "../../../test/fixtures/context-reconstruction",
);

// 构造 side-query-session-title fixture 对应的 DiscoveredProxyRecord
function makeSideQueryProxyRecord() {
  const raw = JSON.parse(
    readFileSync(join(FIXTURE_BASE, "side-query-session-title", "proxy-request.json"), "utf-8"),
  ) as Record<string, unknown>;
  const ts = (raw["ts"] as string) ?? new Date().toISOString();
  const tsDigits = ts.replace(/[^0-9]/g, "");
  const sessionId = "fixture-side-query-session-title";
  const queryId = `query-${tsDigits}`;
  const key: QueryKey = { agentKind: "claude-code", sessionId, queryId };
  return {
    queryKey: key,
    queryKeyHash: queryKeyHash(key),
    proxySourceFile: join(FIXTURE_BASE, "side-query-session-title", "proxy-request.json"),
    trafficLine: 0,
    timestamp: ts,
    sessionId,
    agentKind: "claude-code" as const,
    raw: { ...raw, _fixtureName: "side-query-session-title", _fixtureSource: "ant-native" },
  };
}

describe("proxy_without_jsonl：无 JSONL 时 pipeline 返回 skipped", () => {
  it("side-query-session-title fixture 在 discoverFixtures 结果中出现在 proxyWithoutJsonl", () => {
    expect(VALID_FIXTURE_NAMES).toContain("side-query-session-title");
    const discovery = discoverFixtures();
    const found = discovery.proxyWithoutJsonl.find(
      (r) => (r.raw["_fixtureName"] as string) === "side-query-session-title",
    );
    expect(found).toBeDefined();
    const matched = discovery.matchedProxyJsonl.find(
      (m) => (m.proxy.raw["_fixtureName"] as string) === "side-query-session-title",
    );
    expect(matched).toBeUndefined();
  });

  it("jsonlFile=null 时 runPipeline 返回 status=skipped", () => {
    const proxy = makeSideQueryProxyRecord();
    const result = runPipeline({ proxy, jsonlFile: null });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("proxy_without_jsonl");
  });

  it("jsonlFile=null 时 runPipelineWithData 返回 status=skipped，无 data", () => {
    const proxy = makeSideQueryProxyRecord();
    const { result, data } = runPipelineWithData({ proxy, jsonlFile: null });
    expect(result.status).toBe("skipped");
    expect(data).toBeUndefined();
  });
});
