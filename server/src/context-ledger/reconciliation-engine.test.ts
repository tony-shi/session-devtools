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
  // v2.1.126 fixture：40 tools，984 messages，64 smoosh，11 task_reminder
  "task-reminder-smoosh": {
    proxySegmentCount: 1341,
    expectedSegmentCount: 204,
    maxUnexplainedCoverage: 0.01,  // 几乎全部有归因
    requiredFindingTypes: ["matched", "known_noise"],
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

  // ── P2-3：comparePolicy 驱动 M3.5 matchKind（fixture 驱动） ─────────────────
  // task-reminder-smoosh (v2.1.126) 覆盖 4 种 comparePolicy 分支
  // 注：需传 attributions 给 reconstructor 才能触发 R9 → rule_id alignments
  test("P2-3: M3.5 rule_id match 产出正确的 matchKind/confidence（fixture 驱动）", () => {
    const caseName = "task-reminder-smoosh";
    const proxyRaw = JSON.parse(readFileSync(`${FIXTURE_DIR}/${caseName}/proxy-request.json`, "utf8"));
    const jsonlRaw = readFileSync(`${FIXTURE_DIR}/${caseName}/session.jsonl`, "utf8");
    const snapshot = parseClaudeProxyRequest(proxyRaw, { proxyFile: `${FIXTURE_DIR}/${caseName}/proxy-request.json` });
    const snapForAttr = JSON.parse(JSON.stringify({ ...snapshot, metadata: { ...snapshot.metadata, rawBody: proxyRaw.reqBody } })) as typeof snapshot;
    const attributions = inferClaudeProxyAttributions(snapForAttr);
    const parsed = parseClaudeJsonlMutations(jsonlRaw, { jsonlFile: `${FIXTURE_DIR}/${caseName}/session.jsonl` });
    // 传 attributions 给 reconstructor，触发 R9 生成 rule_id expected segments
    const expectedWithR9 = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary: { queryId: `q-${caseName}`, proxyTimestamp: proxyRaw.ts, sessionId: parsed.sessionId },
      hasPreSessionActivity: parsed.hasPreSessionActivity,
      attributions,
    });
    const report = reconcileClaudeContext({ snapshot, attributions, expected: expectedWithR9, fixtureName: caseName });
    const ruleIdAlignments = report.alignments.filter((a) => a.basis === "rule_id");

    // 至少有覆盖到 rule_id alignments
    expect(ruleIdAlignments.length).toBeGreaterThan(0);

    for (const a of ruleIdAlignments) {
      const policy = a.note?.match(/policy=(\w+)/)?.[1];
      expect(policy).toBeDefined();

      if (policy === "raw_hash") {
        // raw_hash policy：exact_text rule，M3.5 命中说明 M1 未命中（hash 不等），降为 heuristic
        expect(a.matchKind).toBe("heuristic");
      } else if (policy === "normalized_hash") {
        // normalized_hash：M2 未命中时降为 heuristic
        expect(a.matchKind).toBe("heuristic");
      } else if (policy === "presence_only" || policy === "structural") {
        // presence/structural：只验存在性
        expect(a.matchKind).toBe("heuristic");
        expect(a.confidence).toBe("inferred");
      } else if (policy === "char_diff") {
        // char_diff + exact_text → exact
        expect(["exact", "heuristic"]).toContain(a.matchKind);
      }
    }

    // 验证 note 格式包含 policy 字段（P2-3 改动的标志）
    const notesWithPolicy = ruleIdAlignments.filter((a) => a.note?.includes("policy="));
    expect(notesWithPolicy.length).toBe(ruleIdAlignments.length);

    // 分 policy 统计（确认各分支都有命中）
    const policyCounts: Record<string, number> = {};
    for (const a of ruleIdAlignments) {
      const p = a.note?.match(/policy=(\w+)/)?.[1] ?? "unknown";
      policyCounts[p] = (policyCounts[p] ?? 0) + 1;
    }
    // task-reminder-smoosh 应覆盖 raw_hash / presence_only / normalized_hash / structural
    expect(policyCounts["raw_hash"] ?? 0).toBeGreaterThan(0);
    expect(policyCounts["presence_only"] ?? 0).toBeGreaterThan(0);
    expect(policyCounts["normalized_hash"] ?? 0).toBeGreaterThan(0);
    expect(policyCounts["structural"] ?? 0).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-4：tryMergeAlignment 路径分析
// ─────────────────────────────────────────────────────────────────────────────
//
// R-MERGE-N1 和 R-MERGE-1N 经全量扫描（Claude Code 2.1.x 全部本地历史记录）
// 确认均不会触发，且前提条件在逻辑上与现有匹配路径互斥：
//   - R-MERGE-N1 要求每个 expected 能在 proxy 单独 rawHash 命中 → M1 已先命中，不走 merge
//   - R-MERGE-1N 要求同 toolUseId 对应多个 proxy segment → Messages API 保证 toolUseId 唯一
//
// tryMergeAlignment 保留为 return null（接口契约存在，供未来扩展），
// 不添加无法触发的实现代码。
// 参见 reconciliation-engine.ts tryMergeAlignment 注释。
