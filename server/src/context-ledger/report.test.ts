import { describe, expect, test } from "bun:test";
import { buildMockReconciliationReport } from "./report";
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
