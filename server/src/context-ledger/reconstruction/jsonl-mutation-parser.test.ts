import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { parseClaudeJsonlMutations, pairToolUseAndResult, buildRuntimeSnapshotFromJsonl } from "./jsonl-mutation-parser";
import type { ContextMutation, SegmentCategory } from "../types";

const FIXTURE_DIR = new URL(
  "../../../test/fixtures/context-reconstruction",
  import.meta.url,
).pathname;

function loadJsonl(caseName: string): string {
  return readFileSync(`${FIXTURE_DIR}/${caseName}/session.jsonl`, "utf8");
}

function parse(caseName: string) {
  return parseClaudeJsonlMutations(loadJsonl(caseName), {
    jsonlFile: `server/test/fixtures/context-reconstruction/${caseName}/session.jsonl`,
  });
}

function countByCategory(mutations: ContextMutation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of mutations) out[m.category] = (out[m.category] ?? 0) + 1;
  return out;
}

function countUnknownReasons(unknowns: ReturnType<typeof parse>["unknownLines"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of unknowns) out[u.reason] = (out[u.reason] ?? 0) + 1;
  return out;
}

// fixture 期望值是从当前 fixture 内容固化下来的快照值；
// 如果 fixture session.jsonl 改了，需要刷新这些数字。
//
// v2.1.126 更新（2026-05-03）：4 个主场景 fixture 共享同一个 JSONL
// 来自 86d62994 session（2026-05-01，promptId bd75b839）
// 系统特征：无 permission mutation（此 session 无权限请求），有 local_command_history
const SHARED_V126 = {
  sessionId: "86d62994-8622-4245-b7db-21c144dee7dd",
  // system/local_command subtype이 이제 local_command_history mutation으로 emit됨 (+1)
  totalMutations: 225,
  byCategory: {
    local_command_history: 3,  // 기존 user 타입 2개 + system/local_command 1개
    user_message: 1,
    skill_listing: 1,
    assistant_text: 31,
    tool_use: 64,
    tool_result: 64,
    hook_event: 52,
    attachment: 7,
    unknown: 2,
  } as Partial<Record<SegmentCategory, number>>,
  pairs: 64,
  unknownReasons: {
    // system_subtype_local_command 제거됨 (이제 mutation으로 처리)
    "harness_state_file-history-snapshot": 5,
    "harness_state_last-prompt": 17,
  },
};

const EXPECTED: Record<
  string,
  {
    sessionId: string;
    totalMutations: number;
    byCategory: Partial<Record<SegmentCategory, number>>;
    pairs: number;
    unknownReasons: Record<string, number>;
  }
> = {
  "system-tools-overhead": SHARED_V126,
  "single-tool-call":      SHARED_V126,
  "multi-turn-human":      SHARED_V126,
  "large-tool-output":     SHARED_V126,
};

