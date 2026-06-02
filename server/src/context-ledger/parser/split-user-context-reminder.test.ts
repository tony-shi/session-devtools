// splitUserContextReminder 鲁棒性契约（v8）。
//
// v8 改动：识别从"硬锁 # claudeMd/# userEmail/# currentDate 三锚点全在"换成按 CC 固定
// 引导语前缀签名识别，缺 CLAUDE.md / 缺 # userEmail 不再整条 bail——有哪段切哪段。
// 常见情形（含项目指令）逐字节不变由 attribution-service.test.ts 的契约用例保证；
// "仅 memory"形态由真实 fixture（dump-attribution）覆盖。本文件专钉 v8 新增的"真降级"
// 路径 + 完整 tiling + 签名 gate 不过触发。走轻量 attributeWithJsonl（dump-attribution 同入口）。

import { describe, it, expect } from "vitest";
import { attributeWithJsonl } from "./index.ts";
import type { SegmentNode } from "./types.ts";
import { withBillingHeader } from "./attribution/test-fixtures.ts";

function ruleIdOf(node: SegmentNode): string | undefined {
  return node.origin?.kind === "rule" ? node.origin.ruleId : undefined;
}

function findReminderParent(nodes: SegmentNode[]): SegmentNode | undefined {
  for (const n of nodes) {
    if (n.slotType === "messages.inline.system-reminder" && n.children.length > 0) return n;
    const c = findReminderParent(n.children);
    if (c) return c;
  }
  return undefined;
}

function splitReminder(reminderText: string): SegmentNode | undefined {
  const reqBody = withBillingHeader(
    {
      system: [{ type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: reminderText }] }],
    },
    "2.1.158.000",
  );
  const { snapshot } = attributeWithJsonl({
    reqBody,
    proxyFile: "synthetic",
    jsonl: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    call: { callId: 0, turnId: 0 } as any,
  });
  return findReminderParent(snapshot.roots);
}

const SR = "messages.inline.system-reminder";

