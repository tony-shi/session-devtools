import { describe, it, expect } from "vitest";
import { parseQuery, attributeSnapshot } from "../index";
import { computeTreeDiff } from "./tree-diff";

function reqBody(systemH1: string, userText: string) {
  return {
    system: [
      { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text" as const, text: `Prelude.\n# Doing tasks\n${systemH1}\n` },
    ],
    tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
  };
}

function build(body: ReturnType<typeof reqBody>) {
  const snap = parseQuery({ reqBody: body, proxyFile: "t.json" });
  attributeSnapshot(snap);
  return snap;
}

describe("PR 4a — tree-diff", () => {
  it("previous=null → 所有 current 叶子都是 added", () => {
    const cur = build(reqBody("Stay focused.", "hello"));
    const diff = computeTreeDiff(cur, null);
    expect(diff.summary.addedLeaves).toBe(diff.summary.currentLeaves);
    expect(diff.summary.unchangedLeaves).toBe(0);
    expect(diff.summary.removedLeaves).toBe(0);
    for (const status of Object.values(diff.leafStatus)) {
      expect(status).toBe("added");
    }
  });

  it("内容完全相同 → 所有叶子 unchanged，summary 数清零", () => {
    const a = build(reqBody("Stay focused.", "hello"));
    const b = build(reqBody("Stay focused.", "hello"));
    const diff = computeTreeDiff(b, a);
    expect(diff.summary.addedLeaves).toBe(0);
    expect(diff.summary.removedLeaves).toBe(0);
    expect(diff.summary.unchangedLeaves).toBe(diff.summary.currentLeaves);
    expect(diff.summary.netCharDelta).toBe(0);
  });

  it("仅 user message 变化 → 旧 user 叶子 removed，新 user 叶子 added，其它 unchanged", () => {
    const a = build(reqBody("Stay focused.", "old prompt"));
    const b = build(reqBody("Stay focused.", "new prompt entirely"));
    const diff = computeTreeDiff(b, a);
    expect(diff.summary.addedLeaves).toBeGreaterThan(0);
    expect(diff.summary.removedLeaves).toBeGreaterThan(0);
    // 应当有一些 unchanged（system identity / doing-tasks 等）
    expect(diff.summary.unchangedLeaves).toBeGreaterThan(0);
    // removed 列表里应当能找到旧 user 文本
    const hasOldUser = diff.removedFromPrevious.some((r) => r.preview.includes("old prompt"));
    expect(hasOldUser).toBe(true);
  });

  it("netCharDelta = addedChars - removedChars", () => {
    const a = build(reqBody("Stay focused.", "short"));
    const b = build(reqBody("Stay focused.", "much much longer prompt with more content"));
    const diff = computeTreeDiff(b, a);
    expect(diff.summary.netCharDelta).toBe(diff.summary.addedChars - diff.summary.removedChars);
    expect(diff.summary.netCharDelta).toBeGreaterThan(0);
  });

  it("current 中同 hash 叶子比 previous 多一份 → 多出的一份算 added", () => {
    // 构造 messages 中重复内容的极端情形（不太可能但行为应正确）
    const reqA = {
      system: [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text" as const, text: "Prelude.\n# Doing tasks\nx\n" },
      ],
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "dup" }] }],
    };
    const reqB = {
      ...reqA,
      messages: [
        { role: "user", content: [{ type: "text", text: "dup" }] },
        { role: "user", content: [{ type: "text", text: "dup" }] },
      ],
    };
    const a = build(reqA);
    const b = build(reqB);
    const diff = computeTreeDiff(b, a);
    // dup 出现两次 vs 一次 — 一份 unchanged, 一份 added
    const dupCurrentNodes = Object.entries(diff.leafStatus).filter(([id]) =>
      b.index[id]?.rawText === "dup",
    );
    const unchanged = dupCurrentNodes.filter(([, s]) => s === "unchanged");
    const added = dupCurrentNodes.filter(([, s]) => s === "added");
    expect(unchanged.length).toBe(1);
    expect(added.length).toBe(1);
  });

  it("removedFromPrevious 含 nodeId / slotType / rawHash / preview / charCount / jsonPath", () => {
    const a = build(reqBody("Stay focused.", "to be removed"));
    const b = build(reqBody("Stay focused.", "new"));
    const diff = computeTreeDiff(b, a);
    const removed = diff.removedFromPrevious.find((r) => r.preview.includes("to be removed"));
    expect(removed).toBeDefined();
    if (!removed) return;
    expect(removed.nodeId).toBeDefined();
    expect(removed.slotType).toBeDefined();
    expect(removed.rawHash).toMatch(/^sha256:[0-9a-f]+$/);
    expect(removed.charCount).toBeGreaterThan(0);
    expect(removed.jsonPath).toContain("messages");
  });

  it("previousLeafStatus: prev 中所有叶子都有状态，removed 节点状态为 removed", () => {
    const a = build(reqBody("Stay focused.", "to be removed"));
    const b = build(reqBody("Stay focused.", "fresh"));
    const diff = computeTreeDiff(b, a);
    expect(diff.previousLeafStatus).toBeDefined();
    if (!diff.previousLeafStatus) return;

    // prev 中每个叶子都有 status
    const prevLeafCount = Object.values(a.index).filter((n) => n.children.length === 0).length;
    expect(Object.keys(diff.previousLeafStatus).length).toBe(prevLeafCount);

    // 与 removedFromPrevious 数量一致
    const removedCount = Object.values(diff.previousLeafStatus).filter((s) => s === "removed").length;
    expect(removedCount).toBe(diff.removedFromPrevious.length);

    // removedFromPrevious 中每个 nodeId 在 status 中都标 removed
    for (const removed of diff.removedFromPrevious) {
      expect(diff.previousLeafStatus[removed.nodeId]).toBe("removed");
    }
  });

  it("previous=null 时不返回 previousLeafStatus", () => {
    const cur = build(reqBody("Stay focused.", "hello"));
    const diff = computeTreeDiff(cur, null);
    expect(diff.previousLeafStatus).toBeUndefined();
  });
});