for (const caseName of Object.keys(EXPECTED)) {
  const expected = EXPECTED[caseName];

  describe(caseName, () => {
    const result = parse(caseName);

    test("sessionId 从 JSONL 内提取", () => {
      expect(result.sessionId).toBe(expected.sessionId);
    });

    test("总 mutation 数稳定", () => {
      expect(result.mutations.length).toBe(expected.totalMutations);
    });

    test("4 个 fixture 都不含 sidechain 行 → sidechainMutations 为空", () => {
      expect(result.sidechainMutations).toEqual([]);
    });

    test("category 分布稳定", () => {
      const counts = countByCategory(result.mutations);
      for (const k of Object.keys(expected.byCategory) as SegmentCategory[]) {
        expect(counts[k] ?? 0).toBe(expected.byCategory[k]!);
      }
      // 没有意外的 category 出现
      const allowed = new Set(Object.keys(expected.byCategory));
      const surprises = Object.keys(counts).filter((k) => !allowed.has(k));
      expect(surprises).toEqual([]);
    });

    test("每条 mutation 都带 jsonl SourceRef，附 line 与 file", () => {
      expect(result.mutations.length).toBeGreaterThan(0);
      for (const m of result.mutations) {
        expect(m.sourceRef.kind).toBe("jsonl");
        if (m.sourceRef.kind === "jsonl") {
          expect(m.sourceRef.jsonl.file).toBe(
            `server/test/fixtures/context-reconstruction/${caseName}/session.jsonl`,
          );
          expect(typeof m.sourceRef.jsonl.line).toBe("number");
          expect(m.sourceRef.jsonl.line).toBeGreaterThan(0);
        }
      }
    });

    test("tool_use 与 tool_result 一一配对（按 toolUseId）", () => {
      const pair = pairToolUseAndResult(result.mutations);
      expect(pair.unmatchedUses).toEqual([]);
      expect(pair.unmatchedResults).toEqual([]);
      expect(pair.paired.length).toBe(expected.pairs);
      // toolUseId 都填了
      const useMs = result.mutations.filter((m) => m.category === "tool_use");
      const resMs = result.mutations.filter((m) => m.category === "tool_result");
      for (const m of useMs) expect(typeof m.toolUseId).toBe("string");
      for (const m of resMs) expect(typeof m.toolUseId).toBe("string");
    });

    test("unknownLines 只包含已知的 harness_state_* 类型", () => {
      const counts = countUnknownReasons(result.unknownLines);
      expect(counts).toEqual(expected.unknownReasons);
    });

    test("permission-mode 行都映射成 permission inject mutation（若 fixture 有 permission）", () => {
      const ps = result.mutations.filter((m) => m.category === "permission");
      // v2.1.126 fixture（86d62994 session）无 permission mutation，跳过验证
      for (const m of ps) {
        expect(m.type).toBe("inject");
        expect(m.contentRef?.kind).toBe("inline");
        expect(m.metadata?.permissionMode).toBeDefined();
      }
    });

    test("api_error 与 turn_duration/away_summary 标记为 noise", () => {
      const noises = result.mutations.filter((m) => m.type === "noise");
      // api_error 至少一条；turn_duration / away_summary 视 fixture 而定
      expect(noises.length).toBeGreaterThan(0);
      for (const m of noises) {
        expect(m.confidence).toBe("estimated");
        expect(m.metadata?.systemSubtype).toBeDefined();
      }
    });

    test("assistant 文本/工具调用 mutation 带 messageId 与 model", () => {
      const aMs = result.mutations.filter(
        (m) => m.category === "assistant_text" || m.category === "tool_use",
      );
      for (const m of aMs) {
        expect(typeof m.metadata?.messageId).toBe("string");
        expect(typeof m.metadata?.model).toBe("string");
      }
    });

    test("user 字符串内容含 <local-command-*> 时分类为 local_command_history", () => {
      const lc = result.mutations.filter((m) => m.category === "local_command_history");
      for (const m of lc) {
        const text = m.contentRef?.text ?? "";
        expect(/^(?:<local-command-|<bash-|<command-)/.test(text.trimStart())).toBe(true);
      }
    });
  });
}

// ── 跨 fixture 共性断言 ──────────────────────────────────────────────────────

