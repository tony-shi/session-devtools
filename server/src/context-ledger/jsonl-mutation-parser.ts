import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ContentRef,
  ContextMutation,
  HarnessRuntimeSnapshot,
  MutationSourceRef,
  MutationType,
  SegmentCategory,
} from "./types";

// ── 输入 / 输出 ────────────────────────────────────────────────────────────────

export interface ParseJsonlOptions {
  jsonlFile?: string;
  sessionId?: string;
}

export interface UnknownJsonlLine {
  line: number;
  type?: string;
  subtype?: string;
  attachmentType?: string;
  reason: string;
}

export interface JsonlMutationParseResult {
  mutations: ContextMutation[];
  // sidechain（subagent）transcript 行不能并入父会话 expected context，
  // 单独路由到这里。父会话对账只看 mutations；subagent 对账拿 sidechainMutations。
  sidechainMutations: ContextMutation[];
  unknownLines: UnknownJsonlLine[];
  sessionId: string;
  // TODO(prior-session-prefix): --resume 场景下，若 JSONL 文件中第一条有时间戳的
  // user/assistant 行之前出现了 last-prompt 条目，说明 prefix 缺少历史 turn。
  // 经 Claude Code 2.1.x 全量本地扫描（244 个 JSONL），此场景从未出现：
  // last-prompt 始终由 Claude Code 在 query 结束时 append，不会出现在文件头部。
  // 如未来出现此场景，需在此处恢复检测逻辑，并在 reconcile 层降级 order_mismatch 告警。
  // 从 assistant mutations 的 message.model 字段推断的模型名。
  // 只有 JSONL 包含 assistant 行时才有值；proxy snapshot 的 model 字段来自请求参数，
  // 两者一致时可互相验证；不一致时 targetRequest 优先用 JSONL 推断值。
  inferredModel?: string;
  // 第一版 HarnessRuntimeSnapshot，由 JSONL 可提取的字段填充。
  // proxy snapshot 不参与此快照的构建。
  runtimeSnapshot: HarnessRuntimeSnapshot;
}

// ── Claude Code session.jsonl 形状 ────────────────────────────────────────────
// 仅描述 parser 用到的字段，避免把 harness 的所有可选字段都搬进来。
//
// TODO(unsupported): hook subtype 除 stop_hook_summary 之外（如 pre_prompt、
//   post_tool_use 等）当前未拆分 category；落到 hook_event 兜底分支。
// thinking / redacted_thinking block 字段名按 Anthropic API 真实形状（thinking
// 用 `thinking`，redacted_thinking 用 `data`），4 个 fixture 不覆盖，由合成
// 测试验证。

interface JsonlMessageBlock {
  type?: string;
  // text block 用 text；thinking 用 thinking；redacted_thinking 用 data
  // 参考 restored-src/src/utils/messages.ts:getAssistantMessageContentLength。
  text?: string;
  thinking?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
}

interface JsonlMessage {
  id?: string;
  role?: string;
  model?: string;
  content?: string | JsonlMessageBlock[];
}

interface JsonlAttachment {
  type?: string;
  content?: unknown;
  // queued_command 的消息文本在 prompt 字段（不是 content），参考 binary T27 函数
  prompt?: string | Array<{ type?: string; text?: string }>;
  skillCount?: number;
  itemCount?: number;
  isInitial?: boolean;
  // type=file / already_read_file：文件绝对路径（attachments.ts AlreadyReadFileAttachment / FileAttachment）
  filename?: string;
  // type=file：文件内容超过 MAX_LINES_TO_READ(2000) 时为 true（attachments.ts:3163）
  truncated?: boolean;
}

