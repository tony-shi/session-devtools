#!/usr/bin/env bun
/**
 * 扫描 ~/.claude/projects 下的 JSONL 会话日志，找出"插话"案例。
 *
 *   定义：turn T 仍在执行（assistant 在 T 内发出过 tool_use，但其中至少一个
 *         tool_use_id 没被同 turn 内的 tool_result 回收）；
 *         紧接着的下一条真实用户输入（不同 promptId、非 meta、非 local-command）
 *         即视为对 T 的插话。
 *
 * 用法:
 *   bun scripts/find-interjections.ts                 # 扫描所有项目
 *   bun scripts/find-interjections.ts <sessionId> ... # 只看指定 session
 *   bun scripts/find-interjections.ts --json          # 输出 JSON
 *   bun scripts/find-interjections.ts --verbose       # 打印 turn 级 debug
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface RawEvent {
  type?: string;
  promptId?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    content?: unknown;
    stop_reason?: string | null;
  };
}

interface TurnSummary {
  sessionId: string;
  promptId: string;
  startTs: string;
  endTs: string;
  userPromptPreview: string | null;
  startedByRealUser: boolean;
  /** 该 turn 内 assistant 发出的所有 tool_use_id */
  emittedToolUseIds: string[];
  /** 没被同 turn 内 tool_result 回收的 tool_use_id */
  pendingToolUseIds: string[];
  assistantMessageCount: number;
  lastStopReason: string | null;
}

interface Interjection {
  sessionId: string;
  jsonlFile: string;
  interruptedTurnIndex: number;
  interruptedPromptId: string;
  interruptedPreview: string | null;
  interruptedStartTs: string;
  interruptedEndTs: string;
  interruptedLastStopReason: string | null;
  pendingToolUseIds: string[];
  interjectionTurnIndex: number;
  interjectionPromptId: string;
  interjectionPreview: string | null;
  interjectionTs: string;
  gapMs: number;
}

function parseJsonl(file: string): RawEvent[] {
  const out: RawEvent[] = [];
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); }
    catch { /* skip */ }
  }
  return out;
}

function previewOf(content: unknown): string | null {
  if (typeof content === "string") {
    return content.slice(0, 100).replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(content)) {
    const first = content[0] as { text?: string; type?: string } | undefined;
    if (first?.text) return first.text.slice(0, 100).replace(/\s+/g, " ").trim();
    if (first?.type) return `[${first.type}]`;
  }
  return null;
}

function looksLikeRealUserPrompt(ev: RawEvent): boolean {
  if (ev.type !== "user") return false;
  if (ev.isMeta) return false;
  const c = ev.message?.content;
  if (typeof c !== "string") return false;
  const trimmed = c.trimStart();
  if (trimmed.startsWith("<command-") || trimmed.startsWith("<local-command-")) return false;
  return true;
}

function collectToolUseIdsFromAssistant(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: string }).type === "tool_use") {
      const id = (b as { id?: string }).id;
      if (id) ids.push(id);
    }
  }
  return ids;
}

function collectToolResultIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: string }).type === "tool_result") {
      const id = (b as { tool_use_id?: string }).tool_use_id;
      if (id) ids.push(id);
    }
  }
  return ids;
}

function summarizeTurns(events: RawEvent[]): TurnSummary[] {
  // 第一遍：建立 uuid → promptId（assistant 行 promptId 为 null，靠 parentUuid 回溯到带 promptId 的 user 行）
  const promptIdByUuid = new Map<string, string>();
  const parentByUuid = new Map<string, string | null>();
  for (const ev of events) {
    if (!ev.uuid) continue;
    parentByUuid.set(ev.uuid, ev.parentUuid ?? null);
    if (ev.promptId) promptIdByUuid.set(ev.uuid, ev.promptId);
  }
  const resolvePromptId = (ev: RawEvent): string | undefined => {
    if (ev.promptId) return ev.promptId;
    let cur: string | null | undefined = ev.parentUuid;
    let hops = 0;
    while (cur && hops < 64) {
      const p = promptIdByUuid.get(cur);
      if (p) return p;
      cur = parentByUuid.get(cur);
      hops++;
    }
    return undefined;
  };

  const order: string[] = [];
  type Mut = TurnSummary & { emittedSet: Set<string>; resolvedSet: Set<string> };
  const map = new Map<string, Mut>();

  for (const ev of events) {
    const pid = resolvePromptId(ev);
    if (!pid) continue;
    if (!map.has(pid)) {
      order.push(pid);
      map.set(pid, {
        sessionId: ev.sessionId ?? "",
        promptId: pid,
        startTs: ev.timestamp ?? "",
        endTs: ev.timestamp ?? "",
        userPromptPreview: null,
        startedByRealUser: false,
        emittedToolUseIds: [],
        pendingToolUseIds: [],
        assistantMessageCount: 0,
        lastStopReason: null,
        emittedSet: new Set(),
        resolvedSet: new Set(),
      });
    }
    const t = map.get(pid)!;
    if (ev.timestamp) {
      if (!t.startTs || ev.timestamp < t.startTs) t.startTs = ev.timestamp;
      if (ev.timestamp > t.endTs) t.endTs = ev.timestamp;
    }
    if (ev.type === "user") {
      if (looksLikeRealUserPrompt(ev) && t.userPromptPreview === null) {
        t.userPromptPreview = previewOf(ev.message?.content);
        t.startedByRealUser = true;
      }
      for (const id of collectToolResultIds(ev.message?.content)) t.resolvedSet.add(id);
    } else if (ev.type === "assistant") {
      t.assistantMessageCount += 1;
      const sr = ev.message?.stop_reason;
      if (sr) t.lastStopReason = sr;
      for (const id of collectToolUseIdsFromAssistant(ev.message?.content)) t.emittedSet.add(id);
    }
  }

  return order.map((pid) => {
    const t = map.get(pid)!;
    const emitted = [...t.emittedSet];
    const pending = emitted.filter((id) => !t.resolvedSet.has(id));
    return {
      sessionId: t.sessionId,
      promptId: t.promptId,
      startTs: t.startTs,
      endTs: t.endTs,
      userPromptPreview: t.userPromptPreview,
      startedByRealUser: t.startedByRealUser,
      emittedToolUseIds: emitted,
      pendingToolUseIds: pending,
      assistantMessageCount: t.assistantMessageCount,
      lastStopReason: t.lastStopReason,
    };
  });
}

