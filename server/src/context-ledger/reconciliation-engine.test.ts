import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { reconcileClaudeContext } from "./reconciliation-engine";
import { inferClaudeProxyAttributions } from "./proxy-attribution";
import { parseClaudeProxyRequest } from "./proxy-snapshot-parser";
import { parseClaudeJsonlMutations } from "./jsonl-mutation-parser";
import { reconstructExpectedClaudeContext } from "./expected-context-reconstructor";
import { MOCK_RECONCILIATION_REPORT } from "./report";
import type { ReconciliationReport } from "./types";

const FIXTURE_DIR = new URL(
  "../../test/fixtures/context-reconstruction",
  import.meta.url,
).pathname;

// ── mock report 验证 ─────────────────────────────────────────────────────────

describe("mock report: schema sanity", () => {
  const mock = MOCK_RECONCILIATION_REPORT;

  test("schemaVersion 正确", () => {
    expect(mock.schemaVersion).toBe("context-ledger.report.v1");
  });

  test("snapshot / expected / attributions 都存在", () => {
    expect(mock.snapshot.segments.length).toBeGreaterThan(0);
    expect(mock.expected!.segments.length).toBeGreaterThan(0);
    expect(mock.proxyAttributions.length).toBeGreaterThan(0);
  });

  test("alignments 覆盖主要 segment", () => {
    expect(mock.alignments.length).toBeGreaterThan(3);
  });

  test("findings 包含 matched / known_noise / unmatched_proxy_segment", () => {
    const types = new Set(mock.findings.map((f) => f.type));
    expect(types.has("matched")).toBe(true);
    expect(types.has("known_noise")).toBe(true);
    expect(types.has("unmatched_proxy_segment")).toBe(true);
  });

  test("coverage 字段完整", () => {
    const c = mock.coverage;
    expect(typeof c.proxyChars).toBe("number");
    expect(typeof c.wireExactCoverage).toBe("number");
    expect(typeof c.templateCoverage).toBe("number");
    expect(typeof c.unexplainedCoverage).toBe("number");
    expect(typeof c.unexplainedChars).toBe("number");
    expect(Array.isArray(c.byCategory)).toBe(true);
  });
});

// ── reconcileClaudeContext 在 mock 输入上运行 ────────────────────────────────

describe("reconcileClaudeContext: mock input", () => {
  const mock = MOCK_RECONCILIATION_REPORT;
  const report = reconcileClaudeContext({
    snapshot: mock.snapshot,
    attributions: mock.proxyAttributions,
    expected: mock.expected,
    fixtureName: "mock",
  });

  test("返回 ReconciliationReport schemaVersion", () => {
    expect(report.schemaVersion).toBe("context-ledger.report.v1");
  });

  test("findings 不为空", () => {
    expect(report.findings.length).toBeGreaterThan(0);
  });

  test("known_noise finding 存在", () => {
    expect(report.findings.some((f) => f.type === "known_noise")).toBe(true);
  });

  test("unmatched_proxy_segment finding 存在（mock 有 pseg-unknown）", () => {
    // mock 里 pseg-unknown category=unknown，attribution confidence=unknown
    // 应产生 unmatched_proxy_segment
    const unmatched = report.findings.filter((f) => f.type === "unmatched_proxy_segment");
    expect(unmatched.length).toBeGreaterThan(0);
  });

  test("coverage.wireExactCoverage + templateCoverage > 0", () => {
    const c = report.coverage;
    expect(c.wireExactCoverage + c.templateCoverage).toBeGreaterThan(0);
  });

  test("attribution-only 和 expected-match 区别：expected-match finding 有 expectedSegmentIds", () => {
    // expected-match: type=matched + expectedSegmentIds set
    const expectedMatched = report.findings.filter(
      (f) =>
        f.type === "matched" &&
        f.expectedSegmentIds &&
        f.expectedSegmentIds.length > 0,
    );
    // mock report expected 有 system_prompt / tools_schema / tool_use / tool_result 等
    expect(expectedMatched.length).toBeGreaterThan(0);
    // attribution-only: 在 fixture 测试里验证（mock expected 覆盖了所有 proxy segment）
    // 这里验证 expected-match 的 finding 有 mutationIds 或 attributionIds
    for (const f of expectedMatched) {
      const hasMutations = (f.mutationIds?.length ?? 0) > 0;
      const hasAlignments = (f.alignmentIds?.length ?? 0) > 0;
      expect(hasMutations || hasAlignments).toBe(true);
    }
  });

  test("每条 finding 都有 id、type、severity、message", () => {
    for (const f of report.findings) {
      expect(typeof f.id).toBe("string");
      expect(typeof f.type).toBe("string");
      expect(typeof f.severity).toBe("string");
      expect(typeof f.message).toBe("string");
    }
  });

  test("每条 alignment 都有 id、matchKind、basis", () => {
    for (const a of report.alignments) {
      expect(typeof a.id).toBe("string");
      expect(typeof a.matchKind).toBe("string");
      expect(typeof a.basis).toBe("string");
    }
  });
});

