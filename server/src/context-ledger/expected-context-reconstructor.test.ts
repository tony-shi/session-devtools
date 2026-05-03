import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { parseClaudeJsonlMutations } from "./jsonl-mutation-parser";
import {
  reconstructExpectedClaudeContext,
  UNIMPLEMENTED_RULES,
} from "./expected-context-reconstructor";
import type { SegmentCategory } from "./types";

const FIXTURE_DIR = new URL(
  "../../test/fixtures/context-reconstruction",
  import.meta.url,
).pathname;

interface FixtureMeta {
  proxyTimestamp: string;
}

function loadProxyTs(caseName: string): string {
  const raw = JSON.parse(
    readFileSync(`${FIXTURE_DIR}/${caseName}/proxy-request.json`, "utf8"),
  ) as { ts?: string };
  if (!raw.ts) throw new Error(`fixture ${caseName} proxy-request.json missing ts`);
  return raw.ts;
}

function loadJsonl(caseName: string): string {
  return readFileSync(`${FIXTURE_DIR}/${caseName}/session.jsonl`, "utf8");
}

function reconstruct(caseName: string) {
  const ts = loadProxyTs(caseName);
  const parsed = parseClaudeJsonlMutations(loadJsonl(caseName), {
    jsonlFile: `server/test/fixtures/context-reconstruction/${caseName}/session.jsonl`,
  });
  const expected = reconstructExpectedClaudeContext({
    mutations: parsed.mutations,
    boundary: { queryId: `q-${caseName}`, proxyTimestamp: ts, sessionId: parsed.sessionId },
    fixtureName: caseName,
    hasPreSessionActivity: parsed.hasPreSessionActivity,
  });
  return { expected, parsed, proxyTimestamp: ts };
}

// 期望值是从当前 fixture 内容固化下来的快照值；fixture 改了请刷新这些数字。
// 这些数字反映的是 expected segment count（不是 proxy segment count）；
// 真正与 proxy 对账由后续 reconciliation engine 完成。
interface CaseExpect {
  totalSegments: number;
  byCategory: Partial<Record<SegmentCategory, number>>;
  retryDropped?: boolean; // 是否触发了 R7 api_error retry 对齐
  prefixIncomplete?: boolean; // JSONL 是否缺少 prior session history
  logicalMessageGroupCount: number;
}

const CASES: Record<string, CaseExpect> = {
  // 首个 query：只有 boundary 内一条 user 输入 + skill_listing。
  // R7 触发：失败 attempt 的 user_message 被丢；skill_listing 是 session-scoped，保留。
  "system-tools-overhead": {
    totalSegments: 2,
    byCategory: { user_message: 1, skill_listing: 1 },
    retryDropped: true,
    logicalMessageGroupCount: 1,
  },
  // 完整一次 tool 调用往返：proxy 拿到 [user, assistant tool_use×2, user tool_result×2]。
  // boundary（proxy ts 之前）的 mutation：retry user + skill_listing + assistant
  // text/tool_use + 一组 tool_result。R7 触发：失败 attempt 被丢。
  "single-tool-call": {
    totalSegments: 7,
    byCategory: {
      user_message: 1,
      skill_listing: 1,
      assistant_text: 1,
      tool_use: 2,
      tool_result: 2,
    },
    retryDropped: true,
    logicalMessageGroupCount: 3,
  },
  // 多轮人类输入：3 条 local_command_history + 1 user_message + 1 assistant_text +
  // 2 次 tool_use/tool_result 往返。assistant 共享同一个 messageId，所以两个 tool_use
  // 归到同一组（lm-2），即便中间有 user tool_result。
  // prefixIncomplete=true：JSONL prefix 之外存在 assistant turn（历史 "are you there?" 会话）。
  "multi-turn-human": {
    totalSegments: 9,
    byCategory: {
      user_message: 1,
      local_command_history: 3,
      assistant_text: 1,
      tool_use: 2,
      tool_result: 2,
    },
    prefixIncomplete: true,
    logicalMessageGroupCount: 4,
  },
  // 大 tool_result：boundary 内 2 个独立 user 轮 + 2 个 assistant 响应（msg_60b7359b、
  // msg_cc69992e），每个响应携带 2 个 tool_use；user tool_result 各自独立成组。
  "large-tool-output": {
    totalSegments: 13,
    byCategory: {
      user_message: 2,
      skill_listing: 1,
      assistant_text: 2,
      tool_use: 4,
      tool_result: 4,
    },
    logicalMessageGroupCount: 9,
  },
};

