import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import type { Database } from "better-sqlite3";
import type { SessionDrilldown, UserTurn, LlmCall, ProxyCallData, ModelStats, SubAgentSummary, InterTurnBlock, IntervalEvent, CompactEvent, EventBelonging } from "./session-drilldown-types.ts";
import { normaliseModelName } from "./model-info.ts";
import { matchCompactCallsForSession, type CompactBoundaryEvidence } from "./compact-proxy-matcher.ts";

// ─── JSONL record shapes (loose, best-effort) ────────────────────────────────

interface JUserEvent {
  type: "user";
  isMeta?: boolean;
  isSidechain?: boolean;
  // compact 后 CLI 注入的 summary user 事件标记。它不是用户真实输入 ——
  // 已由 CompactEvent（压缩 N）完整承载，不应被当成 turn opener。
  isCompactSummary?: boolean;
  message?: { content?: unknown };
  timestamp?: string;
  ts?: string;
  cwd?: string;
  // cli.js SkillTool 通过 tagMessagesWithToolUseID 把 skill 调用产出的所有
  // user / attachment 行外层挂 sourceToolUseID === 触发的 Skill tool_use id。
  // 我们用它聚合"这次 Skill 注入了哪些行 / 多少字节"。
  sourceToolUseID?: string;
}

interface JAssistantEvent {
  type: "assistant";
  isSidechain?: boolean;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    stop_reason?: string;
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
      [key: string]: unknown;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      // Split of cache_creation_input_tokens by server cache TTL. Present on
      // recent Claude Code versions; absent on older logs.
      cache_creation?: {
        ephemeral_1h_input_tokens?: number;
        ephemeral_5m_input_tokens?: number;
      };
    };
  };
  timestamp?: string;
  ts?: string;
}

interface JSystemEvent {
  type: "system";
  subtype?: string;
  durationMs?: number;
  timestamp?: string;
  ts?: string;
}

type JEvent = JUserEvent | JAssistantEvent | JSystemEvent | { type: string; [k: string]: unknown };

type AssistantContentBlock = NonNullable<NonNullable<JAssistantEvent["message"]>["content"]>[number];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.length > 0 && (content as Array<{ type?: string }>).every(b => b?.type === "tool_result");
}

function isCommandContent(content: unknown): boolean {
  const text = typeof content === "string" ? content : extractUserText(content);
  const trimmed = text.trimStart();
  return trimmed.startsWith("<command-name>")
    || trimmed.startsWith("<local-command-caveat>")
    || trimmed.startsWith("<local-command-stdout>")
    || trimmed.startsWith("<local-command-stderr>")
    || trimmed.startsWith("<bash-input>")
    || trimmed.startsWith("<bash-stdout>")
    || trimmed.startsWith("<bash-stderr>");
}

function isHumanInput(ev: JUserEvent): boolean {
  if (ev.isMeta || ev.isSidechain) return false;
  // compact summary 是 CLI 注入的合成 user 事件（post-compact 上下文），不是
  // 用户真实输入。不排除它会让它错误地开启一个新 turn —— 把 summary 当成 turn
  // 的 userInput，把真实输入降级成 mid-turn，还让 turn 误带 compaction 标。
  // 它已由 CompactEvent（压缩 N）承载，这里直接跳过。
  if (ev.isCompactSummary) return false;
  const content = ev.message?.content;
  if (isToolResultOnly(content)) return false;
  if (isCommandContent(content)) return false;
  return true;
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter(b => b?.type !== "thinking" && b?.type !== "redacted_thinking" && b?.type !== "tool_result")
    .map(b => {
      if (typeof b === "string") return b;
      if (b?.type === "text") return (b.text ?? "");
      return "";
    })
    .join(" ")
    .trim();
}

function tsOf(ev: JEvent): string {
  const ts = ("timestamp" in ev ? (ev as { timestamp?: string }).timestamp : undefined)
    ?? ("ts" in ev ? (ev as { ts?: string }).ts : undefined);
  return ts ?? "";
}

function assistantUsageTotal(ev: JAssistantEvent): number {
  const u = ev.message?.usage ?? {};
  return (u.input_tokens ?? 0)
    + (u.cache_read_input_tokens ?? 0)
    + (u.cache_creation_input_tokens ?? 0)
    + (u.output_tokens ?? 0);
}

function pickCanonicalAssistantFrame(
  frames: Array<{ ev: JAssistantEvent; lineIdx: number }>,
): { ev: JAssistantEvent; lineIdx: number } {
  const withUsage = [...frames].reverse().find(({ ev }) => assistantUsageTotal(ev) > 0);
  if (withUsage) return withUsage;
  return frames[frames.length - 1];
}

function cloneAssistantBlock(block: AssistantContentBlock): AssistantContentBlock {
  return { ...block };
}

function mergeAssistantContentBlocks(
  frames: Array<{ ev: JAssistantEvent; lineIdx: number }>,
): AssistantContentBlock[] {
  const merged: AssistantContentBlock[] = [];
  const toolUseIndex = new Map<string, number>();
  const seenText = new Set<string>();
  const seenOther = new Set<string>();

  for (const { ev } of frames) {
    for (const block of ev.message?.content ?? []) {
      if (block.type === "text") {
        const text = block.text ?? "";
        if (!text.trim() || seenText.has(text)) continue;
        seenText.add(text);
        merged.push(cloneAssistantBlock(block));
        continue;
      }

      if (block.type === "tool_use" && block.id) {
        const existingIdx = toolUseIndex.get(block.id);
        if (existingIdx !== undefined) {
          // Later streaming frames may carry a more complete input object.
          merged[existingIdx] = cloneAssistantBlock(block);
        } else {
          toolUseIndex.set(block.id, merged.length);
          merged.push(cloneAssistantBlock(block));
        }
        continue;
      }

      const key = `${block.type ?? "unknown"}:${JSON.stringify(block)}`;
      if (seenOther.has(key)) continue;
      seenOther.add(key);
      merged.push(cloneAssistantBlock(block));
    }
  }

  return merged;
}

interface LogicalAssistantCall {
  ev: JAssistantEvent;
  lineIdx: number;
  firstLineIdx: number;
  frameLineIdxs: number[];
  messageId: string | null;
  apiRequestId: string | null;
}

function mergeAssistantFrames(
  frames: Array<{ ev: JAssistantEvent; lineIdx: number }>,
): LogicalAssistantCall {
  const canonical = pickCanonicalAssistantFrame(frames);
  const base = canonical.ev as JAssistantEvent & Record<string, unknown>;
  const merged: JAssistantEvent = {
    ...base,
    message: {
      ...(canonical.ev.message ?? {}),
      content: mergeAssistantContentBlocks(frames),
    },
  };

  // requestId can vary across frames; prefer the canonical frame's, fall back
  // to the first frame that has one.
  const apiRequestId =
    canonical.ev.requestId
    ?? frames.find((f) => typeof f.ev.requestId === "string" && f.ev.requestId)?.ev.requestId
    ?? null;

  return {
    ev: merged,
    lineIdx: canonical.lineIdx,
    firstLineIdx: frames[0]?.lineIdx ?? canonical.lineIdx,
    frameLineIdxs: frames.map(({ lineIdx }) => lineIdx),
    messageId: canonical.ev.message?.id ?? null,
    apiRequestId,
  };
}