// ── fixture 驱动测试 ─────────────────────────────────────────────────────────

interface FixtureExpect {
  proxySegmentCount: number;
  expectedSegmentCount: number;
  // 最大 unexplained coverage（< 此值表示大部分 proxy 被覆盖）
  maxUnexplainedCoverage: number;
  // 必须存在的 finding types
  requiredFindingTypes: string[];
  // 是否触发 api_error_retry finding
  hasRetryFinding: boolean;
}

const FIXTURE_CASES: Record<string, FixtureExpect> = {
  // 48 proxy segments（12 system + 34 tools + 2 messages）
  //   system: billing(1) + identity(1) + system[2]→10 sections（prelude+6 static+3 dynamic）
  // expected: 2 segments（skill_listing + user_message）
  // charCoverage ~79%：proxy-attribution.ts 尚未消费 section-level segment id（pseg-system-2-sN），
  //   仍产出 pseg-system-2-{hash} 形式的 attribution，导致 system[2] 的 10 个 section segments
  //   没有被 attribution 覆盖。本阶段只建立 proxy recognition contract，attribution 更新是下一阶段。
  "system-tools-overhead": {
    proxySegmentCount: 48,
    expectedSegmentCount: 2,
    maxUnexplainedCoverage: 0.22,
    requiredFindingTypes: ["known_noise", "unmatched_expected_segment", "api_error_retry"],
    hasRetryFinding: true,
  },
  "single-tool-call": {
    proxySegmentCount: 53,
    expectedSegmentCount: 7,
    maxUnexplainedCoverage: 0.22,
    requiredFindingTypes: ["matched", "known_noise", "unmatched_expected_segment", "api_error_retry"],
    hasRetryFinding: true,
  },
  "multi-turn-human": {
    proxySegmentCount: 73,
    expectedSegmentCount: 9,
    maxUnexplainedCoverage: 0.20,
    requiredFindingTypes: ["matched", "known_noise", "unmatched_expected_segment"],
    hasRetryFinding: false,
  },
  "large-tool-output": {
    proxySegmentCount: 69,
    expectedSegmentCount: 13,
    maxUnexplainedCoverage: 0.16,
    requiredFindingTypes: ["matched", "known_noise", "unmatched_expected_segment"],
    hasRetryFinding: false,
  },
};

function runFixture(caseName: string): ReconciliationReport {
  const proxyRaw = JSON.parse(
    readFileSync(`${FIXTURE_DIR}/${caseName}/proxy-request.json`, "utf8"),
  );
  const jsonlRaw = readFileSync(`${FIXTURE_DIR}/${caseName}/session.jsonl`, "utf8");

  // parseClaudeProxyRequest 产生 ground truth snapshot（segments 是 parser 切出的）
  const snapshot = parseClaudeProxyRequest(proxyRaw, {
    proxyFile: `server/test/fixtures/context-reconstruction/${caseName}/proxy-request.json`,
  });

  // inferClaudeProxyAttributions 会 mutate snapshot.segments（追加 attribution 生成的 segment）
  // 为了让 reconciliation 使用原始 parser segments 作为 ground truth，
  // 把 attribution 跑在一个独立的拷贝上，只取 attributions 数组，不取修改后的 segments。
  const snapForAttr = JSON.parse(JSON.stringify({
    ...snapshot,
    metadata: { ...snapshot.metadata, rawBody: proxyRaw.reqBody },
  })) as typeof snapshot;
  const attributions = inferClaudeProxyAttributions(snapForAttr);

  const parsed = parseClaudeJsonlMutations(jsonlRaw, {
    jsonlFile: `server/test/fixtures/context-reconstruction/${caseName}/session.jsonl`,
  });
  const expected = reconstructExpectedClaudeContext({
    mutations: parsed.mutations,
    boundary: { queryId: `q-${caseName}`, proxyTimestamp: proxyRaw.ts, sessionId: parsed.sessionId },
    fixtureName: caseName,
    hasPreSessionActivity: parsed.hasPreSessionActivity,
  });

  return reconcileClaudeContext({
    snapshot,          // 原始 parser snapshot，segments 未被 attribution 污染
    attributions,
    expected,
    fixtureName: caseName,
  });
}

