// workflow 工件 ingest 的稳定契约测试（合成 fixture，不依赖本机 ~/.claude 数据）：
//   1. readWorkflowRunsFromDisk —— 只见已完结 run（wf json 存在）；journal result
//      换源；superseded 转录只计数。
//   2. resolveSubAgentPaths —— 平铺 / workflow 复合 id 双形态 + 格式白名单。
//   3. parseSessionDrilldown 集成 —— workflow agent 平铺进 subAgents 并挂回
//      launch call；task-notification 仍开 turn 但 openerSource 换语义。
// 字段语义的真值依据：session bd5d3dd7（CC 2.1.167）与 3915787e（2.1.170，含 resume）。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readWorkflowRunsFromDisk } from "./workflow-runs.ts";
import { resolveSubAgentPaths, parseSessionDrilldown } from "./session-drilldown-parser.ts";

let root: string;          // tmp 根
let sourceFile: string;    // 主 session jsonl
let sessionDir: string;    // <root>/session

const RUN_ID = "wf_test-run1";
const SCRIPT = "export const meta = { name: 'test-wf', description: 'd' }\nreturn 1\n";

const T = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wf-runs-test-"));
  sourceFile = join(root, "session.jsonl");
  sessionDir = join(root, "session");

  // ── 主 session jsonl：human turn（含 Workflow launch + mid-turn 回执）→
  //    notification turn → resume turn（in-flight，晚于 wf json 写出时刻）──
  const mainLines = [
    { type: "user", timestamp: T(0), promptId: "p1", message: { content: "do it" } },
    {
      type: "assistant", timestamp: T(1),
      message: {
        id: "m1", model: "claude-test", stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "tool_use", id: "toolu_wf_1", name: "Workflow", input: { script: SCRIPT } }],
      },
    },
    {
      // 旧格式 launch 回执（≤2026-05-31，实样本 8e685b5d）：没有 taskType 字段 ——
      // launch 收集不得硬卡 taskType，否则整个 run 失锚
      type: "user", timestamp: T(2),
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_wf_1", content: "Workflow launched in background." }] },
      toolUseResult: {
        status: "async_launched", taskId: "wtask1",
        workflowName: "test-wf", runId: RUN_ID, summary: "s",
        transcriptDir: "/x", scriptPath: "/x/test-wf.js",
      },
    },
    {
      // mid-turn 到达的其他后台任务回执（批量完结场景）—— 不得进 midTurnInjections
      type: "user", timestamp: T(3), origin: { kind: "task-notification" },
      message: { content: "<task-notification>\n<task-id>wother</task-id>\n<status>completed</status>\n</task-notification>" },
    },
    {
      type: "assistant", timestamp: T(4),
      message: {
        id: "m2", model: "claude-test", stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 6 },
        content: [{ type: "text", text: "launched, will report back" }],
      },
    },
    {
      type: "user", timestamp: T(60), origin: { kind: "task-notification" },
      message: {
        content: "<task-notification>\n<task-id>wtask1</task-id>\n<tool-use-id>toolu_wf_1</tool-use-id>\n<status>completed</status>\n<result>{...}</result>\n</task-notification>",
      },
    },
    {
      type: "assistant", timestamp: T(61),
      message: {
        id: "m3", model: "claude-test", stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 8 },
        content: [{ type: "text", text: "workflow done, summarizing" }],
      },
    },
    // resume：同 runId 的第二次 launch，发生在 wf json 写出时刻（T59）之后 ——
    // 属于进行中的下一次物理执行，不得进入已完结快照的 launches
    { type: "user", timestamp: T(110), promptId: "p2", message: { content: "resume it" } },
    {
      type: "assistant", timestamp: T(120),
      message: {
        id: "m4", model: "claude-test", stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "tool_use", id: "toolu_wf_2", name: "Workflow", input: { scriptPath: "/x/test-wf.js", resumeFromRunId: RUN_ID } }],
      },
    },
    {
      type: "user", timestamp: T(121),
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_wf_2", content: "Workflow launched in background." }] },
      toolUseResult: {
        status: "async_launched", taskId: "wtask2", taskType: "local_workflow",
        workflowName: "test-wf", runId: RUN_ID, summary: "s",
        transcriptDir: "/x", scriptPath: "/x/test-wf.js",
      },
    },
    {
      type: "assistant", timestamp: T(122),
      message: {
        id: "m5", model: "claude-test", stop_reason: "end_turn",
        usage: { input_tokens: 9, output_tokens: 4 },
        content: [{ type: "text", text: "resumed" }],
      },
    },
  ];
  writeFileSync(sourceFile, mainLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  // ── 已完结 run 工件 ──
  mkdirSync(join(sessionDir, "workflows"), { recursive: true });
  const agentsDir = join(sessionDir, "subagents", "workflows", RUN_ID);
  mkdirSync(agentsDir, { recursive: true });

  writeFileSync(join(sessionDir, "workflows", `${RUN_ID}.json`), JSON.stringify({
    runId: RUN_ID, timestamp: T(59), taskId: "wtask1",
    script: SCRIPT, scriptPath: "/x/test-wf.js",
    result: { ok: true }, agentCount: 1, logs: [], durationMs: 58000,
    summary: "s", workflowName: "test-wf", status: "completed",
    startTime: Date.parse(T(1)), phases: [{ title: "Probe", detail: "one reader" }],
    defaultModel: "claude-test",
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "Probe" },
      {
        type: "workflow_agent", index: 1, label: "probe:a", phaseIndex: 1, phaseTitle: "Probe",
        agentId: "aaa111", model: "claude-test", state: "done",
        startedAt: Date.parse(T(2)), lastProgressAt: Date.parse(T(50)), cached: false,
        resultPreview: "{\"findings\":\"F\"}", promptPreview: "agent prompt",
      },
    ],
    totalTokens: 170, totalToolCalls: 1,
  }));

  writeFileSync(join(agentsDir, "journal.jsonl"), [
    // attempt 槽位：aaa111 的槽位 v2:abc 有一次更早的失败尝试 orphan99
    // （started 无 result —— resume 后被重跑，正是 superseded 转录的来源）
    JSON.stringify({ type: "started", key: "v2:abc", agentId: "orphan99" }),
    JSON.stringify({ type: "started", key: "v2:abc", agentId: "aaa111" }),
    JSON.stringify({ type: "result", key: "v2:abc", agentId: "aaa111", result: { findings: "F" } }),
    // result 键缺失的 result 行（写出竞态）—— 不得把 undefined 塞进 Map
    JSON.stringify({ type: "result", key: "v2:def", agentId: "ghostagent" }),
  ].join("\n") + "\n");

  writeFileSync(join(agentsDir, "agent-aaa111.meta.json"), JSON.stringify({ agentType: "workflow-subagent" }));
  writeFileSync(join(agentsDir, "agent-aaa111.jsonl"), [
    JSON.stringify({
      type: "user", isSidechain: true, agentId: "aaa111", sessionId: "session",
      timestamp: T(2), promptId: "p1", message: { content: "agent prompt" },
    }),
    JSON.stringify({
      type: "assistant", isSidechain: true, agentId: "aaa111", sessionId: "session",
      timestamp: T(10), requestId: "req_a1",
      message: {
        id: "am1", model: "claude-test", stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 0 },
        content: [{ type: "text", text: "done" }],
      },
    }),
  ].join("\n") + "\n");

  // superseded：有转录但不被 workflowProgress 引用（resume 作废/失败的上一轮 agent）
  writeFileSync(join(agentsDir, "agent-orphan99.jsonl"), JSON.stringify({
    type: "user", isSidechain: true, agentId: "orphan99", timestamp: T(2), message: { content: "x" },
  }) + "\n");
  // 孤儿但首行时间晚于 wf json 写出时刻（T59）—— 属于进行中的下一次 resume 的
  // 转录，不是 superseded，不得计入
  writeFileSync(join(agentsDir, "agent-orphanlate1.jsonl"), JSON.stringify({
    type: "user", isSidechain: true, agentId: "orphanlate1", timestamp: T(130), message: { content: "z" },
  }) + "\n");

  // ── 进行中 run：只有 agents 目录，没有 wf json —— 必须不可见 ──
  const inflightDir = join(sessionDir, "subagents", "workflows", "wf_inflight-x");
  mkdirSync(inflightDir, { recursive: true });
  writeFileSync(join(inflightDir, "agent-bbb222.jsonl"), JSON.stringify({
    type: "user", isSidechain: true, agentId: "bbb222", timestamp: T(2), message: { content: "y" },
  }) + "\n");

  // ── runId 不合白名单（含双下划线，会与复合 agentFileId 分隔符冲突）的 wf json
  //    —— 生成端按损坏 run 跳过，避免产出自己都路由不到的死链 ──
  writeFileSync(join(sessionDir, "workflows", "wf_bad__name.json"), JSON.stringify({
    runId: "wf_bad__name", status: "completed", workflowName: "bad", timestamp: T(59),
    startTime: Date.parse(T(1)), workflowProgress: [], phases: [],
  }));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readWorkflowRunsFromDisk", () => {
  it("只返回已完结 run；journal/superseded/script 元数据齐全", () => {
    const runs = readWorkflowRunsFromDisk(sessionDir);
    // in-flight（无 wf json）与白名单不合规 runId（wf_bad__name）均不可见
    expect(runs.map((r) => r.runId)).toEqual([RUN_ID]);

    const run = runs[0];
    expect(run.status).toBe("completed");
    expect(run.workflowName).toBe("test-wf");
    expect(run.agentCount).toBe(1);
    expect(run.scriptLength).toBe(SCRIPT.length);
    expect(run.phases).toEqual([{ title: "Probe", detail: "one reader" }]);
    expect(run.agents).toHaveLength(1);
    expect(run.agents[0]).toMatchObject({ agentId: "aaa111", label: "probe:a", phaseIndex: 1, phaseTitle: "Probe", cached: false });
    expect(run.journalResults.get("aaa111")).toBe(JSON.stringify({ findings: "F" }));
    // result 键缺失的 journal 行不得把 undefined 塞进 Map
    expect(run.journalResults.has("ghostagent")).toBe(false);
    expect(run.transcriptAgentIds.has("aaa111")).toBe(true);
    // orphan99（T2，早于 completedAt）计入；orphanlate1（T130，进行中 resume 的转录）不计
    expect(run.supersededAgentCount).toBe(1);
  });

  it("workflows 目录缺失时返回空", () => {
    expect(readWorkflowRunsFromDisk(join(root, "nope"))).toEqual([]);
  });
});

