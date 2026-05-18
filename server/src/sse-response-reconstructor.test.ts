import { describe, it, expect } from "vitest";
import { reconstructAssistantMessage, parseSseText } from "./sse-response-reconstructor.ts";
import type { SseEvent } from "./sse-response-reconstructor.ts";

// 测试约定：每条事件用 evt(type, data) 构造，data 是 JSON.stringify(...) 的字符串
// — 与上游 parseSseText 的输出 (Array<{eventType, data}>) 同构。
function evt(eventType: string, data: Record<string, unknown>): SseEvent {
  return { eventType, data: JSON.stringify(data) };
}

const messageStartUsage = {
  input_tokens: 100,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 50,
};

function messageStart(): SseEvent {
  return evt("message_start", {
    type: "message_start",
    message: {
      id: "msg_01ABC",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-7",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: messageStartUsage,
    },
  });
}

function messageDeltaEndTurn(outputTokens = 42): SseEvent {
  return evt("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
}

function messageDeltaToolUse(outputTokens = 88): SseEvent {
  return evt("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
}

function messageStop(): SseEvent {
  return evt("message_stop", { type: "message_stop" });
}

describe("reconstructAssistantMessage", () => {
  it("重组纯 text 响应", () => {
    const events: SseEvent[] = [
      messageStart(),
      evt("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello, " },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "world!" },
      }),
      evt("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageDeltaEndTurn(),
      messageStop(),
    ];

    const r = reconstructAssistantMessage(events);
    expect(r.truncated).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.message).not.toBeNull();
    expect(r.message?.id).toBe("msg_01ABC");
    expect(r.message?.model).toBe("claude-opus-4-7");
    expect(r.message?.role).toBe("assistant");
    expect(r.message?.stop_reason).toBe("end_turn");
    expect(r.message?.content).toEqual([{ type: "text", text: "Hello, world!" }]);
    expect(r.message?.usage.input_tokens).toBe(100);
    expect(r.message?.usage.output_tokens).toBe(42);
    expect(r.message?.usage.cache_read_input_tokens).toBe(50);
  });

  it("重组单个 tool_use（input 通过多次 partial_json 拼起来 JSON.parse）", () => {
    const events: SseEvent[] = [
      messageStart(),
      evt("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_01XYZ", name: "WebFetch", input: {} },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"url":"https://news' },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '.google.com/","prompt":"列出头条"}' },
      }),
      evt("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageDeltaToolUse(),
      messageStop(),
    ];

    const r = reconstructAssistantMessage(events);
    expect(r.truncated).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.message?.stop_reason).toBe("tool_use");
    expect(r.message?.content).toEqual([
      {
        type: "tool_use",
        id: "toolu_01XYZ",
        name: "WebFetch",
        input: { url: "https://news.google.com/", prompt: "列出头条" },
      },
    ]);
  });

  it("混合 thinking + text + tool_use 多块响应（顺序应按 index 升序输出）", () => {
    const events: SseEvent[] = [
      messageStart(),

      // block 0: thinking
      evt("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "用户想读 package.json，" },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "我应该调用 Read 工具。" },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "abc123sig" },
      }),
      evt("content_block_stop", { type: "content_block_stop", index: 0 }),

      // block 1: text
      evt("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "我来读一下 package.json。" },
      }),
      evt("content_block_stop", { type: "content_block_stop", index: 1 }),

      // block 2: tool_use
      evt("content_block_start", {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_R", name: "Read", input: {} },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"file":"package.json"}' },
      }),
      evt("content_block_stop", { type: "content_block_stop", index: 2 }),

      messageDeltaToolUse(),
      messageStop(),
    ];

    const r = reconstructAssistantMessage(events);
    expect(r.truncated).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.message?.content).toEqual([
      { type: "thinking", thinking: "用户想读 package.json，我应该调用 Read 工具。", signature: "abc123sig" },
      { type: "text", text: "我来读一下 package.json。" },
      { type: "tool_use", id: "toolu_R", name: "Read", input: { file: "package.json" } },
    ]);
  });

  it("ping 事件被忽略，不影响内容", () => {
    const events: SseEvent[] = [
      messageStart(),
      evt("ping", { type: "ping" }),
      evt("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      evt("ping", { type: "ping" }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }),
      evt("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageDeltaEndTurn(),
      messageStop(),
    ];

    const r = reconstructAssistantMessage(events);
    expect(r.truncated).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.message?.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("流中断（无 message_stop）标记 truncated=true，但已有块仍可输出", () => {
    const events: SseEvent[] = [
      messageStart(),
      evt("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial response..." },
      }),
      // 流到此为止 — 没有 stop / message_delta / message_stop
    ];

    const r = reconstructAssistantMessage(events);
    expect(r.truncated).toBe(true);
    expect(r.message?.content).toEqual([{ type: "text", text: "partial response..." }]);
    expect(r.message?.stop_reason).toBeNull();
  });

  it("tool_use input 的 partial_json 解析失败时回落到 raw string + errors", () => {
    const events: SseEvent[] = [
      messageStart(),
      evt("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_X", name: "Foo", input: {} },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"broken":' },
      }),
      // 没等到下一个 delta，流就被截断了
      messageStop(),
    ];

    const r = reconstructAssistantMessage(events);
    expect(r.truncated).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.message?.content[0]).toEqual({
      type: "tool_use",
      id: "toolu_X",
      name: "Foo",
      input: '{"broken":',  // raw string fallback
    });
  });

  it("message_start 缺失时返回 message=null（无法重组）", () => {
    const events: SseEvent[] = [
      evt("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "orphan" },
      }),
      messageStop(),
    ];

    const r = reconstructAssistantMessage(events);
    expect(r.message).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it("error 事件被记录到 errors[] 但不阻断重组", () => {
    const events: SseEvent[] = [
      messageStart(),
      evt("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      evt("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "before error" },
      }),
      evt("error", { type: "error", error: { type: "overloaded_error", message: "服务繁忙" } }),
      // 流被中止
    ];

    const r = reconstructAssistantMessage(events);
    expect(r.truncated).toBe(true);
    expect(r.errors.some((e) => e.includes("overloaded_error"))).toBe(true);
    expect(r.message?.content).toEqual([{ type: "text", text: "before error" }]);
  });

  it("空 partial_json（工具无参数）→ input 保留 content_block_start 的初始值 {}", () => {
    const events: SseEvent[] = [
      messageStart(),
      evt("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_NP", name: "Ping", input: {} },
      }),
      evt("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageDeltaToolUse(),
      messageStop(),
    ];

    const r = reconstructAssistantMessage(events);
    expect(r.truncated).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.message?.content).toEqual([
      { type: "tool_use", id: "toolu_NP", name: "Ping", input: {} },
    ]);
  });

  it("parseSseText 解析完整 SSE 文本，与 reconstruct 端到端串联", () => {
    const text = [
      "event: message_start",
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_X", role: "assistant", model: "claude", usage: { input_tokens: 5 } } })}`,
      "",
      "event: content_block_start",
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      "",
      "event: content_block_delta",
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}`,
      "",
      "event: content_block_stop",
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      "",
      "event: message_delta",
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } })}`,
      "",
      "event: message_stop",
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ].join("\n");

    const events = parseSseText(text);
    expect(events.length).toBe(6);
    expect(events[0].eventType).toBe("message_start");
    expect(events[2].eventType).toBe("content_block_delta");

    const r = reconstructAssistantMessage(events);
    expect(r.truncated).toBe(false);
    expect(r.message?.content).toEqual([{ type: "text", text: "hi" }]);
    expect(r.message?.stop_reason).toBe("end_turn");
  });

  it("usage.output_tokens 从 message_delta 更新而非 message_start", () => {
    const events: SseEvent[] = [
      messageStart(),
      evt("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "x" },
      }),
      evt("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageDeltaEndTurn(256),
      messageStop(),
    ];
    const r = reconstructAssistantMessage(events);
    expect(r.message?.usage.output_tokens).toBe(256);
    expect(r.message?.usage.input_tokens).toBe(100);
  });
});
