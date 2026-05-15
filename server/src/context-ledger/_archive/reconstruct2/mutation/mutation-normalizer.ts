// reconstruct2 / mutation / mutation-normalizer
//
// 把 ClaudeJsonlEvent[] 转换为 ContextMutation[]，并回写 line ledger 的
// mutationIds / 临时 disposition。本步骤不做 frame 切片——frame builder 在
// 下一步从 mutation/event 序列推断 LLM call boundary，再回填最终 disposition。
//
// 与旧 jsonl-mutation-parser.ts 的关系：
//   - 第一阶段我们故意不复用旧函数，避免把"过滤/合并"半语义偷渡进 layer 1。
//   - mutation 的字段沿用 ContextMutation（导出类型不变），便于 audit UI 复用。
//   - 已实现的语义集合与旧 parser 对齐（user / assistant / attachment / system /
//     compact / permission）；retry 对齐 / R6 噪声合并放到 layer 2。
//
// 字段语义参考：
//   - restored-src/src/utils/messages.ts            text/thinking/tool_use 块
//   - restored-src/src/services/compact/compact.ts  isCompactSummary
//   - restored-src/src/services/attachments.ts      attachment.type 分支

import type {
  ClaudeJsonlEvent,
  JsonlLineLedgerEntry,
} from "../jsonl/event-types";
import type {
  ContentRef,
  ContextMutation,
  MutationSourceRef,
  MutationType,
  SegmentCategory,
} from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// 输入 / 输出
// ─────────────────────────────────────────────────────────────────────────────

export interface NormalizeInput {
  events: ClaudeJsonlEvent[];
  /** event-decoder 透传的 raw record（key=eventId） */
  rawRecords: Map<string, unknown>;
  ledger: JsonlLineLedgerEntry[];
  jsonlFile: string;
  sessionId: string;
}

export interface NormalizeResult {
  mutations: ContextMutation[];
  sidechainMutations: ContextMutation[];
  /** mutationId → eventId 反查 */
  mutationToEvent: Map<string, string>;
  /** eventId → mutationIds */
  eventToMutations: Map<string, string[]>;
  /** 推断的最终 model（最后一条 assistant 的 message.model） */
  inferredModel?: string;
  /** 最早 timestamp（assistant 优先） */
  firstTimestamp?: string;
  /** 最近一次 permission-mode 的值 */
  lastPermissionMode?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具：raw record 形状最小子集
// ─────────────────────────────────────────────────────────────────────────────

interface RawJsonlMessageBlock {
  type?: string;
  text?: string;
  thinking?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface RawJsonlMessage {
  id?: string;
  role?: string;
  model?: string;
  content?: string | RawJsonlMessageBlock[];
}

interface RawJsonlAttachment {
  type?: string;
  content?: unknown;
  prompt?: string | Array<{ type?: string; text?: string }>;
  skillCount?: number;
  itemCount?: number;
  isInitial?: boolean;
  filename?: string;
  truncated?: boolean;
}

interface RawJsonlRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  promptId?: string;
  sessionId?: string;
  timestamp?: string;
  message?: RawJsonlMessage;
  attachment?: RawJsonlAttachment;
  isCompactSummary?: boolean;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  agentId?: string;
  permissionMode?: string;
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
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_COMMAND_HEAD_RE =
  /^(?:<local-command-(?:caveat|stdout|stderr)>|<bash-(?:input|stdout|stderr)>|<command-name>|<command-message>|<command-args>)/;

function classifyUserText(text: string): SegmentCategory {
  if (LOCAL_COMMAND_HEAD_RE.test(text.trimStart())) return "local_command_history";
  return "user_message";
}

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

function stringifyToolResultContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as Array<{ text?: string }>).map((x) => x?.text ?? "").join("\n");
  }
  if (c == null) return "";
  return JSON.stringify(c);
}

