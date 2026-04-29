import { describe, expect, test } from "bun:test";
import { buildMockReconciliationReport } from "./report";
import {
  ATTRIBUTION_RULES,
  ATTRIBUTION_RULE_BY_ID,
  CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE,
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

  // 当前 registry 只有一条 rule（首批只落地 identity rule）
  test("当前 registry 只包含一条人工确认的 rule", () => {
    expect(ATTRIBUTION_RULES).toHaveLength(1);
  });

  // identity rule 核心属性断言
  test("identity rule 的 promptPattern 严格等于固定标识字符串", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.promptPattern).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
  });

  test("identity rule 的 matchMode 是 exact", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.matchMode).toBe("exact");
  });

  test("identity rule 的 stability 是 static", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.stability).toBe("static");
  });

  test("identity rule 的 ruleVersion 是 2.1.123", () => {
    expect(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.ruleVersion).toBe("2.1.123");
  });

  // promptPattern 不含尾部换行
  test("identity rule 的 promptPattern 没有尾部换行", () => {
    const pattern = CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.promptPattern;
    expect(pattern).not.toBeNull();
    expect(pattern!.endsWith("\n")).toBe(false);
    expect(pattern!.endsWith("\r")).toBe(false);
  });

  // ATTRIBUTION_RULE_BY_ID lookup helper
  test("getAttributionRule 能通过 ruleId 查找 identity rule", () => {
    const rule = getAttributionRule("claude-code.system-prompt-identity.v1");
    expect(rule).toBe(CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE);
  });

  test("getAttributionRule 对未知 ruleId 返回 undefined", () => {
    expect(getAttributionRule("does-not-exist.v99")).toBeUndefined();
  });

  // mock report 中出现的 ruleId 与 registry 边界一致性检查：
  // identity rule 不归因整段 system prompt（尚无 full rule），
  // mock report 里所有出现的 ruleId 均为未入 registry 的泛化占位。
  test("mock report 中的泛化占位 ruleId 均不在 registry 中（预期行为）", () => {
    const report = buildMockReconciliationReport();

    // 收集 report 里所有出现过的 ruleId
    const reportRuleIds = new Set<string>();
    for (const attr of report.proxyAttributions) {
      if (attr.ruleId) reportRuleIds.add(attr.ruleId);
    }
    for (const rule of report.expected?.rulesApplied ?? []) {
      reportRuleIds.add(rule.ruleId);
    }

    // mock report 里用的都是泛化占位，不应在 registry 中找到
    for (const ruleId of reportRuleIds) {
      expect(getAttributionRule(ruleId)).toBeUndefined();
    }
  });

  // identity rule 自身不应出现在 mock report 的 attribution / rulesApplied 中：
  // 它只是识别锚点，1800 字符的整段归因需独立的 full rule（未入 registry）。
  test("identity rule 的 ruleId 不出现在 mock report 的 attribution 或 rulesApplied 中", () => {
    const report = buildMockReconciliationReport();
    const identityRuleId = CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE.ruleId;

    const inAttr = report.proxyAttributions.some((a) => a.ruleId === identityRuleId);
    const inApplied = (report.expected?.rulesApplied ?? []).some((r) => r.ruleId === identityRuleId);

    expect(inAttr).toBe(false);
    expect(inApplied).toBe(false);
  });
});
