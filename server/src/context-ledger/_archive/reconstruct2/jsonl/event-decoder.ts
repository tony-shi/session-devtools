// reconstruct2 / jsonl / event-decoder
//
// 输入：JSONL 文本（多行）；输出：ClaudeJsonlEvent[] + JsonlLineLedgerEntry[]。
//
// 本文件只关心 schema 解码——不构建 mutation、不做 frame 切片。disposition 字段
// 在这里只能取以下值：
//   - parse_error / unknown_schema    解析或 schema 失败
//   - runtime_fact_only               permission-mode（无对应 mutation，但更新 runtime）
//   - sidechain_routed                isSidechain=true（在第二步 mutation normalizer 验证）
//   - filtered_noise / parsed_not_materialized / included_in_frame
//                                     这些在第二步根据生成的 mutation/frame 回填，
//                                     decoder 阶段只填一个临时值 "parsed"
//
// 理由：line ledger 的最终 disposition 取决于 mutation 是否进入 frame。所以 decoder
// 阶段先建好行 → event 映射，frame builder 完成后再回写 ledger。

import type {
  ClaudeJsonlEvent,
  ClaudeJsonlEventKind,
  JsonlLineLedgerEntry,
} from "./event-types";
import { absorbRuntimeFacts } from "./runtime-snapshot";
import type { HarnessRuntimeSnapshot } from "../../types";

// JSONL record 形状（仅描述本层使用的字段；未列字段在 metadata 里保留 raw）
interface RawJsonlRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  promptId?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  isCompactSummary?: boolean;
  agentId?: string;
  permissionMode?: string;
  userType?: string;
  entrypoint?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  attachment?: { type?: string };
  // 其余字段保留在 raw record 里，由 mutation normalizer 进一步解析
  [k: string]: unknown;
}

export interface DecodeJsonlOptions {
  jsonlFile?: string;
  sessionId?: string;
}

export interface DecodeJsonlResult {
  events: ClaudeJsonlEvent[];
  ledger: JsonlLineLedgerEntry[];
  rawRecords: Map<string, RawJsonlRecord>;
  sessionId: string;
  runtimeFacts: Partial<HarnessRuntimeSnapshot>;
}

const PREVIEW_MAX = 240;
const RAW_PREVIEW_MAX = 4096;

function previewLine(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  return raw.slice(0, max) + "…";
}

function classifyEventKind(rec: RawJsonlRecord): ClaudeJsonlEventKind {
  const t = rec.type ?? "";
  if (rec.isCompactSummary === true) return "compact_summary";
  if (t === "user") return "user";
  if (t === "assistant") return "assistant";
  if (t === "attachment") return "attachment";
  if (t === "system") return "system";
  if (t === "permission-mode") return "permission_mode";
  if (
    t === "worktree-state" ||
    t === "file-history-snapshot" ||
    t === "last-prompt"
  ) {
    return "harness_state";
  }
  return "unknown";
}

/** 第一遍扫描：每行 → 一个 ClaudeJsonlEvent + 一个 ledger entry。
 *
 * 返回的 ledger.disposition 是"临时占位"（除 parse_error / unknown_schema /
 * runtime_fact_only / harness_state 外都标 parsed_not_materialized），mutation
 * normalizer 完成后再覆盖为最终值。
 */
export function decodeClaudeJsonl(
  input: string | string[],
  opts: DecodeJsonlOptions = {},
): DecodeJsonlResult {
  const lines = Array.isArray(input) ? input : input.split(/\r?\n/);
  const events: ClaudeJsonlEvent[] = [];
  const ledger: JsonlLineLedgerEntry[] = [];
  const rawRecords = new Map<string, RawJsonlRecord>();
  const runtimeFacts: Partial<HarnessRuntimeSnapshot> = {};
  let sessionId = opts.sessionId ?? "unknown";
  let counter = 0;

  for (let li = 0; li < lines.length; li++) {
    const lineNum = li + 1;
    const raw = lines[li];
    if (!raw || !raw.trim()) continue;

    let rec: RawJsonlRecord;
    try {
      rec = JSON.parse(raw) as RawJsonlRecord;
    } catch {
      ledger.push({
        line: lineNum,
        eventIds: [],
        mutationIds: [],
        frameIds: [],
        disposition: "parse_error",
        reasonCode: "json_parse_error",
        sourcePath: opts.jsonlFile,
        preview: previewLine(raw, PREVIEW_MAX),
      });
      continue;
    }

    if (rec.sessionId && sessionId === "unknown") sessionId = rec.sessionId;
    absorbRuntimeFacts(rec, runtimeFacts);

    const kind = classifyEventKind(rec);
    counter += 1;
    const eventId = `evt-${counter}`;

    const event: ClaudeJsonlEvent = {
      id: eventId,
      line: lineNum,
      kind,
      rawType: rec.type,
      rawSubtype: rec.subtype,
      uuid: rec.uuid,
      parentUuid: typeof rec.parentUuid === "string" ? rec.parentUuid : undefined,
      timestamp: rec.timestamp,
      promptId: rec.promptId,
      isSidechain: rec.isSidechain === true,
      agentId: rec.agentId,
      isMeta: rec.isMeta === true,
      isApiErrorMessage: rec.isApiErrorMessage === true,
      isCompactSummary: rec.isCompactSummary === true,
      metadata: collectEventMetadata(rec),
      rawPreview: previewLine(raw, RAW_PREVIEW_MAX),
    };
    events.push(event);
    rawRecords.set(eventId, rec);

    // ledger 占位 disposition；后续 mutation normalizer / frame builder 回填
    let disposition: JsonlLineLedgerEntry["disposition"] = "parsed_not_materialized";
    let reasonCode = "decoded";
    if (kind === "unknown") {
      disposition = "unknown_schema";
      reasonCode = `unknown_top_level_type_${rec.type ?? "missing"}`;
    } else if (kind === "permission_mode") {
      // permission-mode 后续会生成一条 inject mutation；保留 parsed_not_materialized。
      // 真正的 runtime_fact_only 由 normalizer 决定。
    } else if (kind === "harness_state") {
      disposition = "deferred_unimplemented";
      reasonCode = `harness_state_${rec.type}`;
    }

    ledger.push({
      line: lineNum,
      uuid: rec.uuid,
      type: rec.type,
      subtype: rec.subtype,
      attachmentType: rec.attachment?.type,
      eventIds: [eventId],
      mutationIds: [],
      frameIds: [],
      disposition,
      reasonCode,
      sourcePath: opts.jsonlFile,
      preview: previewLine(raw, PREVIEW_MAX),
      metadata: {
        ...(event.isSidechain ? { isSidechain: true } : {}),
        ...(event.isMeta ? { isMeta: true } : {}),
        ...(event.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
        ...(event.isCompactSummary ? { isCompactSummary: true } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {}),
      },
    });
  }

  return { events, ledger, rawRecords, sessionId, runtimeFacts };
}

/** 收集 event 上"非 raw type"的小元信息（attachment.type、permissionMode、subtype 等）。
 * 这些字段在后续 mutation normalizer 里会用到，提前抽到 metadata 节省一次 walk。
 */
function collectEventMetadata(rec: RawJsonlRecord): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (rec.subtype) meta.subtype = rec.subtype;
  if (rec.attachment?.type) meta.attachmentType = rec.attachment.type;
  if (rec.permissionMode) meta.permissionMode = rec.permissionMode;
  if (rec.parentUuid != null) meta.parentUuid = rec.parentUuid;
  return meta;
}
