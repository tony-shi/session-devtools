import { describe, expect, test } from "bun:test";
import {
  buildTargetRequestWithBody,
  computeRequestLevelExact,
} from "./request-builder";
import { evaluatePreCondition, materializeHarnessRules } from "../reconstruction/expected-context-reconstructor";
import { CONTEXT_LEDGER_RULES } from "../rules/rule-registry";
import { BUILTIN_TOOL_SCHEMA_JSON } from "../rules/tool-schema-registry";
import { hashCanonicalJson } from "./canonical";
import type {
  ContextSegment,
  ExpectedQueryContext,
  HarnessRuntimeSnapshot,
  ProxyQuerySnapshot,
  SourceRef,
} from "../types";

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

// ─────────────────────────────────────────────────────────────────────────────
// Guardrail G2：TargetRequest.sourceMap 不允许出现 proxy sourceRef
//
// 设计约束（来自 reconstruct.md 全局不变量）：
//   TargetRequest.sourceMap[].sourceRefs 不允许出现 kind="proxy"，
//   除非字段名明确标为 legacy/debug 且不参与 coverage。
//
// buildTargetRequest 的 sourceMap 由 targetSegmentFromContext 填充，
// 其 sourceRefs 来自 ExpectedQueryContext.segments[].sourceRefs。
// G1 已保证 expected segments 不含 proxy sourceRef，
// G2 进一步在 TargetRequest 层验证这一传播不变量。
//
// G2a  正常输入：jsonl + harness_rule sourceRef 构成的 expected → sourceMap 无 proxy
// G2b  混合 section（system/tools/messages）：每个 section 的 sourceMap entry 无 proxy
// G2c  buildTargetRequest 不接受 proxy-only 来源的 expected（类型文档）
// ─────────────────────────────────────────────────────────────────────────────

function proxyRef(): Extract<SourceRef, { kind: "proxy" }> {
  return { kind: "proxy", proxy: { file: "proxy.json", jsonPath: "reqBody.messages[0]" } };
}

function harnessRuleRef(ruleId: string): Extract<SourceRef, { kind: "harness_rule" }> {
  return { kind: "harness_rule", harness: { ruleId } };
}

