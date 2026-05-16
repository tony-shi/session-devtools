import { describe, it, expect } from "vitest";
import { parseQuery, attributeSnapshot } from "../index";
import { assertAllInvariants } from "./invariants";
import { coverageStateOf } from "./origin";
import { linkJsonl, type LinkableJsonlEvent } from "./jsonl-linker";

// 目标：验证 PR 2 — attributeSnapshot 把归因结果原地写到 node.origin，且 SegmentAttribution[]
// 投影仍然产出（向后兼容）。所有不变量在归因后仍然成立。

function reqBodyWithIdentityAndTools() {
  return {
    system: [
      {
        type: "text" as const,
        // identity slot 由 main-session template 的字面 anchor 路由
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      {
        type: "text" as const,
        text: "Prelude.\n# Doing tasks\nDo stuff.\n# Tone and style\nBe concise.\n",
      },
    ],
    tools: [
      { name: "Read", description: "Read a file", input_schema: {} },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "toolu_test123", name: "Read", input: { file: "x" } },
          { type: "tool_result", tool_use_id: "toolu_test123", content: "ok" },
        ],
      },
    ],
  };
}

describe("PR 2 — attributeSnapshot 原地写 origin", () => {
  it("rule 命中的叶子节点 origin.kind = rule，含 ruleId", () => {
    const snap = parseQuery({ reqBody: reqBodyWithIdentityAndTools(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const identity = Object.values(snap.index).find((n) => n.slotType === "system.identity");
    expect(identity).toBeDefined();
    if (!identity) return;
    expect(identity.origin.kind).toBe("rule");
    if (identity.origin.kind === "rule") {
      // identity rule 应当命中
      expect(identity.origin.ruleId).toContain("identity");
      expect(["exact", "regex", "prefix"]).toContain(identity.origin.matchMode);
    }
  });

  it("tool_use / tool_result / tools.builtin.* 节点 origin = rule (wire 合成 ruleId)", () => {
    const snap = parseQuery({ reqBody: reqBodyWithIdentityAndTools(), proxyFile: "t.json" });
    attributeSnapshot(snap);

    const toolUse = Object.values(snap.index).find((n) => n.slotType === "messages.tool_use");
    expect(toolUse?.origin.kind).toBe("rule");
    if (toolUse?.origin.kind === "rule") {
      expect(toolUse.origin.ruleId).toBe("wire.messages.tool_use");
    }

    const toolResult = Object.values(snap.index).find((n) => n.slotType === "messages.tool_result");
    expect(toolResult?.origin.kind).toBe("rule");
    if (toolResult?.origin.kind === "rule") {
      expect(toolResult.origin.ruleId).toBe("wire.messages.tool_result");
    }

    const builtinTool = Object.values(snap.index).find((n) => n.slotType.startsWith("tools.builtin."));
    expect(builtinTool?.origin.kind).toBe("rule");
    if (builtinTool?.origin.kind === "rule") {
      expect(builtinTool.origin.ruleId).toBe("wire.tools.builtin");
    }
  });

  it("container 节点 origin 保持 structural/container_node，不被归因改写", () => {
    const snap = parseQuery({ reqBody: reqBodyWithIdentityAndTools(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const mainPrompt = Object.values(snap.index).find((n) => n.slotType === "system.main-prompt-block");
    expect(mainPrompt).toBeDefined();
    if (!mainPrompt) return;
    expect(mainPrompt.children.length).toBeGreaterThan(0);
    expect(mainPrompt.origin.kind).toBe("structural");
    if (mainPrompt.origin.kind === "structural") {
      expect(mainPrompt.origin.reason).toBe("container_node");
    }
  });

  it("归因后 assertAllInvariants 仍然通过", () => {
    const snap = parseQuery({ reqBody: reqBodyWithIdentityAndTools(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    expect(() => assertAllInvariants(snap)).not.toThrow();
  });

  it("SegmentAttribution[] 投影仍然产出（向后兼容）：叶子数 ≈ SegmentAttribution 数", () => {
    const snap = parseQuery({ reqBody: reqBodyWithIdentityAndTools(), proxyFile: "t.json" });
    const attrs = attributeSnapshot(snap);
    const leaves = Object.values(snap.index).filter((n) => n.children.length === 0);
    // 每个叶子产生一条 SegmentAttribution（rule 命中 / wire fallback / rule_gap projection）
    expect(attrs.length).toBe(leaves.length);
    // 每条 attribution 都能反查到一个叶子
    const leafIds = new Set(leaves.map((l) => l.id));
    for (const a of attrs) {
      expect(leafIds.has(a.nodeId)).toBe(true);
    }
  });

  it("wire rule origin fullyCovered=true（tool_use / tool_result / builtin schema 均为原子单元）", () => {
    const snap = parseQuery({ reqBody: reqBodyWithIdentityAndTools(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    for (const slot of ["messages.tool_use", "messages.tool_result"]) {
      const node = Object.values(snap.index).find((n) => n.slotType === slot);
      expect(node?.origin.kind).toBe("rule");
      if (node?.origin.kind === "rule") {
        expect(node.origin.fullyCovered).toBe(true);
      }
    }
  });

  it("identity 静态文本 rule 命中 → fullyCovered=true 且 coverageState=full", () => {
    const snap = parseQuery({ reqBody: reqBodyWithIdentityAndTools(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const identity = Object.values(snap.index).find((n) => n.slotType === "system.identity");
    expect(identity?.origin.kind).toBe("rule");
    if (identity?.origin.kind === "rule") {
      // identity 模式应当 exact 或 regex 覆盖整段。
      expect(identity.origin.fullyCovered).toBe(true);
      expect(coverageStateOf(identity.origin)).toBe("full");
    }
  });

  it("jsonl tool_use id 匹配 → JsonlOrigin.fullyCovered=true（atomic wire 单元）", () => {
    const snap = parseQuery({ reqBody: reqBodyWithIdentityAndTools(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const events: LinkableJsonlEvent[] = [
      {
        lineIdx: 7,
        type: "assistant",
        callId: 1,
        turnId: 0,
        toolUses: [{ id: "toolu_test123", name: "Read" }],
      },
    ];
    linkJsonl(snap, events, { callId: 1, turnId: 0 });
    const toolUse = Object.values(snap.index).find((n) => n.slotType === "messages.tool_use");
    expect(toolUse?.origin.kind).toBe("jsonl");
    if (toolUse?.origin.kind === "jsonl") {
      expect(toolUse.origin.fullyCovered).toBe(true);
      expect(coverageStateOf(toolUse.origin)).toBe("full");
    }
  });

  it("coverageStateOf(structural / unknown) === 'none'", () => {
    const snap = parseQuery({ reqBody: reqBodyWithIdentityAndTools(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const container = Object.values(snap.index).find((n) => n.slotType === "system.main-prompt-block");
    expect(container).toBeDefined();
    if (container) expect(coverageStateOf(container.origin)).toBe("none");
  });

  it("无 rule 命中的叶子保留 structural/no_rule_matched，投影输出 rule_gap", () => {
    const snap = parseQuery({ reqBody: reqBodyWithIdentityAndTools(), proxyFile: "t.json" });
    const attrs = attributeSnapshot(snap);
    // 找一个 prelude 叶子（pre-H1 前导文本）— 通常无具体 rule
    const prelude = Object.values(snap.index).find(
      (n) => n.slotType === "system.main-prompt.section.prelude",
    );
    if (!prelude) return;
    // 它可能命中也可能没命中具体规则；若没命中，origin 应保留 structural
    if (prelude.origin.kind === "structural") {
      expect(prelude.origin.reason).toBe("no_rule_matched");
      const a = attrs.find((x) => x.nodeId === prelude.id);
      expect(a?.matchMode).toBe("rule_gap");
    }
  });
});

// Tone-style section 在 wire 上有两种字节形态（cc_version 决定）：
//   - 2.1.142+：cache 切点放在 Nm3 之后，section 落到 system block 末尾，splitByH1Headers 切出 = 555B
//   - 2.1.140-：多 section 用 `\n\n` 拼到同一个 block，splitByH1Headers 把后续 `\n\n` 划入本段 = 557B
// rule 用 regex + 尾部 `\s*$` 两个版本都命中。这条 case 锁定两种形态都识别为 rule。
describe("tone-style rule — cc_version 版本兼容", () => {
  const TONE_LITERAL =
    "# Tone and style\n" +
    " - Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.\n" +
    " - Your responses should be short and concise.\n" +
    " - When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.\n" +
    " - Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like \"Let me read the file:\" followed by a read tool call should just be \"Let me read the file.\" with a period.";

  function reqWithToneSection(toneSuffix: string) {
    return {
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        {
          type: "text" as const,
          // 至少一个 prelude/前置 section，让 splitByH1Headers 把 tone-style 当作一个独立 H1。
          text: "Prelude line.\n\n" + TONE_LITERAL + toneSuffix,
        },
      ],
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
  }

  it("2.1.142+ 形态（555B，无尾换行）→ rule 命中且 fullyCovered", () => {
    const snap = parseQuery({ reqBody: reqWithToneSection(""), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const tone = Object.values(snap.index).find((n) => n.slotType === "system.main-prompt.section.tone-style");
    expect(tone).toBeDefined();
    expect(tone!.charCount).toBe(555);
    expect(tone!.origin.kind).toBe("rule");
    if (tone!.origin.kind === "rule") {
      expect(tone!.origin.ruleId).toBe("claude-code.system-prompt-tone-style.external.v1");
      expect(tone!.origin.fullyCovered).toBe(true);
    }
  });

  it("2.1.140- 形态（557B，尾 \\n\\n 划入本段）→ 同一条 rule 仍命中且 fullyCovered", () => {
    const snap = parseQuery({ reqBody: reqWithToneSection("\n\n"), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const tone = Object.values(snap.index).find((n) => n.slotType === "system.main-prompt.section.tone-style");
    expect(tone).toBeDefined();
    expect(tone!.charCount).toBe(557);
    expect(tone!.origin.kind).toBe("rule");
    if (tone!.origin.kind === "rule") {
      expect(tone!.origin.ruleId).toBe("claude-code.system-prompt-tone-style.external.v1");
      expect(tone!.origin.fullyCovered).toBe(true);
    }
  });
});