for (const caseName of Object.keys(FIXTURE_CASES)) {
  const want = FIXTURE_CASES[caseName];

  describe(caseName, () => {
    const report = runFixture(caseName);

    test("proxy segment count 稳定", () => {
      expect(report.snapshot.segments.length).toBe(want.proxySegmentCount);
    });

    test("expected segment count 稳定", () => {
      expect(report.expected!.segments.length).toBe(want.expectedSegmentCount);
    });

    test(`unexplainedCoverage <= ${want.maxUnexplainedCoverage}`, () => {
      expect(report.coverage.unexplainedCoverage).toBeLessThanOrEqual(want.maxUnexplainedCoverage);
    });

    test("必须包含的 finding types 全部出现", () => {
      const types = new Set<string>(report.findings.map((f) => f.type));
      for (const t of want.requiredFindingTypes) {
        expect(types.has(t)).toBe(true);
      }
    });

    test("api_error_retry finding 检查", () => {
      const hasRetry = report.findings.some((f) => f.type === "api_error_retry");
      expect(hasRetry).toBe(want.hasRetryFinding);
    });

    test("unknown segment 不被吞掉（unknown category 产生 unmatched_proxy_segment）", () => {
      const unknownSegs = report.snapshot.segments.filter((s) => s.category === "unknown");
      if (unknownSegs.length > 0) {
        const unmatchedFindings = report.findings.filter(
          (f) =>
            f.type === "unmatched_proxy_segment" &&
            f.proxySegmentIds?.some((id) => unknownSegs.some((s) => s.id === id)),
        );
        expect(unmatchedFindings.length).toBeGreaterThan(0);
      }
    });

    test("coverage byCategory 包含 tools_schema 和 billing_noise", () => {
      const cats = new Set(report.coverage.byCategory?.map((c) => c.category) ?? []);
      expect(cats.has("tools_schema")).toBe(true);
      expect(cats.has("billing_noise")).toBe(true);
    });

    test("所有 finding 都有 id、type、severity、message", () => {
      for (const f of report.findings) {
        expect(typeof f.id).toBe("string");
        expect(typeof f.type).toBe("string");
        expect(typeof f.severity).toBe("string");
        expect(typeof f.message).toBe("string");
      }
    });

    test("alignments 中 expected-match 有 expectedSegmentIds，attribution-only 没有", () => {
      for (const a of report.alignments) {
        if (a.expectedSegmentIds.length > 0) {
          // expected-match: 应有 proxySegmentIds
          expect(a.proxySegmentIds.length).toBeGreaterThan(0);
        } else {
          // attribution-only or known_noise: expectedSegmentIds 为空
          expect(a.expectedSegmentIds.length).toBe(0);
        }
      }
    });
  });
}

// ── 跨 fixture 不变量 ─────────────────────────────────────────────────────────

