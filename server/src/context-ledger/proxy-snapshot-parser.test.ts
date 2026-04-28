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

  test("system 切出 3 个 segment", () => {
    const sys = snapshot.segments.filter((s) => s.section === "system");
    expect(sys.length).toBe(3);
  });

  test("tools 切出 34 个 segment", () => {
    const tools = snapshot.segments.filter((s) => s.section === "tools");
    expect(tools.length).toBe(34);
  });

  test("messages 切出 2 个 segment（messages[0] 有 2 个 text block）", () => {
    const msgs = snapshot.segments.filter((s) => s.section === "messages");
    expect(msgs.length).toBe(2);
  });

  test("system[0] 是 billing_noise", () => {
    const s = snapshot.segments.find((s) => s.id === "pseg-system-0");
    expect(s?.category).toBe("billing_noise");
  });

  test("system[2] charCount ≈ 27912", () => {
    const s = snapshot.segments.find((s) => s.id === "pseg-system-2");
    expect(s?.charCount).toBeGreaterThan(20000);
  });

  test("system[1] 有 cache_control → cacheHint=write", () => {
    const s = snapshot.segments.find((s) => s.id === "pseg-system-1");
    expect(s?.cacheHint).toBe("write");
  });

  test("top char segment 是 system[2]（system prompt 主体）", () => {
    const sorted = [...snapshot.segments].sort((a, b) => (b.charCount ?? 0) - (a.charCount ?? 0));
    expect(sorted[0].id).toBe("pseg-system-2");
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

  test("总 segment 数 = 3 + 34 + 2 = 39", () => {
    expect(snapshot.segments.length).toBe(39);
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

  test("system 切出 3 个 segment", () => {
    expect(snapshot.segments.filter((s) => s.section === "system").length).toBe(3);
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

  test("messages[0] 有 harness_injection segment（system-reminder）", () => {
    const injected = snapshot.segments.filter((s) => s.category === "harness_injection");
    expect(injected.length).toBeGreaterThan(0);
  });

  test("messages[0] 有 local_command_history segment", () => {
    const lcmd = snapshot.segments.filter((s) => s.category === "local_command_history");
    expect(lcmd.length).toBeGreaterThan(0);
  });

  test("messages[0] 有 user_message segment（真实用户输入）", () => {
    const userMsg = snapshot.segments.filter(
      (s) => s.section === "messages" && s.category === "user_message",
    );
    expect(userMsg.length).toBeGreaterThan(0);
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