for (const caseName of Object.keys(CASES)) {
  const want = CASES[caseName];

  describe(caseName, () => {
    const { expected } = reconstruct(caseName);

    test("生成 ExpectedQueryContext 基本字段", () => {
      expect(expected.agentKind).toBe("claude-code");
      expect(expected.queryId).toBe(`q-${caseName}`);
      expect(expected.id).toBe(`expected-q-${caseName}`);
      expect(expected.segments.length).toBeGreaterThan(0);
    });

    test("总 expected segment 数稳定", () => {
      expect(expected.segments.length).toBe(want.totalSegments);
    });

    test("category 分布匹配快照", () => {
      const counts: Record<string, number> = {};
      for (const s of expected.segments) counts[s.category] = (counts[s.category] ?? 0) + 1;
      for (const k of Object.keys(want.byCategory) as SegmentCategory[]) {
        expect(counts[k] ?? 0).toBe(want.byCategory[k]!);
      }
      const allowed = new Set(Object.keys(want.byCategory));
      const surprises = Object.keys(counts).filter((k) => !allowed.has(k));
      expect(surprises).toEqual([]);
    });

    test("每条 segment 带 sourceMutationId 或 harness rule SourceRef", () => {
      for (const s of expected.segments) {
        const hasMutation = typeof s.metadata?.sourceMutationId === "string";
        const hasHarnessRule = s.sourceRefs.some((r) => r.kind === "harness_rule");
        const hasJsonlRef = s.sourceRefs.some((r) => r.kind === "jsonl");
        expect(hasMutation || hasHarnessRule || hasJsonlRef).toBe(true);
      }
    });

    test("logicalMessageId 把同一逻辑 message 内的 block 归到一组", () => {
      const groups = new Set<string>();
      for (const s of expected.segments) {
        const id = s.metadata?.logicalMessageId as string | undefined;
        expect(typeof id).toBe("string");
        groups.add(id ?? "?");
      }
      expect(groups.size).toBe(want.logicalMessageGroupCount);
    });

    test("rulesApplied 至少含 R1 / R6 / R7", () => {
      const ids = new Set(expected.rulesApplied.map((r) => r.ruleId));
      expect(ids.has("R1_base_append")).toBe(true);
      expect(ids.has("R6_filter_known_noise")).toBe(true);
      expect(ids.has("R7_api_error_retry_alignment")).toBe(true);
    });

    test("metadata.unimplementedRules 列出全部已知缺失项", () => {
      const ur = expected.metadata?.unimplementedRules as string[] | undefined;
      expect(Array.isArray(ur)).toBe(true);
      for (const u of UNIMPLEMENTED_RULES) {
        expect(ur).toContain(u);
      }
    });

    if (want.retryDropped) {
      test("R7 触发：retryDroppedMutationCount > 0", () => {
        expect(expected.metadata?.retryDroppedMutationCount as number).toBeGreaterThan(0);
      });
    }

    test("不含 hook_event / billing_noise / permission（R6 过滤）", () => {
      const cats = new Set(expected.segments.map((s) => s.category));
      expect(cats.has("hook_event")).toBe(false);
      expect(cats.has("billing_noise")).toBe(false);
      expect(cats.has("permission")).toBe(false);
    });

    test("tool_use 与 tool_result 都带 toolUseId", () => {
      for (const s of expected.segments) {
        if (s.category === "tool_use" || s.category === "tool_result") {
          expect(typeof s.toolUseId).toBe("string");
        }
      }
    });

    test("有 contentRef.text 的 segment 都带 rawHash（sha256: 前缀）", () => {
      for (const s of expected.segments) {
        if (s.contentRef?.text && s.contentRef.text.length > 0) {
          expect(typeof s.rawHash).toBe("string");
          expect(s.rawHash!.startsWith("sha256:")).toBe(true);
        }
      }
    });

    test("rulesApplied 包含 R8_filter_synthetic_api_error", () => {
      const ids = new Set(expected.rulesApplied.map((r) => r.ruleId));
      expect(ids.has("R8_filter_synthetic_api_error")).toBe(true);
    });

    if (want.prefixIncomplete) {
      test("prefixIncomplete=true（JSONL prefix 缺少 prior history turn）", () => {
        expect(expected.metadata?.prefixIncomplete).toBe(true);
      });
    } else {
      test("prefixIncomplete 未触发（JSONL prefix 完整）", () => {
        expect(expected.metadata?.prefixIncomplete).toBeUndefined();
      });
    }
  });
}

