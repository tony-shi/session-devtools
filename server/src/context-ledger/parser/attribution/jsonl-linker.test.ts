import { describe, it, expect } from "vitest";
import { attributeWithJsonl } from "../index";
import type { LinkableJsonlEvent } from "./jsonl-linker";

// 构造一个完整 fixture：1 个 user input + 1 个 assistant call 含 tool_use + 1 个 tool_result
// + 1 个 assistant 收尾文本。proxy reqBody 把它们拍扁成 messages[]，jsonl 是事件流。

function makeFixture() {
  const userInputText = "请帮我看一下 package.json 里的 dev 脚本";
  const assistantText1 = "我先看下 package.json。";
  const toolUseId = "toolu_test_abc123";
  const toolResultText = '{"dev": "vite"}';
  const assistantText2 = "dev 脚本是 vite。";

  // —— proxy 视角的 messages（积累态）——
  const reqBody = {
    system: [
      { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
      // 给一个有 H1 的 main-prompt block 让 selector 判定 main_session
      { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
    ],
    tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
    messages: [
      // [0] 用户原始输入
      { role: "user", content: [{ type: "text", text: userInputText }] },
      // [1] 助手第一次响应：含文本 + tool_use
      {
        role: "assistant",
        content: [
          { type: "text", text: assistantText1 },
          { type: "tool_use", id: toolUseId, name: "Read", input: { file: "package.json" } },
        ],
      },
      // [2] 用户消息（实际是 tool_result）
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: toolResultText }] },
      // [3] 助手最终输出
      { role: "assistant", content: [{ type: "text", text: assistantText2 }] },
    ],
  };

  // —— jsonl 视角的事件流（claude-code 记录的）——
  const events: LinkableJsonlEvent[] = [
    {
      lineIdx: 10,
      type: "user",
      userText: userInputText,
      callId: 1,
      turnId: 2,
    },
    {
      lineIdx: 11,
      type: "assistant",
      assistantText: assistantText1,
      toolUses: [{ id: toolUseId, name: "Read" }],
      callId: 1,
      turnId: 2,
    },
    {
      lineIdx: 12,
      type: "user",
      toolResults: [{ toolUseId, contentText: toolResultText }],
      callId: 1,
      turnId: 2,
    },
    {
      lineIdx: 13,
      type: "assistant",
      assistantText: assistantText2,
      callId: 1,
      turnId: 2,
    },
  ];

  return { reqBody, events, toolUseId, userInputText, assistantText1, assistantText2, toolResultText };
}

