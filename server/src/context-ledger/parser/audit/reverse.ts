// parser/audit/reverse：反向归因 — 哪些 jsonl 事件"应当出现在 proxy"但没有被任何
// segment 引用？
//
// 心智模型：每条 LinkableJsonlEvent 可拆成若干"原子单元"：
//   - 0/1 个 userText 单元      (event.userText !== undefined)
//   - 0/1 个 assistantText 单元 (event.assistantText !== undefined)
//   - 0..N 个 toolUse 单元      (event.toolUses[i])
//   - 0..N 个 toolResult 单元   (event.toolResults[i])
//   - 0/1 个 attachment 单元    (event.attachment !== undefined)
//
// 对每个单元，反向查 snapshot 是否有 JsonlOrigin 节点引用它。没有 → 进 missing 列表。
//
// 严格 v1：只判断"是否有任意 segment 通过 jsonl-linker 引用了该单元"。
//   - 不判定 partial / definitive；fullyCovered=false 也算"已引用"。
//   - 不做内容相似度回退；linker 没匹配到就是 missing。
//
// 用户视角：missing 列表就是"jsonl 里有但 proxy 里看不到"的诊断面。
//
// IDE 入口排除（cc_entrypoint != "cli"）：
//   与 forward audit 同样的策略 —— 当 entrypoint 为 IDE（claude-vscode 等）时，
//   返回空桶 + excluded 标记。理由：IDE call 的 system prompt 形态当前未在 rule
//   覆盖范围内，跑反向 audit 也会因 jsonl-linker 命中模式偏差产出 false missing。
//   排除策略只发生在 audit 这一层；parser / linker 仍照常处理，snapshot 不变。
//   后续支持计划见 docs/inner/context-ledger/roadmap.md。

import type { ParsedQuerySnapshot } from "../types";
import type { LinkableJsonlEvent } from "../attribution/jsonl-linker";
import type { JsonlEventKind } from "../attribution/origin";
import { computeAuditExclusion, type AuditExclusion } from "./entrypoint";

// ─── 输出类型 ────────────────────────────────────────────────────────────────

export type ReverseEventKind =
  | "user_input"
  | "command_text"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "attachment";

export interface ReverseAuditBucket {
  total: number;
  linked: number;
  missing: number;
}

export interface MissingJsonlUnit {
  jsonlLineIdx: number;
  eventKind: ReverseEventKind;
  callId?: number;
  turnId?: number;
  /** toolUse / toolResult 携带的 tool_use id，便于人工溯源。 */
  toolUseId?: string;
  /** 此单元的概要文本（前 80 字节）；纯调试用。 */
  preview?: string;
  /** 简短原因码（machine-readable）。 */
  reason:
    | "no_segment_linked"          // 该单元未被任何 JsonlOrigin 节点引用
    | "no_matching_slot";          // 该单元应进的 slot 未被 template 切出（reserved，v1 暂用前者）
  /** 给人看的提示，如 "应出现在 messages.tool_use 槽"。 */
  expectedSlotHint?: string;
}

export interface ReverseAudit {
  byKind: Record<ReverseEventKind, ReverseAuditBucket>;
  missing: MissingJsonlUnit[];
  /**
   * 若被设置，表示此 call 已从 audit 聚合中排除（当前唯一原因：非 CLI entrypoint）。
   * 所有桶的计数与 missing 列表均为空。snapshot / linker 自身不受影响。
   */
  excluded?: AuditExclusion;
}

// ─── 实现 ────────────────────────────────────────────────────────────────────

function emptyBucket(): ReverseAuditBucket {
  return { total: 0, linked: 0, missing: 0 };
}

function preview(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t.length === 0) return undefined;
  return t.length > 80 ? t.slice(0, 77) + "..." : t;
}

function slotHintFor(kind: ReverseEventKind): string {
  switch (kind) {
    case "tool_use":      return "messages.tool_use";
    case "tool_result":   return "messages.tool_result";
    case "user_input":    return "messages.text 或 messages.inline.free-text (role=user, 真实人类输入)";
    case "command_text":  return "messages.text 或 messages.inline.free-text (role=user, 以 <command-name>/<local-command-*>/<bash-*> 起始)";
    case "assistant_text":return "messages.text 或 messages.inline.free-text (role=assistant)";
    case "attachment":    return "messages.inline.system-reminder (smoosh SR 子段)";
  }
}

/**
 * 把结构化 JsonlEventKind 投影为扁平 ReverseEventKind（用于 audit 统计粒度）。
 * audit 当前不区分 contentType（text/image），只按 source 桶统计。
 * 未来需要按 contentType 拆桶时，扩展 ReverseEventKind 并更新此处即可。
 */
function flattenToReverseKind(kind: JsonlEventKind): ReverseEventKind | null {
  switch (kind.source) {
    case "user_input":
    case "assistant_text":
    case "tool_use":
    case "tool_result":
    case "attachment":
      return kind.source;
    case "system_local_command":
      return "command_text";
    default:
      return null;
  }
}

/**
 * 从 snapshot 中索引所有 JsonlOrigin 引用，返回三个集合：
 *   - linkedByLine: 按 lineIdx 归类的 eventKind 集合（用于 userInput / assistantText / attachment）
 *   - linkedToolUseIds: 已被某 tool_use segment 引用的 toolUseId 集合
 *   - linkedToolResultIds: 已被某 tool_result segment 引用的 toolUseId 集合
 */
