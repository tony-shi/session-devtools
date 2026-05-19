#!/usr/bin/env bun
/**
 * 找 JSONL 中的"队列消息"（queue-operation）并按项目内 turn 边界归位。
 *
 * 项目内 turn 定义（与 server/src/session-drilldown-parser.ts:521-574 一致）：
 *   - turn 开启：遇到 isHumanInput 的 user 事件（非 meta / 非 sidechain / 非纯
 *     tool_result / 非 <command-*> 注入）
 *   - turn 关闭：遇到 assistant 且 stop_reason !== "tool_use"
 *   - 中途再次出现的 human-input user 事件不切 turn，记为 midTurnInjection
 *
 * 因此 queue.enqueue 一定落在某个仍在执行（LLM 还在 tool_use 循环里）的 turn 内；
 * dequeue 既可能发生在 turn 关闭前（出队即变 midTurnInjection），也可能发生在
 * turn 关闭之后（出队成为下一 turn 的起手 user 提示）。
 *
 * 用法:
 *   bun scripts/find-queue-messages.ts                  # 扫描所有项目
 *   bun scripts/find-queue-messages.ts <sessionId> ...  # 限定 session
 *   bun scripts/find-queue-messages.ts --json
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface RawEvent {
  type?: string;
  operation?: string;
  content?: string;
  promptId?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: unknown;
    stop_reason?: string | null;
  };
}

interface Turn {
  index: number;                    // 1-based
  startEventIdx: number;
  endEventIdx: number | null;       // null = 还未关闭
  startTs: string;
  endTs: string | null;
  userPromptPreview: string | null;
  callCount: number;                // turn 内 assistant 消息数（去重前的近似）
  lastStopReason: string | null;    // 关闭 turn 时那次 assistant 的 stop_reason
  midTurnInjections: { idx: number; ts: string; preview: string | null }[];
}

interface QueueEntry {
  sessionId: string;
  jsonlFile: string;
  enqueueTs: string;
  content: string;
  /** enqueue 时正在执行的 turn 序号 */
  duringTurnIndex: number | null;
  duringTurnPrompt: string | null;
  duringTurnCallsSoFar: number;     // enqueue 时该 turn 已发出的 assistant 消息数
  /** 出队/取消时刻信息 */
  fate: "dequeued" | "removed" | "popAll" | "unconsumed";
  fateTs: string | null;
  /** dequeue 时所在的 turn：若 == 入队 turn → 队列被 mid-turn 消费（midTurnInjection）；
   *  若 > 入队 turn → turn 关闭后再启新 turn 消费 */
  dequeueTurnIndex: number | null;
  dequeueTurnPrompt: string | null;
  consumedAsMidTurn: boolean;       // dequeueTurnIndex === duringTurnIndex
  queuedForMs: number;
}

function parseJsonl(file: string): RawEvent[] {
  const out: RawEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); }
    catch { /* skip */ }
  }
  return out;
}

function previewOf(content: unknown): string | null {
  if (typeof content === "string") return content.slice(0, 120).replace(/\s+/g, " ").trim();
  if (Array.isArray(content)) {
    const first = content[0] as { text?: string; type?: string } | undefined;
    if (first?.text) return first.text.slice(0, 120).replace(/\s+/g, " ").trim();
    if (first?.type) return `[${first.type}]`;
  }
  return null;
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return (content as Array<{ type?: string }>).every((b) => b?.type === "tool_result");
}

function isCommandContent(content: unknown): boolean {
  let s = "";
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    const first = content[0] as { text?: string } | undefined;
    s = first?.text ?? "";
  }
  const t = s.trimStart();
  return t.startsWith("<command-name>") || t.startsWith("<command-") || t.startsWith("<local-command-");
}

function isHumanInput(ev: RawEvent): boolean {
  if (ev.type !== "user") return false;
  if (ev.isMeta || ev.isSidechain) return false;
  const c = ev.message?.content;
  if (isToolResultOnly(c)) return false;
  if (isCommandContent(c)) return false;
  return true;
}

