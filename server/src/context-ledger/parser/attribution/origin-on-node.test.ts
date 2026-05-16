import { describe, it, expect } from "vitest";
import { parseQuery, attributeSnapshot } from "../index";
import { assertAllInvariants } from "./invariants";
import { coverageStateOf } from "./origin";
import { linkJsonl, type LinkableJsonlEvent } from "./jsonl-linker";
import { withBillingHeader } from "./test-fixtures";

// 目标：验证 PR 2 — attributeSnapshot 把归因结果原地写到 node.origin，且 SegmentAttribution[]
// 投影仍然产出（向后兼容）。所有不变量在归因后仍然成立。

function reqBodyWithIdentityAndTools() {
  return withBillingHeader({
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
  });
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

// Tone-style 两套 byte-exact rule + appliesTo 版本范围。
//   v0 适用 2.1.140-2.1.141：leaf 含尾 `\n\n` = 557B
//   v1 适用 2.1.142+：leaf 严格止于 `period.` = 555B
// 同一份 NM3 输出文本，按 cc_version 路由到正确版本的 rule。
describe("tone-style rule — cc_version 版本化分发 (v0 / v1)", () => {
  const TONE_LITERAL =
    "# Tone and style\n" +
    " - Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.\n" +
    " - Your responses should be short and concise.\n" +
    " - When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.\n" +
    " - Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like \"Let me read the file:\" followed by a read tool call should just be \"Let me read the file.\" with a period.";

  function reqWith(toneSuffix: string, ccVersion: string) {
    return withBillingHeader({
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        {
          type: "text" as const,
          text: "Prelude line.\n\n" + TONE_LITERAL + toneSuffix,
        },
      ],
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }, ccVersion);
  }

  it("2.1.140.453 wire 形态（557B，尾 \\n\\n）→ 命中 v0 rule", () => {
    const snap = parseQuery({ reqBody: reqWith("\n\n", "2.1.140.453"), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const tone = Object.values(snap.index).find((n) => n.slotType === "system.main-prompt.section.tone-style");
    expect(tone).toBeDefined();
    expect(tone!.charCount).toBe(557);
    expect(tone!.origin.kind).toBe("rule");
    if (tone!.origin.kind === "rule") {
      expect(tone!.origin.ruleId).toBe("claude-code.system-prompt-tone-style.external.v0");
      expect(tone!.origin.fullyCovered).toBe(true);
    }
  });

  it("2.1.139.6c9 也是老形态（557B）→ 同样命中 v0 rule", () => {
    const snap = parseQuery({ reqBody: reqWith("\n\n", "2.1.139.6c9"), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const tone = Object.values(snap.index).find((n) => n.slotType === "system.main-prompt.section.tone-style");
    expect(tone).toBeDefined();
    expect(tone!.charCount).toBe(557);
    expect(tone!.origin.kind).toBe("rule");
    if (tone!.origin.kind === "rule") {
      expect(tone!.origin.ruleId).toBe("claude-code.system-prompt-tone-style.external.v0");
      expect(tone!.origin.fullyCovered).toBe(true);
    }
  });

  it("2.1.141.7ed 已经是新形态（555B）→ 命中 v1 rule", () => {
    // 注意：边界在 2.1.140 → 2.1.141 之间（不是 2.1.141 → 2.1.142）；
    // 真实 dump: 59339097 #15 cc=2.1.141.7ed leaf=555B 同 2.1.142 形态。
    const snap = parseQuery({ reqBody: reqWith("", "2.1.141.7ed"), proxyFile: "t.json" });
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

  it("2.1.142.6c2 wire 形态（555B）→ 命中 v1 rule", () => {
    const snap = parseQuery({ reqBody: reqWith("", "2.1.142.6c2"), proxyFile: "t.json" });
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

  it("版本 / 形态错配：2.1.140 leaf 是 555B（无尾 \\n\\n）→ 不命中 v0 也不命中 v1", () => {
    // v0 的 pattern 含尾 \n\n（要求 557B），exact 不命中 555B leaf。
    // v1 的 appliesTo minCcVersion=2.1.141，cc=2.1.140 也不进入候选。
    // 结果：tone leaf 保持 structural / no_rule_matched —— 这是严格版本化要的诚实行为。
    const snap = parseQuery({ reqBody: reqWith("", "2.1.140.453"), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const tone = Object.values(snap.index).find((n) => n.slotType === "system.main-prompt.section.tone-style");
    expect(tone).toBeDefined();
    expect(tone!.origin.kind).toBe("structural");
  });

  it("版本 / 形态错配：2.1.141 leaf 是 557B（含尾 \\n\\n）→ 不命中 v1（v0 也因版本被滤掉）", () => {
    const snap = parseQuery({ reqBody: reqWith("\n\n", "2.1.141.7ed"), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const tone = Object.values(snap.index).find((n) => n.slotType === "system.main-prompt.section.tone-style");
    expect(tone).toBeDefined();
    expect(tone!.origin.kind).toBe("structural");
  });
});

// 归因失败：billing-noise 没命中（system[0] 不是 billing header）→ 所有 rule 评估跳过。
// tool_use / tool_result / wire schema 仍能拿到 wire fallback origin（协议层不依赖 cc_version）。
describe("AttributionContext 缺失 → 归因失败，跳过 rule 评估", () => {
  it("system[0] 不是 billing header → snapshot.attributionContext.ok=false，叶子保持 structural", () => {
    const snap = parseQuery({
      reqBody: {
        // 故意不调 withBillingHeader：第一个块是 identity，没有 billing header
        system: [
          { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        ],
        tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      proxyFile: "t.json",
    });
    expect(snap.attributionContext.ok).toBe(false);

    attributeSnapshot(snap);
    // identity slot 也应保持 structural（没跑 rule）
    const identity = Object.values(snap.index).find((n) => n.slotType === "system.identity");
    expect(identity).toBeDefined();
    expect(identity!.origin.kind).toBe("structural");
  });
});