function indexLinks(snapshot: ParsedQuerySnapshot): {
  linkedByLine: Map<number, Set<ReverseEventKind>>;
  linkedToolUseIds: Set<string>;
  linkedToolResultIds: Set<string>;
} {
  const linkedByLine = new Map<number, Set<ReverseEventKind>>();
  const linkedToolUseIds = new Set<string>();
  const linkedToolResultIds = new Set<string>();

  for (const node of Object.values(snapshot.index)) {
    const origin = node.origin;
    if (origin.kind !== "jsonl") continue;

    const reverseKind = flattenToReverseKind(origin.eventKind);
    if (reverseKind) {
      const set = linkedByLine.get(origin.jsonlLineIdx) ?? new Set<ReverseEventKind>();
      set.add(reverseKind);
      linkedByLine.set(origin.jsonlLineIdx, set);
    }

    if (origin.eventKind.source === "tool_use" && origin.toolUseId) {
      linkedToolUseIds.add(origin.toolUseId);
    }
    if (origin.eventKind.source === "tool_result" && origin.toolUseId) {
      linkedToolResultIds.add(origin.toolUseId);
    }
  }

  return { linkedByLine, linkedToolUseIds, linkedToolResultIds };
}

/**
 * computeReverseAudit：扫描 jsonl events，统计每个原子单元是否被 snapshot 引用。
 *
 * 输入约定：snapshot 必须已经过 attributeSnapshot + linkJsonl 处理。
 * 复杂度：O(events × units_per_event) + O(nodes)。
 */
export function computeReverseAudit(
  snapshot: ParsedQuerySnapshot,
  events: LinkableJsonlEvent[],
): ReverseAudit {
  // 非 CLI entrypoint（IDE 集成）：返回空桶 + excluded 标记，跳过事件扫描。
  // 见文件顶部 "IDE 入口排除" 段落。
  const excluded = computeAuditExclusion(snapshot);
  if (excluded) {
    return {
      byKind: {
        user_input: emptyBucket(),
        command_text: emptyBucket(),
        assistant_text: emptyBucket(),
        tool_use: emptyBucket(),
        tool_result: emptyBucket(),
        attachment: emptyBucket(),
      },
      missing: [],
      excluded,
    };
  }

  const { linkedByLine, linkedToolUseIds, linkedToolResultIds } = indexLinks(snapshot);

  const byKind: Record<ReverseEventKind, ReverseAuditBucket> = {
    user_input: emptyBucket(),
    command_text: emptyBucket(),
    assistant_text: emptyBucket(),
    tool_use: emptyBucket(),
    tool_result: emptyBucket(),
    attachment: emptyBucket(),
  };
  const missing: MissingJsonlUnit[] = [];

  function record(kind: ReverseEventKind, linked: boolean, unit: Omit<MissingJsonlUnit, "reason" | "expectedSlotHint">) {
    byKind[kind].total += 1;
    if (linked) {
      byKind[kind].linked += 1;
      return;
    }
    byKind[kind].missing += 1;
    missing.push({
      ...unit,
      reason: "no_segment_linked",
      expectedSlotHint: slotHintFor(kind),
    });
  }

  for (const ev of events) {
    const baseUnit = {
      jsonlLineIdx: ev.lineIdx,
      callId: ev.callId,
      turnId: ev.turnId,
    };
    const kindsThisLine = linkedByLine.get(ev.lineIdx);

    if (ev.userText !== undefined) {
      const linked = kindsThisLine?.has("user_input") ?? false;
      record("user_input", linked, {
        ...baseUnit,
        eventKind: "user_input",
        preview: preview(ev.userText),
      });
    }
    if (ev.commandText !== undefined) {
      const linked = kindsThisLine?.has("command_text") ?? false;
      record("command_text", linked, {
        ...baseUnit,
        eventKind: "command_text",
        preview: preview(ev.commandText),
      });
    }
    if (ev.assistantText !== undefined) {
      const linked = kindsThisLine?.has("assistant_text") ?? false;
      record("assistant_text", linked, {
        ...baseUnit,
        eventKind: "assistant_text",
        preview: preview(ev.assistantText),
      });
    }
    if (ev.toolUses) {
      for (const tu of ev.toolUses) {
        const linked = linkedToolUseIds.has(tu.id);
        record("tool_use", linked, {
          ...baseUnit,
          eventKind: "tool_use",
          toolUseId: tu.id,
          preview: tu.name,
        });
      }
    }
    if (ev.toolResults) {
      for (const tr of ev.toolResults) {
        const linked = linkedToolResultIds.has(tr.toolUseId);
        record("tool_result", linked, {
          ...baseUnit,
          eventKind: "tool_result",
          toolUseId: tr.toolUseId,
          preview: preview(tr.contentText),
        });
      }
    }
    if (ev.attachment) {
      const linked = kindsThisLine?.has("attachment") ?? false;
      record("attachment", linked, {
        ...baseUnit,
        eventKind: "attachment",
        preview: ev.attachment.type,
      });
    }
  }

  return { byKind, missing };
}
