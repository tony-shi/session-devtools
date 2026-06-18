// agent teams 域的稳定契约测试（合成 fixture，真值依据 wf-review 实测解剖——
// tmp/teams-truth/ 与 memory project_agent_teams_groundtruth）：
//   1. parsers-v2：行级 teamName/agentName 提取 + 入站消息不计 human_input_count
//   2. drilldown：teammate-message turn opener（openerSource/openerTeammateId）
//      + mid-turn 入站消息不进 midTurnInjections
//   3. team-domain：成员发现 + 消息时间线重建（spawn/message/idle/shutdown 形态）

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { parseClaudeSessionV2 } from "./parsers-v2/claude.ts";
import { parseSessionDrilldown } from "./session-drilldown-parser.ts";
import { readTeamDomain } from "./team-domain.ts";

let root: string;
let leadFile: string;
let mateFile: string;

const T = (s: number) => new Date(Date.UTC(2026, 0, 2, 0, 0, s)).toISOString();
const TEAM = "t-test";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "team-domain-test-"));
  leadFile = join(root, "lead-uuid.jsonl");
  mateFile = join(root, "mate-uuid.jsonl");

  // ── lead 会话：人类输入 → SendMessage(spawn 后的指令) → 收 idle 通知（JSON）──
  writeFileSync(leadFile, [
    { type: "user", teamName: TEAM, timestamp: T(0), promptId: "p1", message: { content: "build a team" } },
    {
      type: "assistant", teamName: TEAM, timestamp: T(1),
      message: {
        id: "L1", model: "claude-test", stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "tool_use", id: "toolu_sm_1", name: "SendMessage", input: { to: "worker", summary: "任务下发", message: "请审查 X 模块并汇报" } }],
      },
    },
    {
      type: "user", teamName: TEAM, timestamp: T(2),
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_sm_1", content: "Message sent" }] },
      toolUseResult: { status: "sent" },
    },
    {
      type: "assistant", teamName: TEAM, timestamp: T(3),
      message: { id: "L2", model: "claude-test", stop_reason: "end_turn", usage: { input_tokens: 11, output_tokens: 4 }, content: [{ type: "text", text: "已派发" }] },
    },
    // 入站 idle 通知（结构化 JSON）→ 开新 turn，openerSource=teammate-message
    {
      type: "user", teamName: TEAM, timestamp: T(60),
      message: { content: `Another Claude session sent a message:\n<teammate-message teammate_id="worker" color="blue" summary="[to team-lead] 审查完成">{"type":"idle_notification","from":"worker","timestamp":"${T(59)}","idleReason":"available","summary":"[to team-lead] 审查完成"}</teammate-message>` },
    },
    {
      type: "assistant", teamName: TEAM, timestamp: T(61),
      message: { id: "L3", model: "claude-test", stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 6 }, content: [{ type: "text", text: "收到，综合中" }] },
    },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");

  // ── teammate 会话：spawn 首行（<teammate-message> 包裹）→ 干活 → 发汇报；
  //    mid-turn 收到一条 peer 消息（不应进 midTurnInjections）──
  writeFileSync(mateFile, [
    {
      type: "user", teamName: TEAM, agentName: "worker", timestamp: T(5), promptId: "p2",
      message: { content: `<teammate-message teammate_id="team-lead">\n你是 worker，请审查 X 模块` },
    },
    {
      type: "assistant", teamName: TEAM, agentName: "worker", timestamp: T(10),
      message: {
        id: "M1", model: "claude-test", stop_reason: "tool_use",
        usage: { input_tokens: 30, output_tokens: 8 },
        content: [{ type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: "/x" } }],
      },
    },
    // mid-turn 入站 peer 消息（turn 进行中到达）
    {
      type: "user", teamName: TEAM, agentName: "worker", timestamp: T(11),
      message: { content: `Another Claude session sent a message:\n<teammate-message teammate_id="other" summary="质疑">你的 F-1 不成立</teammate-message>` },
    },
    {
      type: "user", teamName: TEAM, agentName: "worker", timestamp: T(12),
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_r1", content: "file body" }] },
    },
    {
      type: "assistant", teamName: TEAM, agentName: "worker", timestamp: T(20),
      message: {
        id: "M2", model: "claude-test", stop_reason: "end_turn",
        usage: { input_tokens: 40, output_tokens: 9 },
        content: [
          { type: "tool_use", id: "toolu_sm_2", name: "SendMessage", input: { to: "team-lead", summary: "审查完成", message: "X 模块审查结论：…" } },
          { type: "text", text: "汇报完毕" },
        ],
      },
    },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parsers-v2 × teams", () => {
  it("提取 team_name/team_agent_name；入站消息不计 human_input_count", async () => {
    const lead = await parseClaudeSessionV2(leadFile);
    expect(lead.team_name).toBe(TEAM);
    expect(lead.team_agent_name).toBeNull();
    // lead：1 条真人输入；idle 通知不计
    expect(lead.human_input_count).toBe(1);

    const mate = await parseClaudeSessionV2(mateFile);
    expect(mate.team_name).toBe(TEAM);
    expect(mate.team_agent_name).toBe("worker");
    // teammate：spawn 行 + mid-turn 消息都不是人类输入
    expect(mate.human_input_count).toBe(0);
  });
});