describe("cross-fixture invariants", () => {
  // 真实 Claude Code 把 compact 摘要做成 createUserMessage({content:<string>,
  // isCompactSummary:true})；不是顶层 compactSummaryText。
  test("isCompactSummary=true 时从 message.content 读取摘要正文（string 形态）", () => {
    const synthetic = JSON.stringify({
      type: "user",
      uuid: "u-compact",
      timestamp: "2026-04-27T12:00:00.000Z",
      isCompactSummary: true,
      sessionId: "synthetic",
      message: {
        role: "user",
        content:
          "This session is being continued from a previous conversation that ran out of context. ...",
      },
    });
    const r = parseClaudeJsonlMutations(synthetic);
    expect(r.mutations.length).toBe(1);
    const m = r.mutations[0];
    expect(m.category).toBe("compaction");
    expect(m.type).toBe("compact");
    expect(m.contentRef?.text).toMatch(/continued from a previous conversation/);
    expect(m.charDeltaEstimate).toBeGreaterThan(0);
    if (m.sourceRef.kind === "jsonl") {
      expect(m.sourceRef.jsonl.fieldPath).toBe("message.content");
    }
  });

  test("compact 摘要也支持 message.content 是 text block 数组的形态", () => {
    const synthetic = JSON.stringify({
      type: "user",
      uuid: "u-compact-arr",
      isCompactSummary: true,
      message: {
        role: "user",
        content: [
          { type: "text", text: "Summary part A" },
          { type: "text", text: "Summary part B" },
        ],
      },
    });
    const r = parseClaudeJsonlMutations(synthetic);
    expect(r.mutations.length).toBe(1);
    expect(r.mutations[0].contentRef?.text).toBe("Summary part A\nSummary part B");
  });

  // 真实 Claude Code 把 subagent transcript 行写到主 session.jsonl 时打
  // isSidechain:true。父会话 expected context 不能包含这些行。
  test("isSidechain=true 行进入 sidechainMutations 而不是 mutations", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "main-session",
        message: { role: "user", content: "main session prompt" },
      }),
      JSON.stringify({
        type: "user",
        uuid: "u2",
        isSidechain: true,
        agentId: "subagent-1",
        sessionId: "main-session",
        message: { role: "user", content: "subagent prompt" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        isSidechain: true,
        agentId: "subagent-1",
        message: {
          id: "msg_x",
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "subagent reply" }],
        },
      }),
    ];
    const r = parseClaudeJsonlMutations(lines);
    expect(r.mutations.length).toBe(1);
    expect(r.mutations[0].contentRef?.text).toBe("main session prompt");
    expect(r.mutations[0].metadata?.isSidechain).toBeUndefined();

    expect(r.sidechainMutations.length).toBe(2);
    for (const m of r.sidechainMutations) {
      expect(m.subagentId).toBe("subagent-1");
      expect(m.metadata?.isSidechain).toBe(true);
      expect(m.sourceRef.kind).toBe("jsonl");
    }
  });

  // thinking / redacted_thinking block 字段名是 `thinking` / `data`，不是 `text`。
  test("assistant thinking block 从 .thinking 字段读取正文", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a-think",
      message: {
        id: "msg_t",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "thinking", thinking: "internal reasoning here" }],
      },
    });
    const r = parseClaudeJsonlMutations(line);
    expect(r.mutations.length).toBe(1);
    const m = r.mutations[0];
    expect(m.category).toBe("thinking");
    expect(m.contentRef?.text).toBe("internal reasoning here");
    expect(m.charDeltaEstimate).toBe("internal reasoning here".length);
    expect(m.metadata?.redacted).toBe(false);
  });

  test("redacted_thinking block 从 .data 字段读取正文", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a-redact",
      message: {
        id: "msg_r",
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "OPAQUE_BLOB_xyz" }],
      },
    });
    const r = parseClaudeJsonlMutations(line);
    expect(r.mutations.length).toBe(1);
    const m = r.mutations[0];
    expect(m.category).toBe("thinking");
    expect(m.contentRef?.text).toBe("OPAQUE_BLOB_xyz");
    expect(m.metadata?.redacted).toBe(true);
  });

  test("空行与解析失败的 JSON 不抛异常", () => {
    const lines = ["", "not-json", "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}"];
    const r = parseClaudeJsonlMutations(lines);
    expect(r.mutations.length).toBe(1);
    expect(r.unknownLines.some((u) => u.reason === "json_parse_error")).toBe(true);
  });

  test("未知 attachment 子型仍发 mutation 并报 unknownLines", () => {
    const line = JSON.stringify({
      type: "attachment",
      uuid: "u",
      attachment: { type: "future_thing", content: "x" },
    });
    const r = parseClaudeJsonlMutations(line);
    expect(r.mutations.length).toBe(1);
    expect(r.mutations[0].category).toBe("attachment");
    expect(r.mutations[0].confidence).toBe("estimated");
    expect(r.unknownLines.some((u) => u.reason === "attachment_unknown_subtype")).toBe(true);
  });

  // system:api_error 行生成 noise mutation，并标记 syntheticApiError=true 供
  // reconstructor rule 过滤（不作为普通 assistant_text 进入 expected context）。
  test("system:api_error 生成 noise mutation 且 metadata.syntheticApiError=true", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "api_error",
      uuid: "sys-err",
      timestamp: "2026-04-29T10:00:00.000Z",
      cause: "connection_timeout",
      retryAttempt: 1,
      parentUuid: "parent-1",
    });
    const r = parseClaudeJsonlMutations(line);
    expect(r.mutations.length).toBe(1);
    const m = r.mutations[0];
    expect(m.type).toBe("noise");
    expect(m.category).toBe("hook_event");
    expect(m.confidence).toBe("estimated");
    expect(m.metadata?.systemSubtype).toBe("api_error");
    expect(m.metadata?.syntheticApiError).toBe(true);
    expect(m.metadata?.retryAttempt).toBe(1);
  });

  // isMeta=true 的 user record 需把标记透传到 metadata，供 reconstructor 识别
  // 这类 harness 注入行（system-reminder / caveat）不计入真实 token 统计。
  test("isMeta=true 的 user record 在 metadata 里保留 isMeta 标记", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u-meta",
      isMeta: true,
      promptId: "prompt-42",
      message: { id: "msg-meta", role: "user", content: "system caveat text" },
    });
    const r = parseClaudeJsonlMutations(line);
    expect(r.mutations.length).toBe(1);
    const m = r.mutations[0];
    expect(m.metadata?.isMeta).toBe(true);
    expect(m.metadata?.promptId).toBe("prompt-42");
    expect(m.metadata?.messageId).toBe("msg-meta");
  });

  // isApiErrorMessage=true 的 assistant record 标记需透传到每个 block mutation 的 metadata。
  test("isApiErrorMessage=true 的 assistant record 在 metadata 里保留标记", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a-err",
      isApiErrorMessage: true,
      message: {
        id: "msg-apierr",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "API error occurred" }],
      },
    });
    const r = parseClaudeJsonlMutations(line);
    expect(r.mutations.length).toBe(1);
    const m = r.mutations[0];
    expect(m.category).toBe("assistant_text");
    expect(m.metadata?.isApiErrorMessage).toBe(true);
    expect(m.metadata?.messageId).toBe("msg-apierr");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HarnessRuntimeSnapshot（第一版 JSONL 可填充字段）