function pruneMetadata(
  meta: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(meta)) {
    const v = meta[k];
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeMutations(input: NormalizeInput): NormalizeResult {
  const { events, rawRecords, ledger, jsonlFile, sessionId } = input;
  const ledgerByLine = new Map<number, JsonlLineLedgerEntry>();
  for (const entry of ledger) ledgerByLine.set(entry.line, entry);

  const mutations: ContextMutation[] = [];
  const sidechainMutations: ContextMutation[] = [];
  const mutationToEvent = new Map<string, string>();
  const eventToMutations = new Map<string, string[]>();

  let counter = 0;
  let inferredModel: string | undefined;
  let firstTimestamp: string | undefined;
  let lastPermissionMode: string | undefined;

  const newId = (): string => {
    counter += 1;
    return `cmut2-${counter}`;
  };

  // 把单条 mutation 落入对应 bucket，并回写 ledger。
  const emit = (
    event: ClaudeJsonlEvent,
    type: MutationType,
    category: SegmentCategory,
    sourceRef: MutationSourceRef,
    extras: {
      contentRef?: ContentRef;
      toolUseId?: string;
      charDeltaEstimate?: number;
      metadata?: Record<string, unknown>;
      confidence?: ContextMutation["confidence"];
    } = {},
  ): ContextMutation => {
    const baseMeta = extras.metadata ?? {};
    const meta = event.isSidechain
      ? { ...baseMeta, isSidechain: true }
      : baseMeta;
    // handler 用 "__file__" 占位填 source ref，emit 时替换为真实路径
    const fixedRef: MutationSourceRef =
      sourceRef.kind === "jsonl" && sourceRef.jsonl.file === "__file__"
        ? { ...sourceRef, jsonl: { ...sourceRef.jsonl, file: jsonlFile } }
        : sourceRef;
    const m: ContextMutation = {
      id: newId(),
      agentKind: "claude-code",
      sessionId,
      type,
      category,
      source: "jsonl",
      sourceRef: fixedRef,
      confidence: extras.confidence ?? "definitive",
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
      ...(extras.contentRef ? { contentRef: extras.contentRef } : {}),
      ...(extras.toolUseId ? { toolUseId: extras.toolUseId } : {}),
      ...(event.isSidechain && event.agentId ? { subagentId: event.agentId } : {}),
      ...(extras.charDeltaEstimate !== undefined
        ? { charDeltaEstimate: extras.charDeltaEstimate }
        : {}),
      ...(Object.keys(meta).length ? { metadata: pruneMetadata(meta) } : {}),
    };
    if (event.isSidechain) sidechainMutations.push(m);
    else mutations.push(m);

    mutationToEvent.set(m.id, event.id);
    const list = eventToMutations.get(event.id) ?? [];
    list.push(m.id);
    eventToMutations.set(event.id, list);

    const ledgerEntry = ledgerByLine.get(event.line);
    if (ledgerEntry) ledgerEntry.mutationIds.push(m.id);

    return m;
  };

  for (const event of events) {
    const rec = rawRecords.get(event.id) as RawJsonlRecord | undefined;
    if (!rec) continue;

    if (event.timestamp && firstTimestamp === undefined) {
      firstTimestamp = event.timestamp;
    }

    const ledgerEntry = ledgerByLine.get(event.line);

    // compact summary 优先级最高
    if (event.isCompactSummary) {
      const text = extractMessageText(rec.message?.content);
      const m = emit(
        event,
        "compact",
        "compaction",
        makeJsonlRef(jsonlFile, event.line, event.uuid, "message.content"),
        {
          contentRef: text ? inlineRef(text) : undefined,
          charDeltaEstimate: text.length,
          metadata: {
            parentUuid: rec.parentUuid ?? undefined,
            recordType: rec.type,
          },
        },
      );
      if (ledgerEntry) {
        ledgerEntry.category = m.category;
        ledgerEntry.disposition = "parsed_not_materialized";
        ledgerEntry.reasonCode = "compact_summary";
      }
      continue;
    }

    switch (event.kind) {
      case "user":
        handleUser(event, rec, emit, ledgerEntry);
        break;
      case "assistant": {
        const lastModel = handleAssistant(event, rec, emit, ledgerEntry);
        if (lastModel) inferredModel = lastModel;
        break;
      }
      case "attachment":
        handleAttachment(event, rec, emit, ledgerEntry);
        break;
      case "system":
        handleSystem(event, rec, emit, ledgerEntry);
        break;
      case "permission_mode": {
        // permission-mode 单独处理：记录最近值，不生成 mutation（runtime_fact_only）
        const mode = rec.permissionMode ?? "";
        if (mode) lastPermissionMode = mode;
        if (ledgerEntry) {
          ledgerEntry.disposition = "runtime_fact_only";
          ledgerEntry.reasonCode = "permission_mode_runtime";
          ledgerEntry.metadata = {
            ...(ledgerEntry.metadata ?? {}),
            permissionMode: mode,
          };
        }
        break;
      }
      case "harness_state":
        // worktree-state / file-history-snapshot / last-prompt 暂不生成 mutation
        if (ledgerEntry) {
          ledgerEntry.disposition = "deferred_unimplemented";
          ledgerEntry.reasonCode = `harness_state_${rec.type ?? "unknown"}`;
        }
        break;
      case "unknown":
      default:
        if (ledgerEntry) {
          ledgerEntry.disposition = "unknown_schema";
          ledgerEntry.reasonCode = `unknown_top_level_type_${rec.type ?? "missing"}`;
        }
        break;
    }
  }

  return {
    mutations,
    sidechainMutations,
    mutationToEvent,
    eventToMutations,
    inferredModel,
    firstTimestamp,
    lastPermissionMode,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 各 event kind 处理
// ─────────────────────────────────────────────────────────────────────────────

type EmitFn = (
  event: ClaudeJsonlEvent,
  type: MutationType,
  category: SegmentCategory,
  sourceRef: MutationSourceRef,
  extras?: {
    contentRef?: ContentRef;
    toolUseId?: string;
    charDeltaEstimate?: number;
    metadata?: Record<string, unknown>;
    confidence?: ContextMutation["confidence"];
  },
) => ContextMutation;

function handleUser(
  event: ClaudeJsonlEvent,
  rec: RawJsonlRecord,
  emit: EmitFn,
  ledger: JsonlLineLedgerEntry | undefined,
): void {
  const msg = rec.message;
  if (!msg) {
    if (ledger) {
      ledger.disposition = "unknown_schema";
      ledger.reasonCode = "user_record_missing_message";
    }
    return;
  }
  const content = msg.content;
  let lastCategory: SegmentCategory | undefined;

  if (typeof content === "string") {
    const cat = classifyUserText(content);
    emit(
      event,
      "append",
      cat,
      makeJsonlRef("__file__", event.line, event.uuid, "message.content"),
      {
        contentRef: inlineRef(content),
        charDeltaEstimate: content.length,
        metadata: {
          parentUuid: rec.parentUuid ?? undefined,
          promptId: rec.promptId,
          messageId: msg.id,
          ...(event.isMeta ? { isMeta: true } : {}),
        },
      },
    );
    lastCategory = cat;
  } else if (Array.isArray(content)) {
    for (let bi = 0; bi < content.length; bi++) {
      const blk = content[bi] ?? {};
      const fieldPath = `message.content[${bi}]`;
      if (blk.type === "tool_result") {
        const text = stringifyToolResultContent(blk.content);
        emit(
          event,
          "append",
          "tool_result",
          makeJsonlRef("__file__", event.line, event.uuid, fieldPath),
          {
            toolUseId: blk.tool_use_id,
            contentRef: inlineRef(text),
            charDeltaEstimate: text.length,
            metadata: {
              isError: blk.is_error ?? false,
              parentUuid: rec.parentUuid ?? undefined,
              recordUuid: event.uuid ?? undefined,
              promptId: rec.promptId,
              messageId: msg.id,
              ...(event.isMeta ? { isMeta: true } : {}),
            },
          },
        );
        lastCategory = "tool_result";
      } else if (blk.type === "text") {
        const text = blk.text ?? "";
        const cat = classifyUserText(text);
        emit(
          event,
          "append",
          cat,
          makeJsonlRef("__file__", event.line, event.uuid, fieldPath),
          {
            contentRef: inlineRef(text),
            charDeltaEstimate: text.length,
            metadata: {
              parentUuid: rec.parentUuid ?? undefined,
              promptId: rec.promptId,
              messageId: msg.id,
              ...(event.isMeta ? { isMeta: true } : {}),
            },
          },
        );
        lastCategory = cat;
      } else {
        if (ledger) {
          ledger.disposition = "unknown_schema";
          ledger.reasonCode = `user_block_type_${blk.type ?? "missing"}`;
        }
      }
    }
  } else {
    if (ledger) {
      ledger.disposition = "unknown_schema";
      ledger.reasonCode = "user_content_unrecognized";
    }
    return;
  }

  if (ledger && ledger.disposition !== "unknown_schema") {
    ledger.category = lastCategory;
    ledger.disposition = "parsed_not_materialized";
    ledger.reasonCode = "user_block_emitted";
  }
}

function handleAssistant(
  event: ClaudeJsonlEvent,
  rec: RawJsonlRecord,
  emit: EmitFn,
  ledger: JsonlLineLedgerEntry | undefined,
): string | undefined {
  const msg = rec.message;
  if (!msg || !Array.isArray(msg.content)) {
    if (ledger) {
      ledger.disposition = "unknown_schema";
      ledger.reasonCode = "assistant_content_unrecognized";
    }
    return undefined;
  }

  let modelSeen: string | undefined;
  for (let bi = 0; bi < msg.content.length; bi++) {
    const blk = msg.content[bi] ?? {};
    const fieldPath = `message.content[${bi}]`;
    if (blk.type === "text") {
      const text = blk.text ?? "";
      emit(
        event,
        "append",
        "assistant_text",
        makeJsonlRef("__file__", event.line, event.uuid, fieldPath),
        {
          contentRef: inlineRef(text),
          charDeltaEstimate: text.length,
          metadata: {
            messageId: msg.id,
            model: msg.model,
            parentUuid: rec.parentUuid ?? undefined,
            ...(event.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
          },
        },
      );
      if (msg.model) modelSeen = msg.model;
    } else if (blk.type === "tool_use") {
      const inputJson = JSON.stringify(blk.input ?? null);
      emit(
        event,
        "append",
        "tool_use",
        makeJsonlRef("__file__", event.line, event.uuid, fieldPath),
        {
          toolUseId: blk.id,
          contentRef: { kind: "inline", text: inputJson, charCount: inputJson.length },
          charDeltaEstimate: inputJson.length,
          metadata: {
            toolName: blk.name,
            messageId: msg.id,
            model: msg.model,
            parentUuid: rec.parentUuid ?? undefined,
            ...(event.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
          },
        },
      );
      if (msg.model) modelSeen = msg.model;
    } else if (blk.type === "thinking" || blk.type === "redacted_thinking") {
      const text = blk.type === "thinking" ? (blk.thinking ?? "") : (blk.data ?? "");
      emit(
        event,
        "append",
        "thinking",
        makeJsonlRef("__file__", event.line, event.uuid, fieldPath),
        {
          contentRef: inlineRef(text),
          charDeltaEstimate: text.length,
          metadata: {
            redacted: blk.type === "redacted_thinking",
            messageId: msg.id,
            parentUuid: rec.parentUuid ?? undefined,
            ...(event.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
          },
        },
      );
    } else {
      if (ledger) {
        ledger.disposition = "unknown_schema";
        ledger.reasonCode = `assistant_block_type_${blk.type ?? "missing"}`;
      }
    }
  }

  if (ledger && ledger.disposition !== "unknown_schema") {
    ledger.category = "assistant_text";
    ledger.disposition = event.isApiErrorMessage
      ? "filtered_noise"
      : "parsed_not_materialized";
    ledger.reasonCode = event.isApiErrorMessage
      ? "synthetic_api_error_message"
      : "assistant_block_emitted";
  }

  return modelSeen;
}

function handleAttachment(
  event: ClaudeJsonlEvent,
  rec: RawJsonlRecord,
  emit: EmitFn,
  ledger: JsonlLineLedgerEntry | undefined,
): void {
  const att = rec.attachment ?? {};
  const at = att.type ?? "";
  const ref = makeJsonlRef("__file__", event.line, event.uuid, "attachment");

  // queued_command 的文本在 prompt 字段；其余在 content
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

  if (at === "skill_listing") {
    emit(event, "inject", "skill_listing", ref, {
      contentRef: inlineRef(text),
      charDeltaEstimate: text.length,
      metadata: {
        attachmentType: at,
        skillCount: att.skillCount,
        itemCount: att.itemCount,
        isInitial: att.isInitial,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
  } else if (at === "task_reminder" || at === "queued_command") {
    emit(event, "inject", "attachment", ref, {
      contentRef: inlineRef(text),
      charDeltaEstimate: text.length,
      metadata: {
        attachmentType: at,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
  } else if (at === "file") {
    const fileContent = att.content as
      | { type?: string; file?: { content?: string; numLines?: number; startLine?: number } }
      | undefined;
    const fileText = fileContent?.file?.content ?? "";
    const numLines = fileContent?.file?.numLines ?? 0;
    const startLine = fileContent?.file?.startLine ?? 1;
    const truncated = att.truncated === true;
    emit(event, "inject", "attachment", ref, {
      contentRef: inlineRef(fileText),
      charDeltaEstimate: fileText.length,
      metadata: {
        attachmentType: at,
        fileAttachmentFilename: att.filename,
        fileAttachmentNumLines: numLines,
        fileAttachmentStartLine: startLine,
        fileAttachmentTruncated: truncated || undefined,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
  } else {
    emit(event, "inject", "attachment", ref, {
      contentRef: inlineRef(text),
      charDeltaEstimate: text.length,
      confidence: "estimated",
      metadata: {
        attachmentType: at,
        skillCount: att.skillCount,
        itemCount: att.itemCount,
        isInitial: att.isInitial,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
    if (ledger) {
      ledger.disposition = "unknown_schema";
      ledger.reasonCode = `attachment_unknown_subtype_${at || "missing"}`;
      ledger.attachmentType = at;
      ledger.category = "attachment";
      return;
    }
  }

  if (ledger) {
    ledger.attachmentType = at;
    ledger.category = at === "skill_listing" ? "skill_listing" : "attachment";
    ledger.disposition = "parsed_not_materialized";
    ledger.reasonCode = `attachment_${at || "missing"}`;
  }
}

function handleSystem(
  event: ClaudeJsonlEvent,
  rec: RawJsonlRecord,
  emit: EmitFn,
  ledger: JsonlLineLedgerEntry | undefined,
): void {
  const st = rec.subtype ?? "";
  const ref = makeJsonlRef("__file__", event.line, event.uuid, `subtype:${st}`);

  if (st === "stop_hook_summary") {
    const summary = JSON.stringify({
      hookCount: rec.hookCount,
      hookInfos: rec.hookInfos,
      hookErrors: rec.hookErrors,
      preventedContinuation: rec.preventedContinuation,
      stopReason: rec.stopReason,
    });
    emit(event, "inject", "hook_event", ref, {
      contentRef: inlineRef(summary),
      metadata: {
        systemSubtype: st,
        hookCount: rec.hookCount,
        preventedContinuation: rec.preventedContinuation,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
    if (ledger) {
      ledger.category = "hook_event";
      ledger.disposition = "filtered_noise";
      ledger.reasonCode = "system_stop_hook_summary";
    }
    return;
  }

  if (st === "api_error") {
    const summary = JSON.stringify({ cause: rec.cause, retryAttempt: rec.retryAttempt });
    emit(event, "noise", "hook_event", ref, {
      contentRef: inlineRef(summary),
      confidence: "estimated",
      metadata: {
        systemSubtype: st,
        syntheticApiError: true,
        retryAttempt: rec.retryAttempt,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
    if (ledger) {
      ledger.category = "hook_event";
      ledger.disposition = "filtered_noise";
      ledger.reasonCode = "system_api_error";
    }
    return;
  }

  if (st === "local_command") {
    const content = rec.content ?? "";
    emit(event, "inject", "local_command_history", ref, {
      contentRef: inlineRef(content),
      charDeltaEstimate: content.length,
      metadata: {
        systemSubtype: st,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
    if (ledger) {
      ledger.category = "local_command_history";
      ledger.disposition = "parsed_not_materialized";
      ledger.reasonCode = "system_local_command";
    }
    return;
  }

  if (st === "turn_duration" || st === "away_summary") {
    const summary = JSON.stringify({
      subtype: st,
      durationMs: rec.durationMs,
      messageCount: rec.messageCount,
      content: rec.content,
    });
    emit(event, "noise", "unknown", ref, {
      contentRef: inlineRef(summary),
      confidence: "estimated",
      metadata: {
        systemSubtype: st,
        durationMs: rec.durationMs,
        messageCount: rec.messageCount,
        parentUuid: rec.parentUuid ?? undefined,
      },
    });
    if (ledger) {
      ledger.disposition = "filtered_noise";
      ledger.reasonCode = `system_${st}`;
    }
    return;
  }

  if (ledger) {
    ledger.disposition = "unknown_schema";
    ledger.reasonCode = `system_subtype_${st || "missing"}`;
  }
}
