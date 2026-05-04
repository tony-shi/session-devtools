import { describe, expect, test } from "bun:test";
import {
  buildTargetRequestWithBody,
  computeRequestLevelExact,
} from "./target-request-builder";
import { hashCanonicalJson } from "./request-canonical";
import type {
  ContextSegment,
  ExpectedQueryContext,
  ProxyQuerySnapshot,
  SourceRef,
} from "./types";

function jsonlRef(): Extract<SourceRef, { kind: "jsonl" }> {
  return { kind: "jsonl", jsonl: { file: "session.jsonl" } };
}

function makeSegment(
  id: string,
  category: ContextSegment["category"],
  order: number,
  text: string | undefined,
  extra: Partial<ContextSegment> = {},
): ContextSegment {
  return {
    id,
    section: "messages",
    category,
    role: category === "tool_use" || category === "assistant_text" ? "assistant" : "user",
    label: id,
    sourceRefs: [jsonlRef()],
    order,
    charCount: text?.length ?? extra.charCount ?? 0,
    ...(text !== undefined
      ? { contentRef: { kind: "inline", text, charCount: text.length } }
      : {}),
    metadata: {
      logicalMessageId: `lm-${order}`,
      ...extra.metadata,
    },
    ...extra,
  };
}

function makeExpected(segments: ContextSegment[]): ExpectedQueryContext {
  return {
    id: "expected-q1",
    agentKind: "claude-code",
    sessionId: "sess",
    queryId: "q1",
    mutationIds: [],
    segments,
    rulesApplied: [{ ruleId: "R1_base_append", source: "harness_rule", confidence: "exact" }],
    generatedAt: "2026-01-01T00:00:00.000Z",
    metadata: { unimplementedRules: ["system_reminder_per_turn"] },
  };
}

function makeSnapshot(overrides: Partial<ProxyQuerySnapshot> = {}): ProxyQuerySnapshot {
  return {
    id: "snapshot-q1",
    agentKind: "claude-code",
    sessionId: "sess",
    queryId: "q1",
    timestamp: "2026-01-01T00:00:00.000Z",
    sourceRef: { kind: "proxy", proxy: { file: "proxy.json", jsonPath: "reqBody" } },
    segments: [],
    rawRequestHash: "sha256:legacy",
    request: {
      model: "claude-opus-4-7",
      stream: true,
      maxTokens: 64000,
    },
    ...overrides,
  };
}

describe("buildTargetRequestWithBody", () => {
  test("按 logicalMessageId 生成 request body messages 与 sourceMap", () => {
    const expected = makeExpected([
      makeSegment("seg-user", "user_message", 0, "hello"),
      makeSegment("seg-tool", "tool_use", 1, JSON.stringify({ command: "pwd" }), {
        toolUseId: "toolu_1",
        metadata: { logicalMessageId: "lm-tool", toolName: "Bash" },
      }),
      makeSegment("seg-result", "tool_result", 2, "ok", {
        toolUseId: "toolu_1",
        metadata: { logicalMessageId: "lm-result" },
      }),
    ]);

    const { targetRequest, requestBody } = buildTargetRequestWithBody({
      expected,
      snapshot: makeSnapshot(),
    });

    expect(targetRequest.request.max_tokens).toBe(64000);
    expect(targetRequest.messages).toHaveLength(3);
    expect(targetRequest.sourceMap["reqBody.messages[1].content[0]"]?.segmentIds).toEqual(["seg-tool"]);
    expect(requestBody.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ]);
  });

  test("canonical exact 使用 proxy canonicalRequestHash，不把 raw bytes hash 当作 canonical", () => {
    const expected = makeExpected([makeSegment("seg-user", "user_message", 0, "hello")]);
    const baseSnapshot = makeSnapshot();
    const built = buildTargetRequestWithBody({ expected, snapshot: baseSnapshot });
    const snapshot = makeSnapshot({
      canonicalRequestHash: built.targetRequest.canonicalHash,
      rawRequestBytesHash: built.targetRequest.canonicalHash,
    });

    const result = computeRequestLevelExact({
      snapshot,
      targetRequest: built.targetRequest,
      proxyRequestBody: built.requestBody,
      hasSegmentEvidence: true,
    });

    expect(result.rawExact).toBe(false);
    expect(result.canonicalExact).toBe(true);
    expect(result.level).toBe("canonical");
    expect(result.reasons).toContain("target_wire_hash_unavailable");
  });

  test("raw exact 只有 target 显式携带 wireHash 时才成立", () => {
    const expected = makeExpected([makeSegment("seg-user", "user_message", 0, "hello")]);
    const built = buildTargetRequestWithBody({ expected, snapshot: makeSnapshot() });
    const targetRequest = {
      ...built.targetRequest,
      metadata: {
        ...built.targetRequest.metadata,
        wireHash: "sha256:wire",
      },
    };

    const result = computeRequestLevelExact({
      snapshot: makeSnapshot({
        canonicalRequestHash: "sha256:not-the-target",
        rawRequestBytesHash: "sha256:wire",
      }),
      targetRequest,
      proxyRequestBody: { model: "different" },
      hasSegmentEvidence: true,
    });

    expect(result.rawExact).toBe(true);
    expect(result.level).toBe("raw");
  });

  test("structural exact 允许 target 字符串 placeholder 匹配 proxy 字符串", () => {
    const expected = makeExpected([
      makeSegment("seg-placeholder", "user_message", 0, undefined, { charCount: 12 }),
    ]);
    const built = buildTargetRequestWithBody({ expected, snapshot: makeSnapshot() });
    const proxyBody = {
      model: "claude-opus-4-7",
      max_tokens: 64000,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "actual text" }] }],
    };
    const snapshot = makeSnapshot({
      canonicalRequestHash: hashCanonicalJson(proxyBody),
    });

    const result = computeRequestLevelExact({
      snapshot,
      targetRequest: built.targetRequest,
      proxyRequestBody: proxyBody,
      hasSegmentEvidence: false,
    });

    expect(result.canonicalExact).toBe(false);
    expect(result.structuralExact).toBe(true);
    expect(result.level).toBe("structural");
  });

  test("无 request-level 命中但有 segment evidence 时降级为 segment-only", () => {
    const expected = makeExpected([makeSegment("seg-user", "user_message", 0, "hello")]);
    const built = buildTargetRequestWithBody({ expected, snapshot: makeSnapshot() });
    const snapshot = makeSnapshot({ canonicalRequestHash: "sha256:not-the-target" });

    const result = computeRequestLevelExact({
      snapshot,
      targetRequest: built.targetRequest,
      proxyRequestBody: { model: "different" },
      hasSegmentEvidence: true,
    });

    expect(result.level).toBe("segment-only");
  });
});
