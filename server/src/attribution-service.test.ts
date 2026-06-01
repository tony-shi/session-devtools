import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadAttributionTree, readSessionEventsForLinker } from "./attribution-service.ts";
import type { SerializedNode } from "./attribution-service.ts";
import { withBillingHeader } from "./context-ledger/parser/attribution/test-fixtures";

// 不依赖真实 SQLite — controller helpers 由测试注入。
// 验证 service 层：jsonl 适配、attributeWithJsonl 调用、tree-diff 串联是否完整。

function makeSessionJsonl(tmpDir: string): string {
  const sourceFile = join(tmpDir, "session.jsonl");
  const lines = [
    // line 0: user input
    JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T10:00:00Z",
      message: { content: [{ type: "text", text: "请帮我读 package.json" }] },
    }),
    // line 1: assistant call 1 — text + tool_use
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-01-01T10:00:01Z",
      message: {
        id: "msg_call1",
        content: [
          { type: "text", text: "我看一下" },
          { type: "tool_use", id: "toolu_abc", name: "Read", input: { file: "package.json" } },
        ],
      },
    }),
    // line 2: tool_result
    JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T10:00:02Z",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_abc", content: '{"dev":"vite"}' }] },
    }),
    // line 3: assistant call 2 — final answer
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-01-01T10:00:03Z",
      message: {
        id: "msg_call2",
        content: [{ type: "text", text: "dev 是 vite" }],
      },
    }),
  ];
  writeFileSync(sourceFile, lines.join("\n"));
  return sourceFile;
}