function makeIntervalEvent(iev: JEvent, lineIdx: number): IntervalEvent {
  const ts  = tsOf(iev);
  const raw = JSON.stringify(iev);
  let kind: IntervalEvent["kind"] = "unknown";
  let preview = "";
  let size = raw.length;

  if (iev.type === "user") {
    const uev = iev as JUserEvent;
    const content = uev.message?.content;
    if (isToolResultOnly(content)) {
      kind = "user:tool_result";
      const blocks = content as Array<{ type?: string; content?: unknown }>;
      for (const b of blocks) {
        if (b.type === "tool_result") {
          const rc = b.content;
          const text = typeof rc === "string" ? rc
            : Array.isArray(rc) ? rc.map((c: { text?: string }) => c?.text ?? "").join("") : "";
          preview = text.slice(0, 300);
          size = text.length;
          break;
        }
      }
    } else if (isCommandContent(content)) {
      kind = "user:command";
      preview = (typeof content === "string" ? content : extractUserText(content)).slice(0, 300);
    } else if (uev.isMeta && typeof uev.sourceToolUseID === "string") {
      // Skill 工具 tagMessagesWithToolUseID 路径产物 —— 确定性识别（cli.js
      // SkillTool.ts:735 显式写入 sourceToolUseID）。
      // 注意：这里只识别 user-type 行；attachment 行无 sourceToolUseID（见
      // claude-code source: tagMessagesWithToolUseID 跳过 attachment），所以
      // command_permissions 等仍保持 unknown / attachment 分类。
      kind = "user:skill_injection";
      preview = (typeof content === "string" ? content : extractUserText(content)).slice(0, 300);
    } else {
      kind = "user:human";
      preview = (typeof content === "string" ? content : extractUserText(content)).slice(0, 300);
    }
  } else if (iev.type === "system") {
    const sub = (iev as JSystemEvent).subtype ?? "";
    if (sub === "api_error") {
      kind = "system:api_error";
      preview = JSON.stringify((iev as { error?: unknown }).error ?? {}).slice(0, 300);
    } else if (sub === "local_command") {
      kind = "system:local_command";
      preview = ((iev as { content?: string }).content ?? "").slice(0, 300);
    } else if (sub === "turn_duration") {
      kind = "system:turn_duration";
      // Format duration into a human-readable string + include messageCount
      // (raw `durationMs: 47430` was technically accurate but unreadable at a
      // glance). Falls through to `0ms` if both fields are absent.
      const ms = (iev as { durationMs?: number }).durationMs ?? 0;
      const msgCount = (iev as { messageCount?: number }).messageCount;
      let durStr: string;
      if (ms >= 60_000) {
        const min = Math.floor(ms / 60_000);
        const sec = Math.round((ms % 60_000) / 1000);
        durStr = `${min}m ${sec}s`;
      } else if (ms >= 1000) {
        durStr = `${(ms / 1000).toFixed(1)}s`;
      } else {
        durStr = `${ms}ms`;
      }
      preview = msgCount !== undefined
        ? `Duration: ${durStr} · Messages: ${msgCount}`
        : `Duration: ${durStr}`;
    } else if (sub === "stop_hook_summary") {
      kind = "system:stop_hook_summary";
      preview = JSON.stringify((iev as { hookInfos?: unknown }).hookInfos ?? {}).slice(0, 300);
    } else if (sub === "away_summary") {
      kind = "system:away_summary";
      preview = ((iev as { content?: string }).content ?? "").slice(0, 300);
    } else {
      kind = "unknown";
      preview = raw.slice(0, 300);
    }
  } else if (iev.type === "attachment") {
    const att = (iev as { attachment?: { type?: string; content?: unknown; itemCount?: number } }).attachment ?? {};
    const attType = att.type ?? "";
    if (attType === "skill_listing") { kind = "attachment:skill_listing"; preview = String(att.content ?? "").slice(0, 300); }
    else if (attType === "task_reminder") {
      kind = "attachment:task_reminder";
      // Render the actual task list as a checklist string so the row's
      // CONTENT segment is useful at a glance. Older behavior dropped to
      // just `itemCount: N`, which hid every task entirely. Falls back to
      // a count summary when `content` isn't a parsable list (defensive
      // against schema drift in upstream JSONL).
      const tasks = Array.isArray((att as { content?: unknown }).content)
        ? (att as { content: unknown[] }).content
        : null;
      if (!tasks || tasks.length === 0) {
        preview = `(empty task list, itemCount: ${(att as { itemCount?: number }).itemCount ?? 0})`;
      } else {
        const lines = tasks
          .filter((t): t is { status?: unknown; subject?: unknown } => Boolean(t) && typeof t === "object")
          .map((t) => {
            const status = typeof t.status === "string" ? t.status : "pending";
            const subject = typeof t.subject === "string" ? t.subject : "(no subject)";
            // Markdown-style checkbox: [ ] pending, [x] completed, [>] in_progress.
            // Aligned to render correctly under EventUnitCard's monospace `<pre>`.
            const mark = status === "completed" ? "[x]"
                       : status === "in_progress" ? "[>]"
                       : "[ ]";
            return `${mark} ${subject}`;
          });
        preview = lines.join("\n").slice(0, 1500);
      }
    }
    else if (attType === "queued_command") {
      // attachment.prompt 是用户排队的消息文本（可能为 string 或 text-block array）
      const att2 = att as { prompt?: unknown };
      const promptText = typeof att2.prompt === "string"
        ? att2.prompt
        : Array.isArray(att2.prompt)
          ? (att2.prompt as Array<{ text?: string }>).map(b => b?.text ?? "").join("\n")
          : "";
      kind = "attachment:queued_command";
      preview = promptText.slice(0, 300);
    }
    else if (attType === "edited_text_file") {
      const att2 = att as { filename?: string; snippet?: string };
      kind = "attachment:edited_text_file";
      // Two-line layout: filename header + snippet body. Easier to scan than
      // a single em-dashed joined line, and lets the snippet take a longer
      // truncation budget (~800 chars) so the surrounding context is visible
      // — the snippet already carries leading line numbers from the harness.
      const fname = att2.filename ?? "(unknown file)";
      const snippet = (att2.snippet ?? "").slice(0, 800);
      preview = snippet ? `${fname}\n──────\n${snippet}` : fname;
    }
    else if (attType === "file") { kind = "attachment:file"; preview = String(att.content ?? "").slice(0, 300); }
    else { kind = "unknown"; preview = raw.slice(0, 300); }
  } else if (iev.type === "file-history-snapshot") {
    kind = "file-history-snapshot";
    // Surface the snapshotted file paths so users can see *what* was
    // captured, not just the timestamp. trackedFileBackups is a record keyed
    // by absolute file path; iterate the keys and render them as a list.
    // Empty snapshots are a legitimate "initial baseline" event — call that
    // out explicitly rather than hiding it behind a bare timestamp.
    const snap = (iev as {
      snapshot?: { timestamp?: string; trackedFileBackups?: Record<string, unknown> };
      isSnapshotUpdate?: boolean;
    }).snapshot ?? {};
    const backups = snap.trackedFileBackups ?? {};
    const files = Object.keys(backups);
    const ts = snap.timestamp ?? "";
    const isUpdate = (iev as { isSnapshotUpdate?: boolean }).isSnapshotUpdate ?? false;
    const header = isUpdate ? "Snapshot update" : "Snapshot";
    if (files.length === 0) {
      preview = `${header} (empty / initial baseline) — ${ts}`;
    } else {
      const list = files.slice(0, 20).join("\n");
      const overflow = files.length > 20 ? `\n… +${files.length - 20} more` : "";
      preview = `${header} of ${files.length} file${files.length > 1 ? "s" : ""} — ${ts}\n${list}${overflow}`;
    }
  } else if (iev.type === "last-prompt") {
    kind = "last-prompt";
    preview = ((iev as { lastPrompt?: string }).lastPrompt ?? "").slice(0, 300);
  } else if (iev.type === "ai-title") {
    kind = "ai-title";
    preview = ((iev as { aiTitle?: string }).aiTitle ?? "").slice(0, 300);
  } else if (iev.type === "permission-mode" || iev.type === "mode") {
    // 工具权限 / 会话操作模式（normal·default / acceptEdits / bypassPermissions / plan）。
    // 两种 jsonl 形态同源、归为一类：
    //   旧 {type:"permission-mode", permissionMode}
    //   新 {type:"mode", mode, sessionId} —— cli.js 在 session 元数据 flush 时写
    //       （紧跟 agent-setting：jZ(sessionFile,{type:"mode",mode:currentSessionMode,sessionId})），
    //       基线模式记作 "normal"（旧形态记作 "default"）。
    // 两者都在 cli.js 的 METADATA_TYPE_MARKERS 里 —— session-scoped 元数据，**不进 LLM
    // context**（模型只见 system prompt 里一句通用权限说明，不含具体 mode 值）。当元数据行展示即可。
    kind = "permission-mode";
    preview = String(
      (iev as { mode?: unknown }).mode
      ?? (iev as { permissionMode?: unknown }).permissionMode
      ?? "",
    );
  } else if (iev.type === "custom-title") {
    // 用户 /rename 设置的标题（读取优先级高于 ai-title）。piK always，非 context。
    kind = "custom-title";
    preview = ((iev as { customTitle?: string }).customTitle ?? "").slice(0, 300);
  } else if (iev.type === "agent-name") {
    // sub-agent 会话的显示名。piK always，非 context。
    kind = "agent-name";
    preview = ((iev as { agentName?: string }).agentName ?? "").slice(0, 300);
  } else if (iev.type === "queue-operation") {
    // 用户在 LLM 执行时排队/出队消息的操作记录（enqueue/…）。piK always，非 context。
    kind = "queue-operation";
    preview = String((iev as { operation?: unknown }).operation ?? "");
  } else if (iev.type === "worktree-state") {
    // 会话的 git worktree 状态；worktreeSession 为 null 表示不在 worktree。piK always，非 context。
    {
      const ws = (iev as { worktreeSession?: { worktreeName?: string; worktreePath?: string } | null }).worktreeSession;
      kind = "worktree-state";
      preview = ws ? (ws.worktreeName ?? ws.worktreePath ?? "(worktree)") : "(not in worktree)";
    }
  } else {
    kind = "unknown";
    preview = raw.slice(0, 300);
  }

  // 透传 sourceToolUseID（jsonl 外层字段，cli.js 显式写入）。前端 hover 联动
  // + IntervalEventRow 特化渲染都用这个键。skillName 由 turn-level 解析器在
  // intervalEvents 构建完之后批量回填（同 turn 内 toolUseId → input.skill 反查）。
  const stuid = (iev as { sourceToolUseID?: unknown }).sourceToolUseID;
  return {
    kind,
    lineIdx,
    timestamp: ts,
    contentPreview: preview,
    contentSize: size,
    rawJson: raw,
    ...(typeof stuid === "string" ? { sourceToolUseID: stuid } : {}),
  };
}