interface JsonlRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  promptId?: string;
  sessionId?: string;
  timestamp?: string;
  message?: JsonlMessage;
  attachment?: JsonlAttachment;
  // Compact 标记：isCompactSummary=true 时摘要正文在 message.content（string 或
  // 含 text block 的数组），不存在顶层 compactSummaryText 字段。参考
  // restored-src/src/services/compact/compact.ts createUserMessage(...) 调用。
  isCompactSummary?: boolean;
  // sidechain：subagent transcript 在父会话日志里的影子记录。
  // 父会话 expected context 不应包含这些消息。参考 restored-src/src/types/logs.ts
  // 与 utils/stats.ts 中所有 !m.isSidechain 过滤位点。
  isSidechain?: boolean;
  // isMeta：harness 在每次 user turn 头部注入的 system-reminder / caveat message。
  // 参考 restored-src/src/utils/messages.ts createUserMessage { isMeta }。
  // QueryEngine.ts:469 里明确 skip isMeta message（不计入 token 统计）。
  isMeta?: boolean;
  // isApiErrorMessage：assistant message 是 harness 合成的错误展示行（非真实 API response）。
  // 参考 restored-src/src/utils/messages.ts createApiErrorMessage（isApiErrorMessage=true）。
  // 在 proxy 里不会出现，用于标记 reconstructor 应跳过。
  isApiErrorMessage?: boolean;
  agentId?: string;
  // permission-mode
  permissionMode?: string;
  // worktree-state / file-history-snapshot / last-prompt 等留给 unknownLines
  // system 子型
  hookCount?: number;
  hookInfos?: unknown[];
  hookErrors?: unknown[];
  preventedContinuation?: boolean;
  stopReason?: string;
  cause?: unknown;
  retryAttempt?: number;
  durationMs?: number;
  messageCount?: number;
  content?: string;
  // Claude Code 2.x 在多类 JSONL 行顶层重复写入的运行态事实。
  // 这些字段不是 conversation message 内容，但可作为 system prompt rule
  // preCondition 的事实输入；优先级高于旧 sourcemap 推断。
  userType?: "external" | "ant" | "unknown";
  entrypoint?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("\n");
  }
  return "";
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function inlineRef(text: string): ContentRef {
  return { kind: "inline", text, charCount: text.length };
}

function makeJsonlRef(
  file: string,
  line: number,
  uuid: string | undefined,
  fieldPath?: string,
): MutationSourceRef {
  const jsonl: { file: string; line: number; uuid?: string; fieldPath?: string } = {
    file,
    line,
  };
  if (uuid) jsonl.uuid = uuid;
  if (fieldPath) jsonl.fieldPath = fieldPath;
  return { kind: "jsonl", jsonl };
}

function stringifyToolResultContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as Array<{ text?: string }>).map((x) => x?.text ?? "").join("\n");
  }
  if (c == null) return "";
  return JSON.stringify(c);
}

// Claude Code harness 在 user message 的 string content 里注入终端命令上下文。
// 触发标签是固定前缀，不是启发式文本匹配。参考 docs 与 proxy-snapshot-parser
// 里 classifyTextBlock 的同款判定逻辑。
const LOCAL_COMMAND_HEAD_RE =
  /^(?:<local-command-(?:caveat|stdout|stderr)>|<bash-(?:input|stdout|stderr)>|<command-name>|<command-message>|<command-args>)/;

function classifyUserText(text: string): SegmentCategory {
  if (LOCAL_COMMAND_HEAD_RE.test(text.trimStart())) return "local_command_history";
  return "user_message";
}