/** 严格按项目 parser 的算法切分 turn，仅保留事件级时间窗口与若干元数据 */
function segmentTurns(events: RawEvent[]): Turn[] {
  const turns: Turn[] = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (!isHumanInput(ev)) { i++; continue; }

    const t: Turn = {
      index: turns.length + 1,
      startEventIdx: i,
      endEventIdx: null,
      startTs: ev.timestamp ?? "",
      endTs: null,
      userPromptPreview: previewOf(ev.message?.content),
      callCount: 0,
      lastStopReason: null,
      midTurnInjections: [],
    };

    let j = i + 1;
    for (; j < events.length; j++) {
      const jev = events[j];
      if (jev.type === "user" && isHumanInput(jev)) {
        t.midTurnInjections.push({
          idx: j,
          ts: jev.timestamp ?? "",
          preview: previewOf(jev.message?.content),
        });
      } else if (jev.type === "assistant" && !jev.isSidechain) {
        t.callCount += 1;
        const sr = jev.message?.stop_reason ?? "";
        if (sr && sr !== "tool_use") {
          t.lastStopReason = sr;
          t.endEventIdx = j;
          t.endTs = jev.timestamp ?? "";
          break;
        }
      }
    }
    if (t.endEventIdx === null) {
      // 未正常关闭：把最后一个事件 ts 当 endTs（兜底）
      const last = events[events.length - 1];
      t.endTs = last?.timestamp ?? t.startTs;
      t.endEventIdx = events.length - 1;
    }
    turns.push(t);
    i = (t.endEventIdx ?? i) + 1;
  }
  return turns;
}

function turnAtTs(turns: Turn[], ts: string): Turn | null {
  for (const t of turns) {
    if (ts >= t.startTs && (t.endTs ? ts <= t.endTs : true)) return t;
  }
  return null;
}

function callsBeforeTs(turn: Turn, events: RawEvent[], ts: string): number {
  let n = 0;
  for (let k = turn.startEventIdx + 1; k <= (turn.endEventIdx ?? events.length - 1); k++) {
    const e = events[k];
    if (e.type === "assistant" && !e.isSidechain) {
      if ((e.timestamp ?? "") <= ts) n++;
      else break;
    }
  }
  return n;
}

function analyzeFile(file: string): QueueEntry[] {
  const events = parseJsonl(file);
  if (events.length === 0) return [];
  const turns = segmentTurns(events);

  const qevents = events
    .filter((e) => e.type === "queue-operation")
    .sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));

  const pending: QueueEntry[] = [];
  const out: QueueEntry[] = [];

  for (const ev of qevents) {
    const ts = ev.timestamp ?? "";
    const sid = ev.sessionId ?? "";
    if (ev.operation === "enqueue") {
      const during = turnAtTs(turns, ts);
      pending.push({
        sessionId: sid,
        jsonlFile: file,
        enqueueTs: ts,
        content: (ev.content ?? "").trim(),
        duringTurnIndex: during?.index ?? null,
        duringTurnPrompt: during?.userPromptPreview ?? null,
        duringTurnCallsSoFar: during ? callsBeforeTs(during, events, ts) : 0,
        fate: "unconsumed",
        fateTs: null,
        dequeueTurnIndex: null,
        dequeueTurnPrompt: null,
        consumedAsMidTurn: false,
        queuedForMs: 0,
      });
    } else if (ev.operation === "dequeue") {
      const first = pending.shift();
      if (first) {
        first.fate = "dequeued";
        first.fateTs = ts;
        first.queuedForMs = new Date(ts).getTime() - new Date(first.enqueueTs).getTime();
        // 先看 ts 是否落在某个 turn 内（mid-turn 消费）
        let dq = turnAtTs(turns, ts);
        // 否则找下一个 startTs >= ts 的 turn（next-turn 消费）
        if (!dq) {
          let best: Turn | null = null;
          for (const t of turns) {
            if (t.startTs >= ts && (!best || t.startTs < best.startTs)) best = t;
          }
          dq = best;
        }
        if (dq) {
          first.dequeueTurnIndex = dq.index;
          first.dequeueTurnPrompt = dq.userPromptPreview;
          first.consumedAsMidTurn = first.duringTurnIndex !== null && dq.index === first.duringTurnIndex;
        }
        out.push(first);
      }
    } else if (ev.operation === "remove") {
      const first = pending.shift();
      if (first) {
        first.fate = "removed";
        first.fateTs = ts;
        first.queuedForMs = new Date(ts).getTime() - new Date(first.enqueueTs).getTime();
        out.push(first);
      }
    } else if (ev.operation === "popAll") {
      while (pending.length > 0) {
        const p = pending.shift()!;
        p.fate = "popAll";
        p.fateTs = ts;
        p.queuedForMs = new Date(ts).getTime() - new Date(p.enqueueTs).getTime();
        out.push(p);
      }
    }
  }
  for (const p of pending) out.push(p);
  return out;
}