describe("drilldown × teams", () => {
  const stubDb = { prepare: () => ({ all: () => [], get: () => undefined }) } as unknown as import("better-sqlite3").Database;
  const row = { tool: "claude", project: "p", cwd: "", custom_title: null, ai_title: null, first_event_at: "", last_event_at: "", system_error_count: 0 };

  it("入站消息开 turn 但 openerSource=teammate-message + 发送者锚", async () => {
    const d = await parseSessionDrilldown(leadFile, "lead", row, stubDb);
    expect(d.turns).toHaveLength(2);
    expect(d.turns[0].openerSource).toBe("human");
    expect(d.turns[1].openerSource).toBe("teammate-message");
    expect(d.turns[1].openerTeammateId).toBe("worker");
  });

  it("teammate 会话：spawn 行开 turn（teammate-message 语义）；mid-turn 消息不进 midTurnInjections", async () => {
    const d = await parseSessionDrilldown(mateFile, "mate", row, stubDb);
    expect(d.turns).toHaveLength(1);
    expect(d.turns[0].openerSource).toBe("teammate-message");
    expect(d.turns[0].openerTeammateId).toBe("team-lead");
    expect(d.turns[0].midTurnInjections).toHaveLength(0);
    // mid-turn 消息按真实位置进 interval events（user:teammate-message）
    const kinds = d.turns[0].calls.flatMap((c) => c.intervalEvents.map((e) => e.kind));
    expect(kinds).toContain("user:teammate-message");
  });
});

describe("team-domain", () => {
  it("成员发现 + 时间线（spawn/message/idle）按时间序重建", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions_meta_v2 (
      session_id TEXT PRIMARY KEY, source_file TEXT, team_name TEXT, team_agent_name TEXT,
      first_event_at TEXT, last_event_at TEXT, llm_call_count INTEGER, sub_agent_count INTEGER
    )`);
    const ins = db.prepare(`INSERT INTO sessions_meta_v2 VALUES (?,?,?,?,?,?,?,?)`);
    ins.run("lead-uuid", leadFile, TEAM, null, T(0), T(61), 3, 0);
    ins.run("mate-uuid", mateFile, TEAM, "worker", T(5), T(20), 2, 0);

    const domain = readTeamDomain(db as unknown as import("better-sqlite3").Database, TEAM);
    expect(domain.members.map((m) => [m.agentName, m.role])).toEqual([
      [null, "lead"], ["worker", "teammate"],
    ]);

    const kinds = domain.events.map((e) => `${e.kind}:${e.from}`);
    // lead 的下发消息、worker 的 spawn、worker 的汇报、lead 收到的 idle
    expect(kinds).toContain("message:team-lead");
    expect(kinds).toContain("spawn:team-lead");
    expect(kinds).toContain("message:worker");
    expect(kinds).toContain("idle:worker");
    // 接收侧的普通文本投递不重复计（worker 收到的 peer 消息文本来自 other 的
    // 发送侧——other 会话不在本 fixture，故时间线中无该条；不伪造）
    expect(domain.events.filter((e) => e.kind === "message")).toHaveLength(2);
    // 时间序
    const ts = domain.events.map((e) => e.timestamp);
    expect([...ts].sort()).toEqual(ts);
  });
});
