// Pure formatting / parsing helpers used across session detail views.
// 没有 React、没有 hooks — 单纯的字符串/数字/JSON 工具。
// 从 SessionDetailV2.tsx 抽出，未来其他视图也可以复用。

import type { IntervalEvent, LlmCall } from "../drilldown-types";
import { BRAND } from "../shared/brand";

// ─── 数字/比例/字节 ────────────────────────────────────────────────────────────

export function fmtK(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 99.95 && n < 100) return "99.9%";
  return n >= 10 ? `${n.toFixed(1)}%` : `${n.toFixed(2)}%`;
}

// ─── 时间 ─────────────────────────────────────────────────────────────────────

export function fmtDateShort(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = d.toLocaleString("en", { month: "short" });
  const day = d.getDate();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameYear ? `${month} ${day} ${hhmm}` : `${month} ${day}, ${d.getFullYear()}`;
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// Coarse gap formatter for inter-call waits: hours/days for large gaps so a
// 14h cache-expiry gap reads "14h", not "840m". Use fmtDuration for sub-minute.
export function fmtGap(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

// Best-effort JSON parse for hand-off to the JSON tree viewer. Returns
// `undefined` on failure so the segment falls back to text-only mode
// (no "原始 JSON" toggle shown). Avoids surfacing parse errors to the UI.
export function tryParseJson(s: string): unknown {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

// ─── Model name / color ───────────────────────────────────────────────────────

const MODEL_COLORS: Record<string, string> = {
  "opus":    BRAND.indigo500,
  "sonnet":  BRAND.blue500,
  "haiku":   "#22c55e",
};

export function shortModelName(m: string): string {
  return m.replace(/^(aws|gcp|azure)\./i, "").replace("claude-", "");
}

export function modelColor(m: string): string {
  const lower = m.toLowerCase();
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return "#94a3b8";
}

// ─── ID / line-index 显示 ──────────────────────────────────────────────────────

export function shortToolUseId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 10)}...` : id;
}

export function formatJsonlLines(call: LlmCall): string {
  const rawLines = call.jsonlFrameLineIdxs?.length
    ? call.jsonlFrameLineIdxs
    : call.jsonlLineIdx != null
      ? [call.jsonlLineIdx]
      : [];
  const lines = [...new Set(rawLines.map(i => i + 1))].sort((a, b) => a - b);
  if (!lines.length) return "";
  if (lines.length === 1) return `L${lines[0]}`;

  const contiguous = lines.every((line, idx) => idx === 0 || line === lines[idx - 1] + 1);
  if (contiguous) return `L${lines[0]}-${lines[lines.length - 1]}`;
  return lines.slice(0, 3).map(line => `L${line}`).join(", ") + (lines.length > 3 ? ` +${lines.length - 3}` : "");
}

// ─── Call / Tool-use 语义提取 ─────────────────────────────────────────────────

export function toolUseIdsFromIntervalEvent(ev: IntervalEvent): string[] {
  // 关联键有两条独立路径，hover 联动需同时覆盖：
  //   1) content[].tool_use_id  — tool_result block（user.kind="user:tool_result"），
  //      映射 Skill / 任意 tool_use → 对应 tool_result 行
  //   2) 外层 sourceToolUseID    — cli.js SkillTool 通过 tagMessagesWithToolUseID
  //      给 skill 注入的所有 user / attachment 行打上的归属字段。
  //      这条路径覆盖 SKILL.md body + command_permissions 等所有副作用行 ——
  //      hover Skill ToolCallRow 时整个 envelope 全亮。
  const ids: string[] = [];
  try {
    const obj = JSON.parse(ev.rawJson) as { sourceToolUseID?: string; message?: { content?: unknown } };
    if (typeof obj.sourceToolUseID === "string") {
      ids.push(obj.sourceToolUseID);
    }
    if (ev.kind === "user:tool_result") {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; tool_use_id?: string };
          if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
            ids.push(b.tool_use_id);
          }
        }
      }
    }
  } catch {
    return [];
  }
  return ids;
}