// ─── Command grouping (purely visual) ────────────────────────────────────────
// 一次 local/slash 命令（/exit）或 bash（!ls）在 jsonl 里会落成多条连续 user 事件：
//   <local-command-caveat> 样板行 + <command-name>… 行 + <local-command-stdout> 行
// makeIntervalEvent 把它们全部归到 kind="user:command"（bash 同理）。本 helper 把
// 每段「极大连续 run」（kind 是 user:command / system:local_command）折叠成一个
// wrapper IntervalEvent，原始成员原样收进 commandGroup.members 供前端逐段归因。
//
// 重点：合并**纯视觉** —— 成员各自保留 lineIdx / kind / rawJson / contentSize，
// 前端按各自 lineIdx 查归因、各自跳转。run 长度 1 的不包 wrapper（原样返回）。
function groupCommandEvents(events: IntervalEvent[]): IntervalEvent[] {
  const isCmd = (e: IntervalEvent) =>
    e.kind === "user:command" || e.kind === "system:local_command";

  const out: IntervalEvent[] = [];
  let i = 0;
  while (i < events.length) {
    if (!isCmd(events[i])) {
      out.push(events[i]);
      i++;
      continue;
    }
    // Maximal run of consecutive command events.
    let j = i;
    while (j < events.length && isCmd(events[j])) j++;
    const run = events.slice(i, j);
    if (run.length < 2) {
      out.push(run[0]);
    } else {
      const anchor = run[0];
      const hasBash = run.some((m) =>
        m.rawJson.includes("<bash-input>") || m.contentPreview.includes("<bash-input>"),
      );
      // contentPreview = the command name. Prefer <command-name>…; else
      // !<bash-input>…; else the first non-caveat member's preview.
      let preview = "";
      for (const m of run) {
        const cmdMatch = m.contentPreview.match(/<command-name>([^<]+)<\/command-name>/);
        if (cmdMatch) { preview = cmdMatch[1].trim(); break; }
        const bashMatch = m.contentPreview.match(/<bash-input>([^<\n]{0,60})/);
        if (bashMatch) { preview = `!${bashMatch[1].trim()}`; break; }
      }
      if (!preview) {
        const firstNonCaveat = run.find((m) =>
          !m.rawJson.includes("<local-command-caveat>")
          && !m.contentPreview.includes("<local-command-caveat>"),
        );
        preview = (firstNonCaveat ?? anchor).contentPreview;
      }
      out.push({
        kind: "user:command",
        lineIdx: anchor.lineIdx,
        timestamp: anchor.timestamp,
        contentPreview: preview,
        contentSize: run.reduce((s, m) => s + m.contentSize, 0),
        rawJson: anchor.rawJson,
        commandGroup: {
          commandType: hasBash ? "bash" : "local",
          members: run,
        },
      });
    }
    i = j;
  }
  return out;
}

// ─── Sub agent parser ─────────────────────────────────────────────────────────
// Scans the subagents/ directory next to the session JSONL.
// Each agent-{hash}.jsonl is an independent conversation; .meta.json has type+description.
//
// Sub-agent ↔ parent tool_use linkage:
//   The parent JSONL has Agent tool_use blocks (assistant.message.content[]
//   with name="Agent"). The sub-agent JSONL's first event is a user event
//   carrying the exact prompt text that was passed in tool_use.input.prompt,
//   plus a promptId scoping it to a specific parent turn. We match
//   (promptId, prompt-text) → tool_use_id. This is deterministic even when a
//   single turn spawns multiple parallel sub-agents.
//
//   When the match fails (older format, truncated prompt, etc.) we leave
//   toolUseId empty and parentLineIdx=-1 — better to surface "unknown parent"
//   than the positional/dictionary-order guess the prior implementation made.

interface ParentAgentToolUse {
  id: string;
  lineIdx: number;           // index into mainEvents of the containing assistant event
  promptId: string | null;   // promptId of the enclosing turn (from the turn-opener user event)
  prompt: string;            // tool_use.input.prompt verbatim
  resultPreview: string;
  result: string;
}

function parseSubAgents(sourceFile: string, mainEvents: JEvent[]): SubAgentSummary[] {
  const sessionBase = basename(sourceFile, ".jsonl");
  const subagentsDir = join(dirname(sourceFile), sessionBase, "subagents");
  if (!existsSync(subagentsDir)) return [];

  // Walk main events, tracking the "current turn promptId" via the last seen
  // user event that has a promptId. Collect every Agent tool_use with its
  // enclosing turn's promptId and its prompt text.
  const agentToolUses: ParentAgentToolUse[] = [];
  let currentPromptId: string | null = null;
  for (let i = 0; i < mainEvents.length; i++) {
    const ev = mainEvents[i];
    if (ev.type === "user") {
      const pid = (ev as JUserEvent & { promptId?: string }).promptId;
      if (typeof pid === "string" && pid.length > 0) currentPromptId = pid;
    } else if (ev.type === "assistant") {
      const aev = ev as JAssistantEvent;
      for (const b of aev.message?.content ?? []) {
        const bc = b as { type?: string; name?: string; id?: string; input?: { prompt?: unknown } };
        if (bc.type === "tool_use" && bc.name === "Agent") {
          const promptText = typeof bc.input?.prompt === "string" ? bc.input.prompt : "";
          agentToolUses.push({
            id: bc.id ?? "",
            lineIdx: i,
            promptId: currentPromptId,
            prompt: promptText,
            resultPreview: "",
            result: "",
          });
        }
      }
    }
  }
  // Collect tool_results for Agent calls. Keep the full text (for the
  // sub-agent card's expanded view) AND the 300-char preview (for compact
  // list contexts). Match strictly on tool_use_id (deterministic).
  for (const ev of mainEvents) {
    if (ev.type !== "user") continue;
    const uev = ev as JUserEvent;
    const content = uev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const bc = b as { type?: string; tool_use_id?: string; content?: unknown };
      if (bc.type !== "tool_result") continue;
      const matchIdx = agentToolUses.findIndex(tu => tu.id === bc.tool_use_id);
      if (matchIdx !== -1 && agentToolUses[matchIdx].result === "") {
        const rawContent = bc.content;
        let full = "";
        if (typeof rawContent === "string") {
          full = rawContent;
        } else if (Array.isArray(rawContent)) {
          full = rawContent.map((c: { text?: string }) => c?.text ?? "").join("");
        }
        agentToolUses[matchIdx].result = full;
        agentToolUses[matchIdx].resultPreview = full.slice(0, 300);
      }
    }
  }

  // Read all sub agent files
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir).filter(f => f.endsWith(".jsonl"));
  } catch { return []; }

  const summaries: SubAgentSummary[] = [];
  // Track which parent tool_use each sub-agent claimed, so two sub-agents
  // sharing identical (promptId, prompt) (extremely rare — would mean the
  // same prompt was dispatched twice in one turn) still get distinct parents
  // by claim order.
  const claimedToolUseIds = new Set<string>();

  for (const entry of entries.sort()) {
    const agentFileId = entry.replace(".jsonl", "").replace("agent-", "");
    const agentPath  = join(subagentsDir, entry);
    const metaPath   = join(subagentsDir, `agent-${agentFileId}.meta.json`);

    let agentType = "unknown";
    let description = "";
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { agentType?: string; description?: string };
        agentType   = meta.agentType   ?? "unknown";
        description = meta.description ?? "";
      } catch { /* ignore */ }
    }

    // Parse the sub agent JSONL
    let agentLines: string[];
    try {
      agentLines = readFileSync(agentPath, "utf-8").trim().split("\n").filter(Boolean);
    } catch { continue; }

    let llmCallCount = 0;
    let toolCallCount = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalFreshIn = 0;
    let totalOutputTokens = 0;
    let peakContext = 0;
    let lastContext = 0;
    let startedAt = "";
    let endedAt = "";

    // Parse all events first, then dedup by msg.id keeping the LAST occurrence
    // (same logic as main parser — thinking event has usage=0, real tool_use event has the data)
    const agentEvents: JEvent[] = [];
    for (const line of agentLines) {
      try { agentEvents.push(JSON.parse(line)); } catch { /* skip */ }
    }

    // Sub agent JSONL: all events are isSidechain=true (it's a sidechain branch
    // of the main session). So we do NOT filter by isSidechain here.
    const lastIdxByMsgId = new Map<string, number>();
    agentEvents.forEach((ev, i) => {
      if (ev.type !== "assistant") return;
      const mid = (ev as JAssistantEvent).message?.id;
      if (mid) lastIdxByMsgId.set(mid, i);
    });

    agentEvents.forEach((rec, i) => {
      const ts = tsOf(rec);
      if (ts && !startedAt) startedAt = ts;
      if (ts) endedAt = ts;

      if (rec.type !== "assistant") return;
      const aev = rec as JAssistantEvent;
      const msgId = aev.message?.id;
      const isCanonical = msgId ? lastIdxByMsgId.get(msgId) === i : true;
      if (!isCanonical) return;

      const usage = aev.message?.usage ?? {};
      const fi  = usage.input_tokens ?? 0;
      const cr  = usage.cache_read_input_tokens ?? 0;
      const cw  = usage.cache_creation_input_tokens ?? 0;
      const out = usage.output_tokens ?? 0;
      if (fi + cr + cw + out > 0) {
        llmCallCount++;
        totalCacheRead  += cr;
        totalCacheWrite += cw;
        totalFreshIn    += fi;
        totalOutputTokens += out;
        const ctx = fi + cr + cw;
        if (ctx > peakContext) peakContext = ctx;
        lastContext = ctx;
      }
      for (const b of aev.message?.content ?? []) {
        if (b.type === "tool_use") toolCallCount++;
      }
    });

    const durationMs = startedAt && endedAt
      ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
      : 0;

    // Match to a parent Agent tool_use via (promptId, prompt-text). The first
    // event of the sub-agent JSONL is a user event whose message.content is
    // the verbatim prompt that was passed to the Task tool. Its promptId
    // scopes which parent turn this belongs to.
    let subFirstPromptId: string | null = null;
    let subFirstPrompt = "";
    if (agentEvents.length > 0) {
      const first = agentEvents[0] as JEvent & { promptId?: string };
      if (first.type === "user") {
        const pid = first.promptId;
        if (typeof pid === "string") subFirstPromptId = pid;
        const c = (first as JUserEvent).message?.content;
        if (typeof c === "string") subFirstPrompt = c;
        else if (Array.isArray(c)) {
          // older format: content could be a list of text blocks
          subFirstPrompt = c.map((b) => (b as { text?: string })?.text ?? "").join("");
        }
      }
    }

    const candidate = agentToolUses.find((tu) =>
      !claimedToolUseIds.has(tu.id)
      && tu.prompt === subFirstPrompt
      && (subFirstPromptId === null || tu.promptId === null || tu.promptId === subFirstPromptId),
    );
    const tu = candidate ?? { id: "", lineIdx: -1, promptId: null, prompt: "", resultPreview: "", result: "" };
    if (candidate) claimedToolUseIds.add(candidate.id);

    summaries.push({
      agentFileId,
      agentType,
      description,
      toolUseId: tu.id,
      toolUseName: "Agent",
      parentLineIdx: tu.lineIdx,
      parentCallId: 0,
      llmCallCount,
      toolCallCount,
      totalCacheRead,
      totalCacheWrite,
      totalFreshIn,
      totalOutputTokens,
      peakContext,
      lastContext,
      startedAt,
      endedAt,
      durationMs,
      resultPreview: tu.resultPreview,
      result: tu.result,
    });
  }

  return summaries;
}