describe("PR 3 — jsonl-linker", () => {
  it("tool_use by id → JsonlOrigin (definitive, eventKind=tool_use, toolUseId 填入)", () => {
    const fx = makeFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.toolUse).toBe(1);

    const tu = Object.values(snapshot.index).find((n) => n.slotType === "messages.tool_use");
    expect(tu?.origin.kind).toBe("jsonl");
    if (tu?.origin.kind === "jsonl") {
      expect(tu.origin.eventKind).toBe("tool_use");
      expect(tu.origin.confidence).toBe("definitive");
      expect(tu.origin.toolUseId).toBe(fx.toolUseId);
      expect(tu.origin.jsonlLineIdx).toBe(11);
      expect(tu.origin.sourceCallId).toBe(1);
      expect(tu.origin.sourceTurnId).toBe(2);
    }
  });

  it("tool_result by tool_use_id → JsonlOrigin (definitive)", () => {
    const fx = makeFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.toolResult).toBe(1);

    const tr = Object.values(snapshot.index).find((n) => n.slotType === "messages.tool_result");
    expect(tr?.origin.kind).toBe("jsonl");
    if (tr?.origin.kind === "jsonl") {
      expect(tr.origin.eventKind).toBe("tool_result");
      expect(tr.origin.toolUseId).toBe(fx.toolUseId);
      expect(tr.origin.jsonlLineIdx).toBe(12);
    }
  });

  it("user_input by content equality → JsonlOrigin (definitive, eventKind=user_input)", () => {
    const fx = makeFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.userInput).toBe(1);

    const ui = Object.values(snapshot.index).find(
      (n) =>
        n.wireMeta?.messageRole === "user" &&
        n.wireMeta.messageIdx === 0 &&
        n.children.length === 0 &&
        n.rawText === fx.userInputText,
    );
    expect(ui?.origin.kind).toBe("jsonl");
    if (ui?.origin.kind === "jsonl") {
      expect(ui.origin.eventKind).toBe("user_input");
      expect(ui.origin.confidence).toBe("definitive");
      expect(ui.origin.jsonlLineIdx).toBe(10);
    }
  });

  it("assistant_text by content equality → JsonlOrigin (definitive)", () => {
    const fx = makeFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.assistantText).toBe(2); // assistant_text1 和 assistant_text2

    const asst1 = Object.values(snapshot.index).find(
      (n) => n.wireMeta?.messageRole === "assistant" && n.rawText === fx.assistantText1,
    );
    expect(asst1?.origin.kind).toBe("jsonl");
    if (asst1?.origin.kind === "jsonl") {
      expect(asst1.origin.eventKind).toBe("assistant_text");
      expect(asst1.origin.jsonlLineIdx).toBe(11);
    }

    const asst2 = Object.values(snapshot.index).find(
      (n) => n.wireMeta?.messageRole === "assistant" && n.rawText === fx.assistantText2,
    );
    expect(asst2?.origin.kind).toBe("jsonl");
    if (asst2?.origin.kind === "jsonl") {
      expect(asst2.origin.jsonlLineIdx).toBe(13);
    }
  });

  it("tool_use_id 不在 jsonl 中时不覆盖 origin (保留 wire rule origin)", () => {
    const fx = makeFixture();
    const eventsWithoutToolUse: LinkableJsonlEvent[] = fx.events.map((e) =>
      e.toolUses ? { ...e, toolUses: undefined } : e,
    );
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: eventsWithoutToolUse,
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.toolUse).toBe(0);

    const tu = Object.values(snapshot.index).find((n) => n.slotType === "messages.tool_use");
    // 没有 jsonl 命中，origin 应保留为 PR 2 写入的 wire rule origin
    expect(tu?.origin.kind).toBe("rule");
    if (tu?.origin.kind === "rule") {
      expect(tu.origin.ruleId).toBe("wire.messages.tool_use");
    }
  });

  it("不变量在整条 pipeline 之后仍然成立", () => {
    const fx = makeFixture();
    const { snapshot } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: fx.events,
      call: { callId: 1, turnId: 2 },
    });
    // attributeWithJsonl 内部已经跑了 assertAllInvariants；这里再次显式验证。
    // 任何节点都有 origin
    for (const node of Object.values(snapshot.index)) {
      expect(node.origin).toBeDefined();
    }
    // 叶子拼接 ≡ 父节点 rawText
    for (const node of Object.values(snapshot.index)) {
      if (node.children.length === 0) continue;
      const concat = node.children
        .flatMap(function leaves(n): string[] {
          if (n.children.length === 0) return [n.rawText];
          return n.children.flatMap(leaves);
        })
        .join("");
      expect(concat).toBe(node.rawText);
    }
  });

  it("空 jsonl events 时 linkReport.matched 全为 0，origin 保留 PR 2 状态", () => {
    const fx = makeFixture();
    const { snapshot, linkReport } = attributeWithJsonl({
      reqBody: fx.reqBody,
      proxyFile: "t.json",
      jsonl: [],
      call: { callId: 1, turnId: 2 },
    });
    expect(linkReport.matched.toolUse).toBe(0);
    expect(linkReport.matched.toolResult).toBe(0);
    expect(linkReport.matched.userInput).toBe(0);
    expect(linkReport.matched.assistantText).toBe(0);
    // 无任何 JsonlOrigin
    for (const node of Object.values(snapshot.index)) {
      expect(node.origin.kind).not.toBe("jsonl");
    }
  });
});
