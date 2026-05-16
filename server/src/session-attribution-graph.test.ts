import { describe, it, expect } from "vitest";
import { annotateJsonlFromCallConsumers } from "./session-attribution-graph";
import type { LinkableJsonlEvent } from "./context-ledger/parser";

// 构造一个最小 jsonl 流：覆盖 5 类典型事件 + skipped 类。
function makeEvents(): LinkableJsonlEvent[] {
  return [
    // L0 — 人类输入
    { lineIdx: 0, type: "user", userText: "请帮我看 package.json" },
    // L1 — assistant 文本 + tool_use
    {
      lineIdx: 1,
      type: "assistant",
      assistantText: "我看一下。",
      toolUses: [{ id: "toolu_A", name: "Read" }],
    },
    // L2 — tool_result
    {
      lineIdx: 2,
      type: "user",
      toolResults: [{ toolUseId: "toolu_A", contentText: '{"dev":"vite"}' }],
    },
    // L3 — assistant 收尾文本
    { lineIdx: 3, type: "assistant", assistantText: "dev 是 vite。" },
    // L4 — Skill harness 注入（mechanism=skill_invocation）
    {
      lineIdx: 4,
      type: "user",
      harnessInjection: {
        mechanism: "skill_invocation",
        payload: "skill_md_body",
        rawText: "# Demo Skill body...",
        triggerToolUseId: "toolu_B",
      },
    },
    // L5 — 纯 system metadata（无任何可消费内容）→ 应被标 skipped
    { lineIdx: 5, type: "system" },
    // L6 — 有可消费内容（user_input），但本测试不让任何 call 引用它 → pending
    { lineIdx: 6, type: "user", userText: "我没被任何 call 引用" },
  ];
}