// ── 行为单测：rule toggle / boundary 边界 ────────────────────────────────────

describe("rule toggles", () => {
  test("关闭 R7 后失败 attempt 的 user_message 被保留", () => {
    const ts = loadProxyTs("system-tools-overhead");
    const parsed = parseClaudeJsonlMutations(loadJsonl("system-tools-overhead"));
    const off = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary: { queryId: "q", proxyTimestamp: ts },
      rules: { apiErrorRetryAlignment: false },
    });
    const on = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary: { queryId: "q", proxyTimestamp: ts },
      rules: { apiErrorRetryAlignment: true },
    });
    expect(off.segments.length).toBeGreaterThan(on.segments.length);
  });

  test("关闭 R6 后噪声 mutation 不被丢弃（影响 noiseDroppedMutationCount）", () => {
    const ts = loadProxyTs("single-tool-call");
    const parsed = parseClaudeJsonlMutations(loadJsonl("single-tool-call"));
    const off = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary: { queryId: "q", proxyTimestamp: ts },
      rules: { filterKnownNoise: false },
    });
    const on = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary: { queryId: "q", proxyTimestamp: ts },
      rules: { filterKnownNoise: true },
    });
    // R6 关闭时 noiseDropped=0；R6 开启时 noiseDropped>0
    expect(off.metadata?.noiseDroppedMutationCount as number).toBe(0);
    expect(on.metadata?.noiseDroppedMutationCount as number).toBeGreaterThan(0);
  });

  test("upToMutationId boundary 截断在指定 mutation 处（含）", () => {
    const parsed = parseClaudeJsonlMutations(loadJsonl("single-tool-call"));
    const target = parsed.mutations[3];
    const r = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary: { queryId: "q", upToMutationId: target.id },
    });
    // 4 条以内（含 target），减去 noise / permission 后应 ≤ 4
    expect(r.metadata?.droppedMutationCount as number).toBe(parsed.mutations.length - 4);
  });

  test("无 boundary 字段时取全部 mutation", () => {
    const parsed = parseClaudeJsonlMutations(loadJsonl("single-tool-call"));
    const r = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary: { queryId: "q" },
    });
    expect(r.metadata?.droppedMutationCount as number).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-5：HarnessRuleConfig 开关真正 gate segment 生成
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-5 HarnessRuleConfig gate（single-tool-call fixture）", () => {
  const parsed = parseClaudeJsonlMutations(loadJsonl("single-tool-call"), {
    jsonlFile: "server/test/fixtures/context-reconstruction/single-tool-call/session.jsonl",
  });
  const proxyTs = loadProxyTs("single-tool-call");
  const boundary = {
    queryId: "q-p15",
    proxyTimestamp: proxyTs,
    sessionId: parsed.sessionId,
  };

  // 基准：所有开关默认 ON
  const base = reconstructExpectedClaudeContext({
    mutations: parsed.mutations,
    boundary,
    hasPreSessionActivity: parsed.hasPreSessionActivity,
  });
  const baseTotal = base.segments.length;
  const baseSkillCount = base.segments.filter((s) => s.category === "skill_listing").length;
  const baseUserCount = base.segments.filter((s) => s.category === "user_message").length;
  const baseAsstCount = base.segments.filter((s) => s.category === "assistant_text").length;

  test("默认开启：skill_listing segment 存在", () => {
    expect(baseSkillCount).toBeGreaterThan(0);
  });

  test("injectSkillListing=false → skill_listing segment 消失", () => {
    const r = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary,
      rules: { injectSkillListing: false },
      hasPreSessionActivity: parsed.hasPreSessionActivity,
    });
    const skillSegs = r.segments.filter((s) => s.category === "skill_listing");
    expect(skillSegs).toHaveLength(0);
    expect(r.segments.length).toBe(baseTotal - baseSkillCount);
  });

  test("injectLocalCommand=false → local_command_history segment 消失", () => {
    // single-tool-call fixture 本身无 local_command，用 multi-turn-human
    const parsed2 = parseClaudeJsonlMutations(loadJsonl("multi-turn-human"), {
      jsonlFile: "server/test/fixtures/context-reconstruction/multi-turn-human/session.jsonl",
    });
    const ts2 = loadProxyTs("multi-turn-human");
    const base2 = reconstructExpectedClaudeContext({
      mutations: parsed2.mutations,
      boundary: { queryId: "q", proxyTimestamp: ts2, sessionId: parsed2.sessionId },
      hasPreSessionActivity: parsed2.hasPreSessionActivity,
    });
    const baseLocalCount = base2.segments.filter((s) => s.category === "local_command_history").length;
    expect(baseLocalCount).toBeGreaterThan(0);

    const r = reconstructExpectedClaudeContext({
      mutations: parsed2.mutations,
      boundary: { queryId: "q", proxyTimestamp: ts2, sessionId: parsed2.sessionId },
      rules: { injectLocalCommand: false },
      hasPreSessionActivity: parsed2.hasPreSessionActivity,
    });
    const localSegs = r.segments.filter((s) => s.category === "local_command_history");
    expect(localSegs).toHaveLength(0);
    expect(r.segments.length).toBe(base2.segments.length - baseLocalCount);
  });

  test("appendBaseMessages=false → user_message と assistant_text segment 消失", () => {
    const r = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary,
      rules: { appendBaseMessages: false },
      hasPreSessionActivity: parsed.hasPreSessionActivity,
    });
    const userSegs = r.segments.filter((s) => s.category === "user_message");
    const asstSegs = r.segments.filter((s) => s.category === "assistant_text");
    expect(userSegs).toHaveLength(0);
    expect(asstSegs).toHaveLength(0);
    expect(r.segments.length).toBe(baseTotal - baseUserCount - baseAsstCount);
  });

  test("开关关闭时 charCount 之和相应减少", () => {
    const r = reconstructExpectedClaudeContext({
      mutations: parsed.mutations,
      boundary,
      rules: { injectSkillListing: false },
      hasPreSessionActivity: parsed.hasPreSessionActivity,
    });
    const baseChars = base.segments.reduce((s, seg) => s + (seg.charCount ?? 0), 0);
    const noSkillChars = r.segments.reduce((s, seg) => s + (seg.charCount ?? 0), 0);
    // 关闭 skill_listing 后 charCount 更小
    expect(noSkillChars).toBeLessThan(baseChars);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-2：task_reminder smoosh 加法重建
// ─────────────────────────────────────────────────────────────────────────────

import { reconstructExpectedClaudeContext as reconFn } from "./expected-context-reconstructor";
import type { ContextMutation } from "./types";

function makeMutation(overrides: Partial<ContextMutation>): ContextMutation {
  return {
    id: `mut-${Math.random().toString(36).slice(2)}`,
    agentKind: "claude-code",
    sessionId: "sess-test",
    type: "append",
    category: "tool_result",
    source: "jsonl",
    sourceRef: { kind: "jsonl", jsonl: { file: "test.jsonl" } },
    charDeltaEstimate: 0,
    confidence: "exact",
    ...overrides,
  };
}

describe("P1-2 task_reminder 加法重建", () => {
  test("task_reminder 文本追加到对应 tool_result 尾部（空 task list）", () => {
    const RECORD_UUID = "user-msg-uuid-001";
    const toolResultMut = makeMutation({
      id: "mut-tool-result-1",
      category: "tool_result",
      toolUseId: "tu-001",
      contentRef: { kind: "inline", text: "tool output text", charCount: 16 },
      charDeltaEstimate: 16,
      metadata: { recordUuid: RECORD_UUID, messageId: "msg-001" },
    });
    const taskReminderMut = makeMutation({
      id: "mut-task-reminder-1",
      category: "attachment",
      type: "inject",
      contentRef: { kind: "inline", text: "[]", charCount: 2 },
      charDeltaEstimate: 2,
      metadata: {
        attachmentType: "task_reminder",
        parentUuid: RECORD_UUID,
        itemCount: 0,
      },
    });

    const r = reconFn({
      mutations: [toolResultMut, taskReminderMut],
      boundary: { queryId: "q" },
    });

    // task_reminder 不产出独立 segment
    const taskReminderSegs = r.segments.filter(
      (s) => s.category === "attachment" && s.metadata?.sourceMutationId === "mut-task-reminder-1",
    );
    expect(taskReminderSegs).toHaveLength(0);

    // tool_result segment 应包含 task_reminder 文本
    const toolResultSeg = r.segments.find((s) => s.category === "tool_result");
    expect(toolResultSeg).toBeTruthy();
    const text = toolResultSeg!.contentRef?.text ?? "";
    expect(text).toContain("tool output text");
    expect(text).toContain("The task tools haven't been used recently");
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("</system-reminder>");
    // smooshed_reminder flag 已设置
    expect(toolResultSeg!.flags).toContain("smooshed_reminder");
    // charCount 包含两部分
    expect(toolResultSeg!.charCount).toBeGreaterThan(16);
  });

  test("task_reminder 文本追加到对应 tool_result 尾部（有 tasks）", () => {
    const RECORD_UUID = "user-msg-uuid-002";
    const tasks = [
      { id: "1", subject: "Task One", status: "pending" },
      { id: "2", subject: "Task Two", status: "in_progress" },
    ];
    const toolResultMut = makeMutation({
      id: "mut-tr-2",
      category: "tool_result",
      toolUseId: "tu-002",
      contentRef: { kind: "inline", text: "result", charCount: 6 },
      charDeltaEstimate: 6,
      metadata: { recordUuid: RECORD_UUID, messageId: "msg-002" },
    });
    const taskReminderMut = makeMutation({
      id: "mut-task-2",
      category: "attachment",
      type: "inject",
      contentRef: { kind: "inline", text: JSON.stringify(tasks), charCount: JSON.stringify(tasks).length },
      charDeltaEstimate: JSON.stringify(tasks).length,
      metadata: {
        attachmentType: "task_reminder",
        parentUuid: RECORD_UUID,
        itemCount: 2,
      },
    });

    const r = reconFn({
      mutations: [toolResultMut, taskReminderMut],
      boundary: { queryId: "q" },
    });

    const toolResultSeg = r.segments.find((s) => s.category === "tool_result");
    expect(toolResultSeg).toBeTruthy();
    const text = toolResultSeg!.contentRef?.text ?? "";
    expect(text).toContain("Here are the existing tasks:");
    expect(text).toContain("#1. [pending] Task One");
    expect(text).toContain("#2. [in_progress] Task Two");
  });

  test("无 parentUuid 匹配时 fallback 到最后一个 tool_result", () => {
    const taskReminderMut = makeMutation({
      id: "mut-task-3",
      category: "attachment",
      type: "inject",
      contentRef: { kind: "inline", text: "[]", charCount: 2 },
      charDeltaEstimate: 2,
      metadata: {
        attachmentType: "task_reminder",
        parentUuid: "nonexistent-uuid",
        itemCount: 0,
      },
    });
    const toolResultMut = makeMutation({
      id: "mut-tr-3",
      category: "tool_result",
      toolUseId: "tu-003",
      contentRef: { kind: "inline", text: "fallback target", charCount: 15 },
      charDeltaEstimate: 15,
      metadata: { recordUuid: "other-uuid", messageId: "msg-003" },
    });

    // tool_result 在 task_reminder 之前
    const r = reconFn({
      mutations: [toolResultMut, taskReminderMut],
      boundary: { queryId: "q" },
    });

    const toolResultSeg = r.segments.find((s) => s.category === "tool_result");
    expect(toolResultSeg).toBeTruthy();
    const text = toolResultSeg!.contentRef?.text ?? "";
    // fallback：task_reminder 追加到最后一个 tool_result
    expect(text).toContain("fallback target");
    expect(text).toContain("task tools haven't been used recently");
  });

  test("无 tool_result 时 task_reminder 被忽略（不产生独立 segment）", () => {
    const userMsgMut = makeMutation({
      id: "mut-user-1",
      category: "user_message",
      contentRef: { kind: "inline", text: "hello", charCount: 5 },
      charDeltaEstimate: 5,
      metadata: { recordUuid: "rec-001" },
    });
    const taskReminderMut = makeMutation({
      id: "mut-task-4",
      category: "attachment",
      type: "inject",
      contentRef: { kind: "inline", text: "[]", charCount: 2 },
      charDeltaEstimate: 2,
      metadata: {
        attachmentType: "task_reminder",
        parentUuid: "rec-001",
        itemCount: 0,
      },
    });

    const r = reconFn({
      mutations: [userMsgMut, taskReminderMut],
      boundary: { queryId: "q" },
    });

    // task_reminder 没有可附加的 tool_result，应被忽略
    expect(r.segments.filter((s) => s.category === "attachment")).toHaveLength(0);
    // user_message 段正常存在
    expect(r.segments.filter((s) => s.category === "user_message")).toHaveLength(1);
  });
});
