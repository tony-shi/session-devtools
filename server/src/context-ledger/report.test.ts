import { describe, expect, test } from "bun:test";
import { buildMockReconciliationReport } from "./report";
import {
  CONTEXT_LEDGER_RULES,
  CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE,
  getContextLedgerRule,
  // 过渡期兼容别名（测试旧名也能用）
  ATTRIBUTION_RULES,
  getAttributionRule,
} from "./rule-registry";
import type { MutationSourceKind, ReconciliationReport } from "./types";

// @ts-expect-error proxy is a fact-layer source, not a mutation source.
const invalidMutationSource: MutationSourceKind = "proxy";
void invalidMutationSource;

async function readFixture(): Promise<ReconciliationReport> {
  return Bun.file(new URL("./__fixtures__/mock-report.json", import.meta.url)).json();
}

describe("context-ledger mock report contract", () => {
  test("keeps the serialized fixture in sync with the builder", async () => {
    expect(await readFixture()).toEqual(buildMockReconciliationReport());
  });

  test("keeps coverage arithmetic self-consistent", () => {
    const report = buildMockReconciliationReport();
    const coverage = report.coverage;

    expect(coverage.matchedProxySegmentCount + coverage.unmatchedProxySegmentCount).toBe(
      coverage.proxySegmentCount,
    );
    expect(coverage.matchedProxyChars + coverage.unexplainedProxyChars).toBe(coverage.proxyChars);
    const proxyTokenEstimate = coverage.proxyTokenEstimate ?? 0;
    expect(
      (coverage.matchedProxyTokenEstimate ?? 0) + (coverage.unexplainedProxyTokenEstimate ?? 0),
    ).toBe(proxyTokenEstimate);

    const segmentChars = report.snapshot.segments.reduce(
      (total, segment) => total + (segment.charCount ?? 0),
      0,
    );
    const segmentTokens = report.snapshot.segments.reduce(
      (total, segment) => total + (segment.tokenEstimate ?? 0),
      0,
    );

    expect(segmentChars).toBe(coverage.proxyChars);
    expect(segmentTokens).toBe(proxyTokenEstimate);
  });

  test("covers the required segment categories and audit pressures", () => {
    const report = buildMockReconciliationReport();
    const segmentKeys = report.snapshot.segments
      .map((segment) => `${segment.section}:${segment.category}`)
      .sort();
    const findingTypes = report.findings.map((finding) => finding.type);
    const fixturePressures = report.metadata?.fixturePressures as string[];

    expect(segmentKeys).toContain("system:system_prompt");
    expect(segmentKeys).toContain("tools:tools_schema");
    expect(segmentKeys).toContain("messages:user_message");
    expect(segmentKeys).toContain("messages:tool_use");
    expect(segmentKeys).toContain("messages:tool_result");
    expect(segmentKeys).toContain("messages:harness_injection");
    expect(segmentKeys).toContain("messages:unknown");

    expect(findingTypes).toContain("matched");
    expect(findingTypes).toContain("merge_alignment");
    expect(findingTypes).toContain("known_noise");
    expect(findingTypes).toContain("api_error_retry");
    expect(findingTypes).toContain("unmatched_proxy_segment");

    expect(fixturePressures).toEqual([
      "system-tools-overhead",
      "single-tool-call",
      "large-tool-output",
      "multi-turn-human",
    ]);
  });

  test("treats proxy segment attribution as a first-class report object", () => {
    const report = buildMockReconciliationReport();

    expect(report.proxyAttributions.length).toBeGreaterThan(0);
    expect(report.proxyAttributions.some((attribution) => attribution.mechanism === "tool_use_id_match")).toBe(
      true,
    );
    expect(report.alignments.some((alignment) => (alignment.attributionIds?.length ?? 0) > 0)).toBe(
      true,
    );
  });

  test("carries agent identity fields for future subagent fixtures", () => {
    const report = buildMockReconciliationReport();

    expect(report.agentId).toBe("mock-main-agent");
    expect(report.snapshot.agentId).toBe(report.agentId);
    expect(report.expected?.agentId).toBe(report.agentId);
  });
});