function pruneMetadata(meta: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(meta)) {
    const v = meta[k];
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

export function parseClaudeJsonlMutations(
  input: string | string[],
  opts: ParseJsonlOptions = {},
): JsonlMutationParseResult {
  const file = opts.jsonlFile ?? "session.jsonl";
  const lines = Array.isArray(input) ? input : input.split(/\r?\n/);
  const mutations: ContextMutation[] = [];
  const sidechainMutations: ContextMutation[] = [];
  const unknownLines: UnknownJsonlLine[] = [];
  let sessionId = opts.sessionId ?? "unknown";
  let counter = 0;
  const runtimeFacts: Partial<HarnessRuntimeSnapshot> = {};

  // 当前正在处理的行：sidechain / agentId 决定 mutation 路由与 subagentId。
  let currentIsSidechain = false;
  let currentAgentId: string | undefined;

  const newMutation = (
    partial: Omit<ContextMutation, "id" | "agentKind" | "sessionId">,
  ): ContextMutation => {
    counter += 1;
    return {
      id: `cmut-${counter}`,
      agentKind: "claude-code",
      sessionId,
      ...partial,
    };
  };

  const pushMutation = (
    type: MutationType,
    category: SegmentCategory,
    sourceRef: MutationSourceRef,
    extras: {
      timestamp?: string;
      contentRef?: ContentRef;
      toolUseId?: string;
      charDeltaEstimate?: number;
      metadata?: Record<string, unknown>;
      confidence?: ContextMutation["confidence"];
    } = {},
  ): void => {
    const baseMeta = extras.metadata ?? {};
    const meta = currentIsSidechain
      ? { ...baseMeta, isSidechain: true }
      : baseMeta;
    const m = newMutation({
      type,
      category,
      source: "jsonl",
      sourceRef,
      confidence: extras.confidence ?? "exact",
      ...(extras.timestamp ? { timestamp: extras.timestamp } : {}),
      ...(extras.contentRef ? { contentRef: extras.contentRef } : {}),
      ...(extras.toolUseId ? { toolUseId: extras.toolUseId } : {}),
      ...(currentIsSidechain && currentAgentId
        ? { subagentId: currentAgentId }
        : {}),
      ...(extras.charDeltaEstimate !== undefined
        ? { charDeltaEstimate: extras.charDeltaEstimate }
        : {}),
      ...(Object.keys(meta).length ? { metadata: pruneMetadata(meta) } : {}),
    });
    if (currentIsSidechain) sidechainMutations.push(m);
    else mutations.push(m);
  };

  for (let li = 0; li < lines.length; li++) {
    const lineNum = li + 1;
    const raw = lines[li];
    if (!raw || !raw.trim()) continue;

    let rec: JsonlRecord;
    try {
      rec = JSON.parse(raw) as JsonlRecord;
    } catch {
      unknownLines.push({ line: lineNum, reason: "json_parse_error" });
      continue;
    }

    if (rec.sessionId && sessionId === "unknown") sessionId = rec.sessionId;
    absorbRuntimeFacts(rec, runtimeFacts);

    const t = rec.type ?? "";
    const ts = rec.timestamp;
    const uuid = rec.uuid;

    // sidechain 路由开关：本行所有 push 出去的 mutation 都会进
    // sidechainMutations 而不是 mutations。subagentId 从 record.agentId 取。
    currentIsSidechain = rec.isSidechain === true;
    currentAgentId = rec.agentId;

    // Compaction 优先级最高：真实 Claude Code 的 compact 摘要是
    // createUserMessage({ content: <string>, isCompactSummary: true })，
    // 摘要正文在 message.content（string 或含 text block 的数组）。
    // 参考 restored-src/src/services/compact/compact.ts:614 与
    //      restored-src/src/services/compact/sessionMemoryCompact.ts:478。
    if (rec.isCompactSummary === true) {
      const text = extractMessageText(rec.message?.content);
      pushMutation(
        "compact",
        "compaction",
        makeJsonlRef(file, lineNum, uuid, "message.content"),
        {
          timestamp: ts,
          contentRef: text ? inlineRef(text) : undefined,
          charDeltaEstimate: text.length,
          metadata: {
            parentUuid: rec.parentUuid ?? undefined,
            recordType: t,
          },
        },
      );
      continue;
    }

    switch (t) {
      case "user": {
        handleUserRecord(rec, lineNum, file, uuid, ts, pushMutation, unknownLines);
        break;
      }
      case "assistant": {
        handleAssistantRecord(rec, lineNum, file, uuid, ts, pushMutation, unknownLines);
        break;
      }
      case "attachment": {
        handleAttachment(rec, lineNum, file, uuid, ts, pushMutation, unknownLines);
        break;
      }
      case "system": {
        handleSystem(rec, lineNum, file, uuid, ts, pushMutation, unknownLines);
        break;
      }
      case "permission-mode": {
        const mode = rec.permissionMode ?? "";
        pushMutation(
          "inject",
          "permission",
          makeJsonlRef(file, lineNum, undefined, "permissionMode"),
          {
            timestamp: ts,
            contentRef: inlineRef(mode),
            metadata: { permissionMode: mode },
          },
        );
        break;
      }
      case "worktree-state":
      case "file-history-snapshot":
      case "last-prompt": {
        // 这些是 harness 内部状态，不直接修改 context window，留给 unknownLines
        // 让上层规则层决定是否要把它们映射成 mutation。
        unknownLines.push({ line: lineNum, type: t, reason: `harness_state_${t}` });
        break;
      }
      default: {
        unknownLines.push({
          line: lineNum,
          type: t || "missing",
          reason: "unrecognized_top_level_type",
        });
      }
    }
  }

  // 从 assistant mutations 的 metadata.model 推断使用的模型名。
  // 取最后一条有 model 字段的 assistant mutation（最近的响应最能代表实际用的 model）。
  let inferredModel: string | undefined;
  for (let i = mutations.length - 1; i >= 0; i--) {
    const m = mutations[i];
    if (m.category === "assistant_text" || m.category === "tool_use") {
      const model = m.metadata?.["model"];
      if (typeof model === "string" && model.length > 0) {
        inferredModel = model;
        break;
      }
    }
  }

  const runtimeSnapshot = buildRuntimeSnapshotFromJsonl({
    mutations,
    sessionId,
    inferredModel,
    jsonlFile: file,
    runtimeFacts,
  });

  return { mutations, sidechainMutations, unknownLines, sessionId, inferredModel, runtimeSnapshot };
}

function absorbRuntimeFacts(
  rec: JsonlRecord,
  facts: Partial<HarnessRuntimeSnapshot>,
): void {
  if (
    rec.userType === "external" ||
    rec.userType === "ant" ||
    rec.userType === "unknown"
  ) {
    facts.userType = rec.userType;
  }
  if (typeof rec.entrypoint === "string" && rec.entrypoint.length > 0) {
    facts.entrypoint = rec.entrypoint;
  }
  if (typeof rec.cwd === "string" && rec.cwd.length > 0) {
    facts.cwd = rec.cwd;
    facts.autoMemoryPath = defaultAutoMemoryPath(rec.cwd);
    facts.featureFlags = {
      ...(facts.featureFlags ?? {}),
      // 2.1.126 external CLI 默认启用 auto memory；若未来 JSONL 暴露显式禁用信号，
      // 应在这里覆盖为 false，避免 materializer 继续生成该 section。
      "isAutoMemoryEnabled()": true,
    };
  }
  if (typeof rec.version === "string" && rec.version.length > 0) {
    facts.claudeCodeVersion = rec.version;
  }

  // 注意：Claude Code 2.1.126 的 JSONL 不显式记录默认 output style。
  // 对外部 CLI 来说，缺省即 standard intro；若未来 JSONL 出现自定义
  // output style 字段，应在这里覆盖为非 null，而不是让 rule evaluator 猜测。
  const settings = (facts.settings ?? {}) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(settings, "outputStyleConfig")) {
    settings.outputStyleConfig = null;
  }
  facts.settings = settings;
}

