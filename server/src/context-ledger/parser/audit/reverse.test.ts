import { describe, it, expect } from "vitest";
import { parseQuery, attributeSnapshot } from "../index";
import { linkJsonl, type LinkableJsonlEvent } from "../attribution/jsonl-linker";
import { computeReverseAudit } from "./reverse";

function reqBody() {
  return {
    system: [{ type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "toolu_aaa", name: "Read", input: {} },
          { type: "tool_result", tool_use_id: "toolu_aaa", content: "ok" },
        ],
      },
    ],
  };
}

describe("ReverseAudit — 每个 jsonl 单元是否被 segment 引用", () => {
  it("有对应 tool_use jsonl 事件时 → byKind.tool_use.linked++", () => {
    const snap = parseQuery({ reqBody: reqBody(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const events: LinkableJsonlEvent[] = [
      {
        lineIdx: 0,
        type: "assistant",
        callId: 1,
        turnId: 0,
        toolUses: [{ id: "toolu_aaa", name: "Read" }],
      },
    ];
    linkJsonl(snap, events, { callId: 1, turnId: 0 });

    const audit = computeReverseAudit(snap, events);
    expect(audit.byKind.tool_use.total).toBe(1);
    expect(audit.byKind.tool_use.linked).toBe(1);
    expect(audit.byKind.tool_use.missing).toBe(0);
    expect(audit.missing.length).toBe(0);
  });

  it("jsonl 出现 tool_use 但 proxy 中找不到对应 toolUseId → missing 列表非空", () => {
    const snap = parseQuery({ reqBody: reqBody(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    // 制造一个 proxy 中不存在的 tool_use_id
    const events: LinkableJsonlEvent[] = [
      {
        lineIdx: 5,
        type: "assistant",
        callId: 1,
        turnId: 0,
        toolUses: [{ id: "toolu_ghost", name: "Edit" }],
      },
    ];
    linkJsonl(snap, events, { callId: 1, turnId: 0 });

    const audit = computeReverseAudit(snap, events);
    expect(audit.byKind.tool_use.missing).toBe(1);
    expect(audit.missing.length).toBe(1);
    expect(audit.missing[0]).toMatchObject({
      jsonlLineIdx: 5,
      eventKind: "tool_use",
      toolUseId: "toolu_ghost",
      reason: "no_segment_linked",
    });
    expect(audit.missing[0].expectedSlotHint).toContain("messages.tool_use");
  });

  it("assistant_text 事件无 segment 引用时进入 missing", () => {
    const snap = parseQuery({ reqBody: reqBody(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const events: LinkableJsonlEvent[] = [
      {
        lineIdx: 9,
        type: "assistant",
        callId: 1,
        turnId: 0,
        assistantText: "这段回复在 proxy 里完全找不到对应叶子",
      },
    ];
    linkJsonl(snap, events, { callId: 1, turnId: 0 });

    const audit = computeReverseAudit(snap, events);
    expect(audit.byKind.assistant_text.total).toBe(1);
    expect(audit.byKind.assistant_text.missing).toBe(1);
    expect(audit.missing.find((m) => m.eventKind === "assistant_text")).toBeDefined();
  });

  it("一条 jsonl 同时携带 assistantText 和多个 toolUses → 拆成多个单元统计", () => {
    const snap = parseQuery({ reqBody: reqBody(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const events: LinkableJsonlEvent[] = [
      {
        lineIdx: 12,
        type: "assistant",
        callId: 1,
        turnId: 0,
        assistantText: "thinking…",
        toolUses: [{ id: "toolu_aaa", name: "Read" }, { id: "toolu_bbb", name: "Write" }],
      },
    ];
    linkJsonl(snap, events, { callId: 1, turnId: 0 });

    const audit = computeReverseAudit(snap, events);
    expect(audit.byKind.tool_use.total).toBe(2);
    expect(audit.byKind.assistant_text.total).toBe(1);
    // toolu_aaa 在 proxy 里能找到，toolu_bbb 找不到
    expect(audit.byKind.tool_use.linked).toBe(1);
    expect(audit.byKind.tool_use.missing).toBe(1);
  });
});
