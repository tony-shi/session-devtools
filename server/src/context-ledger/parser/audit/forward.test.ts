import { describe, it, expect } from "vitest";
import { parseQuery, attributeSnapshot } from "../index";
import { linkJsonl, type LinkableJsonlEvent } from "../attribution/jsonl-linker";
import { computeForwardAudit } from "./forward";

function baseReqBody() {
  return {
    system: [
      {
        type: "text" as const,
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      {
        type: "text" as const,
        text: "Prelude.\n# Doing tasks\nDo stuff.\n# Tone and style\nBe concise.\n",
      },
    ],
    tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "toolu_abc", name: "Read", input: { file: "x" } },
          { type: "tool_result", tool_use_id: "toolu_abc", content: "ok" },
        ],
      },
    ],
  };
}

describe("ForwardAudit — 三桶覆盖度计数", () => {
  it("totals.leafCount === full + partial + none", () => {
    const snap = parseQuery({ reqBody: baseReqBody(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const audit = computeForwardAudit(snap);
    expect(audit.totals.leafCount).toBe(
      audit.totals.full + audit.totals.partial + audit.totals.none,
    );
  });

  it("wire 节点（tool_use / tool_result）进 full.byOrigin.rule", () => {
    const snap = parseQuery({ reqBody: baseReqBody(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const audit = computeForwardAudit(snap);

    const toolUse = Object.values(snap.index).find((n) => n.slotType === "messages.tool_use");
    const toolResult = Object.values(snap.index).find((n) => n.slotType === "messages.tool_result");
    expect(toolUse).toBeDefined();
    expect(toolResult).toBeDefined();
    if (!toolUse || !toolResult) return;
    expect(audit.full.byOrigin.rule).toContain(toolUse.id);
    expect(audit.full.byOrigin.rule).toContain(toolResult.id);
  });

  it("jsonl link 命中后，tool_use 节点搬到 full.byOrigin.jsonl", () => {
    const snap = parseQuery({ reqBody: baseReqBody(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const events: LinkableJsonlEvent[] = [
      {
        lineIdx: 3,
        type: "assistant",
        callId: 1,
        turnId: 0,
        toolUses: [{ id: "toolu_abc", name: "Read" }],
      },
    ];
    linkJsonl(snap, events, { callId: 1, turnId: 0 });

    const audit = computeForwardAudit(snap);
    const toolUse = Object.values(snap.index).find((n) => n.slotType === "messages.tool_use");
    expect(toolUse).toBeDefined();
    if (!toolUse) return;
    expect(audit.full.byOrigin.jsonl).toContain(toolUse.id);
    expect(audit.full.byOrigin.rule).not.toContain(toolUse.id);
  });

  it("无规则 + 无 jsonl 的叶子计入 none.structural_no_rule 或 none.unknown", () => {
    // 用一个完全空洞的 reqBody，制造 unknown / structural 叶子
    const snap = parseQuery({
      reqBody: {
        system: [{ type: "text", text: "xxxxxxx 完全无规则的 prelude 文本 xxxxxxx" }],
        messages: [{ role: "user", content: [{ type: "text", text: "noop" }] }],
      },
      proxyFile: "t.json",
    });
    attributeSnapshot(snap);
    const audit = computeForwardAudit(snap);
    expect(audit.totals.none).toBeGreaterThan(0);
    // 至少一类是非空
    const noneTotal =
      audit.none.byKind.structural_no_rule.length + audit.none.byKind.unknown.length;
    expect(noneTotal).toBe(audit.totals.none);
  });

  it("partial 桶的 reason 只来自 rule.* 或 jsonl.* 命名空间", () => {
    const snap = parseQuery({ reqBody: baseReqBody(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const audit = computeForwardAudit(snap);
    for (const reason of Object.keys(audit.partial.byReason)) {
      expect(reason.startsWith("rule.") || reason.startsWith("jsonl.")).toBe(true);
    }
  });

  it("segmentIds 不会重复出现在两个桶里", () => {
    const snap = parseQuery({ reqBody: baseReqBody(), proxyFile: "t.json" });
    attributeSnapshot(snap);
    const audit = computeForwardAudit(snap);
    const all = [...audit.full.segmentIds, ...audit.partial.segmentIds, ...audit.none.segmentIds];
    const set = new Set(all);
    expect(set.size).toBe(all.length);
    expect(set.size).toBe(audit.totals.leafCount);
  });
});
