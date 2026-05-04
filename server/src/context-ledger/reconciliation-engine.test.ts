import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { reconcileClaudeContext } from "./reconciliation-engine";
import { inferClaudeProxyAttributions } from "./proxy-attribution";
import { parseClaudeProxyRequest } from "./proxy-snapshot-parser";
import { parseClaudeJsonlMutations } from "./jsonl-mutation-parser";
import { reconstructExpectedClaudeContext } from "./expected-context-reconstructor";
import { buildTargetRequest } from "./target-request-builder";
import { MOCK_RECONCILIATION_REPORT } from "./report";
import { computeCharDiff } from "./debug/char-diff";
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

  test("findings 包含 matched / server_side_attribution / proxy_only", () => {
    const types = new Set(mock.findings.map((f) => f.type));
    expect(types.has("matched")).toBe(true);
    expect(types.has("server_side_attribution")).toBe(true);
    expect(types.has("proxy_only")).toBe(true);
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

  test("server_side_attribution finding 存在", () => {
    expect(report.findings.some((f) => f.type === "server_side_attribution")).toBe(true);
  });

  test("proxy_only finding 存在（mock 有 pseg-unknown）", () => {
    // mock 里 pseg-unknown category=unknown，attribution materializationConfidence=unknown
    // 应产生 proxy_only finding
    const unmatched = report.findings.filter((f) => f.type === "proxy_only");
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

  test("每条 alignment 都有 id、comparisonGrade、basis", () => {
    for (const a of report.alignments) {
      expect(typeof a.id).toBe("string");
      expect(typeof a.comparisonGrade).toBe("string");
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

// ── v2.1.126 fixtures（86d62994 session, 2026-05-01）────────────────────────
// 全部 4 个主场景 fixture 已更新为 v2.1.126，旧 v2.1.119 版本废弃。
// session JSONL 包含 247 records（promptId bd75b839），版本 2.1.126.507。
const FIXTURE_CASES: Record<string, FixtureExpect> = {
  "system-tools-overhead": {
    proxySegmentCount: 59,   // 12 system + 40 tools + 1 message（仅第一条 user prompt，无 tool call）
    expectedSegmentCount: 4,
    maxUnexplainedCoverage: 0.01,
    // attribution_only：proxy 已识别 category 但 expected 缺段（U1-U5 未实现规则）
    requiredFindingTypes: ["server_side_attribution", "matched", "attribution_only"],
    hasRetryFinding: false,
  },
  "single-tool-call": {
    proxySegmentCount: 64,   // 12 system + 40 tools + 3 messages（user + 2×tool_use/tool_result）
    expectedSegmentCount: 9,
    maxUnexplainedCoverage: 0.01,
    requiredFindingTypes: ["matched", "server_side_attribution", "attribution_only"],
    hasRetryFinding: false,
  },
  "multi-turn-human": {
    proxySegmentCount: 73,   // 12 system + 40 tools + 7 messages（multi-turn, has local_command）
    expectedSegmentCount: 18,
    maxUnexplainedCoverage: 0.01,
    requiredFindingTypes: ["matched", "server_side_attribution", "attribution_only"],
    hasRetryFinding: false,
  },
  "large-tool-output": {
    proxySegmentCount: 68,   // 12 system + 40 tools + 5 messages（large tool result >22KB）
    expectedSegmentCount: 13,
    maxUnexplainedCoverage: 0.01,
    requiredFindingTypes: ["matched", "server_side_attribution", "attribution_only"],
    hasRetryFinding: false,
  },
  // v2.1.126 fixture：40 tools，984 messages，64 smoosh，11 task_reminder
  "task-reminder-smoosh": {
    proxySegmentCount: 1341,
    expectedSegmentCount: 204,
    maxUnexplainedCoverage: 0.01,
    requiredFindingTypes: ["matched", "server_side_attribution"],
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
  });
  const targetRequest = buildTargetRequest({ expected, snapshot });

  return reconcileClaudeContext({
    snapshot,          // 原始 parser snapshot，segments 未被 attribution 污染
    attributions,
    expected,
    fixtureName: caseName,
    targetRequest,
    proxyRequestBody: proxyRaw.reqBody,
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

    test("unknown segment 不被吞掉（unknown category 产生 proxy_only finding）", () => {
      const unknownSegs = report.snapshot.segments.filter((s) => s.category === "unknown");
      if (unknownSegs.length > 0) {
        const unmatchedFindings = report.findings.filter(
          (f) =>
            f.type === "proxy_only" &&
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
          // attribution-only or server_side_attribution: expectedSegmentIds 为空
          expect(a.expectedSegmentIds.length).toBe(0);
        }
      }
    });

    test("request-level exact 档位写入 report 与 coverage", () => {
      expect(report.targetRequest).toBeDefined();
      expect(report.requestLevelExact).toBeDefined();
      expect(report.coverage.requestLevelExact).toBe(report.requestLevelExact!.level);
      expect(["raw", "canonical", "structural", "segment-only", "none"]).toContain(
        report.requestLevelExact!.level,
      );
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
    // 没有 expected → 没有 expected_only finding
    const unmatchedExpected = report.findings.filter(
      (f) => f.type === "expected_only" && !f.proxySegmentIds?.length,
    );
    expect(unmatchedExpected.length).toBe(0);
  });

  test("tool_use_id match 产生 exact comparisonGrade alignment", () => {
    const report = runFixture("single-tool-call");
    const toolUseAlignments = report.alignments.filter((a) => a.basis === "tool_use_id");
    expect(toolUseAlignments.length).toBeGreaterThan(0);
    for (const a of toolUseAlignments) {
      expect(a.confidence).toBe("exact");
      expect(a.comparisonGrade).toBe("exact");
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

  // 桶正交性：8 桶字符之和必须 ≤ proxyChars（含 0 误差容忍）。
  // 关键 case：attribution-only 路径不得同时进 attributionOnlyChars 和 presenceChars。
  test("coverage 桶正交：所有 fixture 桶字符之和 == proxyChars", () => {
    for (const name of Object.keys(FIXTURE_CASES)) {
      const report = runFixture(name);
      const c = report.coverage;
      const sum =
        c.wireExactChars +
        c.canonicalExactChars +
        c.templateChars +
        c.regexChars +
        c.presenceChars +
        c.serverSideChars +
        c.attributionOnlyChars +
        c.unexplainedChars;
      expect(sum).toBe(c.proxyChars);
      // 比例之和 ≈ 1.0（容忍 round2 误差）
      const ratioSum =
        c.wireExactCoverage +
        c.canonicalExactCoverage +
        c.templateCoverage +
        c.regexCoverage +
        c.presenceCoverage +
        c.serverSideCoverage +
        c.attributionOnlyCoverage +
        c.unexplainedCoverage;
      expect(Math.abs(ratioSum - 1.0)).toBeLessThan(0.01);
    }
  });

  // attribution-only fallback 用 basis="attribution_only"，不再混入 presence 桶
  test("attribution-only alignment 的 basis 是 attribution_only，不是 harness_rule", () => {
    for (const name of Object.keys(FIXTURE_CASES)) {
      const report = runFixture(name);
      const attrOnly = report.alignments.filter(
        (a) => a.expectedSegmentIds.length === 0 && a.note?.startsWith("attribution-only"),
      );
      for (const a of attrOnly) {
        expect(a.basis).toBe("attribution_only");
      }
    }
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// P3-3：char-diff 与 reconciliation 指标合一（fixture 驱动验证）
// ─────────────────────────────────────────────────────────────────────────────

describe("P3-3: reconcile coverage 与 char-diff 指标一致性（fixture 驱动）", () => {
  // suspectMatchChars：reconcile.coverage 应与 char-diff.summary 的手动计算值一致
  test("suspectMatchChars：reconcile 权威值与 char-diff 手动聚合值一致（所有 fixture）", () => {
    for (const caseName of Object.keys(FIXTURE_CASES)) {
      const report = runFixture(caseName);
      const diff = computeCharDiff(report);

      // char-diff 侧手动聚合（P3-3 前的旧路径：从 diff.entries 聚合）
      const charDiffSuspectChars = diff.entries
        .filter((e) => e.kind === "suspect_match")
        .reduce((acc, e) => acc + (e.proxyTexts ?? []).reduce((s, t) => s + t.chars, 0), 0);

      // reconcile 权威（P3-3 新路径）
      const reconcileSuspectChars = report.coverage.suspectMatchChars;

      expect(reconcileSuspectChars).toBe(charDiffSuspectChars);
    }
  });

  test("suspectMatchCount：reconcile 权威值与 char-diff suspectMatch 条目数一致（所有 fixture）", () => {
    for (const caseName of Object.keys(FIXTURE_CASES)) {
      const report = runFixture(caseName);
      const diff = computeCharDiff(report);
      expect(report.coverage.suspectMatchCount).toBe(diff.summary.suspectMatch);
    }
  });

  test("alignedTextDriftChars：reconcile 权威值与 char-diff totalCharDriftAbsolute 一致（所有 fixture）", () => {
    for (const caseName of Object.keys(FIXTURE_CASES)) {
      const report = runFixture(caseName);
      const diff = computeCharDiff(report);
      // 两者应相等（reconcile 按 alignments 逐段聚合，char-diff 按 entries 逐段聚合）
      expect(report.coverage.alignedTextDriftChars).toBe(diff.summary.totalCharDriftAbsolute);
    }
  });

  test("suspectMatchChars 是 unexplainedChars 的子集（≤ unexplainedChars）", () => {
    for (const caseName of Object.keys(FIXTURE_CASES)) {
      const report = runFixture(caseName);
      expect(report.coverage.suspectMatchChars).toBeLessThanOrEqual(report.coverage.unexplainedChars);
    }
  });

  // mock report 也覆盖：prior_session_guess 是 suspect_match（basis=category），应计入 suspectMatchChars
  test("mock report: suspectMatchChars > 0（prior_session_guess 是 suspect_match）", () => {
    const report = MOCK_RECONCILIATION_REPORT;
    // mock report coverage 已手动初始化 suspectMatchChars=900，验证不为 0
    expect(report.coverage.suspectMatchChars).toBeGreaterThan(0);
    expect(report.coverage.suspectMatchCount).toBeGreaterThan(0);
  });
});

// N:1 merge（多 expected → 单 proxy）和 1:N（单 expected → 多 proxy）路径已移除。
// 经 2.1.x 全量本地扫描确认从未触发，前提条件与现有 M1 路径互斥，见 final-task.md §P1-4。