const USER_CONTEXT_REMINDER = `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.
Contents of /repo/CLAUDE.md (project instructions, checked into the codebase):

Follow project rules.
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

function makeReqBodyWithUserContextReminder() {
  return withBillingHeader({
    system: [
      { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text" as const, text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
    ],
    tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
    messages: [{ role: "user", content: [{ type: "text", text: USER_CONTEXT_REMINDER }] }],
  }, "2.1.158.000");
}

function findSerializedNode(
  nodes: SerializedNode[],
  pred: (node: SerializedNode) => boolean,
): SerializedNode | undefined {
  for (const node of nodes) {
    if (pred(node)) return node;
    const child = findSerializedNode(node.children, pred);
    if (child) return child;
  }
  return undefined;
}

describe("attribution-service — JSONL adapter", () => {
  it("readSessionEventsForLinker 把 user/assistant 事件准确拆分", () => {
    const tmpDir = join(tmpdir(), `attr-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const sourceFile = makeSessionJsonl(tmpDir);
      const events = readSessionEventsForLinker(sourceFile);
      // 4 行 jsonl → 4 个事件
      expect(events.length).toBe(4);

      // line 0：人类输入
      expect(events[0]?.userText).toBe("请帮我读 package.json");
      expect(events[0]?.toolUses).toBeUndefined();
      expect(events[0]?.toolResults).toBeUndefined();

      // line 1：assistant 文本 + tool_use
      expect(events[1]?.assistantText).toBe("我看一下");
      expect(events[1]?.toolUses).toEqual([{ id: "toolu_abc", name: "Read" }]);

      // line 2：tool_result-only user
      expect(events[2]?.toolResults).toEqual([{ toolUseId: "toolu_abc", contentText: '{"dev":"vite"}' }]);
      expect(events[2]?.userText).toBeUndefined();

      // line 3：assistant 文本，无 tool_use
      expect(events[3]?.assistantText).toBe("dev 是 vite");
      expect(events[3]?.toolUses).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("attribution-service — loadAttributionTree 端到端", () => {
  it("userContext system-reminder 返回 parent raw + child charRange，wrapper 默认 rawOnly", async () => {
    const reqBody = makeReqBodyWithUserContextReminder();

    const result = await loadAttributionTree(
      "test-session",
      1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      {
        resolveCallMeta: () => ({
          call: {
            id: 1,
            timestamp: "2026-06-01T10:00:00Z",
            turnId: 1,
            sourceFile: "unused.jsonl",
            apiRequestId: null,
          },
          prevCall: null,
        }),
        fetchProxyReqBodyAt: async () =>
          ({ reqBody, reqHeaders: {}, proxyRequestId: 1, startedAt: "2026-06-01T10:00:00Z" }),
        loadJsonlEvents: () => [],
      },
    );

    expect(result.error).toBeUndefined();
    const parent = findSerializedNode(
      result.snapshot!.roots,
      (node) => node.slotType === "messages.inline.system-reminder" && node.children.length > 0,
    );
    expect(parent).toBeDefined();
    expect(parent!.rawText).toBe(USER_CONTEXT_REMINDER);

    const slots = parent!.children.map((node) => node.slotType);
    expect(slots).toEqual([
      "messages.inline.system-reminder.wrapper.prefix",
      "messages.inline.system-reminder.preamble",
      "messages.inline.system-reminder.project-instructions",
      "messages.inline.system-reminder.memory",
      "messages.inline.system-reminder.account",
      "messages.inline.system-reminder.wrapper.suffix",
    ]);

    expect(parent!.children.map((node) => node.rawText).join("")).toBe(parent!.rawText);
    for (const child of parent!.children) {
      expect(child.charRange).toBeDefined();
      expect(parent!.rawText!.slice(child.charRange!.start, child.charRange!.end)).toBe(child.rawText);
    }

    const visibleSlots = parent!.children
      .filter((node) => node.visibility !== "rawOnly")
      .map((node) => node.slotType);
    expect(visibleSlots).toEqual([
      "messages.inline.system-reminder.project-instructions",
      "messages.inline.system-reminder.memory",
      "messages.inline.system-reminder.account",
    ]);

    const rawOnlySlots = parent!.children
      .filter((node) => node.visibility === "rawOnly")
      .map((node) => node.slotType);
    expect(rawOnlySlots).toEqual([
      "messages.inline.system-reminder.wrapper.prefix",
      "messages.inline.system-reminder.preamble",
      "messages.inline.system-reminder.wrapper.suffix",
    ]);

    const account = parent!.children.find((node) => node.slotType === "messages.inline.system-reminder.account")!;
    const suffix = parent!.children.find((node) => node.slotType === "messages.inline.system-reminder.wrapper.suffix")!;
    expect(account.rawText).toContain("# userEmail");
    expect(account.rawText).not.toContain("IMPORTANT:");
    expect(suffix.rawText).toContain("IMPORTANT:");
    expect(suffix.rawText).toContain("</system-reminder>");
  });

  it("命中 tool_use / tool_result + 与 previous 做 tree-diff", async () => {
    const tmpDir = join(tmpdir(), `attr-svc-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const sourceFile = makeSessionJsonl(tmpDir);

      // —— 构造两次 LLM call 的 proxy reqBody —— //
      // call 1：原始用户提示
      const reqBody1 = {
        system: [
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: "text", text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
        ],
        tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
        messages: [{ role: "user", content: [{ type: "text", text: "请帮我读 package.json" }] }],
      };
      // call 2：附加了 call 1 的输出 + tool_result
      const reqBody2 = {
        ...reqBody1,
        messages: [
          { role: "user", content: [{ type: "text", text: "请帮我读 package.json" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "我看一下" },
              { type: "tool_use", id: "toolu_abc", name: "Read", input: { file: "package.json" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_abc", content: '{"dev":"vite"}' }],
          },
        ],
      };

      // —— 注入 helpers —— //
      const result = await loadAttributionTree(
        "test-session",
        2, // call id = 2
        // db 占位 — service 不直接用 db；通过 helpers 取数据
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
        {
          resolveCallMeta: (_sid, cid) => {
            if (cid !== 2) return null;
            return {
              call: { id: 2, timestamp: "2026-01-01T10:00:03Z", turnId: 1, sourceFile, apiRequestId: null },
              prevCall: { id: 1, timestamp: "2026-01-01T10:00:01Z", apiRequestId: null },
            };
          },
          fetchProxyReqBodyAt: async (_sid, ts) => {
            if (ts === "2026-01-01T10:00:03Z") {
              return { reqBody: reqBody2, reqHeaders: {}, proxyRequestId: 2, startedAt: ts };
            }
            if (ts === "2026-01-01T10:00:01Z") {
              return { reqBody: reqBody1, reqHeaders: {}, proxyRequestId: 1, startedAt: ts };
            }
            return null;
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.hasProxy).toBe(true);
      expect(result.previousCallId).toBe(1);
      expect(result.snapshot).not.toBeNull();
      expect(result.linkReport).not.toBeNull();

      // —— jsonl-linker 应当命中 tool_use + tool_result + user_input + assistant_text —— //
      expect(result.linkReport?.matched.toolUse).toBe(1);
      expect(result.linkReport?.matched.toolResult).toBe(1);
      expect(result.linkReport?.matched.userInput).toBe(1);
      expect(result.linkReport?.matched.assistantText).toBe(1);

      // —— tree-diff 应当有 added（call 2 新增的 assistant message / tool_result）—— //
      expect(result.diff).not.toBeNull();
      expect(result.diff!.summary.addedLeaves).toBeGreaterThan(0);
      // call 2 包含 call 1 全部内容 + 新增，所以 unchanged 也 > 0
      expect(result.diff!.summary.unchangedLeaves).toBeGreaterThan(0);
      // 新增字符数 > 0
      expect(result.diff!.summary.addedChars).toBeGreaterThan(0);

      // —— previousLeaves: 用于双行 strip 的 prev 行 —— //
      expect(result.previousLeaves).toBeDefined();
      expect(result.previousLeaves!.length).toBeGreaterThan(0);
      // 每个 leaf 必有 rootSlotType + diffStatus + preview
      for (const pl of result.previousLeaves!) {
        expect(pl.rootSlotType).toBeTruthy();
        expect(["unchanged", "removed"]).toContain(pl.diffStatus);
        expect(pl.preview).toBeDefined();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("无 previous call 时返回 first-call diff（所有 leaves 都是 added）", async () => {
    const tmpDir = join(tmpdir(), `attr-svc-first-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const sourceFile = makeSessionJsonl(tmpDir);
      const reqBody = {
        system: [
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: "text", text: "Prelude.\n# Doing tasks\nDo stuff.\n" },
        ],
        tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
        messages: [{ role: "user", content: [{ type: "text", text: "请帮我读 package.json" }] }],
      };

      const result = await loadAttributionTree(
        "test-session",
        1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
        {
          resolveCallMeta: () => ({
            call: { id: 1, timestamp: "2026-01-01T10:00:01Z", turnId: 1, sourceFile, apiRequestId: null },
            prevCall: null,
          }),
          fetchProxyReqBodyAt: async () =>
            ({ reqBody, reqHeaders: {}, proxyRequestId: 1, startedAt: "2026-01-01T10:00:01Z" }),
        },
      );

      expect(result.previousCallId).toBeNull();
      expect(result.diff?.summary.unchangedLeaves).toBe(0);
      expect(result.diff?.summary.removedLeaves).toBe(0);
      expect(result.diff!.summary.addedLeaves).toBe(result.diff!.summary.currentLeaves);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