function listJsonlFiles(filter?: Set<string>): string[] {
  const root = join(homedir(), ".claude", "projects");
  const out: string[] = [];
  let projects: string[] = [];
  try { projects = readdirSync(root); } catch { return out; }
  for (const p of projects) {
    const dir = join(root, p);
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      if (filter && filter.size > 0) {
        const sid = f.replace(/\.jsonl$/, "");
        if (!filter.has(sid)) continue;
      }
      const full = join(dir, f);
      try { if (statSync(full).isFile()) out.push(full); } catch { /* */ }
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const sessionIds = new Set(argv.filter((a) => !a.startsWith("--")));
  const files = listJsonlFiles(sessionIds);

  const all: QueueEntry[] = [];
  for (const f of files) all.push(...analyzeFile(f));

  if (asJson) {
    process.stdout.write(JSON.stringify(all, null, 2) + "\n");
    return;
  }

  const total = all.length;
  const fateCount: Record<string, number> = {};
  let midTurnConsumed = 0;
  let nextTurnConsumed = 0;
  for (const e of all) {
    fateCount[e.fate] = (fateCount[e.fate] ?? 0) + 1;
    if (e.fate === "dequeued") {
      if (e.consumedAsMidTurn) midTurnConsumed++; else nextTurnConsumed++;
    }
  }

  process.stdout.write(
    `扫描 ${files.length} 个 JSONL，发现 ${total} 条 enqueue\n` +
    `  dequeued ${fateCount.dequeued ?? 0}` +
    `（其中 mid-turn 消费 ${midTurnConsumed}，下一 turn 消费 ${nextTurnConsumed}）` +
    `  removed ${fateCount.removed ?? 0}` +
    `  popAll ${fateCount.popAll ?? 0}` +
    `  unconsumed ${fateCount.unconsumed ?? 0}\n\n`
  );

  const bySession = new Map<string, QueueEntry[]>();
  for (const e of all) {
    if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
    bySession.get(e.sessionId)!.push(e);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.enqueueTs.localeCompare(b.enqueueTs));
  }

  for (const [sid, list] of bySession) {
    process.stdout.write(`# session ${sid}  (${list.length} 条)\n`);
    process.stdout.write(`  file: ${list[0]!.jsonlFile}\n`);
    for (const e of list) {
      const held = (e.queuedForMs / 1000).toFixed(1) + "s";
      const dq = e.fate === "dequeued"
        ? `${e.consumedAsMidTurn ? "mid-turn" : "next-turn"}@T${e.dequeueTurnIndex ?? "-"}`
        : e.fate;
      process.stdout.write(
        `  · [${e.enqueueTs}] enqueue@T${e.duringTurnIndex ?? "-"}` +
        ` (${e.duringTurnCallsSoFar} calls in so far)  held=${held}  ${dq}\n`
      );
      process.stdout.write(`      during turn: ${e.duringTurnPrompt ?? "-"}\n`);
      process.stdout.write(`      content    : ${e.content.slice(0, 160).replace(/\n/g, " ⏎ ")}\n`);
      if (e.fate === "dequeued") {
        process.stdout.write(`      consumed by turn T${e.dequeueTurnIndex}: ${e.dequeueTurnPrompt ?? "-"}\n`);
      }
    }
    process.stdout.write("\n");
  }
}

main();