describe("resolveSubAgentPaths", () => {
  it("平铺 id → subagents/agent-<id>.jsonl", () => {
    const r = resolveSubAgentPaths(sourceFile, "a92adf579bd9e9f82");
    expect(r.agentPath).toBe(join(sessionDir, "subagents", "agent-a92adf579bd9e9f82.jsonl"));
    expect(r.workflowRunId).toBeNull();
  });

  it("复合 id → subagents/workflows/<runId>/agent-<agentId>.jsonl", () => {
    const r = resolveSubAgentPaths(sourceFile, `${RUN_ID}__aaa111`);
    expect(r.agentPath).toBe(join(sessionDir, "subagents", "workflows", RUN_ID, "agent-aaa111.jsonl"));
    expect(r.workflowRunId).toBe(RUN_ID);
  });

  it("非法 id（路径穿越）拒绝", () => {
    expect(() => resolveSubAgentPaths(sourceFile, "../../etc")).toThrowError(/invalid agentFileId/);
    expect(() => resolveSubAgentPaths(sourceFile, "wf_x__../y")).toThrowError(/invalid agentFileId/);
  });
});

describe("parseSessionDrilldown × workflow", () => {
  const stubDb = {
    prepare: () => ({ all: () => [], get: () => undefined }),
  } as unknown as import("better-sqlite3").Database;
  const sessionRow = {
    tool: "claude", project: "p", cwd: "", custom_title: null, ai_title: null,
    first_event_at: T(0), last_event_at: T(61), system_error_count: 0,
  };

  it("workflow agent 平铺进 subAgents 并挂回 launch call；run 概览齐全", async () => {
    const d = await parseSessionDrilldown(sourceFile, "session", sessionRow, stubDb);

    expect(d.subAgents).toHaveLength(1);
    const sa = d.subAgents[0];
    expect(sa.agentFileId).toBe(`${RUN_ID}__aaa111`);
    expect(sa.agentSource).toBe("workflow");
    expect(sa.toolUseName).toBe("Workflow");
    expect(sa.toolUseId).toBe("toolu_wf_1");
    expect(sa.workflowRunId).toBe(RUN_ID);
    expect(sa.agentLabel).toBe("probe:a");
    expect(sa.phaseName).toBe("Probe");
    expect(sa.llmCallCount).toBe(1);
    // result 换源 journal（父 JSONL 没有逐 agent tool_result）
    expect(sa.result).toBe(JSON.stringify({ findings: "F" }));
    // 挂回了发出 Workflow tool_use 的那个 call
    expect(sa.parentCallId).toBe(d.turns[0].calls[0].id);
    expect(d.turns[0].calls[0].subAgents.map((s) => s.agentFileId)).toContain(`${RUN_ID}__aaa111`);

    expect(d.workflowRuns).toHaveLength(1);
    const run = d.workflowRuns![0];
    // 旧格式回执（无 taskType）照常收集；晚于 completedAt 的 resume launch
    // （toolu_wf_2，进行中）不进已完结快照
    expect(run.launches).toEqual([{ toolUseId: "toolu_wf_1", lineIdx: 1, taskId: "wtask1" }]);
    expect(run.supersededAgentCount).toBe(1);
    expect(run.agents[0].agentFileId).toBe(`${RUN_ID}__aaa111`);
    expect(run.agents[0].hasTranscript).toBe(true);
    // attempt 槽位：v2:abc 的 started 序列 [orphan99, aaa111] → attempts 下发，
    // 物理行序，orphan99 失败（无 result）、aaa111 胜出
    expect(run.agents[0].attempts).toEqual([
      { agentId: "orphan99", agentFileId: `${RUN_ID}__orphan99`, hasResult: false, hasTranscript: true, final: false },
      { agentId: "aaa111", agentFileId: `${RUN_ID}__aaa111`, hasResult: true, hasTranscript: true, final: true },
    ]);
  });

  it("task-notification 仍开 turn，但 openerSource/锚点换语义；mid-turn 回执不进 midTurnInjections", async () => {
    const d = await parseSessionDrilldown(sourceFile, "session", sessionRow, stubDb);

    expect(d.turns).toHaveLength(3); // 切分保留 —— 排除 opener 会让其后的 call 孤儿化
    expect(d.turns[0].openerSource).toBe("human");
    // turn 1 内 T(3) 的 mid-turn 回执不是"用户打断输入"
    expect(d.turns[0].midTurnInjections).toHaveLength(0);
    expect(d.turns[1].openerSource).toBe("task-notification");
    expect(d.turns[1].openerTaskId).toBe("wtask1");
    expect(d.turns[1].openerToolUseId).toBe("toolu_wf_1");
    expect(d.turns[2].openerSource).toBe("human"); // resume turn
  });
});