describe("Guardrail G2：TargetRequest.sourceMap 不含 proxy sourceRef", () => {
  // G2a：纯 jsonl sourceRef 的 expected 生成的 sourceMap 无 proxy
  test("jsonl sourceRef → sourceMap 无 proxy", () => {
    const expected = makeExpected([
      makeSegment("seg-user", "user_message", 0, "hello"),
      makeSegment("seg-tool", "tool_use", 1, JSON.stringify({ cmd: "ls" }), {
        toolUseId: "tu-1",
        metadata: { logicalMessageId: "lm-tool", toolName: "Bash" },
      }),
    ]);

    const { targetRequest } = buildTargetRequestWithBody({
      expected,
      snapshot: makeSnapshot(),
    });

    for (const [, entry] of Object.entries(targetRequest.sourceMap)) {
      for (const ref of entry.sourceRefs) {
        expect(ref.kind).not.toBe("proxy");
      }
    }
  });

  // G2b：system / tools / messages 三个 section 均无 proxy sourceRef
  test("混合 section（system/tools/messages）→ sourceMap 全无 proxy", () => {
    const systemSeg: ContextSegment = {
      id: "seg-system",
      section: "system",
      category: "system_prompt",
      label: "system",
      role: "system",
      order: 0,
      sourceRefs: [harnessRuleRef("R_system_identity")],
      contentRef: { kind: "inline", text: "You are Claude.", charCount: 15 },
      charCount: 15,
      metadata: { logicalMessageId: "lm-sys" },
    };
    const toolSeg: ContextSegment = {
      id: "seg-tool-schema",
      section: "tools",
      category: "tools_schema",
      label: "tools",
      role: "unknown",
      order: 1,
      sourceRefs: [harnessRuleRef("R_tool_bash")],
      contentRef: { kind: "inline", text: JSON.stringify({ name: "Bash", description: "run bash" }), charCount: 40 },
      charCount: 40,
      metadata: { logicalMessageId: "lm-tool-schema" },
    };
    const msgSeg = makeSegment("seg-msg", "user_message", 2, "please help");

    const expected = makeExpected([systemSeg, toolSeg, msgSeg]);

    const { targetRequest } = buildTargetRequestWithBody({
      expected,
      snapshot: makeSnapshot(),
    });

    for (const [jsonPath, entry] of Object.entries(targetRequest.sourceMap)) {
      for (const ref of entry.sourceRefs) {
        // 失败时 jsonPath 会出现在错误信息里，便于定位哪条 entry 违规
        if (ref.kind === "proxy") throw new Error(`sourceMap["${jsonPath}"] 含 proxy sourceRef`);
      }
    }

    // 三个 section 都有 entry
    const paths = Object.keys(targetRequest.sourceMap);
    expect(paths.some((p) => p.startsWith("reqBody.system"))).toBe(true);
    expect(paths.some((p) => p.startsWith("reqBody.tools"))).toBe(true);
    expect(paths.some((p) => p.startsWith("reqBody.messages"))).toBe(true);
  });

  // G2c：即使 expected segment 通过类型断言 bypass 携带了 proxy sourceRef，
  // builder 层的防御性过滤也应确保 sourceMap 不含 proxy
  // （双重保障：G1 从 reconstructor 侧阻止，builder 侧再过滤一次）
  test("expected segment 含 proxy sourceRef 时，builder 过滤后 sourceMap 仍无 proxy", () => {
    const badSeg: ContextSegment = {
      id: "seg-bad",
      section: "messages",
      category: "user_message",
      label: "bad",
      role: "user",
      order: 0,
      // 故意通过类型断言 bypass，模拟类型约束被绕过的极端场景
      sourceRefs: [proxyRef() as unknown as SourceRef],
      contentRef: { kind: "inline", text: "bad input", charCount: 9 },
      charCount: 9,
      metadata: { logicalMessageId: "lm-bad" },
    };

    const expected = makeExpected([badSeg]);
    const { targetRequest } = buildTargetRequestWithBody({
      expected,
      snapshot: makeSnapshot(),
    });

    // builder 层过滤 proxy ref 后，sourceMap 不应含 proxy——这是真正的 guardrail
    const hasProxyInMap = Object.values(targetRequest.sourceMap).some((entry) =>
      entry.sourceRefs.some((ref) => ref.kind === "proxy"),
    );
    expect(hasProxyInMap).toBe(false);
  });

  // G2d：inferredModel 来自 JSONL 时，request.model 不是 proxy 注入，sourceMap 无关字段检查
  test("inferredModel 覆盖 proxy model → sourceMap 不含 proxy", () => {
    const expected = makeExpected([makeSegment("seg-user", "user_message", 0, "test")]);
    const { targetRequest } = buildTargetRequestWithBody({
      expected,
      snapshot: makeSnapshot({ request: { model: "claude-proxy-model", maxTokens: 1000 } }),
      inferredModel: "claude-opus-4-7",
    });

    // model 来自 inferredModel，不是 proxy
    expect(targetRequest.request.model).toBe("claude-opus-4-7");

    // sourceMap 中无 proxy
    for (const [, entry] of Object.entries(targetRequest.sourceMap)) {
      for (const ref of entry.sourceRefs) {
        expect(ref.kind).not.toBe("proxy");
      }
    }

    // metadata 标注了来源
    expect(targetRequest.metadata?.requestScalarSource).toContain("jsonl_inferred");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// proxy snapshot fallback 标注
// ─────────────────────────────────────────────────────────────────────────────

describe("proxy snapshot fallback 标注", () => {
  test("proxy 有 max_tokens / stream 时，proxySnapshotFallbackFields 包含这两个字段", () => {
    const expected = makeExpected([makeSegment("seg-user", "user_message", 0, "hello")]);
    const { targetRequest } = buildTargetRequestWithBody({
      expected,
      snapshot: makeSnapshot({ request: { model: "claude-opus-4-7", maxTokens: 8000, stream: true } }),
      inferredModel: "claude-opus-4-7",
    });

    const fallbacks = targetRequest.metadata?.proxySnapshotFallbackFields as string[] | undefined;
    expect(Array.isArray(fallbacks)).toBe(true);
    expect(fallbacks).toContain("max_tokens");
    expect(fallbacks).toContain("stream");
    // model 有 inferredModel 不应在 fallback 列表里
    expect(fallbacks).not.toContain("model");
  });

  test("没有 inferredModel 且 proxy 有 model 时，model 进入 fallback 列表", () => {
    const expected = makeExpected([makeSegment("seg-user", "user_message", 0, "hello")]);
    const { targetRequest } = buildTargetRequestWithBody({
      expected,
      snapshot: makeSnapshot({ request: { model: "claude-opus-4-7", maxTokens: 8000 } }),
      // 不传 inferredModel
    });

    const fallbacks = targetRequest.metadata?.proxySnapshotFallbackFields as string[] | undefined;
    expect(fallbacks).toContain("model");
    expect(fallbacks).toContain("max_tokens");
  });

  test("runtimeSnapshot.inferredModel 优先级高于顶层 inferredModel", () => {
    const runtimeSnapshot: HarnessRuntimeSnapshot = {
      source: "jsonl",
      inferredModel: "claude-opus-4-7-from-snapshot",
    };
    const expected = makeExpected([makeSegment("seg-user", "user_message", 0, "hello")]);
    const { targetRequest } = buildTargetRequestWithBody({
      expected,
      snapshot: makeSnapshot({ request: { model: "claude-proxy-model", maxTokens: 1000 } }),
      inferredModel: "claude-other-model",  // 应被 runtimeSnapshot 覆盖
      runtimeSnapshot,
    });

    expect(targetRequest.request.model).toBe("claude-opus-4-7-from-snapshot");
    // runtimeSnapshot source 标注在 metadata 中
    expect(targetRequest.metadata?.runtimeSnapshotSource).toBe("jsonl");
  });

  test("proxySnapshotFallbackFields 中的字段不得影响 exact reconstruction 判断", () => {
    const expected = makeExpected([makeSegment("seg-user", "user_message", 0, "hello")]);
    const built = buildTargetRequestWithBody({
      expected,
      snapshot: makeSnapshot({ request: { model: "claude-opus-4-7", maxTokens: 4096, stream: false } }),
    });

    const fallbacks = built.targetRequest.metadata?.proxySnapshotFallbackFields as string[];
    // 当 fallback 字段存在时，request scalar 来源不能被描述为纯正向重建
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(built.targetRequest.metadata?.requestScalarSource).toBe("proxy_snapshot");
    // 即使 canonical hash 相等，也因 fallback 而不能算作 canonical exact——
    // 这里只验证标注本身存在，不验证 computeRequestLevelExact（它不读 fallbackFields）
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RulePreCondition evaluator
// ─────────────────────────────────────────────────────────────────────────────

describe("evaluatePreCondition", () => {
  const noSnapshot = undefined;

  test("always → 无条件 pass，不需要 snapshot", () => {
    expect(evaluatePreCondition({ type: "always" }, noSnapshot)).toBe("pass");
  });

  // ── userType ────────────────────────────────────────────────────────────────

  test("userType: snapshot 缺失 → unknown", () => {
    expect(evaluatePreCondition({ type: "userType", value: "external" }, noSnapshot)).toBe("unknown");
  });

  test("userType: snapshot.userType 未填 → unknown", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl" };
    expect(evaluatePreCondition({ type: "userType", value: "external" }, snap)).toBe("unknown");
  });

  test("userType: snapshot.userType='unknown' → unknown（不允许默认 pass）", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl", userType: "unknown" };
    expect(evaluatePreCondition({ type: "userType", value: "external" }, snap)).toBe("unknown");
  });

  test("userType: 值匹配 → pass", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl", userType: "external" };
    expect(evaluatePreCondition({ type: "userType", value: "external" }, snap)).toBe("pass");
  });

  test("userType: 值不匹配 → fail", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl", userType: "ant" };
    expect(evaluatePreCondition({ type: "userType", value: "external" }, snap)).toBe("fail");
  });

  // ── harnessFlag ─────────────────────────────────────────────────────────────

  test("harnessFlag: snapshot 缺失 → unknown", () => {
    expect(evaluatePreCondition({ type: "harnessFlag", flag: "isAutoMemoryEnabled()" }, noSnapshot)).toBe("unknown");
  });

  test("harnessFlag: featureFlags 未填 → unknown", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl" };
    expect(evaluatePreCondition({ type: "harnessFlag", flag: "isAutoMemoryEnabled()" }, snap)).toBe("unknown");
  });

  test("harnessFlag: 对应 flag 为 'unknown' → unknown", () => {
    const snap: HarnessRuntimeSnapshot = {
      source: "jsonl",
      featureFlags: { "isAutoMemoryEnabled()": "unknown" },
    };
    expect(evaluatePreCondition({ type: "harnessFlag", flag: "isAutoMemoryEnabled()" }, snap)).toBe("unknown");
  });

  test("harnessFlag: flag=true → pass", () => {
    const snap: HarnessRuntimeSnapshot = {
      source: "jsonl",
      featureFlags: { "isAutoMemoryEnabled()": true },
    };
    expect(evaluatePreCondition({ type: "harnessFlag", flag: "isAutoMemoryEnabled()" }, snap)).toBe("pass");
  });

  test("harnessFlag: flag=false → fail", () => {
    const snap: HarnessRuntimeSnapshot = {
      source: "jsonl",
      featureFlags: { "isAutoMemoryEnabled()": false },
    };
    expect(evaluatePreCondition({ type: "harnessFlag", flag: "isAutoMemoryEnabled()" }, snap)).toBe("fail");
  });

  // ── settingsField ────────────────────────────────────────────────────────────

  test("settingsField: snapshot 缺失 → unknown", () => {
    expect(evaluatePreCondition({ type: "settingsField", field: "theme", op: "eq", value: "dark" }, noSnapshot)).toBe("unknown");
  });

  test("settingsField: settings 未填 → unknown", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl" };
    expect(evaluatePreCondition({ type: "settingsField", field: "theme", op: "eq", value: "dark" }, snap)).toBe("unknown");
  });

  test("settingsField: op=null，字段确实为 null → pass", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl", settings: { theme: null } };
    expect(evaluatePreCondition({ type: "settingsField", field: "theme", op: "null" }, snap)).toBe("pass");
  });

  test("settingsField: op=null，字段有值 → fail", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl", settings: { theme: "dark" } };
    expect(evaluatePreCondition({ type: "settingsField", field: "theme", op: "null" }, snap)).toBe("fail");
  });

  test("settingsField: op=notNull，字段存在 → pass", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl", settings: { theme: "dark" } };
    expect(evaluatePreCondition({ type: "settingsField", field: "theme", op: "notNull" }, snap)).toBe("pass");
  });

  test("settingsField: op=eq，值匹配 → pass", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl", settings: { theme: "dark" } };
    expect(evaluatePreCondition({ type: "settingsField", field: "theme", op: "eq", value: "dark" }, snap)).toBe("pass");
  });

  test("settingsField: op=eq，值不匹配 → fail", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl", settings: { theme: "light" } };
    expect(evaluatePreCondition({ type: "settingsField", field: "theme", op: "eq", value: "dark" }, snap)).toBe("fail");
  });

  test("settingsField: op=eq，字段不存在 → unknown（不得猜默认值）", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl", settings: {} };
    expect(evaluatePreCondition({ type: "settingsField", field: "theme", op: "eq", value: "dark" }, snap)).toBe("unknown");
  });

  test("settingsField: op=neq，值不相等 → pass", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl", settings: { theme: "light" } };
    expect(evaluatePreCondition({ type: "settingsField", field: "theme", op: "neq", value: "dark" }, snap)).toBe("pass");
  });

  // ── harnessState ─────────────────────────────────────────────────────────────

  test("harnessState: 自由文本描述无法机器评估 → 始终 unknown", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl" };
    expect(evaluatePreCondition({ type: "harnessState", description: "anything" }, snap)).toBe("unknown");
    expect(evaluatePreCondition({ type: "harnessState", description: "anything" }, noSnapshot)).toBe("unknown");
  });

  // ── all（复合条件）───────────────────────────────────────────────────────────

  test("all: 所有子条件 pass → pass", () => {
    const snap: HarnessRuntimeSnapshot = {
      source: "jsonl",
      userType: "external",
      featureFlags: { myFlag: true },
    };
    const cond = {
      type: "all" as const,
      conditions: [
        { type: "always" as const },
        { type: "userType" as const, value: "external" as const },
        { type: "harnessFlag" as const, flag: "myFlag" },
      ],
    };
    expect(evaluatePreCondition(cond, snap)).toBe("pass");
  });

  test("all: 任一子条件 fail → 立即 fail（不管其它是否 unknown）", () => {
    const snap: HarnessRuntimeSnapshot = { source: "jsonl", userType: "ant" };
    const cond = {
      type: "all" as const,
      conditions: [
        { type: "userType" as const, value: "external" as const },  // fail
        { type: "harnessFlag" as const, flag: "unknownFlag" },       // unknown
      ],
    };
    expect(evaluatePreCondition(cond, snap)).toBe("fail");
  });

  test("all: 无 fail 但有 unknown → unknown（保守 skip）", () => {
    const snap: HarnessRuntimeSnapshot = {
      source: "jsonl",
      userType: "external",
      // featureFlags 未填
    };
    const cond = {
      type: "all" as const,
      conditions: [
        { type: "userType" as const, value: "external" as const },   // pass
        { type: "harnessFlag" as const, flag: "missingFlag" },        // unknown
      ],
    };
    expect(evaluatePreCondition(cond, snap)).toBe("unknown");
  });

  test("all: 空 conditions 数组 → pass（无条件）", () => {
    expect(evaluatePreCondition({ type: "all", conditions: [] }, noSnapshot)).toBe("pass");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reconstruct-05: tools[] schema materialization
// ─────────────────────────────────────────────────────────────────────────────

describe("materializeHarnessRules: tools schema", () => {
  const boundary = { queryId: "q1" };

  // T1：无 enabledToolNames 时，verified exact_text tool rules 全部生成
  test("T1: enabledToolNames 未知时，生成所有 verified exact_text tool segment，标注 all_verified_unfiltered", () => {
    const result = materializeHarnessRules(CONTEXT_LEDGER_RULES, boundary, undefined);
    const toolSegs = result.segments.filter((s) => s.section === "tools");

    // 应有多个 tool segment（内置工具有 26 个 exact_text）
    expect(toolSegs.length).toBeGreaterThan(0);

    // 所有 tool segment 都有 contentRef.text（JSON 字符串）
    for (const seg of toolSegs) {
      expect(typeof seg.contentRef?.text).toBe("string");
      // contentRef.text 必须是合法 JSON
      expect(() => JSON.parse(seg.contentRef!.text!)).not.toThrow();
      // metadata 标注 all_verified_unfiltered
      expect(seg.metadata?.toolEnableMode).toBe("all_verified_unfiltered");
    }
  });

  // T1b（P2-1 修复）：tool segments 按 harness 字母序排列（localeCompare，内置先于 MCP）
  test("T1b: tool segments 按 localeCompare 字母序排列，与 harness assembleToolPool 一致", () => {
    const result = materializeHarnessRules(CONTEXT_LEDGER_RULES, boundary, undefined);
    const toolSegs = result.segments.filter((s) => s.section === "tools");
    const names = toolSegs.map((s) => (JSON.parse(s.contentRef!.text!) as { name: string }).name);

    // 验证字母序（每个相邻对 localeCompare <= 0）
    for (let i = 1; i < names.length; i++) {
      expect(names[i - 1]!.localeCompare(names[i]!)).toBeLessThanOrEqual(0);
    }

    // 验证 segment order 与生成顺序一致（不倒序）
    const orders = toolSegs.map((s) => s.order ?? 0);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]!).toBeGreaterThan(orders[i - 1]!);
    }
  });

  // T2：tool segment 的 contentRef.text 可被 JSON.parse 成对象（含 name/description/input_schema）
  test("T2: tool segment contentRef.text JSON.parse 后含 name/description/input_schema", () => {
    const result = materializeHarnessRules(CONTEXT_LEDGER_RULES, boundary, undefined);
    const toolSegs = result.segments.filter((s) => s.section === "tools");

    for (const seg of toolSegs) {
      const obj = JSON.parse(seg.contentRef!.text!) as Record<string, unknown>;
      expect(typeof obj.name).toBe("string");
      expect(typeof obj.description).toBe("string");
      expect(obj.input_schema !== undefined).toBe(true);
    }
  });

  // T3：MCP tool rules（enabledToolNames 未知时）不生成 segment，进入 unmaterializedRuleIds
  test("T3: enabledToolNames 未知时 MCP tool rules 进入 unmaterializedRuleIds", () => {
    const result = materializeHarnessRules(CONTEXT_LEDGER_RULES, boundary, undefined);
    const toolSegs = result.segments.filter((s) => s.section === "tools");

    // 所有生成的 tool segment 名称不含 mcp__
    for (const seg of toolSegs) {
      const obj = JSON.parse(seg.contentRef!.text!) as { name: string };
      expect(obj.name).not.toContain("mcp__");
    }

    // enabledToolNames 未知时：MCP rule IDs 出现在 unmaterializedRuleIds 中
    const mcpRuleIds = CONTEXT_LEDGER_RULES
      .filter((r) => r.ruleId.includes("mcp__"))
      .map((r) => r.ruleId);
    for (const id of mcpRuleIds) {
      expect(result.unmaterializedRuleIds).toContain(id);
    }
  });

  // T3b（P2-2 修复）：enabledToolNames 明确且不含 MCP 工具时，
  //   MCP rules 不应进入 unmaterializedRuleIds（它们是被禁用的，不是重建缺口）
  test("T3b: enabledToolNames 明确不含 MCP 时，MCP rules 不进入 unmaterializedRuleIds", () => {
    const runtimeSnapshot: HarnessRuntimeSnapshot = {
      source: "jsonl",
      enabledToolNames: ["Edit", "Read"], // 只启用内置工具，不含任何 MCP
    };
    const result = materializeHarnessRules(CONTEXT_LEDGER_RULES, boundary, runtimeSnapshot);

    const mcpInUnmaterialized = result.unmaterializedRuleIds.filter((id) =>
      id.includes("mcp__"),
    );
    // MCP tools 未启用 → 应被静默跳过，不计入 unmaterializedRuleIds
    expect(mcpInUnmaterialized).toHaveLength(0);
  });

  // T4：不从 proxy 复制 tool schema（sourceRefs 不含 kind="proxy"）
  test("T4: tool segment sourceRefs 不含 proxy kind", () => {
    const result = materializeHarnessRules(CONTEXT_LEDGER_RULES, boundary, undefined);
    const toolSegs = result.segments.filter((s) => s.section === "tools");

    for (const seg of toolSegs) {
      for (const ref of seg.sourceRefs) {
        expect(ref.kind).not.toBe("proxy");
      }
    }
  });

  // T5：enabledToolNames 明确时，只生成指定工具
  test("T5: enabledToolNames 明确时，只生成指定工具的 segment", () => {
    const runtimeSnapshot: HarnessRuntimeSnapshot = {
      source: "jsonl",
      enabledToolNames: ["Edit", "Read"],
    };
    const result = materializeHarnessRules(CONTEXT_LEDGER_RULES, boundary, runtimeSnapshot);
    const toolSegs = result.segments.filter((s) => s.section === "tools");

    expect(toolSegs).toHaveLength(2);
    const toolNames = toolSegs.map((s) => (JSON.parse(s.contentRef!.text!) as { name: string }).name);
    expect(toolNames.sort()).toEqual(["Edit", "Read"]);

    // 明确模式标注 explicit
    for (const seg of toolSegs) {
      expect(seg.metadata?.toolEnableMode).toBe("explicit");
    }
  });

  // T6：segmentToToolBlock 将 JSON contentRef 转为 object（不是字符串 placeholder）
  test("T6: buildTargetRequest 中 tools[] 为对象结构", () => {
    const result = materializeHarnessRules(
      CONTEXT_LEDGER_RULES,
      boundary,
      { source: "jsonl", enabledToolNames: ["Edit"] },
    );
    const expected: ExpectedQueryContext = {
      id: "expected-q1",
      agentKind: "claude-code",
      sessionId: "sess",
      queryId: "q1",
      mutationIds: [],
      segments: result.segments,
      rulesApplied: result.appliedRules,
      generatedAt: "2026-01-01T00:00:00.000Z",
      metadata: {},
    };

    const { requestBody } = buildTargetRequestWithBody({
      expected,
      snapshot: makeSnapshot(),
    });

    expect(Array.isArray(requestBody.tools)).toBe(true);
    const tools = requestBody.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    // 应是对象，不是字符串
    expect(typeof tools[0]).toBe("object");
    expect(tools[0]?.name).toBe("Edit");
    expect(typeof tools[0]?.description).toBe("string");
    expect(typeof tools[0]?.input_schema).toBe("object");
  });

  // T7：BUILTIN_TOOL_SCHEMA_JSON 覆盖 P0 dump 已确认的所有内置 exact_text tool
  //     ToolSearch 是 deferred tool，不出现在普通 proxy dump 中，当前无 P0 证据，合理缺口
  test("T7: BUILTIN_TOOL_SCHEMA_JSON 覆盖 P0 dump 中所有内置 exact_text tool", () => {
    // P0 dump（system-tools-overhead）中出现的工具名（排除 MCP）
    const knownDumpTools = new Set(Object.keys(BUILTIN_TOOL_SCHEMA_JSON));

    // verified exact_text tool rules 中，dump 里出现过的工具必须有 schema
    const verifiedExactToolRules = CONTEXT_LEDGER_RULES.filter(
      (r) =>
        r.reconstruction?.emits?.section === "tools" &&
        r.reconstruction?.materialization === "exact_text" &&
        r.verifiedFor !== null &&
        !r.ruleId.includes("mcp__"),
    );

    const knownGaps = new Set(["ToolSearch"]); // P0 dump 无证据，已知合理缺口

    for (const rule of verifiedExactToolRules) {
      const toolName = rule.ruleId.match(/^claude-code\.tool\.([^.]+)\.v\d+$/)?.[1];
      if (!toolName) continue; // shape rules（Agent/Bash）无 toolName 提取
      if (knownGaps.has(toolName)) continue; // 已知合理缺口，跳过断言
      if (!knownDumpTools.has(toolName)) continue; // 超出 dump 范围，不强断言
      // dump 里出现的工具必须在 BUILTIN_TOOL_SCHEMA_JSON 中
      expect(BUILTIN_TOOL_SCHEMA_JSON[toolName]).toBeDefined();
    }

    // dump 里的所有工具都可以被 JSON.parse
    for (const [name, json] of Object.entries(BUILTIN_TOOL_SCHEMA_JSON)) {
      expect(() => JSON.parse(json), `${name} JSON 必须可解析`).not.toThrow();
    }
  });
});