describe("splitUserContextReminder — v8 鲁棒性", () => {
  it("缺 claudeMd（无项目/无记忆）不再 bail：切出 prefix / account / suffix", () => {
    const text = `<system-reminder>
As you answer the user's questions, you can use the following context:
# userEmail
The user's email address is user@example.com.
# currentDate
Today's date is June 1, 2026.

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
`;
    const parent = splitReminder(text);
    expect(parent).toBeDefined();
    expect(parent!.children.map((c) => c.slotType)).toEqual([
      `${SR}.wrapper.prefix`,
      `${SR}.account`,
      `${SR}.wrapper.suffix`,
    ]);
    // 完整 tiling：子段拼回父原文，无空隙。
    expect(parent!.children.map((c) => c.rawText).join("")).toBe(parent!.rawText);
    // prefix 恰为固定引导语本身（无 claudeMd boilerplate）。
    expect(parent!.children[0]!.rawText).toBe(
      "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n",
    );
    // email+date 都在 → account 仍命中 pinned 规则。
    const account = parent!.children.find((c) => c.slotType === `${SR}.account`)!;
    expect(ruleIdOf(account)).toBe("claude-code.messages.reminder.account.v1");
  });

  it("缺 # userEmail（旧版日志）不再 bail：切出 prefix / 项目指令 / account(date-only) / suffix", () => {
    const text = `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.
Contents of /repo/CLAUDE.md (project instructions, checked into the codebase):

Follow project rules.
# currentDate
Today's date is June 1, 2026.

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
`;
    const parent = splitReminder(text);
    expect(parent).toBeDefined();
    expect(parent!.children.map((c) => c.slotType)).toEqual([
      `${SR}.wrapper.prefix`,
      `${SR}.project-instructions`,
      `${SR}.account`,
      `${SR}.wrapper.suffix`,
    ]);
    expect(parent!.children.map((c) => c.rawText).join("")).toBe(parent!.rawText);
    // account 只剩 currentDate → 命不中 pinned account pattern（best-effort），但段仍切出。
    const account = parent!.children.find((c) => c.slotType === `${SR}.account`)!;
    expect(account.rawText.startsWith("# currentDate")).toBe(true);
  });

  it("仅 memory、无项目 CLAUDE.md（真实 fixture 形态）：boilerplate 落 prefix，切 prefix / 记忆 / account / suffix", () => {
    const text = `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.
Contents of /Users/me/.claude/projects/-repo/memory/MEMORY.md (user's auto-memory, indexed for this project):

# Memory Index
- Remember the current project.
# userEmail
The user's email address is user@example.com.
# currentDate
Today's date is June 1, 2026.

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
`;
    const parent = splitReminder(text);
    expect(parent).toBeDefined();
    expect(parent!.children.map((c) => c.slotType)).toEqual([
      `${SR}.wrapper.prefix`,
      `${SR}.memory`,
      `${SR}.account`,
      `${SR}.wrapper.suffix`,
    ]);
    expect(parent!.children.map((c) => c.rawText).join("")).toBe(parent!.rawText);
    // 无紧邻项目指令 → claudeMd 固定导言并入 prefix（wrapper-prefix 规则可选组兜住）。
    expect(parent!.children[0]!.rawText).toContain("# claudeMd");
    // memory 命中 pinned 规则。
    const mem = parent!.children.find((c) => c.slotType === `${SR}.memory`)!;
    expect(ruleIdOf(mem)).toBe("claude-code.messages.reminder.memory.v1");
  });

  it("非 userContext reminder（引导语签名不匹配）不切分，保持单 leaf", () => {
    const text = `<system-reminder>\nThe user has enabled plan mode.\n</system-reminder>\n`;
    // 没有被拆成 wrapper/account 等子段 → findReminderParent（要求 children>0）找不到。
    expect(splitReminder(text)).toBeUndefined();
  });

  it("会话正文里引用 <system-reminder>（assistant 消息 / offset>0）不被误切成信封", () => {
    // 回归：解析本 dashboard 自身会话时，assistant 消息正文常引用 CC 的固定模板（以 guide 开头的
    // 整段 reminder）。修复前 splitUserContextReminder 会把它误当首条注入切分、污染归因甚至触发
    // 不变量。修复后只切 messages[0] 起始整块，正文引用保持单 leaf。
    const reminderBody = `As you answer the user's questions, you can use the following context:
# claudeMd
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.
Contents of /repo/CLAUDE.md (project instructions, checked into the codebase):

rules.
# userEmail
The user's email address is u@example.com.
# currentDate
Today's date is June 1, 2026.

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.`;
    const realReminder = `<system-reminder>\n${reminderBody}\n</system-reminder>\n`;
    // assistant 消息：prose 在前（offset>0），后面再接解释文字。
    const assistantQuote = `分析 CC 真实模板：固定前缀就是\n<system-reminder>\n${reminderBody}\n</system-reminder>\n后面还有一段我的解释文字。`;

    const reqBody = withBillingHeader(
      {
        system: [{ type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
        messages: [
          { role: "user", content: [{ type: "text", text: realReminder }] },
          { role: "assistant", content: [{ type: "text", text: assistantQuote }] },
        ],
      },
      "2.1.158.000",
    );
    // attributeWithJsonl 出口跑 assertAllInvariants —— 不抛即说明 tiling/归因不变量没被破坏。
    const { snapshot } = attributeWithJsonl({
      reqBody,
      proxyFile: "synthetic",
      jsonl: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      call: { callId: 0, turnId: 0 } as any,
    });

    const reminders: SegmentNode[] = [];
    const walk = (n: SegmentNode) => {
      if (n.slotType === SR) reminders.push(n);
      n.children.forEach(walk);
    };
    snapshot.roots.forEach(walk);

    const inMsg0 = reminders.filter((n) => /messages\[0\]/.test(n.jsonPath));
    const inMsg1 = reminders.filter((n) => /messages\[1\]/.test(n.jsonPath));
    // messages[0] 的真注入：被切分（有子段）。
    expect(inMsg0.some((n) => n.children.length > 0)).toBe(true);
    // messages[1] 里引用的那段：识别为 system-reminder 但【不】被切成信封，保持单 leaf。
    expect(inMsg1.length).toBeGreaterThan(0);
    expect(inMsg1.every((n) => n.children.length === 0)).toBe(true);
  });
});
