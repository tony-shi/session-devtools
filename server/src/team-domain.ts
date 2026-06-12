// agent teams 域读取 —— 旁路模块（真值依据 memory project_agent_teams_groundtruth
// 与 tmp/teams-truth/，实测 wf-review，CC 2.1.170+）。
//
// 数据模型（与 workflow 的本质差异）：team 成员是 projects/ 下的平级完整 session
// （已被 sync-v2 当普通 session 入库），team 域只是"分组 + 关联"层——成员发现走
// meta 表的 team_name 列（行级 teamName 字段提取，编排目录 cleanup 即删、行级
// 字段是唯一事后强键）；消息时间线从各成员转录重建：
//   - 人写的消息：发送侧 assistant 行的 SendMessage tool_use（input={to,summary,
//     message}）。接收侧的同一消息是冗余投递，跳过避免重复。
//   - 系统事件（idle / terminated / shutdown_approved）：只存在于接收侧（lead
//     转录）的 <teammate-message> 包裹 JSON —— 无发送侧 tool_use。
//   - spawn：teammate 转录首行 user（<teammate-message teammate_id="team-lead">
//     包裹的逐字 spawn prompt）。
//
// 明确不支持（按"不伪造"原则如实暴露）：
//   - 任务板终态：全部完成时自动 compact（早于 cleanup），事后文件层不可得。
//     TaskCreate/TaskUpdate 的 tool_use 留痕在转录里，事件流重放留待后续批次。
//   - 同名 team 跨期消歧：teamName 是唯一分组键，无 createdAt 等强消歧字段——
//     不同时期的同名 team 会被并到一组（前端文案标注此局限）。
//   - spawn 规格元数据（model/agentType/color）：仅存在于已删除的 config.json，
//     不在 payload 里编造。

import { readFileSync } from "fs";
import type { Database } from "better-sqlite3";

export interface TeamMember {
  sessionId: string;
  /** null = lead（lead 行只带 teamName 不带 agentName）。 */
  agentName: string | null;
  role: "lead" | "teammate";
  firstEventAt: string;
  lastEventAt: string;
  llmCallCount: number;
  subAgentCount: number;
}

export interface TeamTimelineEvent {
  kind: "spawn" | "message" | "shutdown_request" | "idle" | "terminated" | "shutdown";
  /** 发送者：成员 agentName，lead 为 "team-lead"。 */
  from: string;
  /** message/spawn/shutdown_request 的收件人。 */
  to?: string;
  /** SendMessage 的 summary（idle 事件复用其 summary 字段，peer-DM 时带 [to X] 前缀）。 */
  summary?: string;
  textPreview: string;
  textLength: number;
  timestamp: string;
  /** 留痕位置（跳链用）：留痕所在会话 + 0-based 文件行号。 */
  sessionId: string;
  lineIdx: number;
}

export interface TeamDomain {
  teamName: string;
  members: TeamMember[];
  /** 按 timestamp 升序。 */
  events: TeamTimelineEvent[];
}

interface MetaRow {
  session_id: string;
  source_file: string;
  team_agent_name: string | null;
  first_event_at: string;
  last_event_at: string;
  llm_call_count: number;
  sub_agent_count: number;
}

const PREVIEW = 300;

/** lead 的发送者名。config 里 lead 名固定 "team-lead"（实测），接收侧 teammate_id 同。 */
const LEAD_NAME = "team-lead";