describe("cross-fixture invariants", () => {
  test("reconcileClaudeContext 在无 expected 时也能运行（attribution-only 模式）", () => {
    const proxyRaw = JSON.parse(
      readFileSync(`${FIXTURE_DIR}/system-tools-overhead/proxy-request.json`, "utf8"),
    );
    const snapshot = parseClaudeProxyRequest(proxyRaw, { proxyFile: "test.json" });
    const snapshotWithBody = { ...snapshot, metadata: { rawBody: proxyRaw.reqBody } };
    const attributions = inferClaudeProxyAttributions(snapshotWithBody);

    const report = reconcileClaudeContext({
      snapshot: snapshotWithBody,
      attributions,
      // expected 不传
    });

    expect(report.schemaVersion).toBe("context-ledger.report.v1");
    // 无 expected 时：wire/template=0，但 serverSide 或 attrOnly 应有值
    const c = report.coverage;
    expect(c.serverSideCoverage + c.attributionOnlyCoverage + c.unexplainedCoverage).toBeGreaterThan(0);
    // 没有 expected → 没有 unmatched_expected_segment
    const unmatchedExpected = report.findings.filter(
      (f) => f.type === "unmatched_expected_segment" && !f.proxySegmentIds?.length,
    );
    expect(unmatchedExpected.length).toBe(0);
  });

  test("tool_use_id match 产生 exact confidence alignment", () => {
    const report = runFixture("single-tool-call");
    const toolUseAlignments = report.alignments.filter((a) => a.basis === "tool_use_id");
    expect(toolUseAlignments.length).toBeGreaterThan(0);
    for (const a of toolUseAlignments) {
      expect(a.confidence).toBe("exact");
      expect(a.matchKind).toBe("exact");
    }
  });

  test("large-tool-output 的大 tool_result（>20000 chars）被 matched", () => {
    const report = runFixture("large-tool-output");
    // 大 tool_result segment 应被 tool_use_id match 命中
    const largeTr = report.snapshot.segments.find(
      (s) => s.category === "tool_result" && (s.charCount ?? 0) > 20000,
    );
    if (largeTr) {
      const aligned = report.alignments.some((a) => a.proxySegmentIds.includes(largeTr.id));
      expect(aligned).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-4：N:1 merge_alignment 和 1:N one_to_many_alignment
// ─────────────────────────────────────────────────────────────────────────────

import { reconcileClaudeContext } from "./reconciliation-engine";
import { createHash } from "crypto";
import type {
  ContextSegment,
  ProxyQuerySnapshot,
  ExpectedQueryContext,
  ProxySegmentAttribution,
} from "./types";

function sha256Short(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function makeProxySnapshot(segments: Partial<ContextSegment>[]): ProxyQuerySnapshot {
  return {
    id: "snap-test",
    agentKind: "claude-code",
    sessionId: "sess-p14",
    queryId: "q-p14",
    timestamp: "2026-01-01T00:00:00Z",
    rawRequestHash: "sha256:test",
    sourceRef: { kind: "proxy", proxy: { file: "test.json", jsonPath: "reqBody" } },
    segments: segments.map((s, i) => ({
      id: `pseg-${i}`,
      section: "messages" as const,
      category: s.category ?? "user_message",
      label: `seg-${i}`,
      role: s.role ?? "user",
      order: i,
      rawHash: s.rawHash,
      rawText: s.rawText,
      toolUseId: s.toolUseId,
      charCount: s.rawText?.length ?? 0,
      sourceRefs: [{ kind: "proxy" as const, proxy: { file: "test.json", jsonPath: `messages[${i}]` } }],
      ...s,
    })),
  };
}

function makeExpected(segments: Partial<ContextSegment>[]): ExpectedQueryContext {
  return {
    agentKind: "claude-code",
    sessionId: "sess-p14",
    queryId: "q-p14",
    segments: segments.map((s, i) => ({
      id: `eseg-${i}`,
      section: "messages" as const,
      category: s.category ?? "user_message",
      label: `eseg-${i}`,
      role: s.role ?? "user",
      order: i,
      rawHash: s.rawHash,
      rawText: s.rawText,
      toolUseId: s.toolUseId,
      charCount: s.charCount ?? s.rawText?.length ?? 0,
      sourceRefs: [],
      metadata: s.metadata,
      ...s,
    })),
    rulesApplied: [],
    metadata: {},
  };
}

describe("P1-4 N:1 merge_alignment", () => {
  test("两个 expected segments 合并成一个 proxy segment → merge_alignment", () => {
    // proxy: 单一 string-content segment，rawText = text1 + text2
    const text1 = "Hello world from user message.";
    const text2 = "<system-reminder>\nSkill listing content\n</system-reminder>\n";
    const mergedText = text1 + text2;
    const mergedHash = sha256Short(mergedText);

    const snapshot = makeProxySnapshot([
      { rawText: mergedText, rawHash: mergedHash, category: "user_message" },
    ]);

    // expected: 两个 segments，分别对应两段文本（各自有独立 rawHash）
    const hash1 = sha256Short(text1);
    const hash2 = sha256Short(text2);
    const expected = makeExpected([
      {
        rawText: text1,
        rawHash: hash1,
        category: "user_message",
        metadata: { logicalMessageId: "lm-1-user" },
      },
      {
        rawText: text2,
        rawHash: hash2,
        category: "skill_listing",
        metadata: { logicalMessageId: "lm-1-user" },
      },
    ]);

    // 先给 proxy snapshot 加上 hash1 和 hash2 各自的 segment（用于 rawHash 反查）
    // 注：N:1 merge 需要每个 expected rawHash 能在 proxy 里找到对应文本
    // 在此场景中 expected 的 rawHash1/hash2 与 proxy 里不存在的单独 segments 对应
    // → merge 路径要求 proxy 里有这两个单独 segment，否则无法反查 rawText
    // 所以要在 proxy 里额外加入这两个单独 segment（模拟 proxy 在其他 position 也有这些内容）
    const snapshotWithBoth = makeProxySnapshot([
      { rawText: mergedText, rawHash: mergedHash, category: "user_message" },
      { rawText: text1, rawHash: hash1, category: "user_message" },
      { rawText: text2, rawHash: hash2, category: "skill_listing" },
    ]);

    // attributions：给两个单独 segments 加 attribution
    const attributions: ProxySegmentAttribution[] = [
      {
        id: "attr-1",
        snapshotId: "snap-test",
        proxySegmentIds: ["pseg-1"],
        category: "user_message",
        attributedSource: "jsonl",
        sourceRefs: [],
        mechanism: "unknown",
        confidence: "exact",
      },
      {
        id: "attr-2",
        snapshotId: "snap-test",
        proxySegmentIds: ["pseg-2"],
        category: "skill_listing",
        attributedSource: "harness_rule",
        sourceRefs: [],
        mechanism: "system_prompt_pattern",
        confidence: "exact",
      },
    ];

    const report = reconcileClaudeContext({
      snapshot: snapshotWithBoth,
      attributions,
      expected,
    });

    // 应该产出 merge_alignment finding
    const mergeFindings = report.findings.filter((f) => f.type === "merge_alignment");
    expect(mergeFindings.length).toBeGreaterThanOrEqual(1);

    // merged proxy segment（pseg-0）应该被匹配
    const mergeAlign = report.alignments.find(
      (a) => a.note?.includes("R-MERGE-N1"),
    );
    expect(mergeAlign).toBeTruthy();
    expect(mergeAlign!.proxySegmentIds).toContain("pseg-0");
    expect(mergeAlign!.expectedSegmentIds).toHaveLength(2);
  });

  test("1:N：一个 expected tool_result → 多个 proxy segments 同 toolUseId", () => {
    const toolUseId = "tu-abc-001";
    const snapshot = makeProxySnapshot([
      { toolUseId, rawText: "part A", rawHash: sha256Short("part A"), category: "tool_result" },
      { toolUseId, rawText: "part B", rawHash: sha256Short("part B"), category: "tool_result" },
    ]);

    const expected = makeExpected([
      {
        toolUseId,
        rawHash: sha256Short("part A part B"),  // 不匹配任一单独 hash
        category: "tool_result",
        metadata: { logicalMessageId: "lm-2-user" },
      },
    ]);

    const attributions: ProxySegmentAttribution[] = [];
    const report = reconcileClaudeContext({ snapshot, attributions, expected });

    // 应该产出 one_to_many_alignment finding
    const oneToManyFindings = report.findings.filter((f) => f.type === "one_to_many_alignment");
    expect(oneToManyFindings.length).toBeGreaterThanOrEqual(1);

    const align = report.alignments.find((a) => a.note?.includes("R-MERGE-1N"));
    expect(align).toBeTruthy();
    expect(align!.expectedSegmentIds).toHaveLength(1);
    expect(align!.proxySegmentIds).toHaveLength(2);
  });
});
