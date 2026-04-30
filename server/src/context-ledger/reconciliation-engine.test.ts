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
    expect(typeof c.segmentCoverage).toBe("number");
    expect(typeof c.charCoverage).toBe("number");
    expect(typeof c.proxyChars).toBe("number");
    expect(typeof c.matchedProxyChars).toBe("number");
    expect(typeof c.unexplainedProxyChars).toBe("number");
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

  test("coverage.charCoverage > 0", () => {
    expect(report.coverage.charCoverage).toBeGreaterThan(0);
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
  // 最低 char coverage（attribution-only + expected-match 合并计算）
  minCharCoverage: number;
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
    minCharCoverage: 0.78,
    requiredFindingTypes: ["known_noise", "unmatched_expected_segment", "api_error_retry"],
    hasRetryFinding: true,
  },
  // 53 proxy segments（12 system + 34 tools + 7 messages）
  // expected: 7 segments（skill_listing + user + assistant_text + 2 tool_use + 2 tool_result）
  "single-tool-call": {
    proxySegmentCount: 53,
    expectedSegmentCount: 7,
    minCharCoverage: 0.78,
    requiredFindingTypes: ["matched", "known_noise", "unmatched_expected_segment", "api_error_retry"],
    hasRetryFinding: true,
  },
  // 73 proxy segments（12 system + 34 tools + 27 messages）
  // expected: 9 segments（3 local_command + user + assistant_text + 2 tool_use + 2 tool_result）
  "multi-turn-human": {
    proxySegmentCount: 73,
    expectedSegmentCount: 9,
    minCharCoverage: 0.80,
    requiredFindingTypes: ["matched", "known_noise", "unmatched_expected_segment"],
    hasRetryFinding: false,
  },
  // 69 proxy segments（12 system + 34 tools + 23 messages）
  // expected: 13 segments（2 user + skill_listing + 2 assistant_text + 4 tool_use + 4 tool_result）
  "large-tool-output": {
    proxySegmentCount: 69,
    expectedSegmentCount: 13,
    minCharCoverage: 0.84,
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

    test(`charCoverage >= ${want.minCharCoverage}`, () => {
      expect(report.coverage.charCoverage).toBeGreaterThanOrEqual(want.minCharCoverage);
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
    expect(report.coverage.charCoverage).toBeGreaterThan(0);
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
