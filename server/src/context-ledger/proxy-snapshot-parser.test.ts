import { describe, expect, test } from "bun:test";
import { parseClaudeProxyRequest } from "./proxy-snapshot-parser";
import type { ProxyRequestInput } from "./proxy-snapshot-parser";

const FIXTURE_DIR = new URL(
  "../../test/fixtures/context-reconstruction",
  import.meta.url,
).pathname;

function loadFixture(caseName: string): ProxyRequestInput {
  return require(`${FIXTURE_DIR}/${caseName}/proxy-request.json`) as ProxyRequestInput;
}

// ── system-tools-overhead ──────────────────────────────────────────────────────

describe("system-tools-overhead", () => {
  const input = loadFixture("system-tools-overhead");
  const snapshot = parseClaudeProxyRequest(input, {
    proxyFile: `server/test/fixtures/context-reconstruction/system-tools-overhead/proxy-request.json`,
  });

  test("session ID 从 header 提取", () => {
    expect(snapshot.sessionId).toBe("ba3db910-c0df-4863-910c-7b8e9525fa84");
  });

  test("model 正确", () => {
    expect(snapshot.request?.model).toBe("claude-opus-4-7");
  });

  test("stream 正确", () => {
    expect(snapshot.request?.stream).toBe(true);
  });

  test("system 切出 12 个 segment（billing + identity + system[2] 的 10 个 section）", () => {
    const sys = snapshot.segments.filter((s) => s.section === "system");
    expect(sys.length).toBe(12);
  });

  test("tools 切出 34 个 segment", () => {
    const tools = snapshot.segments.filter((s) => s.section === "tools");
    expect(tools.length).toBe(34);
  });

  test("messages 切出 2 个 segment（messages[0] 有 2 个 text block）", () => {
    const msgs = snapshot.segments.filter((s) => s.section === "messages");
    expect(msgs.length).toBe(2);
  });

  // OBSOLETE（旧 contract）：parser 曾识别 billing_noise，现在 category 由 attribution 决定。
  // parser 只产出 system_prompt。billing_noise 判断验证请在 proxy-attribution.test.ts 中查看。
  test("system[0] 的 category 是 system_prompt（parser 保守分类）", () => {
    const s = snapshot.segments.find((s) => s.id === "pseg-system-0");
    expect(s?.category).toBe("system_prompt");
  });

  test("system[2] 被切为 10 个 section（pseg-system-2-s0 ~ s9）", () => {
    const s2segs = snapshot.segments.filter((s) => s.id.startsWith("pseg-system-2-s"));
    expect(s2segs.length).toBe(10);
  });

  test("system[2] 各 section charCount 之和 ≈ 27912", () => {
    const s2segs = snapshot.segments.filter((s) => s.id.startsWith("pseg-system-2-s"));
    const total = s2segs.reduce((sum, s) => sum + (s.charCount ?? 0), 0);
    expect(total).toBe(27912);
  });

  test("system[1] 有 cache_control → cacheHint=write", () => {
    const s = snapshot.segments.find((s) => s.id === "pseg-system-1");
    expect(s?.cacheHint).toBe("write");
  });

  test("top char segment 是 system[2] 的 auto memory section（最大 section）", () => {
    const sorted = [...snapshot.segments].sort((a, b) => (b.charCount ?? 0) - (a.charCount ?? 0));
    // auto memory section（# auto memory，12552 chars）是最大 section
    expect(sorted[0].id).toBe("pseg-system-2-s8");
  });

  test("usage 从 SSE message_delta 提取，三桶语义正确", () => {
    const u = snapshot.usage!;
    // system-tools-overhead 是首次调用，cache_creation 很大，cache_read=0
    expect(u.outputTokens).toBeGreaterThan(0);
    expect(u.cacheCreationInputTokens).toBeGreaterThan(30000);
    expect(u.cacheReadInputTokens).toBe(0);
    // freshInputTokens = input_tokens 本身（不减 cache_read）
    expect(u.freshInputTokens).toBe(u.inputTokens);
    // measuredInputTokens = 三桶之和（完整上下文窗口大小）
    expect(u.measuredInputTokens).toBe(
      (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0),
    );
    expect(u.measuredInputTokens).toBeGreaterThan(30000);
  });

  test("rawRequestHash 是 sha256 格式", () => {
    expect(snapshot.rawRequestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("总 segment 数 = 12（system）+ 34（tools）+ 2（messages）= 48", () => {
    expect(snapshot.segments.length).toBe(48);
  });
});

// ── single-tool-call ──────────────────────────────────────────────────────────

describe("single-tool-call", () => {
  const input = loadFixture("single-tool-call");
  const snapshot = parseClaudeProxyRequest(input, {
    proxyFile: `server/test/fixtures/context-reconstruction/single-tool-call/proxy-request.json`,
  });

  test("session ID 正确", () => {
    expect(snapshot.sessionId).toBe("ba3db910-c0df-4863-910c-7b8e9525fa84");
  });

  test("system 切出 12 个 segment（billing + identity + system[2] 的 10 个 section）", () => {
    expect(snapshot.segments.filter((s) => s.section === "system").length).toBe(12);
  });

  test("tools 切出 34 个 segment", () => {
    expect(snapshot.segments.filter((s) => s.section === "tools").length).toBe(34);
  });

  test("messages 有 tool_use segment", () => {
    const toolUse = snapshot.segments.filter((s) => s.category === "tool_use");
    expect(toolUse.length).toBe(2);
  });

  test("messages 有 tool_result segment", () => {
    const toolResult = snapshot.segments.filter((s) => s.category === "tool_result");
    expect(toolResult.length).toBe(2);
  });

  test("tool_use segment 携带 toolUseId", () => {
    const tu = snapshot.segments.find((s) => s.category === "tool_use");
    expect(tu?.toolUseId).toMatch(/^toolu_/);
  });

  test("tool_result segment 携带 toolUseId（与 tool_use 对应）", () => {
    const tr = snapshot.segments.find((s) => s.category === "tool_result");
    expect(tr?.toolUseId).toMatch(/^toolu_/);
  });

  test("top char tool_result charCount ≈ 1491", () => {
    const trs = snapshot.segments.filter((s) => s.category === "tool_result");
    const maxChars = Math.max(...trs.map((s) => s.charCount ?? 0));
    expect(maxChars).toBeGreaterThan(1000);
  });

  test("usage cache_read_input_tokens > 0，measuredInputTokens = 三桶之和", () => {
    const u = snapshot.usage!;
    expect(u.cacheReadInputTokens).toBeGreaterThan(30000);
    expect(u.freshInputTokens).toBe(u.inputTokens);
    expect(u.measuredInputTokens).toBe(
      (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0),
    );
  });
});

// ── large-tool-output ─────────────────────────────────────────────────────────

describe("large-tool-output", () => {
  const input = loadFixture("large-tool-output");
  const snapshot = parseClaudeProxyRequest(input, {
    proxyFile: `server/test/fixtures/context-reconstruction/large-tool-output/proxy-request.json`,
  });

  test("messages 有 4 个 tool_use segment", () => {
    expect(snapshot.segments.filter((s) => s.category === "tool_use").length).toBe(4);
  });

  test("messages 有 4 个 tool_result segment", () => {
    expect(snapshot.segments.filter((s) => s.category === "tool_result").length).toBe(4);
  });

  test("最大 tool_result charCount > 20000", () => {
    const trs = snapshot.segments.filter((s) => s.category === "tool_result");
    const maxChars = Math.max(...trs.map((s) => s.charCount ?? 0));
    expect(maxChars).toBeGreaterThan(20000);
  });

  test("大 tool_result 有 large_segment flag", () => {
    const large = snapshot.segments.find(
      (s) => s.category === "tool_result" && (s.charCount ?? 0) > 20000,
    );
    expect(large?.flags).toContain("large_segment");
  });

  test("tools 切出 40 个 segment", () => {
    expect(snapshot.segments.filter((s) => s.section === "tools").length).toBe(40);
  });

  test("top-2 char segments 包含大 tool_result（system prompt 更大）", () => {
    const sorted = [...snapshot.segments].sort((a, b) => (b.charCount ?? 0) - (a.charCount ?? 0));
    const top2Categories = sorted.slice(0, 2).map((s) => s.category);
    expect(top2Categories).toContain("tool_result");
    // 大 tool_result 在前两名内
    const largeToolResult = sorted.find((s) => s.category === "tool_result" && (s.charCount ?? 0) > 20000);
    expect(largeToolResult).toBeDefined();
  });
});

// ── multi-turn-human ──────────────────────────────────────────────────────────

describe("multi-turn-human", () => {
  const input = loadFixture("multi-turn-human");
  const snapshot = parseClaudeProxyRequest(input, {
    proxyFile: `server/test/fixtures/context-reconstruction/multi-turn-human/proxy-request.json`,
  });

  test("session ID 正确", () => {
    expect(snapshot.sessionId).toBe("c8bc69a1-1625-4e70-8736-525b3c335b17");
  });

  test("tools 切出 40 个 segment", () => {
    expect(snapshot.segments.filter((s) => s.section === "tools").length).toBe(40);
  });

  // OBSOLETE（旧 contract）：parser 曾用 classifyTextBlock 识别 harness_injection/local_command_history。
  // 现在 parser 只产出 user_message/assistant_text，语义分类由 attribution 完成。
  // harness_injection/local_command_history 验证请在 proxy-attribution.test.ts 中查看。
  test("messages text block 全部保守分类为 user_message 或 assistant_text（parser 不做语义分类）", () => {
    const textSegs = snapshot.segments.filter(
      (s) => s.section === "messages" && s.category !== "tool_use" && s.category !== "tool_result",
    );
    for (const seg of textSegs) {
      expect(["user_message", "assistant_text"]).toContain(seg.category);
    }
  });

  test("messages[0] 的 text block 存有 rawText 供 attribution 消费", () => {
    const msg0TextSegs = snapshot.segments.filter(
      (s) => s.section === "messages" &&
        (s.sourceRefs[0] as { kind: string; proxy?: { jsonPath?: string } })?.proxy?.jsonPath?.startsWith("reqBody.messages[0]"),
    );
    // messages[0] 里应有 text block 且携带 rawText
    const withRawText = msg0TextSegs.filter((s) => s.rawText !== undefined && s.rawText.length > 0);
    expect(withRawText.length).toBeGreaterThan(0);
  });

  test("tool_use segment 存在", () => {
    expect(snapshot.segments.filter((s) => s.category === "tool_use").length).toBe(2);
  });

  test("tool_result segment 存在", () => {
    expect(snapshot.segments.filter((s) => s.category === "tool_result").length).toBe(2);
  });

  test("每个 segment 都有 rawHash", () => {
    for (const seg of snapshot.segments) {
      expect(seg.rawHash).toMatch(/^sha256:/);
    }
  });

  test("每个 segment 都有 charCount ≥ 0", () => {
    for (const seg of snapshot.segments) {
      expect(seg.charCount).toBeGreaterThanOrEqual(0);
    }
  });
});
