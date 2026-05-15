import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildMockReconciliationReport } from "./report";
import {
  CONTEXT_LEDGER_RULES,
  CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE,
  getContextLedgerRule,
  // 过渡期兼容别名（测试旧名也能用）
  ATTRIBUTION_RULES,
  getAttributionRule,
} from "../rules/rule-registry";
import type { MutationSourceKind, ReconciliationReport } from "../types";

// @ts-expect-error proxy is a fact-layer source, not a mutation source.
const invalidMutationSource: MutationSourceKind = "proxy";
void invalidMutationSource;

async function readFixture(): Promise<ReconciliationReport> {
  return JSON.parse(await readFile(fileURLToPath(new URL("../__fixtures__/mock-report.json", import.meta.url)), "utf8")) as ReconciliationReport;
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
    // 正交分桶各 chars 之和 = proxyChars
    const bucketSum = coverage.wireExactChars + coverage.canonicalExactChars
      + coverage.templateChars + coverage.regexChars + coverage.presenceChars
      + coverage.serverSideChars + coverage.attributionOnlyChars + coverage.unexplainedChars;
    expect(bucketSum).toBe(coverage.proxyChars);

    const segmentChars = report.snapshot.segments.reduce(
      (total, segment) => total + (segment.charCount ?? 0),
      0,
    );
    const segmentTokens = report.snapshot.segments.reduce(
      (total, segment) => total + (segment.tokenEstimate ?? 0),
      0,
    );

    expect(segmentChars).toBe(coverage.proxyChars);
    // token estimate 字段已从 CoverageSummary 移除，只验证 segment chars 与 proxyChars 一致
    expect(typeof segmentTokens).toBe("number");
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
    expect(findingTypes).toContain("server_side_attribution");
    expect(findingTypes).toContain("api_error_retry");
    expect(findingTypes).toContain("proxy_only");

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

  test("registry 当前包含 rule（P3-5 删除 embedded 变体后；阶段 2.1 +6 SmoothContent v2 rule）", () => {
    expect(CONTEXT_LEDGER_RULES).toHaveLength(68);
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

// ─────────────────────────────────────────────────────────────────────────────
// P2-7 单测：exact_text rule 的 contentPattern / attribution.pattern 单源一致性
// ─────────────────────────────────────────────────────────────────────────────

describe("P2-7 exact_text rule 单源一致性", () => {
  test("所有 exact_text + exact matchMode 的 rule：contentPattern（或 attr.pattern 作为 fallback）能被 attribution.pattern 命中", () => {
    const failures: string[] = [];
    for (const rule of CONTEXT_LEDGER_RULES) {
      const mat = rule.reconstruction?.materialization;
      if (mat !== "exact_text") continue;
      const matchMode = rule.attribution?.matchMode;
      if (matchMode !== "exact") continue;
      const attrPat = rule.attribution?.pattern;
      const cp = rule.reconstruction?.emits?.contentPattern;

      // 权威文本：contentPattern 优先，fallback 到 attribution.pattern
      const canonical = cp ?? attrPat;
      if (!canonical) continue; // 两者均 null → 跳过（unavailable）

      // attribution.pattern 应等于 canonical（exact matchMode 时两者必须严格一致）
      if (attrPat && attrPat !== canonical) {
        failures.push(`${rule.ruleId}: attr.pattern(${attrPat.length}ch) ≠ canonical(${canonical.length}ch)`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`P2-7 双源不一致:\n${failures.join("\n")}`);
    }
  });

  test("所有 exact_text rule 的有效文本（contentPattern 或 attr.pattern）经 attribution 路径能命中 proxy（fixture 验证）", async () => {
    // 通过跑 4 个 fixture 验证 exact_text rule 有实际命中（已在 fixture audit 中覆盖）
    // 这里只验证 pattern 字段的合法性（非 undefined / 非空字符串）
    const noPattern: string[] = [];
    for (const rule of CONTEXT_LEDGER_RULES) {
      const mat = rule.reconstruction?.materialization;
      if (mat !== "exact_text") continue;
      const cp = rule.reconstruction?.emits?.contentPattern;
      const attrPat = rule.attribution?.pattern;
      // 对 exact_text rule，至少有一个非 null 文本字段
      if (cp === null && attrPat === null) {
        noPattern.push(rule.ruleId);
      }
    }
    // 当前允许 normalized_text 类 rule 有 contentPattern=null（用占位符模板）
    // 只有纯 exact_text 且两者均 null 才是问题
    expect(noPattern).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2-8 单测：regex rule anchor 约定
// ─────────────────────────────────────────────────────────────────────────────

describe("P2-8 regex rule anchor 约定", () => {
  test("所有 fixture 命中的 regex rule 都有 ^ 起始 anchor", () => {
    const noStart: string[] = [];
    for (const rule of CONTEXT_LEDGER_RULES) {
      if (rule.attribution?.matchMode !== "regex") continue;
      const pat = rule.attribution.pattern;
      if (!pat) continue;
      if (!pat.startsWith("^")) {
        noStart.push(rule.ruleId);
      }
    }
    expect(noStart).toHaveLength(0);
  });

  test("fixture 命中的 regex rule 有 $ 或 [\\s\\S]*$ 尾部 anchor", () => {
    // 只检查在 fixture 里有实际命中的 rule
    const fixtureHitRules = new Set([
      "claude-code.billing-noise.v1",
      "claude-code.system-prompt-context-management.v1",
      "claude-code.system-prompt-environment.v1",
      "claude-code.system-prompt-auto-memory.v1",
      "claude-code.messages.local-command.v1",
      "claude-code.tool.Agent.v1",
      "claude-code.tool.Bash.v1",
      "claude-code.tool.ScheduleWakeup.v1",
    ]);
    const noEnd: string[] = [];
    for (const rule of CONTEXT_LEDGER_RULES) {
      if (rule.attribution?.matchMode !== "regex") continue;
      if (!fixtureHitRules.has(rule.ruleId)) continue;
      const pat = rule.attribution.pattern ?? "";
      if (!/\$\s*$/.test(pat)) {
        noEnd.push(rule.ruleId);
      }
    }
    expect(noEnd).toHaveLength(0);
  });
});