// ─── Core parser ─────────────────────────────────────────────────────────────

export async function parseSessionDrilldown(
  sourceFile: string,
  sessionId: string,
  sessionRow: Record<string, unknown>,
  db: Database,
  opts: { treatSidechainAsMain?: boolean } = {},
): Promise<SessionDrilldown> {
  // ── 1. Title (same multi-fallback as SessionListV2) ──────────────────────
  const title = (sessionRow.custom_title as string | null)
    ?? (sessionRow.ai_title as string | null)
    ?? null;

  // ── 2. Parse JSONL ───────────────────────────────────────────────────────
  if (!existsSync(sourceFile)) {
    throw Object.assign(new Error("source file not found"), { status: 404 });
  }

  const lines = readFileSync(sourceFile, "utf-8").trim().split("\n").filter(Boolean);
  const events: JEvent[] = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }

  // Sub-agent JSONL re-use path: every event carries `isSidechain: true`
  // because the file represents a sidechain branch from the parent's POV.
  // For the sub-agent's *own* timeline we want it to behave like a normal
  // session — promote sidechain to main so all five `if (ev.isSidechain) skip`
  // gates below stop short-circuiting (turns segmentation, assistant frame
  // collection, etc.). See parseSubAgentDrilldown for the only caller.
  if (opts.treatSidechainAsMain) {
    for (const ev of events) {
      if ((ev as { isSidechain?: boolean }).isSidechain) {
        (ev as { isSidechain?: boolean }).isSidechain = false;
      }
    }
  }

  // ── 3. Build logical assistant calls from streaming JSONL frames ─────────
  // Claude Code streams responses by writing multiple events per message:
  //   Frame 1 (phantom, usage=0): text block — the AI's spoken text
  //   Frame 2 (phantom, usage=0): tool_use block — tool dispatch decision
  //   Frame N (real, usage>0):    final tool_use + full usage — text block ABSENT
  //
  // A single API response can also contain multiple tool_use blocks. JSONL may
  // split those into separate assistant rows, while the next wire request
  // reconstructs them as one assistant message. Keep one logical call per
  // message.id, but merge all text/tool_use blocks across its frames.
  const lastAssistantByMsgId = new Map<string, number>();
  const assistantFramesByMsgId = new Map<string, Array<{ ev: JAssistantEvent; lineIdx: number }>>();
  const logicalCallByCanonicalLine = new Map<number, LogicalAssistantCall>();
  events.forEach((ev, idx) => {
    if (ev.type !== "assistant" || (ev as JAssistantEvent).isSidechain) return;
    const aev = ev as JAssistantEvent;
    const msgId = aev.message?.id;
    if (msgId) {
      lastAssistantByMsgId.set(msgId, idx);
      const frames = assistantFramesByMsgId.get(msgId) ?? [];
      frames.push({ ev: aev, lineIdx: idx });
      assistantFramesByMsgId.set(msgId, frames);
    }
  });
  for (const frames of assistantFramesByMsgId.values()) {
    const logical = mergeAssistantFrames(frames);
    logicalCallByCanonicalLine.set(logical.lineIdx, logical);
    if (logical.messageId) lastAssistantByMsgId.set(logical.messageId, logical.lineIdx);
  }

  // ── 4. Identify all system errors ────────────────────────────────────────
  let systemErrorCount = 0;
  for (const ev of events) {
    if (ev.type === "system") {
      const sub = (ev as JSystemEvent).subtype ?? "";
      // api_error = Claude Code's own retry signal (network/rate-limit); treat as error
      if (sub === "api_error") systemErrorCount++;
    }
  }

  // ── 4b. Compaction 归属 ───────────────────────────────────────────────────
  // 压缩本身是一个独立事件（CompactEvent / 压缩 N），不属于任何 turn。
  //
  // 旧逻辑曾把"紧跟 compact_boundary 之后第一个 assistant call"（即 post-compact
  // 第一次推理）标成 isCompaction=true，于是那条 call 所在的 *下一个* turn 被
  // 误带上 compaction 标。Fix B2：不再标真实 call —— 压缩标只挂 CompactEvent。
  // 真实 call 的 isCompaction 一律 false（见下方 build 循环）。
  //
  // 注：post-compact 第一次推理"这条 call"的特殊性（context 被重写、delta 基线
  // 应换成 compact postTokens）留给 Fix C 处理，届时再按 CompactEvent 反查定位。

  // ── 5. Build turns ───────────────────────────────────────────────────────
  // Algorithm:
  //   - Scan forward; when we find a human-input user event, start a new turn
  //   - Accumulate all subsequent (deduplicated) assistant events until one has
  //     stop_reason !== "tool_use" (i.e. end_turn / max_tokens / stop_sequence)
  //   - If another human-input event appears BEFORE the turn ends (user typed while
  //     LLM was running), we do NOT split the turn; per spec, turns end at LLM stop.

  const turns: UserTurn[] = [];
  let globalCallIndex = 0; // 1-based across the whole session
  // Session-wide pointer to the previous canonical assistant call event.
  // Used to compute Δ-vs-prev for the *first* call of each turn — without
  // this, every turn's first call would treat prevContext=0 and report Δ
  // equal to its full contextSize (the user-visible "Call 329 +426.2k" bug).
  // Updated at the end of each turn to the turn's last canonical call.
  let prevCallEvAcrossTurns: JAssistantEvent | null = null;

  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.type !== "user" || !isHumanInput(ev as JUserEvent)) { i++; continue; }

    const userEv = ev as JUserEvent;
    const userText = extractUserText(userEv.message?.content);
    const turnStartTs = tsOf(ev);
    // Position of the turn-opener user event in the events array. Used by
    // the client to look up reverse-attribution for the human input
    // (firstSeenInCall / consumedByCallIds) so the Turn card's blue "USER
    // INPUT" node can render a jump chip just like other jsonl events.
    const userInputLineIdx = i;

    // Collect deduplicated assistant events until end_turn.
    // Also capture any human-input user events that arrive mid-turn
    // (user typed while LLM was executing tool calls).
    const rawCalls: LogicalAssistantCall[] = [];
    const midTurnInjections: Array<{ text: string; timestamp: string; afterCallIndex: number }> = [];
    let turnErrorCount = 0;
    let j = i + 1;
    while (j < events.length) {
      const jev = events[j];
      if (jev.type === "user" && isHumanInput(jev as JUserEvent)) {
        midTurnInjections.push({
          text: extractUserText((jev as JUserEvent).message?.content),
          timestamp: tsOf(jev),
          afterCallIndex: rawCalls.length,
        });
      } else if (jev.type === "system") {
        if (((jev as JSystemEvent).subtype ?? "") === "api_error") turnErrorCount++;
      } else if (jev.type === "assistant" && !(jev as JAssistantEvent).isSidechain) {
        const aev = jev as JAssistantEvent;
        const msgId = aev.message?.id;
        const isCanonical = msgId
          ? lastAssistantByMsgId.get(msgId) === j
          : true; // no id → always include
        if (isCanonical) {
          const logicalCall = msgId
            ? logicalCallByCanonicalLine.get(j) ?? { ev: aev, lineIdx: j, firstLineIdx: j, frameLineIdxs: [j], messageId: msgId, apiRequestId: aev.requestId ?? null }
            : { ev: aev, lineIdx: j, firstLineIdx: j, frameLineIdxs: [j], messageId: null, apiRequestId: aev.requestId ?? null };
          rawCalls.push(logicalCall);
          const stopReason = logicalCall.ev.message?.stop_reason ?? "";
          if (stopReason && stopReason !== "tool_use") break; // turn ends
        }
      }
      j++;
    }

    const turnEndTs = rawCalls.length
      ? tsOf(rawCalls[rawCalls.length - 1].ev)
      : turnStartTs;

    // Build LlmCall objects
    const calls: LlmCall[] = rawCalls.map(({ ev: aev }, callIdx) => {
      globalCallIndex++;
      const usage = aev.message?.usage ?? {};
      const freshOut  = usage.output_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      // input_tokens = non-cached tokens the model processed fresh this call.
      const inputTokens = usage.input_tokens ?? 0;
      // cache_creation TTL split (undefined on older logs without the breakdown).
      const cacheEphemeral1h = usage.cache_creation?.ephemeral_1h_input_tokens;
      const cacheEphemeral5m = usage.cache_creation?.ephemeral_5m_input_tokens;
      const stopReason = aev.message?.stop_reason ?? null;
      const rawModel = aev.message?.model ?? "";
      const model = rawModel === "<synthetic>" ? "" : normaliseModelName(rawModel);

      // Fix B2：真实 call 不再标 compaction —— 压缩标只挂 CompactEvent（压缩 N）。
      // 这样 post-compact 第一次推理所在的 turn 不会被误带 compaction 标。
      const content = aev.message?.content ?? [];
      const isCompaction = false;

      // Collect ALL Agent tool_use ids in this call (parallel spawn supported).
      const agentToolUseIds: string[] = [];
      for (const b of content) {
        const bc = b as { type?: string; name?: string; id?: string };
        if (bc.type === "tool_use" && bc.name === "Agent" && bc.id) {
          agentToolUseIds.push(bc.id);
        }
      }

      // Collect all tool_use names dispatched in this call
      const toolNames: string[] = [];
      for (const b of content) {
        const bc = b as { type?: string; name?: string };
        if (bc.type === "tool_use" && bc.name) toolNames.push(bc.name);
      }

      // Extract assistant text from the merged logical assistant message.
      const msgId = rawCalls[callIdx].messageId ?? "";
      const assistantText = (() => {
        const parts: string[] = [];
        for (const b of content) {
          const bc = b as { type?: string; text?: string };
          if (bc.type === "text" && bc.text) parts.push(bc.text);
        }
        const joined = parts.join("\n").trim();
        return joined.slice(0, 500) + (joined.length > 500 ? "…" : "");
      })();

      // Build ToolCallSlot list: pair tool_use blocks with tool_result from next user event
      // Scan forward in events from lineIdx+1 to find the user event(s) with tool_results
      const toolUseMap = new Map<string, {
        name: string;
        inputPreview: string;
        inputSize: number;
      }>();
      for (const b of content) {
        const bc = b as { type?: string; name?: string; id?: string; input?: unknown };
        if (bc.type === "tool_use" && bc.id) {
          const inputStr = bc.input != null ? JSON.stringify(bc.input) : "";
          toolUseMap.set(bc.id, {
            name: bc.name ?? "unknown",
            inputPreview: inputStr.slice(0, 300),
            inputSize: inputStr.length,
          });
        }
      }

      // Scan subsequent events (up to next logical assistant call) for
      // tool_results. Use the first frame line, not the canonical/final frame:
      // Claude Code can interleave tool_result rows between streaming frames
      // that share the same assistant message.id.
      const toolCallSlots: import("./session-drilldown-types.ts").ToolCallSlot[] = [];
      if (toolUseMap.size > 0) {
        const startIdx = rawCalls[callIdx].firstLineIdx + 1;
        const endIdx = callIdx + 1 < rawCalls.length ? rawCalls[callIdx + 1].firstLineIdx : events.length;
        for (let ei = startIdx; ei < endIdx; ei++) {
          const uev = events[ei];
          if (uev.type !== "user") continue;
          const ucontent = (uev as JUserEvent).message?.content;
          if (!Array.isArray(ucontent)) continue;
          for (const rb of ucontent) {
            const rbc = rb as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
            if (rbc.type !== "tool_result" || !rbc.tool_use_id) continue;
            const tu = toolUseMap.get(rbc.tool_use_id);
            if (!tu) continue;
            const rawOut = rbc.content;
            let outStr = "";
            if (typeof rawOut === "string") outStr = rawOut;
            else if (Array.isArray(rawOut)) outStr = rawOut.map((c: { text?: string }) => c?.text ?? "").join("");
            else if (rawOut != null) outStr = JSON.stringify(rawOut);
            // Skill 工具特殊处理：聚合 SKILL.md 注入信息（inline）或识别 forked。
            // 判别：tool_result.content 以 `Skill "{name}" completed (forked execution)`
            // 开头 → forked；否则 inline。然后在 [ei, endIdx) 内按 sourceToolUseID
            // 等于此 toolUseId 的行收集 inline 注入（forked 模式下没有这种行）。
            let skillInjection: import("./session-drilldown-types.ts").SkillInjectionInfo | undefined;
            if (tu.name === "Skill") {
              const forkedMarker = /^Skill "[^"]+" completed \(forked execution\)/;
              if (forkedMarker.test(outStr)) {
                skillInjection = {
                  mode: "forked",
                  ackLineIdx: ei,
                  forkedResultChars: outStr.length,
                };
              } else {
                const injectedLineIdxs: number[] = [];
                const bodyParts: string[] = [];
                // 从 ack 行之后扫到 endIdx，收集所有 sourceToolUseID === id 的行。
                // attachment 行（如 command_permissions）也带 sourceToolUseID，
                // 但其 message 字段不存在 —— 这里只把 user.text 块拼进 bodyText，
                // attachment 仅记入 injectedLineIdxs。
                for (let ej = ei + 1; ej < endIdx; ej++) {
                  const sub = events[ej] as { sourceToolUseID?: string; type?: string; message?: { content?: unknown } };
                  if (sub.sourceToolUseID !== rbc.tool_use_id) continue;
                  injectedLineIdxs.push(ej);
                  if (sub.type === "user" && Array.isArray(sub.message?.content)) {
                    for (const blk of sub.message!.content as Array<{ type?: string; text?: string }>) {
                      if (blk.type === "text" && typeof blk.text === "string") {
                        bodyParts.push(blk.text);
                      }
                    }
                  }
                }
                const bodyText = bodyParts.join("\n\n");
                skillInjection = {
                  mode: "inline",
                  ackLineIdx: ei,
                  injectedLineIdxs,
                  bodyText,
                  totalChars: outStr.length + bodyText.length,
                };
              }
            }
            toolCallSlots.push({
              toolUseId: rbc.tool_use_id,
              name: tu.name,
              inputPreview: tu.inputPreview,
              inputSize: tu.inputSize,
              outputPreview: outStr.slice(0, 300),
              outputSize: outStr.length,
              isError: rbc.is_error === true,
              ...(skillInjection ? { skillInjection } : {}),
            });
            toolUseMap.delete(rbc.tool_use_id); // matched
          }
        }
        // Any unmatched tool_use (no tool_result found yet — still pending)
        for (const [id, tu] of toolUseMap) {
          toolCallSlots.push({
            toolUseId: id,
            name: tu.name,
            inputPreview: tu.inputPreview,
            inputSize: tu.inputSize,
            outputPreview: "",
            outputSize: 0,
            isError: false,
          });
        }
      }

      // ── Collect all interval events between this call and the next ───────────
      // For non-final calls: scan up to (but not including) the next logical
      // call's first frame. Its canonical frame may come later, after
      // interleaved tool_result rows that belong to that next logical call.
      // For the FINAL call in the turn: scan up to the turn boundary (j), NOT
      // beyond — otherwise we'd leak events from the next turn.
      // Also skip phantom assistant events (usage=0, same msg.id as a real event).
      const intervalEvents: import("./session-drilldown-types.ts").IntervalEvent[] = [];
      {
        const isLastCall = callIdx === rawCalls.length - 1;
        const startEi = rawCalls[callIdx].firstLineIdx + 1;
        // For non-final calls: scan up to the next logical call's first frame.
        // For the final call: scan forward but stop at the first human input
        // event (start of next turn) or end of file.
        let endEi: number;
        if (!isLastCall) {
          endEi = rawCalls[callIdx + 1].firstLineIdx;
        } else {
          endEi = events.length;
          for (let ei2 = startEi; ei2 < events.length; ei2++) {
            if (events[ei2].type === "user" && isHumanInput(events[ei2] as JUserEvent)) {
              endEi = ei2; // stop before next turn's human input
              break;
            }
          }
        }
        for (let ei = startEi; ei < endEi; ei++) {
          const iev = events[ei];

          // Skip phantom assistant events (streaming frames with usage=0).
          // The real event has the same msg.id but non-zero usage and is the
          // canonical call already captured in rawCalls.
          if (iev.type === "assistant") {
            const aev = iev as JAssistantEvent;
            const msgId = aev.message?.id;
            // If this is NOT the canonical (last-seen) event for this id, skip it.
            if (msgId && lastAssistantByMsgId.get(msgId) !== ei) continue;
            // If canonical but zero usage, it's a phantom streaming frame — skip.
            const u = aev.message?.usage ?? {};
            const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
              + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
            if (total === 0) continue;
            // A real assistant event here means this is an end_turn for the same call —
            // it's already represented as the call card itself, skip.
            continue;
          }

          intervalEvents.push(makeIntervalEvent(iev, ei));
        }
      }

      // Skill name 回填：对所有 sourceToolUseID 命中本 call name="Skill" 的 tool_use
      // 的 intervalEvent，写入 skillName 字段。范围严格在本 call 的 toolCallSlots
      // 内查找 —— 这与归因事实一致（cli.js SkillTool 写入 sourceToolUseID 时一定
      // 对应同一 assistant call 内的 Skill tool_use id）。零跨 call / 跨 turn。
      if (intervalEvents.length > 0 && toolCallSlots.some(tc => tc.name === "Skill")) {
        const skillNameByToolUseId = new Map<string, string>();
        for (const tc of toolCallSlots) {
          if (tc.name !== "Skill") continue;
          try {
            const obj = JSON.parse(tc.inputPreview) as { skill?: string };
            if (typeof obj.skill === "string") {
              skillNameByToolUseId.set(tc.toolUseId, obj.skill);
            }
          } catch { /* truncated inputPreview, skip */ }
        }
        if (skillNameByToolUseId.size > 0) {
          for (const ev of intervalEvents) {
            if (ev.sourceToolUseID) {
              const name = skillNameByToolUseId.get(ev.sourceToolUseID);
              if (name) ev.skillName = name;
            }
          }
        }
      }

      // contextSize = total prompt size this call (NOT the model's context
      // window capacity — that's a separate thing). = input + cacheRead + cacheWrite.
      const contextSize = inputTokens + cacheRead + cacheWrite;
      // significantDelta = this call's prompt size − previous call's prompt size.
      // A measure of how much the prompt grew (or shrank, on compaction) call-to-call.
      // Used by the UI to flag big jumps.
      const prevCall = callIdx > 0
        ? rawCalls[callIdx - 1].ev
        : prevCallEvAcrossTurns;
      const prevUsage = prevCall?.message?.usage ?? {};
      const prevContext = (prevUsage.input_tokens ?? 0)
        + (prevUsage.cache_read_input_tokens ?? 0)
        + (prevUsage.cache_creation_input_tokens ?? 0);
      const significantDelta = contextSize - prevContext;
      // freshIn ≡ usage.input_tokens — the non-cached fresh input portion,
      // billed at 1x rate. Matches Claude /cost's "X input" per model.
      // Independent from significantDelta (prompt-size delta).
      const callFreshIn = inputTokens;

      // Cache MISS: a prior call existed (cached prefix SHOULD have been
      // readable) but this call read 0 from cache and re-created a prefix.
      // First call of a session (no prev) is initial creation, not a miss.
      const cacheMiss = prevCall != null && cacheRead === 0 && cacheWrite > 0;
      // Wall-clock gap since the previous call — explains a miss when it
      // exceeds the server cache TTL (~1h).
      const prevTs = prevCall ? tsOf(prevCall) : null;
      const curTs = tsOf(aev);
      const gapSincePrevMs = (prevTs && curTs)
        ? new Date(curTs).getTime() - new Date(prevTs).getTime()
        : null;

      return {
        id: globalCallIndex,
        indexInTurn: callIdx + 1,
        messageId: rawCalls[callIdx].messageId,
        apiRequestId: rawCalls[callIdx].apiRequestId,
        jsonlLineIdx: rawCalls[callIdx].lineIdx,
        jsonlFrameLineIdxs: rawCalls[callIdx].frameLineIdxs,
        contextSize,
        outputTokens: freshOut,
        cacheRead,
        cacheWrite,
        cacheEphemeral1h,
        cacheEphemeral5m,
        cacheMiss,
        gapSincePrevMs,
        timestamp: tsOf(aev),
        model,
        stopReason,
        isCompaction,
        freshIn: callFreshIn,
        isUnknownHeavy: false,
        isSignificant: Math.abs(significantDelta) > 2000,
        significantDelta,
        proxy: null,
        proxyMatchMode: "unmatched", // overwritten by sessionDrilldown via computeCallProxyMatchModes
        subAgents: [], // filled below after parsing sub agents
        incomingDiff: [],
        toolNames,
        toolCalls: toolCallSlots,
        assistantText,
        intervalEvents,
        _agentToolUseIds: agentToolUseIds, // temp field for join
      } as LlmCall & { _agentToolUseIds: string[] };
    });

    // Turn-level aggregates
    const llmCallCount = calls.length;
    // Tool calls = assistant events with tool_use content blocks; collect names
    let toolCallCount = 0;
    const turnToolNames: string[] = [];
    for (const { ev: aev } of rawCalls) {
      for (const b of aev.message?.content ?? []) {
        const bc = b as { type?: string; name?: string };
        if (bc.type === "tool_use") {
          toolCallCount++;
          if (bc.name) turnToolNames.push(bc.name);
        }
      }
    }
    const totalCacheRead = calls.reduce((s, c) => s + c.cacheRead, 0);
    const totalCacheWrite = calls.reduce((s, c) => s + c.cacheWrite, 0);
    const peakContext = calls.length ? Math.max(...calls.map(c => c.contextSize)) : 0;
    const firstContext = calls.length ? calls[0].contextSize : 0;
    const lastContext = calls.length ? calls[calls.length - 1].contextSize : 0;
    const netContextDelta = lastContext - firstContext;

    // finalOutput: text from the last end_turn assistant message
    // The canonical end_turn event is the last entry in rawCalls (stop_reason != tool_use).
    const finalCall = rawCalls.length > 0 ? rawCalls[rawCalls.length - 1].ev : null;
    let finalOutput: string | null = null;
    if (finalCall && finalCall.message?.stop_reason !== "tool_use") {
      const textBlocks = (finalCall.message?.content ?? [])
        .filter(b => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0);
      if (textBlocks.length > 0) {
        finalOutput = textBlocks.map(b => b.text ?? "").join("\n").trim();
      }
    }

    // durationMs: wall-clock from first user event to last assistant event
    const durationMs = (turnStartTs && turnEndTs)
      ? Math.max(0, new Date(turnEndTs).getTime() - new Date(turnStartTs).getTime())
      : 0;

    // Leading metadata events between the turn-opener user and the first LLM
    // call. e.g. ai-title — generated by Haiku on first user submit, usually
    // written before the first main-model turn lands. The per-call interval
    // scan starts at firstLineIdx+1 and never covers this gap, so collect it
    // here. Exclude request content (the user opener / its attachments /
    // assistant) — keep only pure metadata so we don't double-count the request.
    const leadingEvents: import("./session-drilldown-types.ts").IntervalEvent[] = [];
    {
      const gapEnd = rawCalls.length > 0 ? rawCalls[0].firstLineIdx : j;
      for (let ei = userInputLineIdx + 1; ei < gapEnd; ei++) {
        const lev = events[ei];
        if (lev.type === "user" || lev.type === "assistant" || lev.type === "attachment") continue;
        leadingEvents.push(makeIntervalEvent(lev, ei));
      }
    }

    turns.push({
      id: turns.length + 1,
      userInput: userText,
      userInputLineIdx,
      finalOutput,
      midTurnInjections,
      leadingEvents,
      startedAt: turnStartTs,
      endedAt: turnEndTs,
      durationMs,
      llmCallCount,
      toolCallCount,
      netContextDelta,
      peakContext,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      unknownDelta: 0,
      hasCompaction: calls.some(c => c.isCompaction),
      hasUnknownSpike: false,
      errorCount: turnErrorCount,
      calls,
      _toolNames: turnToolNames,
    } as UserTurn & { _toolNames: string[] });

    // Carry the last canonical call of this turn forward, so the *next*
    // turn's first call can compute Δ against it (otherwise turn-boundary
    // calls would all report Δ = contextSize, which is the bug being fixed).
    if (rawCalls.length > 0) {
      prevCallEvAcrossTurns = rawCalls[rawCalls.length - 1].ev;
    }

    i = j + 1;
  }

  // ── 5b. Build inter-turn blocks ───────────────────────────────────────────
  // Scan for runs of command-only user events (and related system events) that
  // appear between two turns or after the last turn.
  // Strategy: for each gap between turn[k].endLineIdx and turn[k+1].startLineIdx
  // (and after the last turn), collect any events that are command content.
  // We track the end-of-turn line as the `j` value from each turn's inner loop.
  // Simpler: re-scan events, noting which line each turn started/ended at.

  // Record the JSONL line index of each turn's first human user event and last assistant
  // event, so we can find gaps between turns.
  interface TurnBoundary { turnId: number; startLine: number; endLine: number }
  const turnBoundaries: TurnBoundary[] = [];
  {
    let ti = 0;
    let k = 0;
    while (k < events.length) {
      if (events[k].type !== "user" || !isHumanInput(events[k] as JUserEvent)) { k++; continue; }
      const startLine = k;
      // Find end: scan forward until end_turn assistant (same logic as above)
      let endLine = k;
      let m = k + 1;
      while (m < events.length) {
        const mev = events[m];
        if (mev.type === "user" && isHumanInput(mev as JUserEvent)) {
          // mid-turn injection — keep scanning
        } else if (mev.type === "assistant" && !(mev as JAssistantEvent).isSidechain) {
          const aev = mev as JAssistantEvent;
          const msgId = aev.message?.id;
          const isCanonical = msgId ? lastAssistantByMsgId.get(msgId) === m : true;
          if (isCanonical) {
            const sr = aev.message?.stop_reason ?? "";
            if (sr && sr !== "tool_use") { endLine = m; break; }
          }
        }
        m++;
      }
      if (ti < turns.length) {
        turnBoundaries.push({ turnId: turns[ti].id, startLine, endLine });
        ti++;
      }
      k = m + 1;
    }
  }

  // Build inter-turn blocks: command events in gaps between turns (or after last turn)
  const interTurnBlocks: InterTurnBlock[] = [];
  {
    // Gaps to scan: [afterLine, beforeLine, prevTurnId, nextTurnId]
    type Gap = { afterLine: number; beforeLine: number; prevTurnId: number | null; nextTurnId: number | null };
    const gaps: Gap[] = [];

    if (turnBoundaries.length === 0) {
      // No turns at all — whole file is one gap
      gaps.push({ afterLine: -1, beforeLine: events.length, prevTurnId: null, nextTurnId: null });
    } else {
      // Before first turn
      gaps.push({ afterLine: -1, beforeLine: turnBoundaries[0].startLine, prevTurnId: null, nextTurnId: turnBoundaries[0].turnId });
      // Between turns
      for (let gi = 0; gi < turnBoundaries.length - 1; gi++) {
        gaps.push({
          afterLine: turnBoundaries[gi].endLine,
          beforeLine: turnBoundaries[gi + 1].startLine,
          prevTurnId: turnBoundaries[gi].turnId,
          nextTurnId: turnBoundaries[gi + 1].turnId,
        });
      }
      // After last turn
      gaps.push({
        afterLine: turnBoundaries[turnBoundaries.length - 1].endLine,
        beforeLine: events.length,
        prevTurnId: turnBoundaries[turnBoundaries.length - 1].turnId,
        nextTurnId: null,
      });
    }

    for (const gap of gaps) {
      const blockEvents: IntervalEvent[] = [];
      for (let gi = gap.afterLine + 1; gi < gap.beforeLine; gi++) {
        const gev = events[gi];
        // Include command user events and system:local_command events; skip noise
        const isCmd = gev.type === "user" && isCommandContent((gev as JUserEvent).message?.content);
        const isSysCmd = gev.type === "system" && ((gev as JSystemEvent).subtype ?? "") === "local_command";
        const isMeta = gev.type === "user" && (gev as JUserEvent).isMeta;
        if (isCmd || isSysCmd || isMeta) {
          blockEvents.push(makeIntervalEvent(gev, gi));
        }
      }
      if (blockEvents.length === 0) continue;

      // Build a label summarising what commands were invoked. Only count the
      // *input* envelopes (<command-name> / <bash-input>); stdout/stderr is the
      // RESULT of a command, not another command — historically lumping stdout
      // into the label produced misleading titles like "/exit, Goodbye!" that
      // read as two sibling commands.
      const cmdNames: string[] = [];
      for (const ev of blockEvents) {
        if (ev.kind !== "user:command" && ev.kind !== "system:local_command") continue;
        const raw = ev.contentPreview;
        const cmdMatch = raw.match(/<command-name>([^<]+)<\/command-name>/);
        if (cmdMatch) { cmdNames.push(cmdMatch[1].trim()); continue; }
        const bashMatch = raw.match(/<bash-input>([^<\n]{0,40})/);
        if (bashMatch) cmdNames.push(`!${bashMatch[1].trim()}`);
      }
      const label = cmdNames.length > 0
        ? [...new Set(cmdNames)].slice(0, 3).join(", ")
        : `${blockEvents.length} event${blockEvents.length > 1 ? "s" : ""}`;

      interTurnBlocks.push({
        index: interTurnBlocks.length,
        prevTurnId: gap.prevTurnId,
        nextTurnId: gap.nextTurnId,
        timestamp: blockEvents[0].timestamp,
        label,
        enteredContext: gap.nextTurnId !== null,
        events: blockEvents,
      });
    }
  }

  // ── 5a-dedup. trailing 事件去重 ─────────────────────────────────────────
  // 末尾 call 的 interval 扫描会一直扫到 EOF，把会话末尾的 command / local-command /
  // meta 事件也吸进 call.intervalEvents；而这些又被 trailing inter-turn 块收录 → 重复
  // 渲染（call chain + 「AFTER THIS TURN」各一份）。用户语义上它们属于 tailing(inter-turn
  // 块)，故从 call.intervalEvents 里移除任何已被 inter-turn 块收录的行。away_summary /
  // ai-title 等不被 inter-turn 块收录（它只收 cmd/sysCmd/meta），故仍保留在 call 里。
  {
    const interTurnLineIdxs = new Set<number>();
    for (const b of interTurnBlocks) for (const e of b.events) interTurnLineIdxs.add(e.lineIdx);
    if (interTurnLineIdxs.size > 0) {
      for (const turn of turns) {
        for (const call of turn.calls) {
          call.intervalEvents = call.intervalEvents.filter((ev) => !interTurnLineIdxs.has(ev.lineIdx));
        }
      }
    }
  }

  // ── 5a-group. 命令分组（纯视觉）────────────────────────────────────────────
  // 把每个 call.intervalEvents 和每个 interTurnBlock.events 里连续的 command 事件
  // （caveat + command-name + stdout）折叠成单个 commandGroup wrapper。逐段归因
  // 由前端按 members[].lineIdx 各自查询保留 —— 这里只做视觉合并。
  for (const turn of turns) {
    for (const call of turn.calls) {
      call.intervalEvents = groupCommandEvents(call.intervalEvents);
    }
  }
  for (const block of interTurnBlocks) {
    block.events = groupCommandEvents(block.events);
  }

  // ── 5b. Extract CompactEvent[] ─────────────────────────────────────────
  // 三源拼装：
  //   主锚 = system.compact_boundary（jsonl 决定性事件，compactMetadata 齐全）
  //   副锚 = 紧跟其后的 user 事件，parentUuid === boundary.uuid，
  //          isCompactSummary === true，content 是被注入 post-compact 第一次
  //          推理的 summary 文本（CLI 截取 + 包装过的 LLM 响应）
  //   富化（best-effort）= proxy_requests 表中 prompt 指纹命中 compaction
  //          template 的那条 LLM call。失败时不阻塞，proxy=null。
  //
  // 还要找触发命令：boundary 之前最近的 user 事件，content 含
  // <command-name>/compact</command-name>。从 <command-args>...</command-args>
  // 段提取用户附加 instructions（如 `/compact focus on parser` → "focus on parser"）。
  const compactEvents: CompactEvent[] = [];
  {
    // proxy 富化已经抽到 compact-proxy-matcher.ts —— 这里只构造 CompactEvent
    // 骨架（proxy 先填 null），离开本 loop 后调用 matcher 做批量精确匹配。
    // 详见 docs/inner/claude-take.md 的机制说明与匹配算法。

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.type !== "system") continue;
      const sysEv = ev as JSystemEvent & {
        uuid?: string;
        content?: string;
        compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number; durationMs?: number };
      };
      if (sysEv.subtype !== "compact_boundary") continue;

      const boundaryUuid = sysEv.uuid ?? "";
      const metadata = sysEv.compactMetadata ?? {};
      const timestamp = tsOf(ev);

      // 副锚：紧跟 boundary 之后的 isCompactSummary=true user 事件。
      // 容差最多向后看 10 个 event（理论上紧邻第 1 个，留点窗口防止
      // 未来 CLI 在中间塞其它事件）。
      let summaryLineIdx: number | null = null;
      let summaryUuid: string | null = null;
      let summaryText: string | null = null;
      for (let j = i + 1; j < Math.min(events.length, i + 10); j++) {
        const cand = events[j] as JUserEvent & { isCompactSummary?: boolean; uuid?: string };
        if (cand.type === "user" && cand.isCompactSummary === true) {
          summaryLineIdx = j;
          summaryUuid = cand.uuid ?? null;
          const c = cand.message?.content;
          summaryText = typeof c === "string" ? c : extractUserText(c);
          break;
        }
      }

      // 触发命令 + userInstructions：搜 boundary 两侧 ±30 个事件。
      // 注意：jsonl 是按 *写入完成时刻* 排序，不是按用户输入时刻。boundary
      // 在 LLM call 完成时立刻写，而 /compact 的 user command echo 经常在
      // boundary 之后才被 flush（CLI 队列化命令 echo）。本 case L24 = /compact
      // 出现在 L21 boundary 之后，所以单向 backward 搜会漏。两侧搜，取
      // line-idx 距离 boundary 最近的那条。
      let commandLineIdx: number | null = null;
      let userInstructions: string | null = null;
      {
        let bestDist = Infinity;
        const lo = Math.max(0, i - 30);
        const hi = Math.min(events.length - 1, i + 30);
        for (let k = lo; k <= hi; k++) {
          if (k === i) continue;
          const cand = events[k];
          if (cand.type !== "user") continue;
          const c = (cand as JUserEvent).message?.content;
          const text = typeof c === "string" ? c : extractUserText(c);
          if (!text.includes("<command-name>/compact</command-name>")) continue;
          const dist = Math.abs(k - i);
          if (dist >= bestDist) continue;
          bestDist = dist;
          commandLineIdx = k;
          const m = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
          const args = (m?.[1] ?? "").trim();
          userInstructions = args.length > 0 ? args : null;
        }
      }

      // 归属判定：基于 boundary 在 events 中的位置 vs turnBoundaries 区间。
      // /compact 一定不在任何 turn 内部 —— turn 是 humanInput → endTurn，
      // compact_boundary 写在 endTurn 之后。所以只可能是 between-turns 或
      // post-session。
      let afterTurnId: number | null = null;
      let beforeTurnId: number | null = null;
      for (const tb of turnBoundaries) {
        if (tb.endLine < i) afterTurnId = tb.turnId;
        if (tb.startLine > i && beforeTurnId === null) beforeTurnId = tb.turnId;
      }
      let belonging: EventBelonging;
      if (afterTurnId !== null && beforeTurnId !== null) {
        belonging = { kind: "between-turns", afterTurnId, beforeTurnId };
      } else if (afterTurnId !== null) {
        belonging = { kind: "post-session", afterTurnId };
      } else if (beforeTurnId !== null) {
        // 极少见：session 开头第一条 turn 之前就 compact —— 不合常理但记录下来
        belonging = { kind: "pre-session", beforeTurnId };
      } else {
        // 完全无 turn 的 session 不会触发 compact；防御性兜底
        belonging = { kind: "post-session", afterTurnId: 0 };
      }

      compactEvents.push({
        index: compactEvents.length,
        belonging,
        boundaryLineIdx: i,
        boundaryUuid,
        timestamp,
        trigger: metadata.trigger ?? "manual",
        preTokens: metadata.preTokens ?? 0,
        postTokens: metadata.postTokens ?? 0,
        durationMs: metadata.durationMs ?? 0,
        summaryLineIdx,
        summaryUuid,
        summaryText,
        commandLineIdx,
        userInstructions,
        proxy: null, // 离开 loop 后由 matchCompactCallsForSession 批量填充
      });
    }

    // 批量精确匹配 + 反向归因。0 boundary 时 matcher 早退、不发 SQL / 不读 body。
    // orphanCompactRowIds 暂未被消费 —— 留口子给未来的 reverse-attribution UI
    // （proxy 流量视图想标注"这条是 compact 但没归属到任何 boundary"时直接用）。
    if (compactEvents.length > 0) {
      const evidence: CompactBoundaryEvidence[] = compactEvents.map((ev) => ({
        index: ev.index,
        boundaryTsMs: Date.parse(ev.timestamp),
        expectedDurMs: ev.durationMs,
      }));
      const matches = await matchCompactCallsForSession(db, sessionId, evidence);
      for (const ev of compactEvents) {
        ev.proxy = matches.byBoundaryIndex.get(ev.index) ?? null;
      }
    }
  }

  // ── 6. Parse sub agents and join to LlmCalls ─────────────────────────────
  const subAgents = parseSubAgents(sourceFile, events);
  // Build lookup: toolUseId → SubAgentSummary
  const subAgentByToolUseId = new Map<string, typeof subAgents[number]>();
  for (const sa of subAgents) {
    if (sa.toolUseId) subAgentByToolUseId.set(sa.toolUseId, sa);
  }
  // Attach sub agents to matching LlmCalls, then strip temp field. Also
  // back-fill SubAgentSummary.parentCallId now that we know each call's id.
  for (const turn of turns) {
    for (const call of turn.calls) {
      const c = call as LlmCall & { _agentToolUseIds?: string[] };
      for (const id of c._agentToolUseIds ?? []) {
        const sa = subAgentByToolUseId.get(id);
        if (sa) {
          sa.parentCallId = call.id;
          c.subAgents.push(sa);
        }
      }
      delete c._agentToolUseIds;
    }
  }

  // ── 7. Session-level aggregates ──────────────────────────────────────────
  const allCalls = turns.flatMap(t => t.calls);
  const totalLlmCalls = allCalls.length;
  const totalToolCalls = turns.reduce((s, t) => s + t.toolCallCount, 0);
  const peakContext = allCalls.length ? Math.max(...allCalls.map(c => c.contextSize)) : 0;
  const totalCacheRead = allCalls.reduce((s, c) => s + c.cacheRead, 0);
  const totalCacheWrite = allCalls.reduce((s, c) => s + c.cacheWrite, 0);
  // totalFreshIn = sum of per-call context deltas (new content injected each call)
  const totalFreshIn = allCalls.reduce((s, c) => s + c.freshIn, 0);
  const totalFreshOut = allCalls.reduce((s, c) => s + c.outputTokens, 0);
  const lastContext = allCalls.length ? allCalls[allCalls.length - 1].contextSize : 0;
  // Fix B2：压缩计数来自 CompactEvent（真实来源），不再数 turn.hasCompaction
  // （后者现在恒为 false —— 压缩不再误标在 turn 上）。compactEvents 已在第 5b
  // 节构造完毕（本行在其之后）。
  const compactionCount = compactEvents.length;

  // Per-model breakdown
  const modelBreakdown: Record<string, ModelStats> = {};
  for (const call of allCalls) {
    const m = call.model || "unknown";
    if (!modelBreakdown[m]) {
      modelBreakdown[m] = { calls: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, freshIn: 0 };
    }
    const s = modelBreakdown[m];
    s.calls++;
    s.outputTokens += call.outputTokens;
    s.cacheRead += call.cacheRead;
    s.cacheWrite += call.cacheWrite;
    s.freshIn += call.freshIn;
  }

  // Tool distribution: count by name, sort descending, top 8
  const toolNameCounts = new Map<string, number>();
  for (const turn of turns) {
    const t = turn as UserTurn & { _toolNames?: string[] };
    for (const name of t._toolNames ?? []) {
      toolNameCounts.set(name, (toolNameCounts.get(name) ?? 0) + 1);
    }
    delete t._toolNames;
  }
  const toolDistribution = [...toolNameCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  // ── 8. Proxy data availability ───────────────────────────────────────────
  // Stubbed DBs (e.g. sub-agent drilldown) return undefined here — treat as no proxy.
  const proxyRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM proxy_requests WHERE session_id = ?",
  ).get(sessionId) as { cnt: number } | undefined;
  const hasProxyData = (proxyRow?.cnt ?? 0) > 0;

  return {
    sessionId,
    tool: (sessionRow.tool as string) ?? "claude",
    project: (sessionRow.project as string) ?? "",
    cwd: (sessionRow.cwd as string) ?? "",
    title,
    firstEventAt: (sessionRow.first_event_at as string) ?? "",
    lastEventAt: (sessionRow.last_event_at as string) ?? "",

    totalLlmCalls,
    totalToolCalls,
    peakContext,
    totalCacheRead,
    totalCacheWrite,
    totalFreshIn,
    totalFreshOut,
    lastContext,
    systemErrorCount,
    compactionCount,
    modelBreakdown,
    toolDistribution,

    hasProxyData,
    hasJsonlSource: true,

    subAgentCount: subAgents.length,
    subAgents,

    turns,
    interTurnBlocks,
    compactEvents,
  };
}