describe("annotateJsonlFromCallConsumers — jsonl event 维度的消费历史投影", () => {
  it("两个 call 引用同一批事件：firstSeenInCall = min, consumedByCallIds = sorted", () => {
    const events = makeEvents();
    const callConsumers = [
      { callId: 10, consumedLineIdxs: [0, 1, 2, 3] },   // call 10 引用 L0..L3
      { callId: 20, consumedLineIdxs: [0, 1, 2, 3, 4] }, // call 20 多引用 L4
    ];
    const g = annotateJsonlFromCallConsumers("s", events, callConsumers);

    expect(g.sessionId).toBe("s");
    expect(g.auditedCallIds).toEqual([10, 20]);

    const byLine = Object.fromEntries(g.events.map((e) => [e.lineIdx, e]));

    // L0 人类输入 → human + indexed + firstSeen=10
    expect(byLine[0].authorship).toBe("human");
    expect(byLine[0].source).toBe("user_input");
    expect(byLine[0].firstSeenInCall).toBe(10);
    expect(byLine[0].consumedByCallIds).toEqual([10, 20]);
    expect(byLine[0].contextImpact).toBe("indexed");

    // L1 assistant text + tool_use → primary source 优先取 tool_use（更显著），
    // authorship 是 assistant
    expect(byLine[1].source).toBe("tool_use");
    expect(byLine[1].authorship).toBe("assistant");
    expect(byLine[1].contextImpact).toBe("indexed");

    // L2 tool_result → tool_protocol
    expect(byLine[2].source).toBe("tool_result");
    expect(byLine[2].authorship).toBe("tool_protocol");

    // L3 assistant 文本 → assistant
    expect(byLine[3].source).toBe("assistant_text");
    expect(byLine[3].authorship).toBe("assistant");

    // L4 harness 注入 → harness + 仅 call 20 引用 → firstSeen=20
    expect(byLine[4].source).toBe("harness_injection");
    expect(byLine[4].authorship).toBe("harness");
    expect(byLine[4].firstSeenInCall).toBe(20);
    expect(byLine[4].consumedByCallIds).toEqual([20]);
    expect(byLine[4].contextImpact).toBe("indexed");
  });

  it("system metadata 事件无可消费内容 → contextImpact=skipped，不是 pending", () => {
    const events = makeEvents();
    const g = annotateJsonlFromCallConsumers("s", events, []);

    const l5 = g.events.find((e) => e.lineIdx === 5);
    expect(l5?.contextImpact).toBe("skipped");
    expect(l5?.authorship).toBe("unattributed");
    expect(l5?.firstSeenInCall).toBeNull();
  });

  it("有可消费内容但无 call 引用 → contextImpact=pending（与 skipped 区分）", () => {
    const events = makeEvents();
    // 只让 call 10 引用 L0；L6 也有 userText 但不被任何 call 引用
    const g = annotateJsonlFromCallConsumers("s", events, [
      { callId: 10, consumedLineIdxs: [0] },
    ]);
    const l6 = g.events.find((e) => e.lineIdx === 6);
    expect(l6?.contextImpact).toBe("pending");
    expect(l6?.authorship).toBe("human");
    expect(l6?.firstSeenInCall).toBeNull();
    expect(l6?.consumedByCallIds).toEqual([]);
  });

  it("auditedCallIds 升序去重；同事件被同 call 多次引用只算一次", () => {
    const events = makeEvents();
    const g = annotateJsonlFromCallConsumers("s", events, [
      { callId: 20, consumedLineIdxs: [0, 0, 0] },  // 同 call 多次引用 L0
      { callId: 10, consumedLineIdxs: [0] },        // call 10 也引用 L0
    ]);
    expect(g.auditedCallIds).toEqual([10, 20]);
    const l0 = g.events.find((e) => e.lineIdx === 0)!;
    expect(l0.consumedByCallIds).toEqual([10, 20]);
    expect(l0.firstSeenInCall).toBe(10);
  });

  it("events 全部进 annotation（含 skipped），按 lineIdx 升序", () => {
    const events = makeEvents();
    const g = annotateJsonlFromCallConsumers("s", events, []);
    expect(g.events.map((e) => e.lineIdx)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("unauditedCallIds 透传到结果（前端能知道 graph 的已知边界）", () => {
    const g = annotateJsonlFromCallConsumers(
      "s",
      makeEvents(),
      [{ callId: 10, consumedLineIdxs: [0] }],
      [{ callId: 11, reason: "proxy reqBody unavailable" }],
    );
    expect(g.unauditedCallIds).toEqual([{ callId: 11, reason: "proxy reqBody unavailable" }]);
  });

  it("audit-gap detection: marks firstSeenIsAfterAuditGap when there's an unaudited prefix", () => {
    // Reproduces session 8dc5ef73 bug: Call 1-69 unaudited (no proxy data),
    // Call 70+ audited. Event L0 (a tool_result emitted at call 1) ends up
    // with firstSeenInCall=70 because that's the first call graph can see.
    // We must flag this so UI doesn't show a misleading "first seen → #70"
    // chip that's actually an audit-window boundary artifact.
    const events = makeEvents();
    const g = annotateJsonlFromCallConsumers(
      "s",
      events,
      // All audited calls start at 70 — earlier calls had no proxy data.
      [{ callId: 70, consumedLineIdxs: [0, 1, 2] }],
      // Unaudited calls 1-69 (only one shown for brevity; the test only
      // requires ONE unaudited call before the min audited call to trip
      // the flag).
      [{ callId: 1, reason: "proxy reqBody unavailable for this call" }],
    );
    const l0 = g.events.find((e) => e.lineIdx === 0)!;
    expect(l0.firstSeenInCall).toBe(70);
    expect(l0.firstSeenIsAfterAuditGap).toBe(true);
  });

  it("audit-gap detection: does NOT flag when firstSeen is well inside audit window", () => {
    // call 80 references L0 but min audited is 70 → firstSeenInCall=80,
    // which is NOT the audit-window boundary → not a gap artifact.
    const g = annotateJsonlFromCallConsumers(
      "s",
      makeEvents(),
      [
        { callId: 70, consumedLineIdxs: [1] },  // 70 references L1, not L0
        { callId: 80, consumedLineIdxs: [0] },  // L0 first seen at 80
      ],
      [{ callId: 1, reason: "proxy reqBody unavailable for this call" }],
    );
    const l0 = g.events.find((e) => e.lineIdx === 0)!;
    expect(l0.firstSeenInCall).toBe(80);
    expect(l0.firstSeenIsAfterAuditGap).toBeUndefined();
  });

  it("audit-gap detection: not flagged when no unaudited prefix exists", () => {
    // Even though firstSeenInCall === minAudited, no calls before it were
    // skipped → the value is the real first-seen, no caveat needed.
    const g = annotateJsonlFromCallConsumers(
      "s",
      makeEvents(),
      [{ callId: 10, consumedLineIdxs: [0] }],
      [],  // no unaudited
    );
    const l0 = g.events.find((e) => e.lineIdx === 0)!;
    expect(l0.firstSeenInCall).toBe(10);
    expect(l0.firstSeenIsAfterAuditGap).toBeUndefined();
  });
});