// ─────────────────────────────────────────────────────────────────────────────

describe("HarnessRuntimeSnapshot（第一版）", () => {
  test("fixture 解析结果包含 runtimeSnapshot，source=jsonl", () => {
    for (const caseName of Object.keys(EXPECTED)) {
      const r = parse(caseName);
      expect(r.runtimeSnapshot).toBeDefined();
      expect(r.runtimeSnapshot.source).toBe("jsonl");
    }
  });

  test("inferredModel 从最后一条 assistant mutation 的 model 字段提取", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: {
          id: "msg1",
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "first" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a2",
        message: {
          id: "msg2",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "second" }],
        },
      }),
    ];
    const r = parseClaudeJsonlMutations(lines);
    // 取最后一条 assistant
    expect(r.inferredModel).toBe("claude-sonnet-4-6");
    expect(r.runtimeSnapshot.inferredModel).toBe("claude-sonnet-4-6");
  });

  test("runtimeSnapshot 与 inferredModel 保持同步", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: {
        id: "msg1",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "hello" }],
      },
    });
    const r = parseClaudeJsonlMutations(line);
    expect(r.runtimeSnapshot.inferredModel).toBe(r.inferredModel);
  });

  test("permission-mode 行被提取为 permissionMode 字段", () => {
    const lines = [
      JSON.stringify({
        type: "permission-mode",
        permissionMode: "bypassPermissions",
        timestamp: "2026-05-01T00:00:00.000Z",
      }),
    ];
    const r = parseClaudeJsonlMutations(lines);
    expect(r.runtimeSnapshot.permissionMode).toBe("bypassPermissions");
  });

  test("无 permission-mode 行时 runtimeSnapshot.permissionMode 为 undefined", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: { id: "m1", role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    const r = parseClaudeJsonlMutations(line);
    expect(r.runtimeSnapshot.permissionMode).toBeUndefined();
  });

  test("firstTimestamp 取第一条有时间戳 mutation 的时间", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-05-01T10:00:00.000Z",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-05-01T10:00:01.000Z",
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "hi" }],
        },
      }),
    ];
    const r = parseClaudeJsonlMutations(lines);
    expect(r.runtimeSnapshot.firstTimestamp).toBe("2026-05-01T10:00:00.000Z");
  });

  test("无 assistant 行时 inferredModel 与 runtimeSnapshot.inferredModel 均为 undefined", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "only user" },
    });
    const r = parseClaudeJsonlMutations(line);
    expect(r.inferredModel).toBeUndefined();
    expect(r.runtimeSnapshot.inferredModel).toBeUndefined();
  });

  test("runtimeSnapshot 不含 proxy 相关字段（userType/settings 等第一版均为 undefined）", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: {
        id: "m1",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "hi" }],
      },
    });
    const r = parseClaudeJsonlMutations(line);
    const snap = r.runtimeSnapshot;
    // 第一版待派生字段均为 undefined，明确断言"不猜"
    expect(snap.userType).toBeUndefined();
    expect(snap.settings).toBeUndefined();
    expect(snap.featureFlags).toBeUndefined();
    expect(snap.enabledToolNames).toBeUndefined();
    expect(snap.autoMemoryEnabled).toBeUndefined();
    expect(snap.claudeCodeVersion).toBeUndefined();
    expect(snap.entrypoint).toBeUndefined();
    expect(snap.cwd).toBeUndefined();
  });

  test("buildRuntimeSnapshotFromJsonl 直接构建 snapshot 与 parse 结果一致", () => {
    const mutations: ContextMutation[] = [
      {
        id: "cmut-1",
        agentKind: "claude-code",
        sessionId: "sess-1",
        type: "append",
        category: "assistant_text",
        source: "jsonl",
        sourceRef: { kind: "jsonl", jsonl: { file: "f.jsonl", line: 1 } },
        confidence: "definitive",
        timestamp: "2026-05-01T12:00:00.000Z",
        metadata: { model: "claude-opus-4-7" },
      },
    ];
    const snap = buildRuntimeSnapshotFromJsonl({
      mutations,
      sessionId: "sess-1",
      inferredModel: "claude-opus-4-7",
      jsonlFile: "f.jsonl",
    });
    expect(snap.source).toBe("jsonl");
    expect(snap.inferredModel).toBe("claude-opus-4-7");
    expect(snap.sessionId).toBe("sess-1");
    expect(snap.jsonlFile).toBe("f.jsonl");
    expect(snap.firstTimestamp).toBe("2026-05-01T12:00:00.000Z");
  });
});