// ─── Sub-agent drilldown ──────────────────────────────────────────────────────
// Parses a sub-agent JSONL as a standalone SessionDrilldown so the frontend
// can display it with the same components as a regular session.

export async function parseSubAgentDrilldown(
  parentSourceFile: string,
  agentFileId: string,
): Promise<SessionDrilldown> {
  const sessionBase = basename(parentSourceFile, ".jsonl");
  const subagentsDir = join(dirname(parentSourceFile), sessionBase, "subagents");
  const agentPath = join(subagentsDir, `agent-${agentFileId}.jsonl`);
  const metaPath  = join(subagentsDir, `agent-${agentFileId}.meta.json`);

  if (!existsSync(agentPath)) {
    throw Object.assign(new Error(`sub-agent file not found: agent-${agentFileId}.jsonl`), { status: 404 });
  }

  let agentType = "unknown";
  let description = "";
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { agentType?: string; description?: string };
      agentType   = meta.agentType   ?? "unknown";
      description = meta.description ?? "";
    } catch { /* ignore */ }
  }

  // Re-use the core parser with a synthetic sessionRow.
  // The sub-agent JSONL is in the same format as the parent session JSONL.
  const fakeRow: Record<string, unknown> = {
    tool:             "claude",
    project:          description || agentType,
    cwd:              "",
    custom_title:     description || null,
    ai_title:         agentType !== "unknown" ? agentType : null,
    first_event_at:   "",
    last_event_at:    "",
    system_error_count: 0,
  };

  // parseSessionDrilldown expects a DB for proxy lookups; sub-agents have none.
  // We pass a minimal stub — proxy will be empty (null for every call).
  const stubDb = {
    prepare: () => ({ all: () => [], get: () => undefined }),
  } as unknown as import("better-sqlite3").Database;

  return parseSessionDrilldown(agentPath, `subagent:${agentFileId}`, fakeRow, stubDb, {
    treatSidechainAsMain: true,
  });
}