function findInterjections(turns: TurnSummary[], jsonlFile: string): Interjection[] {
  const real = turns.filter((t) => t.startedByRealUser);
  const out: Interjection[] = [];
  for (let i = 0; i < real.length - 1; i++) {
    const cur = real[i];
    const next = real[i + 1];
    // 触发条件：cur 中至少有一个 tool_use 没等到 tool_result
    if (cur.pendingToolUseIds.length === 0) continue;
    const ta = new Date(cur.endTs).getTime();
    const tb = new Date(next.startTs).getTime();
    out.push({
      sessionId: cur.sessionId,
      jsonlFile,
      interruptedTurnIndex: i + 1,
      interruptedPromptId: cur.promptId,
      interruptedPreview: cur.userPromptPreview,
      interruptedStartTs: cur.startTs,
      interruptedEndTs: cur.endTs,
      interruptedLastStopReason: cur.lastStopReason,
      pendingToolUseIds: cur.pendingToolUseIds,
      interjectionTurnIndex: i + 2,
      interjectionPromptId: next.promptId,
      interjectionPreview: next.userPromptPreview,
      interjectionTs: next.startTs,
      gapMs: Number.isFinite(ta) && Number.isFinite(tb) ? tb - ta : 0,
    });
  }
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
      try { if (statSync(full).isFile()) out.push(full); } catch { /* skip */ }
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const verbose = argv.includes("--verbose");
  const sessionIds = new Set(argv.filter((a) => !a.startsWith("--")));
  const files = listJsonlFiles(sessionIds);

  const all: Interjection[] = [];
  for (const f of files) {
    const events = parseJsonl(f);
    if (events.length === 0) continue;
    const turns = summarizeTurns(events);
    if (verbose) {
      process.stdout.write(`# ${f}\n`);
      for (const t of turns) {
        if (!t.startedByRealUser) continue;
        process.stdout.write(
          `  ${t.startTs} promptId=${t.promptId.slice(0, 8)} ` +
          `asst=${t.assistantMessageCount} stop=${t.lastStopReason ?? "-"} ` +
          `emitted=${t.emittedToolUseIds.length} pending=${t.pendingToolUseIds.length}\n`
        );
      }
    }
    const interjections = findInterjections(turns, f);
    all.push(...interjections);
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(all, null, 2) + "\n");
    return;
  }

  if (all.length === 0) {
    process.stdout.write(`扫描了 ${files.length} 个 JSONL 文件，未找到插话案例。\n`);
    return;
  }

  const bySession = new Map<string, Interjection[]>();
  for (const it of all) {
    if (!bySession.has(it.sessionId)) bySession.set(it.sessionId, []);
    bySession.get(it.sessionId)!.push(it);
  }

  process.stdout.write(`扫描 ${files.length} 个 JSONL，发现 ${all.length} 次插话，分布在 ${bySession.size} 个 session：\n\n`);
  for (const [sid, list] of bySession) {
    process.stdout.write(`# session ${sid}  (${list.length} 次)\n`);
    process.stdout.write(`  file: ${list[0]!.jsonlFile}\n`);
    for (const it of list) {
      process.stdout.write(
        `  · T${it.interruptedTurnIndex} → T${it.interjectionTurnIndex}` +
        `   pending=${it.pendingToolUseIds.length}` +
        `   stop=${it.interruptedLastStopReason ?? "-"}` +
        `   gap=${(it.gapMs / 1000).toFixed(1)}s\n`
      );
      process.stdout.write(`      T${it.interruptedTurnIndex} [${it.interruptedStartTs}] ${it.interruptedPreview ?? "(no preview)"}\n`);
      process.stdout.write(`      T${it.interjectionTurnIndex} [${it.interjectionTs}] ${it.interjectionPreview ?? "(no preview)"}\n`);
    }
    process.stdout.write("\n");
  }
}

main();