function defaultAutoMemoryPath(cwd: string): string {
  const sanitizedCwd = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", sanitizedCwd, "memory") + "/";
}

// ── HarnessRuntimeSnapshot 构建 ───────────────────────────────────────────────

interface RuntimeSnapshotInput {
  mutations: ContextMutation[];
  sessionId: string;
  inferredModel: string | undefined;
  jsonlFile: string;
  runtimeFacts?: Partial<HarnessRuntimeSnapshot>;
}

// 从 JSONL 解析结果填充第一版 HarnessRuntimeSnapshot。
// 只消费 JSONL 内可直接提取的字段；proxy snapshot 不参与此函数。
// 未知字段显式留 undefined——调用方不得假定未填字段有业务默认值。
export function buildRuntimeSnapshotFromJsonl(
  input: RuntimeSnapshotInput,
): HarnessRuntimeSnapshot {
  const { mutations, sessionId, inferredModel, jsonlFile, runtimeFacts } = input;

  // permission-mode：取最后一条（最近一次授权最具代表性）
  let permissionMode: string | undefined;
  for (let i = mutations.length - 1; i >= 0; i--) {
    const m = mutations[i];
    if (m.category === "permission" && typeof m.metadata?.permissionMode === "string") {
      permissionMode = m.metadata.permissionMode as string;
      break;
    }
  }

  // firstTimestamp：取第一条有 timestamp 的 mutation
  let firstTimestamp: string | undefined;
  for (const m of mutations) {
    if (m.timestamp) {
      firstTimestamp = m.timestamp;
      break;
    }
  }

  const snapshot: HarnessRuntimeSnapshot = {
    source: "jsonl",
    ...(inferredModel !== undefined ? { inferredModel } : {}),
    ...(jsonlFile ? { jsonlFile } : {}),
    ...(sessionId && sessionId !== "unknown" ? { sessionId } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(firstTimestamp !== undefined ? { firstTimestamp } : {}),
    ...(runtimeFacts?.claudeCodeVersion !== undefined
      ? { claudeCodeVersion: runtimeFacts.claudeCodeVersion }
      : {}),
    ...(runtimeFacts?.entrypoint !== undefined ? { entrypoint: runtimeFacts.entrypoint } : {}),
    ...(runtimeFacts?.cwd !== undefined ? { cwd: runtimeFacts.cwd } : {}),
    ...(runtimeFacts?.userType !== undefined ? { userType: runtimeFacts.userType } : {}),
    ...(runtimeFacts?.autoMemoryPath !== undefined
      ? { autoMemoryPath: runtimeFacts.autoMemoryPath }
      : {}),
    ...(runtimeFacts?.settings !== undefined ? { settings: runtimeFacts.settings } : {}),
    ...(runtimeFacts?.featureFlags !== undefined ? { featureFlags: runtimeFacts.featureFlags } : {}),
    // 以下字段第一版仍无法从 JSONL 读取，留 undefined，由后续 local_env / derived 源补充：
    // enabledToolNames / mcpToolNames / autoMemoryEnabled / autoMemoryPath / featureFlags
  };

  return snapshot;
}

// ── user 行 ─────────────────────────────────────────────────────────────────

function handleUserRecord(
  rec: JsonlRecord,
  lineNum: number,
  file: string,
  uuid: string | undefined,
  ts: string | undefined,
  push: PushMutation,
  unknownLines: UnknownJsonlLine[],
): void {
  const msg = rec.message;
  if (!msg) {
    unknownLines.push({ line: lineNum, type: "user", reason: "user_record_missing_message" });
    return;
  }
  const content = msg.content;

  if (typeof content === "string") {
    const cat = classifyUserText(content);
    push("append", cat, makeJsonlRef(file, lineNum, uuid, "message.content"), {
      timestamp: ts,
      contentRef: inlineRef(content),
      charDeltaEstimate: content.length,
      metadata: {
        parentUuid: rec.parentUuid ?? undefined,
        promptId: rec.promptId,
        messageId: msg.id,
        ...(rec.isMeta ? { isMeta: true } : {}),
      },
    });
    return;
  }

  if (Array.isArray(content)) {
    for (let bi = 0; bi < content.length; bi++) {
      const blk = content[bi] ?? {};
      const fieldPath = `message.content[${bi}]`;
      if (blk.type === "tool_result") {
        const text = stringifyToolResultContent(blk.content);
        push("append", "tool_result", makeJsonlRef(file, lineNum, uuid, fieldPath), {
          timestamp: ts,
          toolUseId: blk.tool_use_id,
          contentRef: inlineRef(text),
          charDeltaEstimate: text.length,
          metadata: {
            isError: blk.is_error ?? false,
            parentUuid: rec.parentUuid ?? undefined,
            // P1-2：recordUuid 是本条 user message JSONL record 的 uuid，
            // 供 task_reminder post-processing 通过 task_reminder.parentUuid 匹配
            recordUuid: uuid ?? undefined,
            promptId: rec.promptId,
            messageId: msg.id,
            ...(rec.isMeta ? { isMeta: true } : {}),
          },
        });
      } else if (blk.type === "text") {
        const text = blk.text ?? "";
        const cat = classifyUserText(text);
        push("append", cat, makeJsonlRef(file, lineNum, uuid, fieldPath), {
          timestamp: ts,
          contentRef: inlineRef(text),
          charDeltaEstimate: text.length,
          metadata: {
            parentUuid: rec.parentUuid ?? undefined,
            promptId: rec.promptId,
            messageId: msg.id,
            ...(rec.isMeta ? { isMeta: true } : {}),
          },
        });
      } else {
        unknownLines.push({
          line: lineNum,
          type: "user",
          reason: `user_block_type_${blk.type ?? "missing"}`,
        });
      }
    }
    return;
  }

  unknownLines.push({ line: lineNum, type: "user", reason: "user_content_unrecognized" });
}

// ── assistant 行 ────────────────────────────────────────────────────────────

function handleAssistantRecord(
  rec: JsonlRecord,
  lineNum: number,
  file: string,
  uuid: string | undefined,
  ts: string | undefined,
  push: PushMutation,
  unknownLines: UnknownJsonlLine[],
): void {
  const msg = rec.message;
  if (!msg || !Array.isArray(msg.content)) {
    unknownLines.push({
      line: lineNum,
      type: "assistant",
      reason: "assistant_content_unrecognized",
    });
    return;
  }
  for (let bi = 0; bi < msg.content.length; bi++) {
    const blk = msg.content[bi] ?? {};
    const fieldPath = `message.content[${bi}]`;
    if (blk.type === "text") {
      const text = blk.text ?? "";
      push("append", "assistant_text", makeJsonlRef(file, lineNum, uuid, fieldPath), {
        timestamp: ts,
        contentRef: inlineRef(text),
        charDeltaEstimate: text.length,
        metadata: {
          messageId: msg.id,
          model: msg.model,
          parentUuid: rec.parentUuid ?? undefined,
          ...(rec.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
        },
      });
    } else if (blk.type === "tool_use") {
      const inputJson = JSON.stringify(blk.input ?? null);
      push("append", "tool_use", makeJsonlRef(file, lineNum, uuid, fieldPath), {
        timestamp: ts,
        toolUseId: blk.id,
        contentRef: { kind: "inline", text: inputJson, charCount: inputJson.length },
        charDeltaEstimate: inputJson.length,
        metadata: {
          toolName: blk.name,
          messageId: msg.id,
          model: msg.model,
          parentUuid: rec.parentUuid ?? undefined,
          ...(rec.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
        },
      });
    } else if (blk.type === "thinking" || blk.type === "redacted_thinking") {
      // Anthropic 的 thinking block 用 `thinking` 字段，redacted_thinking 用
      // `data` 字段（不是 `text`）。参考 restored-src/src/utils/messages.ts
      // getAssistantMessageContentLength 与 utils/tokens.ts。
      const text =
        blk.type === "thinking" ? (blk.thinking ?? "") : (blk.data ?? "");
      push("append", "thinking", makeJsonlRef(file, lineNum, uuid, fieldPath), {
        timestamp: ts,
        contentRef: inlineRef(text),
        charDeltaEstimate: text.length,
        metadata: {
          redacted: blk.type === "redacted_thinking",
          messageId: msg.id,
          parentUuid: rec.parentUuid ?? undefined,
          ...(rec.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
        },
      });
    } else {
      unknownLines.push({
        line: lineNum,
        type: "assistant",
        reason: `assistant_block_type_${blk.type ?? "missing"}`,
      });
    }
  }
}

// ── attachment 行 ────────────────────────────────────────────────────────────

function handleAttachment(
  rec: JsonlRecord,
  lineNum: number,
  file: string,
  uuid: string | undefined,
  ts: string | undefined,
  push: PushMutation,
  unknownLines: UnknownJsonlLine[],
): void {
  const att = rec.attachment ?? {};
  const at = att.type ?? "";

  // queued_command 的消息文本在 att.prompt（string 或 text-block array），其余类型用 att.content。
  const rawContent = at === "queued_command" ? att.prompt : att.content;
  const text =
    typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
        ? (rawContent as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text ?? "")
            .join("\n") || JSON.stringify(rawContent)
        : rawContent == null
          ? ""
          : JSON.stringify(rawContent);

  let category: SegmentCategory;
  let confidence: ContextMutation["confidence"] = "exact";
  if (at === "skill_listing") {
    category = "skill_listing";
  } else if (at === "task_reminder") {
    category = "attachment";
  } else if (at === "queued_command") {
    category = "attachment";
  } else if (at === "file") {
    // sourcemap: attachments.ts generateFileAttachment → case 'file'（messages.ts:3545）
    // normalizeAttachmentForAPI 对 type=file 生成：
    //   (1) createToolUseMessage("Read", {file_path})  → wrapMessagesInSystemReminder
    //   (2) createToolResultMessage(FileReadTool, content) → wrapMessagesInSystemReminder
    //   (3) 若 truncated：createUserMessage(truncation note) → wrapMessagesInSystemReminder
    // reconstructor 需要这三段的原始文件内容，不能用 JSON.stringify(att.content)。
    // 此处把 filename / 文件原文 / truncated 标记存入 metadata，contentRef.text 存文件原文。
    const fileContent = att.content as { type?: string; file?: { content?: string; numLines?: number; startLine?: number } } | undefined;
    const fileText = fileContent?.file?.content ?? "";
    const numLines = fileContent?.file?.numLines ?? 0;
    // startLine：FileReadTool 输出行号从此值开始（通常为 1，offset 读取时可能不同）
    const startLine = fileContent?.file?.startLine ?? 1;
    const truncated = att.truncated === true;
    category = "attachment";
    push("inject", category, makeJsonlRef(file, lineNum, uuid, "attachment"), {
      timestamp: ts,
      contentRef: inlineRef(fileText),
      charDeltaEstimate: fileText.length,
      confidence: "exact",
      metadata: {
        attachmentType: at,
        fileAttachmentFilename: att.filename as string | undefined,
        fileAttachmentNumLines: numLines,
        fileAttachmentStartLine: startLine,
        fileAttachmentTruncated: truncated || undefined,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
    return; // 已经 push，避免走到下方通用 push
  } else {
    category = "attachment";
    confidence = "estimated";
    unknownLines.push({
      line: lineNum,
      type: "attachment",
      attachmentType: at,
      reason: "attachment_unknown_subtype",
    });
  }

  push("inject", category, makeJsonlRef(file, lineNum, uuid, "attachment"), {
    timestamp: ts,
    contentRef: inlineRef(text),
    charDeltaEstimate: text.length,
    confidence,
    metadata: {
      attachmentType: at,
      skillCount: att.skillCount,
      itemCount: att.itemCount,
      isInitial: att.isInitial,
      parentUuid: rec.parentUuid ?? undefined,
    },
  });
}

// ── system 行 ────────────────────────────────────────────────────────────────

function handleSystem(
  rec: JsonlRecord,
  lineNum: number,
  file: string,
  uuid: string | undefined,
  ts: string | undefined,
  push: PushMutation,
  unknownLines: UnknownJsonlLine[],
): void {
  const st = rec.subtype ?? "";
  const ref = makeJsonlRef(file, lineNum, uuid, `subtype:${st}`);

  if (st === "stop_hook_summary") {
    const summary = JSON.stringify({
      hookCount: rec.hookCount,
      hookInfos: rec.hookInfos,
      hookErrors: rec.hookErrors,
      preventedContinuation: rec.preventedContinuation,
      stopReason: rec.stopReason,
    });
    push("inject", "hook_event", ref, {
      timestamp: ts,
      contentRef: inlineRef(summary),
      metadata: {
        systemSubtype: st,
        hookCount: rec.hookCount,
        preventedContinuation: rec.preventedContinuation,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
    return;
  }

  if (st === "api_error") {
    // api_error 不增加 context window，只是传输层事件。
    // 用 type=noise + category=hook_event 让上层规则层可以识别且过滤。
    // syntheticApiError=true 标记供 reconstructor rule 区分，不作为普通 assistant_text 进入 expected。
    const summary = JSON.stringify({ cause: rec.cause, retryAttempt: rec.retryAttempt });
    push("noise", "hook_event", ref, {
      timestamp: ts,
      contentRef: inlineRef(summary),
      confidence: "estimated",
      metadata: {
        systemSubtype: st,
        syntheticApiError: true,
        retryAttempt: rec.retryAttempt,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
    return;
  }

  if (st === "turn_duration" || st === "away_summary") {
    const summary = JSON.stringify({
      subtype: st,
      durationMs: rec.durationMs,
      messageCount: rec.messageCount,
      content: rec.content,
    });
    push("noise", "unknown", ref, {
      timestamp: ts,
      contentRef: inlineRef(summary),
      confidence: "estimated",
      metadata: {
        systemSubtype: st,
        durationMs: rec.durationMs,
        messageCount: rec.messageCount,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
    return;
  }

  unknownLines.push({
    line: lineNum,
    type: "system",
    subtype: st,
    reason: `system_subtype_${st || "missing"}`,
  });
}

// ── push 函数类型（避免在 handler 函数签名里重复书写） ─────────────────────────

type PushMutation = (
  type: MutationType,
  category: SegmentCategory,
  sourceRef: MutationSourceRef,
  extras?: {
    timestamp?: string;
    contentRef?: ContentRef;
    toolUseId?: string;
    charDeltaEstimate?: number;
    metadata?: Record<string, unknown>;
    confidence?: ContextMutation["confidence"];
  },
) => void;

// ── 配对辅助（test/上层使用） ─────────────────────────────────────────────────

export interface ToolUsePairingResult {
  paired: Array<{ toolUseId: string; useMutationId: string; resultMutationId: string }>;
  unmatchedUses: string[];
  unmatchedResults: string[];
}

export function pairToolUseAndResult(
  mutations: ContextMutation[],
): ToolUsePairingResult {
  const uses = new Map<string, ContextMutation>();
  const results = new Map<string, ContextMutation[]>();

  for (const m of mutations) {
    if (!m.toolUseId) continue;
    if (m.category === "tool_use") {
      uses.set(m.toolUseId, m);
    } else if (m.category === "tool_result") {
      const arr = results.get(m.toolUseId) ?? [];
      arr.push(m);
      results.set(m.toolUseId, arr);
    }
  }

  const paired: ToolUsePairingResult["paired"] = [];
  const unmatchedUses: string[] = [];
  for (const [id, useM] of uses) {
    const rs = results.get(id);
    if (rs && rs.length) {
      // 一次 tool_use 对应一次 tool_result（fixture 里没有重发场景）
      paired.push({ toolUseId: id, useMutationId: useM.id, resultMutationId: rs[0].id });
    } else {
      unmatchedUses.push(id);
    }
  }
  const unmatchedResults: string[] = [];
  for (const [id] of results) {
    if (!uses.has(id)) unmatchedResults.push(id);
  }

  return { paired, unmatchedUses, unmatchedResults };
}