export function readTeamDomain(db: Database, teamName: string): TeamDomain {
  const rows = db.prepare(`
    SELECT session_id, source_file, team_agent_name,
           first_event_at, last_event_at, llm_call_count, sub_agent_count
    FROM sessions_meta_v2 WHERE team_name = ? ORDER BY first_event_at
  `).all(teamName) as MetaRow[];

  const members: TeamMember[] = rows.map((r) => ({
    sessionId: r.session_id,
    agentName: r.team_agent_name,
    role: r.team_agent_name ? "teammate" : "lead",
    firstEventAt: r.first_event_at,
    lastEventAt: r.last_event_at,
    llmCallCount: r.llm_call_count,
    subAgentCount: r.sub_agent_count,
  }));

  const events: TeamTimelineEvent[] = [];
  for (const r of rows) {
    const selfName = r.team_agent_name ?? LEAD_NAME;
    let lines: string[];
    try {
      lines = readFileSync(r.source_file, "utf-8").split("\n");
    } catch {
      continue; // 单成员转录读失败不拖垮整个 team 视图（成员列表仍有它）
    }
    let sawSpawn = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let rec: {
        type?: string;
        timestamp?: string;
        message?: { content?: unknown };
      };
      try { rec = JSON.parse(lines[i]) as typeof rec; } catch { continue; }
      const ts = rec.timestamp ?? "";

      // ── 发送侧：SendMessage tool_use ──
      if (rec.type === "assistant" && Array.isArray(rec.message?.content)) {
        for (const b of rec.message!.content as Array<{ type?: string; name?: string; input?: { to?: unknown; summary?: unknown; message?: unknown } }>) {
          if (b?.type !== "tool_use" || b.name !== "SendMessage") continue;
          const to = typeof b.input?.to === "string" ? b.input.to : undefined;
          const summary = typeof b.input?.summary === "string" ? b.input.summary : undefined;
          const m = b.input?.message;
          if (typeof m === "string") {
            events.push({
              kind: "message", from: selfName, ...(to ? { to } : {}), ...(summary ? { summary } : {}),
              textPreview: m.slice(0, PREVIEW), textLength: m.length,
              timestamp: ts, sessionId: r.session_id, lineIdx: i,
            });
          } else if (m !== null && typeof m === "object" && (m as { type?: string }).type === "shutdown_request") {
            const reason = (m as { reason?: string }).reason ?? "";
            events.push({
              kind: "shutdown_request", from: selfName, ...(to ? { to } : {}),
              textPreview: reason.slice(0, PREVIEW), textLength: reason.length,
              timestamp: ts, sessionId: r.session_id, lineIdx: i,
            });
          }
        }
        continue;
      }

      if (rec.type !== "user") continue;
      const c = rec.message?.content;
      const text = typeof c === "string" ? c : "";
      if (!text) continue;
      const trimmed = text.trimStart();
      const isInbound = trimmed.startsWith("<teammate-message")
        || trimmed.startsWith("Another Claude session sent a message");
      if (!isInbound) continue;

      // ── spawn：teammate 转录的首条入站行 = 逐字 spawn prompt ──
      if (!sawSpawn && r.team_agent_name) {
        sawSpawn = true;
        const body = extractTeammateMessageBody(trimmed);
        events.push({
          kind: "spawn", from: parseSender(trimmed) ?? LEAD_NAME, to: r.team_agent_name,
          textPreview: body.slice(0, PREVIEW), textLength: body.length,
          timestamp: ts, sessionId: r.session_id, lineIdx: i,
        });
        continue;
      }

      // ── 接收侧结构化系统事件（idle / terminated / shutdown_approved）——
      //    普通文本消息的接收行是发送侧的冗余投递，跳过。 ──
      const body = extractTeammateMessageBody(trimmed);
      if (!body.startsWith("{")) continue;
      let obj: { type?: string; from?: string; timestamp?: string; summary?: string; message?: string };
      try { obj = JSON.parse(body) as typeof obj; } catch { continue; }
      if (obj.type === "idle_notification") {
        events.push({
          kind: "idle", from: obj.from ?? parseSender(trimmed) ?? "?",
          ...(obj.summary ? { summary: obj.summary } : {}),
          textPreview: (obj.summary ?? "").slice(0, PREVIEW), textLength: (obj.summary ?? "").length,
          timestamp: obj.timestamp ?? ts, sessionId: r.session_id, lineIdx: i,
        });
      } else if (obj.type === "teammate_terminated") {
        events.push({
          kind: "terminated", from: parseSender(trimmed) ?? "?",
          textPreview: (obj.message ?? "").slice(0, PREVIEW), textLength: (obj.message ?? "").length,
          timestamp: ts, sessionId: r.session_id, lineIdx: i,
        });
      } else if (obj.type === "shutdown_approved") {
        events.push({
          kind: "shutdown", from: obj.from ?? parseSender(trimmed) ?? "?",
          textPreview: body.slice(0, PREVIEW), textLength: body.length,
          timestamp: obj.timestamp ?? ts, sessionId: r.session_id, lineIdx: i,
        });
      }
    }
  }

  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { teamName, members, events };
}

function parseSender(text: string): string | null {
  return /<teammate-message[^>]*\bteammate_id="([^"]+)"/.exec(text)?.[1] ?? null;
}

/** <teammate-message …>body</teammate-message> 的 body；无闭合 tag 时取开 tag 之后全部。 */
function extractTeammateMessageBody(text: string): string {
  const open = text.indexOf(">", text.indexOf("<teammate-message"));
  if (open === -1) return text;
  const close = text.lastIndexOf("</teammate-message>");
  return (close > open ? text.slice(open + 1, close) : text.slice(open + 1)).trim();
}