describe("rule registry contract", () => {
  // registry 中 ruleId 唯一
  test("ruleId 在 registry 中唯一", () => {
    const ids = ATTRIBUTION_RULES.map((r) => r.ruleId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  // ── registry 基础契约 ────────────────────────────────────────────────────

  test("registry 当前包含 47 条人工确认的 rule", () => {
    expect(CONTEXT_LEDGER_RULES).toHaveLength(47);
  });

  test("ruleId 在 registry 中唯一", () => {
    const ids = CONTEXT_LEDGER_RULES.map((r) => r.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("verifiedFor 字段存在（值由人工校对决定）", () => {
    // B1.4: ruleVersion 已替换为 verifiedFor，其值在人工校对前为 null。
    // 这里只断言字段类型合法，不锁定具体版本号——版本号绑定在 SUPPORTED_CLAUDE_CODE_VERSION。
    const v = CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.verifiedFor;
    expect(v === null || typeof v === "string").toBe(true);
  });

  test("stability 是 static", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.stability).toBe("static");
  });

  // ── attribution 子字段 ───────────────────────────────────────────────────

  test("attribution.pattern 严格等于带句号的固定标识字符串", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.attribution?.pattern).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
  });

  test("attribution.pattern 不以换行结尾", () => {
    const pattern = CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.attribution?.pattern;
    expect(pattern).toBeDefined();
    expect(pattern!.endsWith("\n")).toBe(false);
    expect(pattern!.endsWith("\r")).toBe(false);
  });

  test("attribution.matchMode 是 exact", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.attribution?.matchMode).toBe("exact");
  });

  test("attribution.location.section 是 system", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.attribution?.location?.section).toBe("system");
  });

  test("attribution.location.segmentPosition 是 segment_start", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.attribution?.location?.segmentPosition).toBe(
      "segment_start",
    );
  });

  // ── reconstruction 子字段 ────────────────────────────────────────────────

  test("reconstruction.materialization 是 exact_text", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.reconstruction?.materialization).toBe(
      "exact_text",
    );
  });

  test("reconstruction.trigger 是 always_per_query", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.reconstruction?.trigger).toBe(
      "always_per_query",
    );
  });

  // ── reconciliation 子字段 ────────────────────────────────────────────────

  test("reconciliation.comparePolicy 是 char_diff", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.reconciliation?.comparePolicy).toBe("char_diff");
  });

  test("reconciliation.exactTextExpected 是 true", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.reconciliation?.exactTextExpected).toBe(true);
  });

  // ── lookup helper ────────────────────────────────────────────────────────

  test("getContextLedgerRule 能通过 ruleId 查找 identity rule", () => {
    expect(getContextLedgerRule("claude-code.system-prompt-identity.v1")).toBe(
      CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE,
    );
  });

  test("getContextLedgerRule 对未知 ruleId 返回 undefined", () => {
    expect(getContextLedgerRule("does-not-exist.v99")).toBeUndefined();
  });

  // 过渡期兼容别名仍可工作
  test("过渡期别名 getAttributionRule 仍能查找到 identity rule", () => {
    expect(getAttributionRule("claude-code.system-prompt-identity.v1")).toBe(
      CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE,
    );
  });

  // ── mock report 边界一致性 ────────────────────────────────────────────────

  test("mock report 中的泛化占位 ruleId 均不在 registry 中（预期行为）", () => {
    const report = buildMockReconciliationReport();
    const reportRuleIds = new Set<string>();
    for (const attr of report.proxyAttributions) {
      if (attr.ruleId) reportRuleIds.add(attr.ruleId);
    }
    for (const rule of report.expected?.rulesApplied ?? []) {
      reportRuleIds.add(rule.ruleId);
    }
    // mock report 使用泛化占位（尚未经人工审核入 registry），不应在 registry 中找到
    for (const ruleId of reportRuleIds) {
      expect(getContextLedgerRule(ruleId)).toBeUndefined();
    }
  });

  // identity rule 不归因整段 1800-char system prompt（尚无 full rule 入 registry）
  test("identity rule 的 ruleId 不出现在 mock report 的 attribution 或 rulesApplied 中", () => {
    const report = buildMockReconciliationReport();
    const identityRuleId = CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.ruleId;
    const inAttr = report.proxyAttributions.some((a) => a.ruleId === identityRuleId);
    const inApplied = (report.expected?.rulesApplied ?? []).some((r) => r.ruleId === identityRuleId);
    expect(inAttr).toBe(false);
    expect(inApplied).toBe(false);
  });
});
