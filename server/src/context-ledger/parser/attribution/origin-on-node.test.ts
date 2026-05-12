import { describe, it, expect } from "vitest";
import { parseQuery, attributeSnapshot } from "../index";
import { assertAllInvariants } from "./invariants";

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
