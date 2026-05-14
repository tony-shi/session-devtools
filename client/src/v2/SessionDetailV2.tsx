import { useTranslation } from "react-i18next";
import React, { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { scaleLinear, scaleSqrt, scaleOrdinal, line as d3line, curveCatmullRom, schemeTableau10 } from "d3";
import { TurnMinimap } from "./TurnMinimap";
import type { SessionV2 } from "./types";
import type { DiffEntry, IntervalEvent, IntervalEventKind, LlmCall, ModelStats, SessionDrilldown, ToolCallSlot, UserTurn, InterTurnBlock, CallDetail, SegmentDiff } from "./drilldown-types";
import { apiV2 } from "./api";
import {
  buildMockAttributedDiff,
  buildMockPayloadSegments,
  buildMockCallResponse,
  buildMockBridgeEvents, buildTrustMode,
  attachMockSubAgents,
  type AttributedDiffRange, type PayloadSegment,
  type MockBridgeEvent, type BridgeEventKind, type ChangeType, type ConfidenceLevel,
  type TrustMode, type MockToolGroup, type MockAgentLoopData,
} from "./drilldown-mock-fill";
import type { SubAgentSummary } from "./drilldown-types";
import {
  deriveSessionMetrics, deriveSessionHotspots,
  type SessionMetrics,
} from "./drilldown-real-fill";
import { getSessionDisplayName } from "./session-display";
import { AttributionTreePanel } from "./AttributionTreePanel";
import { ResponseTreePanel } from "./ResponseTreePanel";
import { DiffPanel } from "./DiffPanel";
import { TOKEN_METRICS } from "./metricRegistry";

// Local aliases for brevity (same as drilldown-types, no local re-declaration needed)
type MockDiffEntry = DiffEntry;
// LlmCall fields added in drilldown-types are optional in the raw fallback
// data below; normalizeTurns() fills them in.
type RawMockCall = Omit<LlmCall,
  "indexInTurn" | "messageId" | "jsonlLineIdx" | "jsonlFrameLineIdxs" |
  "model" | "stopReason" | "proxy" | "subAgents" |
  "isCompaction" | "isUnknownHeavy" | "isSignificant" | "significantDelta" | "freshIn" |
  "toolNames" | "toolCalls" | "assistantText" | "intervalEvents"
> & {
  isCompaction?: boolean; isUnknownHeavy?: boolean; isSignificant?: boolean;
  significantDelta?: number; freshIn?: number; toolNames?: string[];
};
type RawMockTurn = Omit<UserTurn, "startedAt" | "endedAt" | "hasCompaction" | "hasUnknownSpike" | "finalOutput" | "durationMs" | "midTurnInjections" | "errorCount" | "calls"> & {
  hasCompaction?: boolean; hasUnknownSpike?: boolean; errorCount?: number; midTurnInjections?: UserTurn["midTurnInjections"]; calls: RawMockCall[];
};
type MockLlmCall = LlmCall;
type MockUserTurn = UserTurn;

function normalizeTurns(raw: RawMockTurn[]): UserTurn[] {
  return raw.map((t) => ({
    startedAt: "",
    endedAt: "",
    finalOutput: null,
    durationMs: 0,
    hasCompaction: t.hasCompaction ?? false,
    hasUnknownSpike: t.hasUnknownSpike ?? false,
    errorCount: t.errorCount ?? 0,
    ...t,
    midTurnInjections: t.midTurnInjections ?? [],
    calls: t.calls.map((c, ci) => ({
      ...c,
      indexInTurn: ci + 1,
      messageId: null,
      jsonlLineIdx: null,
      jsonlFrameLineIdxs: [],
      model: "claude-opus-4-7",
      stopReason: "end_turn" as const,
      proxy: null,
      subAgents: [],
      freshIn: c.freshIn ?? 0,
      isCompaction: c.isCompaction ?? false,
      isUnknownHeavy: c.isUnknownHeavy ?? false,
      isSignificant: c.isSignificant ?? false,
      significantDelta: c.significantDelta ?? 0,
      toolNames: c.toolNames ?? [],
      toolCalls: [],
      assistantText: "",
      intervalEvents: [],
    })),
  }));
}

// ─── Fallback Mock Data (used when API is unavailable) ───────────────────────

function buildFallbackTurns(): UserTurn[] {
  const raw: RawMockTurn[] = [
    {
      id: 1,
      userInput: "初始化项目，帮我搭一个 Express + TypeScript 的后端框架",
      llmCallCount: 4,
      toolCallCount: 6,
      netContextDelta: 18400,
      peakContext: 62000,
      cacheRead: 14200,
      cacheWrite: 8100,
      unknownDelta: 400,
      calls: [
        {
          id: 1, contextSize: 42000, outputTokens: 1200, cacheRead: 0, cacheWrite: 8100, timestamp: "14:01:02",
          incomingDiff: [
            { id: "d1", category: "System", label: "system prompt", delta: 31000, changeType: "added", cause: "initial", confidence: "High", evidence: "First call in session" },
            { id: "d2", category: "Tool Schemas", label: "tool schemas", delta: 9400, changeType: "added", cause: "initial", confidence: "High" },
            { id: "d3", category: "User Messages", label: "user input", delta: 1600, changeType: "added", cause: "user input", confidence: "High", evidence: "Matched user turn content" },
          ],
        },
        {
          id: 2, contextSize: 54200, outputTokens: 980, cacheRead: 6800, cacheWrite: 0, timestamp: "14:01:18", isSignificant: true, significantDelta: 12200,
          incomingDiff: [
            { id: "d4", category: "Tool Output", label: "Bash(mkdir -p src/routes)", delta: 840, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_01A" },
            { id: "d5", category: "Tool Output", label: "Write(src/index.ts)", delta: 4800, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_01B" },
            { id: "d6", category: "Tool Output", label: "Write(tsconfig.json)", delta: 1200, changeType: "added", cause: "tool result", confidence: "High" },
            { id: "d7", category: "Assistant History", label: "assistant response #1", delta: 5360, changeType: "added", cause: "assistant output", confidence: "High" },
          ],
        },
        {
          id: 3, contextSize: 58900, outputTokens: 720, cacheRead: 4200, cacheWrite: 0, timestamp: "14:01:35",
          incomingDiff: [
            { id: "d8", category: "Tool Output", label: "Read(package.json)", delta: 2100, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_01C" },
            { id: "d9", category: "Tool Output", label: "Bash(npm install)", delta: 2600, changeType: "added", cause: "tool result", confidence: "Medium", evidence: "Matched bash output pattern" },
          ],
        },
        {
          id: 4, contextSize: 62000, outputTokens: 540, cacheRead: 3200, cacheWrite: 0, timestamp: "14:01:52",
          incomingDiff: [
            { id: "d10", category: "Assistant History", label: "assistant response #2", delta: 3100, changeType: "added", cause: "assistant output", confidence: "High" },
          ],
        },
      ],
    },
    {
      id: 2,
      userInput: "review 当前 context 展示逻辑，看看哪里有性能问题",
      llmCallCount: 17,
      toolCallCount: 9,
      netContextDelta: 81600,
      peakContext: 143000,
      cacheRead: 121000,
      cacheWrite: 2100,
      unknownDelta: 2300,
      hasUnknownSpike: true,
      calls: [
        { id: 12, contextSize: 90000, outputTokens: 1100, cacheRead: 18000, cacheWrite: 0, timestamp: "14:22:01", incomingDiff: [
          { id: "e1", category: "User Messages", label: "user input (turn 2)", delta: 820, changeType: "added", cause: "user input", confidence: "High" },
          { id: "e2", category: "Tool Output", label: "retained bash outputs", delta: 6200, changeType: "retained", cause: "retained", confidence: "High" },
        ]},
        { id: 13, contextSize: 103000, outputTokens: 1400, cacheRead: 22000, cacheWrite: 0, timestamp: "14:22:18", isSignificant: true, significantDelta: 12800, incomingDiff: [
          { id: "e3", category: "Tool Output", label: "Read(server/src/context.ts)", delta: 12800, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_02A · source: JSONL line 1842 · proxy request: req_abc123" },
          { id: "e4", category: "Assistant History", label: "assistant step #3", delta: 180, changeType: "added", cause: "assistant output", confidence: "High" },
        ]},
        { id: 14, contextSize: 106000, outputTokens: 880, cacheRead: 19000, cacheWrite: 0, timestamp: "14:22:34", incomingDiff: [
          { id: "e5", category: "Tool Output", label: "Read(server/src/parser.ts)", delta: 3100, changeType: "added", cause: "tool result", confidence: "High" },
        ]},
        { id: 15, contextSize: 109000, outputTokens: 760, cacheRead: 21000, cacheWrite: 0, timestamp: "14:22:51", incomingDiff: [
          { id: "e6", category: "Tool Output", label: "Bash(grep -n performance)", delta: 2800, changeType: "added", cause: "tool result", confidence: "Medium" },
        ]},
        { id: 16, contextSize: 143000, outputTokens: 2100, cacheRead: 24000, cacheWrite: 0, timestamp: "14:23:08", isSignificant: true, significantDelta: 3400, incomingDiff: [
          { id: "e7", category: "Tool Output", label: "Bash test output", delta: 3400, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_02B" },
          { id: "e8", category: "Unknown", label: "unattributed delta +1.2k", delta: 1200, changeType: "added", cause: "unknown", confidence: "Unknown" },
        ]},
        { id: 17, contextSize: 102000, outputTokens: 1800, cacheRead: 0, cacheWrite: 2100, timestamp: "14:23:22", isCompaction: true, incomingDiff: [
          { id: "e9", category: "Compaction Summary", label: "compaction summary injected", delta: 4200, changeType: "added", cause: "compaction", confidence: "High" },
          { id: "e10", category: "Tool Output", label: "previous tool outputs (removed)", delta: -41200, changeType: "removed", cause: "compaction", confidence: "High" },
          { id: "e11", category: "Assistant History", label: "prior assistant history (removed)", delta: -4000, changeType: "removed", cause: "compaction", confidence: "High" },
        ]},
        { id: 18, contextSize: 118000, outputTokens: 1200, cacheRead: 17000, cacheWrite: 0, timestamp: "14:23:38", isSignificant: true, significantDelta: 2100, incomingDiff: [
          { id: "e12", category: "Skills / Task Injection", label: "task reminder re-injected", delta: 2100, changeType: "added", cause: "skill injection", confidence: "Medium", evidence: "Matched skill/task pattern in system context" },
          { id: "e13", category: "Unknown", label: "environment delta", delta: 1100, changeType: "changed", cause: "unknown", confidence: "Low" },
        ]},
        ...([19,20,21,22,23,24,25,26,27,28].map(id => ({
          id, contextSize: 118000 + (id - 18) * 1200, outputTokens: 600, cacheRead: 15000, cacheWrite: 0, timestamp: `14:2${id}:00`, incomingDiff: [
            { id: `minor-${id}`, category: "Assistant History", label: "incremental assistant step", delta: 400 + id * 30, changeType: "added" as const, cause: "assistant output", confidence: "High" as const },
          ],
        }))),
      ],
    },
    {
      id: 3,
      userInput: "把 ContextTimeline 组件拆分为更小的子组件",
      llmCallCount: 8,
      toolCallCount: 12,
      netContextDelta: 24200,
      peakContext: 138000,
      cacheRead: 98000,
      cacheWrite: 1200,
      unknownDelta: 600,
      hasCompaction: true,
      calls: [
        { id: 29, contextSize: 118000, outputTokens: 900, cacheRead: 19000, cacheWrite: 0, timestamp: "15:10:01", incomingDiff: [
          { id: "f1", category: "User Messages", label: "user input (turn 3)", delta: 740, changeType: "added", cause: "user input", confidence: "High" },
        ]},
        { id: 30, contextSize: 128000, outputTokens: 1300, cacheRead: 22000, cacheWrite: 0, timestamp: "15:10:18", isSignificant: true, significantDelta: 9800, incomingDiff: [
          { id: "f2", category: "Tool Output", label: "Read(ContextTimeline/index.tsx)", delta: 9800, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_03A" },
        ]},
        { id: 31, contextSize: 138000, outputTokens: 1100, cacheRead: 20000, cacheWrite: 0, timestamp: "15:10:35", isSignificant: true, significantDelta: 7200, incomingDiff: [
          { id: "f3", category: "Tool Output", label: "Read(ContextTimeline/types.ts)", delta: 4100, changeType: "added", cause: "tool result", confidence: "High" },
          { id: "f4", category: "Tool Output", label: "Read(StackedAreaChart.tsx)", delta: 3100, changeType: "added", cause: "tool result", confidence: "High" },
        ]},
        { id: 32, contextSize: 91000, outputTokens: 800, cacheRead: 0, cacheWrite: 1200, timestamp: "15:10:52", isCompaction: true, incomingDiff: [
          { id: "f5", category: "Compaction Summary", label: "compaction summary", delta: 3800, changeType: "added", cause: "compaction", confidence: "High" },
          { id: "f6", category: "Tool Output", label: "large tool reads (removed)", delta: -38000, changeType: "removed", cause: "compaction", confidence: "High" },
        ]},
        ...([33,34,35,36].map(id => ({
          id, contextSize: 91000 + (id - 32) * 3000, outputTokens: 700, cacheRead: 14000, cacheWrite: 0, timestamp: `15:11:${(id - 32) * 15}`, incomingDiff: [
            { id: `f-minor-${id}`, category: "Tool Output", label: `Write(new-component-${id - 32}.tsx)`, delta: 2800 + id * 20, changeType: "added" as const, cause: "tool result", confidence: "High" as const },
          ],
        }))),
      ],
    },
    {
      id: 4,
      userInput: "运行测试，确认没有回归",
      llmCallCount: 3,
      toolCallCount: 2,
      netContextDelta: 4800,
      peakContext: 108000,
      cacheRead: 76000,
      cacheWrite: 0,
      unknownDelta: 0,
      calls: [
        { id: 37, contextSize: 103000, outputTokens: 600, cacheRead: 18000, cacheWrite: 0, timestamp: "15:32:01", incomingDiff: [
          { id: "g1", category: "User Messages", label: "user input (turn 4)", delta: 420, changeType: "added", cause: "user input", confidence: "High" },
        ]},
        { id: 38, contextSize: 106000, outputTokens: 820, cacheRead: 29000, cacheWrite: 0, timestamp: "15:32:15", isSignificant: true, significantDelta: 3200, incomingDiff: [
          { id: "g2", category: "Tool Output", label: "Bash(npm test)", delta: 3200, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_04A · Matched test runner output pattern" },
        ]},
        { id: 39, contextSize: 108000, outputTokens: 540, cacheRead: 29000, cacheWrite: 0, timestamp: "15:32:30", incomingDiff: [
          { id: "g3", category: "Assistant History", label: "final summary", delta: 1600, changeType: "added", cause: "assistant output", confidence: "High" },
        ]},
      ],
    },
    {
      id: 5,
      userInput: "更新 README，补充 context 追踪模块的说明",
      llmCallCount: 5,
      toolCallCount: 3,
      netContextDelta: 6100,
      peakContext: 112000,
      cacheRead: 84000,
      cacheWrite: 0,
      unknownDelta: 300,
      calls: [
        { id: 40, contextSize: 108000, outputTokens: 700, cacheRead: 20000, cacheWrite: 0, timestamp: "16:05:01", incomingDiff: [
          { id: "h1", category: "User Messages", label: "user input (turn 5)", delta: 380, changeType: "added", cause: "user input", confidence: "High" },
        ]},
        { id: 41, contextSize: 110000, outputTokens: 900, cacheRead: 22000, cacheWrite: 0, timestamp: "16:05:18", isSignificant: true, significantDelta: 2400, incomingDiff: [
          { id: "h2", category: "Tool Output", label: "Read(README.md)", delta: 2400, changeType: "added", cause: "tool result", confidence: "High" },
        ]},
        { id: 42, contextSize: 111000, outputTokens: 1100, cacheRead: 21000, cacheWrite: 0, timestamp: "16:05:35", incomingDiff: [
          { id: "h3", category: "Tool Output", label: "Write(README.md)", delta: 1200, changeType: "changed", cause: "tool result", confidence: "Medium" },
        ]},
        { id: 43, contextSize: 112000, outputTokens: 640, cacheRead: 21000, cacheWrite: 0, timestamp: "16:05:52", incomingDiff: [
          { id: "h4", category: "Unknown", label: "environment block update", delta: 300, changeType: "changed", cause: "unknown", confidence: "Low" },
        ]},
        { id: 44, contextSize: 114000, outputTokens: 480, cacheRead: 0, cacheWrite: 0, timestamp: "16:06:08", incomingDiff: [
          { id: "h5", category: "Assistant History", label: "closing summary", delta: 1800, changeType: "added", cause: "assistant output", confidence: "High" },
        ]},
      ],
    },
  ];
  return normalizeTurns(raw);
}

// ─── Category Colors ─────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  "System": "#6366f1",
  "Tool Schemas": "#6b7280",
  "User Messages": "#3b82f6",
  "Assistant History": "#22c55e",
  "Tool Output": "#f59e0b",
  "Memory / Project Context": "#a855f7",
  "Skills / Task Injection": "#f97316",
  "Compaction Summary": "#ef4444",
  "Unknown": "#94a3b8",
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 99.95 && n < 100) return "99.9%";
  return n >= 10 ? `${n.toFixed(1)}%` : `${n.toFixed(2)}%`;
}

function fmtDateShort(iso: string): string {
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

// ─── Sub-components ───────────────────────────────────────────────────────────

// ─── Badge icon registry ──────────────────────────────────────────────────────
// Single place to swap icons for all session badges.
// Each entry is a function (size, color) => ReactNode so it works at any scale.

function ForkIcon({ size = 12, color = "#7c3aed" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}>
      <line x1="4" y1="1" x2="4" y2="11" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 5 Q4 3 9 3" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <circle cx="9" cy="3" r="1.5" fill={color} />
      <circle cx="4" cy="1" r="1.5" fill={color} />
    </svg>
  );
}

// To swap any icon: edit the corresponding entry here.
const BADGE_ICONS = {
  compaction: (size: number, color: string) => (
    <span style={{ fontSize: size, fontWeight: 700, lineHeight: 1, color }}>C</span>
  ),
  error: (size: number, color: string) => (
    <span style={{ fontSize: size, fontWeight: 700, lineHeight: 1, color }}>⚠</span>
  ),
  subAgent: (size: number, color: string) => (
    <ForkIcon size={size} color={color} />
  ),
  command: (size: number, color: string) => (
    <span style={{ fontSize: size, fontWeight: 700, lineHeight: 1, color }}>/</span>
  ),
  unknown: (size: number, color: string) => (
    <span style={{ fontSize: size, fontWeight: 700, lineHeight: 1, color }}>?</span>
  ),
} as const;

function MockBadge() {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, color: "#9ca3af", border: "1px dashed #d1d5db",
      borderRadius: 3, padding: "1px 4px", letterSpacing: "0.05em", marginLeft: 4,
    }}>MOCK</span>
  );
}

function RiskBadge({ type }: { type: "compaction" | "unknown-spike" | "large-growth" | "tool-heavy" | "near-limit" }) {
  const configs = {
    "compaction": { label: "Compaction", bg: "#fef2f2", color: "#dc2626", border: "#fecaca" },
    "unknown-spike": { label: "Unknown Spike", bg: "#f8fafc", color: "#64748b", border: "#cbd5e1" },
    "large-growth": { label: "Large Growth", bg: "#fffbeb", color: "#d97706", border: "#fde68a" },
    "tool-heavy": { label: "Tool Heavy", bg: "#fffbeb", color: "#d97706", border: "#fde68a" },
    "near-limit": { label: "Near Limit", bg: "#fff7ed", color: "#ea580c", border: "#fdba74" },
  };
  const c = configs[type];
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, background: c.bg, color: c.color,
      border: `1px solid ${c.border}`, borderRadius: 4, padding: "2px 6px",
    }}>{c.label}</span>
  );
}

function ChangeTypeIcon({ type }: { type: MockDiffEntry["changeType"] }) {
  const configs = {
    added: { symbol: "+", color: "#16a34a" },
    removed: { symbol: "−", color: "#dc2626" },
    changed: { symbol: "~", color: "#d97706" },
    retained: { symbol: "·", color: "#9ca3af" },
  };
  const c = configs[type];
  return <span style={{ color: c.color, fontWeight: 700, fontSize: 13, width: 14, display: "inline-block" }}>{c.symbol}</span>;
}

// ─── Inspector Panels ─────────────────────────────────────────────────────────

function SessionHotspotsPanel({ turns }: { turns: MockUserTurn[] }) {
  const { t } = useTranslation();
  const biggestTurn = [...turns].sort((a, b) => b.netContextDelta - a.netContextDelta)[0];
  const biggestPeak = [...turns].sort((a, b) => b.peakContext - a.peakContext)[0];
  const unknownTurn = [...turns].sort((a, b) => b.unknownDelta - a.unknownDelta)[0];
  const compactionTurns = turns.filter(t => t.hasCompaction || t.calls.some(c => c.isCompaction));

  return (
    <div style={{ padding: "16px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.06em", marginBottom: 12 }}>
        {t("sessionOverview.hotspots.title")} <MockBadge />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <HotspotCard icon="↑" label={t("sessionOverview.hotspots.largestGrowth")} value={`Turn ${biggestTurn.id} · +${fmtK(biggestTurn.netContextDelta)}`} color="#d97706" />
        <HotspotCard icon="▲" label={t("sessionOverview.hotspots.peakContext")} value={`Turn ${biggestPeak.id} · ${fmtK(biggestPeak.peakContext)}`} color="#6366f1" />
        <HotspotCard icon="?" label={t("sessionOverview.hotspots.largestUnknown")} value={`Turn ${unknownTurn.id} · +${fmtK(unknownTurn.unknownDelta)}`} color="#94a3b8" />
        {compactionTurns.length > 0 && (
          <HotspotCard icon="◆" label={t("sessionOverview.hotspots.compactionTurns")} value={compactionTurns.map(t => `Turn ${t.id}`).join(", ")} color="#ef4444" />
        )}
        <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 10, marginTop: 2 }}>
          <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>Top context contributors <MockBadge /></div>
          {[
            { label: "Tool Output", pct: 42 },
            { label: "Assistant History", pct: 28 },
            { label: "System", pct: 18 },
            { label: "Unknown", pct: 7 },
            { label: "Other", pct: 5 },
          ].map(item => (
            <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: CATEGORY_COLORS[item.label] ?? "#e5e7eb" }} />
              <span style={{ fontSize: 11, color: "#374151", flex: 1 }}>{item.label}</span>
              <div style={{ width: 60, height: 4, background: "#f3f4f6", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ width: `${item.pct}%`, height: "100%", background: CATEGORY_COLORS[item.label] ?? "#e5e7eb" }} />
              </div>
              <span style={{ fontSize: 10, color: "#9ca3af", width: 28, textAlign: "right" }}>{item.pct}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HotspotCard({ icon, label, value, color }: { icon: string; label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ fontSize: 13, color, lineHeight: 1.4, width: 16, flexShrink: 0 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 10, color: "#9ca3af" }}>{label}</div>
        <div style={{ fontSize: 12, color: "#374151", fontWeight: 500 }}>{value}</div>
      </div>
    </div>
  );
}

function TurnRollupPanel({ turn }: { turn: MockUserTurn }) {
  const significantCalls = turn.calls.filter(c => c.isSignificant || c.isCompaction);
  return (
    <div style={{ padding: "16px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.06em", marginBottom: 12 }}>
        TURN {turn.id} ROLLUP <MockBadge />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
        {[
          { label: "Context Δ", value: `${turn.netContextDelta > 0 ? "+" : ""}${fmtK(turn.netContextDelta)}` },
          { label: "Peak Context", value: fmtK(turn.peakContext) },
          { label: "Cache Read", value: fmtK(turn.cacheRead) },
          { label: "Unknown Δ", value: `+${fmtK(turn.unknownDelta)}` },
        ].map(({ label, value }) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: "#9ca3af" }}>{label}</span>
            <span style={{ fontSize: 11, color: "#374151", fontWeight: 500 }}>{value}</span>
          </div>
        ))}
      </div>
      {significantCalls.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>Key calls</div>
          {significantCalls.map(c => (
            <div key={c.id} style={{ fontSize: 11, color: "#374151", padding: "4px 0", borderBottom: "1px solid #f9fafb", display: "flex", justifyContent: "space-between" }}>
              <span>Call #{c.id}</span>
              <span style={{ color: c.isCompaction ? "#ef4444" : "#3b82f6" }}>
                {c.isCompaction ? "compaction" : `+${fmtK(c.significantDelta ?? 0)}`}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function DiffEvidencePanel({ entry }: { entry: MockDiffEntry }) {
  const confidenceColors = { High: "#16a34a", Medium: "#d97706", Low: "#dc2626", Unknown: "#6b7280" };
  return (
    <div style={{ padding: "16px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.06em", marginBottom: 12 }}>EVIDENCE</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#111827", marginBottom: 10, wordBreak: "break-all" }}>{entry.label}</div>
      {[
        { label: "Category", value: <span style={{ color: CATEGORY_COLORS[entry.category] ?? "#374151" }}>{entry.category}</span> },
        { label: "Change type", value: entry.changeType },
        { label: "Delta", value: `${entry.delta > 0 ? "+" : ""}${fmtK(entry.delta)} tokens` },
        { label: "Cause", value: entry.cause },
        { label: "Confidence", value: <span style={{ color: confidenceColors[entry.confidence], fontWeight: 600 }}>{entry.confidence}</span> },
      ].map(({ label, value }) => (
        <div key={label} style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: "1px solid #f3f4f6" }}>
          <span style={{ width: 90, flexShrink: 0, fontSize: 11, color: "#9ca3af" }}>{label}</span>
          <span style={{ fontSize: 11, color: "#374151" }}>{value}</span>
        </div>
      ))}
      {entry.evidence && (
        <div style={{ marginTop: 12, padding: "10px 12px", background: "#f9fafb", borderRadius: 6, fontSize: 11, color: "#4b5563", lineHeight: 1.6, fontFamily: "monospace" }}>
          {entry.evidence}
        </div>
      )}
      {!entry.evidence && (
        <div style={{ marginTop: 12, padding: "10px 12px", background: "#f9fafb", borderRadius: 6, fontSize: 11, color: "#9ca3af", fontStyle: "italic" }}>
          No source reference available.
        </div>
      )}
      <div style={{ marginTop: 12, fontSize: 11, color: "#9ca3af", fontStyle: "italic" }}>
        {entry.confidence === "High" && "Exact content matched from event record."}
        {entry.confidence === "Medium" && "Structural match from event record; boundary is inferred."}
        {entry.confidence === "Low" && "Inferred from token gap only. Weak heuristic."}
        {entry.confidence === "Unknown" && "Cannot attribute. Only token gap observed."}
      </div>
    </div>
  );
}

function CallDiffSummaryPanel({ call }: { call: MockLlmCall }) {
  const added = call.incomingDiff.filter(e => e.changeType === "added");
  const removed = call.incomingDiff.filter(e => e.changeType === "removed");
  const netDelta = call.incomingDiff.reduce((s, e) => s + e.delta, 0);
  return (
    <div style={{ padding: "16px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.06em", marginBottom: 12 }}>CALL #{call.id} DIFF</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>Net Δ</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: netDelta >= 0 ? "#16a34a" : "#dc2626" }}>
            {netDelta >= 0 ? "+" : ""}{fmtK(netDelta)}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>Added entries</span>
          <span style={{ fontSize: 11, color: "#374151" }}>{added.length}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>Removed entries</span>
          <span style={{ fontSize: 11, color: "#374151" }}>{removed.length}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>Cache read</span>
          <span style={{ fontSize: 11, color: "#374151" }}>{fmtK(call.cacheRead)}</span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>Top entries</div>
      {call.incomingDiff.slice(0, 4).map(e => (
        <div key={e.id} style={{ display: "flex", gap: 6, padding: "4px 0", borderBottom: "1px solid #f9fafb", alignItems: "center" }}>
          <ChangeTypeIcon type={e.changeType} />
          <span style={{ fontSize: 10, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.label}</span>
          <span style={{ fontSize: 10, color: e.delta >= 0 ? "#16a34a" : "#dc2626", fontWeight: 500, flexShrink: 0 }}>
            {e.delta >= 0 ? "+" : ""}{fmtK(e.delta)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Canvas Panels ───────────────────────────────────────────────────────

function SessionOverviewPanel({
  turns, drilldown, onSelectTurn,
}: {
  turns: MockUserTurn[];
  drilldown: SessionDrilldown | null;
  onSelectTurn: (t: MockUserTurn) => void;
}) {
  const { t } = useTranslation();
  const isMock = drilldown === null;

  // Use deriveSessionMetrics when real data available; fallback to turn-computed values
  const sm: SessionMetrics | null = drilldown ? deriveSessionMetrics(drilldown) : null;

  const totalCalls       = sm?.totalLlmCalls   ?? turns.reduce((s, t) => s + t.llmCallCount, 0);
  const totalToolCalls   = sm?.totalToolCalls   ?? turns.reduce((s, t) => s + t.toolCallCount, 0);
  const peakContext      = sm?.peakContext      ?? (turns.length ? Math.max(...turns.map(t => t.peakContext)) : 0);
  const totalCacheRead   = sm?.totalCacheRead   ?? turns.reduce((s, t) => s + t.cacheRead, 0);
  const totalCacheWrite  = sm?.totalCacheWrite  ?? turns.reduce((s, t) => s + t.cacheWrite, 0);
  const totalFreshIn     = sm?.totalFreshIn     ?? null;
  const totalFreshOut    = sm?.totalFreshOut    ?? null;
  const systemErrors     = sm?.systemErrorCount ?? null;
  const durationStr      = sm?.durationStr      ?? "—";
  const cacheRatio       = sm?.cacheRatio       ?? null;
  const modelBreakdown   = drilldown?.modelBreakdown ?? null;

  // Hotspots from real data
  const hotspots = drilldown ? deriveSessionHotspots(drilldown) : null;

  const compactionTurns = hotspots?.compactionTurns ?? turns.filter(t => t.hasCompaction || t.calls.some(c => c.isCompaction));

  // ── Badge summary (session-level counts) ──────────────────────────────────
  const badgeSummary = React.useMemo(() => {
    const compactionCount  = compactionTurns.length;
    const errorCount       = turns.reduce((s, t) => s + t.errorCount, 0);
    const subAgentTurns    = turns.filter(t => t.calls.some(c => c.subAgents.length > 0)).length;
    const subAgentTotal    = turns.reduce((s, t) => s + t.calls.reduce((cs, c) => cs + c.subAgents.length, 0), 0);
    const commandTurns     = turns.filter(t =>
      t.calls.some(c => c.intervalEvents.some(e => e.kind === "user:command"))
    ).length;
    const unknownTurns     = turns.filter(t =>
      t.calls.some(c => c.intervalEvents.some(e => e.kind === "unknown"))
    ).length;
    return { compactionCount, errorCount, subAgentTurns, subAgentTotal, commandTurns, unknownTurns };
  }, [turns, compactionTurns]);

  // Token ledger bar segments (same proportions as main dashboard)
  const tokenTotal = totalFreshIn !== null
    ? (totalFreshIn + totalCacheRead + totalCacheWrite + (totalFreshOut ?? 0))
    : (totalCacheRead + totalCacheWrite);
  const ledgerSegments = tokenTotal > 0 ? [
    { key: "freshIn",    value: totalFreshIn ?? 0,    color: "#3b82f6",  label: "Fresh In" },
    { key: "cacheRead",  value: totalCacheRead,        color: "#10b981",  label: "Cache Read" },
    { key: "cacheWrite", value: totalCacheWrite,       color: "#f59e0b",  label: "Cache Write" },
    { key: "output",     value: totalFreshOut ?? 0,   color: "#8b5cf6",  label: "Output" },
  ] : [];

  const [modelsExpanded, setModelsExpanded] = React.useState(false);
  const multiModel = modelBreakdown && Object.keys(modelBreakdown).length > 1;
  const singleModel = modelBreakdown && Object.keys(modelBreakdown).length === 1
    ? Object.keys(modelBreakdown)[0] : null;

  // Token ledger values from registry colors
  const M = TOKEN_METRICS;
  const ledgerRows = [
    { id: "fresh_input", value: totalFreshIn ?? 0 },
    { id: "cache_read",  value: totalCacheRead },
    { id: "cache_write", value: totalCacheWrite },
    { id: "output",      value: totalFreshOut ?? 0 },
  ];

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* ── Overview: flat rows, no card border ─────────────────────── */}
      <div style={{ marginBottom: 16 }}>

        {/* Row 1: Activity */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 24, paddingBottom: 10, borderBottom: "1px solid #f3f4f6", flexWrap: "wrap" }}>
          {[
            { label: t("sessionOverview.activity.userTurns"), value: String(drilldown?.turns.length ?? turns.length), color: undefined as string | undefined },
            { label: t("sessionOverview.activity.llmCalls"),  value: String(totalCalls), color: undefined },
            { label: t("sessionOverview.activity.toolCalls"), value: String(totalToolCalls), color: undefined },
            { label: t("sessionOverview.activity.duration"),  value: durationStr, color: undefined },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: color ?? "#111827", lineHeight: 1 }}>{value}</div>
            </div>
          ))}

          {/* Model chip — single inline, multi as expandable */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            {singleModel && (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 7, height: 7, borderRadius: 2, background: modelColor(singleModel), flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: "#6b7280" }}>{shortModelName(singleModel)}</span>
              </div>
            )}
            {multiModel && (
              <button
                onClick={() => setModelsExpanded(v => !v)}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  fontSize: 11, padding: "3px 8px", borderRadius: 5,
                  border: "1px solid #e5e7eb", background: modelsExpanded ? "#f3e8ff" : "#f9fafb",
                  color: modelsExpanded ? "#7c3aed" : "#6b7280", cursor: "pointer",
                }}
              >
                {t("sessionOverview.activity.models", { n: Object.keys(modelBreakdown!).length })}
                <svg width="9" height="9" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  style={{ transform: modelsExpanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
            {isMock && <MockBadge />}
          </div>
        </div>

        {/* Models expanded panel */}
        {multiModel && modelsExpanded && (
          <div style={{ marginTop: 8, marginBottom: 4 }}>
            <ModelBreakdownBlock breakdown={modelBreakdown!} />
          </div>
        )}

        {/* Row 2: Token Ledger — same compact style as list rows */}
        <div style={{ paddingTop: 10 }}>
          {/* label + cache ratio */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("dashboard.tokenLedger")}</span>
            {cacheRatio !== null && (
              <>
                <div style={{ width: 1, height: 10, background: "#e5e7eb" }} />
                <span style={{ fontSize: 9, fontWeight: 700, color: M.cache_ratio.color }}>
                  {t("metrics.cacheRatio.label", M.cache_ratio.label)} {fmtPct(cacheRatio)}
                </span>
              </>
            )}
          </div>
          {/* values row — mirrors MiniTokenLedger */}
          <div style={{ display: "flex", gap: 16, alignItems: "flex-end", marginBottom: 5 }}>
            {ledgerRows.map(({ id, value }) => {
              const m = M[id];
              const hasVal = value > 0;
              return (
                <div key={id} title={m.description}>
                  <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, marginBottom: 2, whiteSpace: "nowrap" }}>{m.label}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: hasVal ? m.color : "#d1d5db", lineHeight: 1 }}>
                    {hasVal ? fmtK(value) : "—"}
                  </div>
                </div>
              );
            })}
          </div>
          {/* stacked bar */}
          {tokenTotal > 0 && (
            <div style={{ height: 3, borderRadius: 2, overflow: "hidden", display: "flex", background: "#f3f4f6" }}>
              {ledgerRows.filter(r => r.value > 0).map(({ id, value }) => (
                <div key={id} style={{ flex: value, background: M[id].color }} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Badge strip — below token ledger, compact inline style ── */}
      {!isMock && (() => {
        const { compactionCount, errorCount, subAgentTurns, subAgentTotal, commandTurns, unknownTurns } = badgeSummary;
        type BS = { key: string; icon: React.ReactNode; label: string; detail: string; color: string };
        const items: BS[] = [
          compactionCount > 0 ? { key: "C", icon: BADGE_ICONS.compaction(10, "#ef4444"), label: t("sessionOverview.badges.compaction"), detail: `${compactionCount}t`, color: "#ef4444" } : null,
          errorCount > 0      ? { key: "E", icon: BADGE_ICONS.error(10, "#dc2626"),      label: t("sessionOverview.badges.errors"),      detail: `${errorCount}`,    color: "#dc2626" } : null,
          subAgentTotal > 0   ? { key: "A", icon: BADGE_ICONS.subAgent(10, "#7c3aed"),   label: t("sessionOverview.badges.subAgents"),   detail: `${subAgentTotal} · ${subAgentTurns}t`, color: "#7c3aed" } : null,
          commandTurns > 0    ? { key: "/", icon: BADGE_ICONS.command(10, "#d97706"),    label: t("sessionOverview.badges.commands"),    detail: `${commandTurns}t`, color: "#d97706" } : null,
          unknownTurns > 0    ? { key: "?", icon: BADGE_ICONS.unknown(10, "#9ca3af"),    label: t("sessionOverview.badges.unknown"),     detail: `${unknownTurns}t`, color: "#9ca3af" } : null,
        ].filter(Boolean) as BS[];
        if (items.length === 0) return null;
        return (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16, paddingTop: 2 }}>
            {items.map(b => (
              <div key={b.key} style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "2px 7px", borderRadius: 5,
                border: `1px solid ${b.color}28`, background: `${b.color}08`,
              }}>
                <span style={{ display: "inline-flex", alignItems: "center" }}>{b.icon}</span>
                <span style={{ fontSize: 10, color: b.color, fontWeight: 600 }}>{b.label}</span>
                <span style={{ fontSize: 10, color: b.color, opacity: 0.6 }}>{b.detail}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Context Overview Timeline */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
          {t("sessionOverview.charts.contextTimeline")} {isMock && <MockBadge />}
        </div>
        <ContextTimelineChart turns={turns} isMock={isMock} />
      </div>


      {/* Tool Distribution */}
      {(() => {
        const dist = drilldown?.toolDistribution ?? [];
        if (dist.length === 0) return null;
        const maxCount = dist[0].count;
        return (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>{t("sessionOverview.charts.toolUsage")}</div>
            <div>
              {dist.map(entry => (
                <div key={entry.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <span style={{ fontSize: 11, color: "#374151", width: 120, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                  <div style={{ flex: 1, height: 5, background: "#f3f4f6", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ width: `${(entry.count / maxCount) * 100}%`, height: "100%", background: "#6366f1", borderRadius: 2 }} />
                  </div>
                  <span style={{ fontSize: 11, color: "#6b7280", width: 36, textAlign: "right", flexShrink: 0 }}>{entry.count}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* User Turn List */}
      <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>{t("sessionOverview.charts.userTurns")}</div>
      <div style={{ display: "flex", gap: 0 }}>
        {/* Left USER rail */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 26, flexShrink: 0 }}>
          <span style={{ fontSize: 9, fontWeight: 600, color: "#93c5fd", letterSpacing: "0.05em", marginBottom: 4 }}>{t("sessionOverview.turn.roleUser")}</span>
          <div style={{ flex: 1, width: 1, background: "#dbeafe" }} />
        </div>
        {/* Center content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {turns.map((turn, idx) => (
            <React.Fragment key={turn.id}>
              {/* Turn divider */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, margin: idx === 0 ? "0 0 8px" : "20px 0 8px" }}>
                <div style={{ flex: 1, height: 1, background: "#f3f4f6" }} />
                <span style={{ fontSize: 10, whiteSpace: "nowrap", flexShrink: 0 }}>
                  <strong style={{ color: "#6366f1", fontWeight: 600 }}>{t("sessionOverview.turn.label")} {turn.id}</strong>
                  {turn.startedAt ? <span style={{ color: "#d1d5db" }}>{`  ·  ${new Date(turn.startedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}</span> : null}
                </span>
                <div style={{ flex: 1, height: 1, background: "#f3f4f6" }} />
              </div>
              <TurnCard turn={turn} onClick={() => onSelectTurn(turn)} />
            </React.Fragment>
          ))}
        </div>
        {/* Right AI rail */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 26, flexShrink: 0 }}>
          <span style={{ fontSize: 9, fontWeight: 600, color: "#86efac", letterSpacing: "0.05em", marginBottom: 4 }}>{t("sessionOverview.turn.roleAgent")}</span>
          <div style={{ flex: 1, width: 1, background: "#dcfce7" }} />
        </div>
      </div>
    </div>
  );
}

// Model name display: strip provider prefix, keep version suffix
function shortModelName(m: string): string {
  return m.replace(/^(aws|gcp|azure)\./i, "").replace("claude-", "");
}

const MODEL_COLORS: Record<string, string> = {
  "opus":    "#6366f1",
  "sonnet":  "#3b82f6",
  "haiku":   "#22c55e",
};
function modelColor(m: string): string {
  const lower = m.toLowerCase();
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return "#94a3b8";
}

function ModelBreakdownBlock({
  breakdown,
}: { breakdown: Record<string, ModelStats> }) {
  const { t } = useTranslation();
  const M = TOKEN_METRICS;
  const entries = Object.entries(breakdown).sort((a, b) => b[1].calls - a[1].calls);
  const totalCalls = entries.reduce((s, [, v]) => s + v.calls, 0);

  const COL = "repeat(2, 44px)"; // Calls + Out

  // Pre-compute per-row ledgers and the global max for proportional bar widths
  const rowData = entries.map(([model, stats]) => {
    const ledger = [
      { id: "fresh_input", value: stats.freshIn ?? 0 },
      { id: "cache_read",  value: stats.cacheRead },
      { id: "cache_write", value: stats.cacheWrite },
      { id: "output",      value: stats.outputTokens },
    ];
    const cacheInputTotal = (stats.freshIn ?? 0) + stats.cacheRead + stats.cacheWrite;
    const cacheRatio = cacheInputTotal > 0 ? stats.cacheRead / cacheInputTotal * 100 : null;
    return { model, stats, ledger, ledgerTotal: ledger.reduce((s, r) => s + r.value, 0), cacheRatio };
  });
  const maxLedgerTotal = Math.max(...rowData.map(r => r.ledgerTotal), 1);

  return (
    <div>
      {/* header */}
      <div style={{ display: "grid", gridTemplateColumns: `1fr ${COL} 1fr`, alignItems: "end", paddingBottom: 4, borderBottom: "1px solid #f3f4f6" }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>Model</span>
        {[t("sessionOverview.models.calls"), t("sessionOverview.models.output")].map(h => (
          <span key={h} style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", textAlign: "right", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</span>
        ))}
        <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", paddingLeft: 16 }}>{t("dashboard.tokenLedger")}</span>
      </div>

      {rowData.map(({ model, stats, ledger, ledgerTotal, cacheRatio }, i) => {
        const pct = totalCalls > 0 ? Math.round((stats.calls / totalCalls) * 100) : 0;
        const color = modelColor(model);
        // Bar width is proportional to global max — allows visual comparison across rows
        const barWidthPct = maxLedgerTotal > 0 ? (ledgerTotal / maxLedgerTotal) * 100 : 0;

        return (
          <div key={model} style={{
            display: "grid", gridTemplateColumns: `1fr ${COL} 1fr`,
            alignItems: "center", padding: "7px 0",
            borderBottom: i < rowData.length - 1 ? "1px solid #f3f4f6" : "none",
          }}>
            {/* model name + call-share bar */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>{shortModelName(model)}</span>
                <span style={{ fontSize: 10, color: "#9ca3af" }}>{pct}%</span>
              </div>
              <div style={{ height: 3, background: "#f3f4f6", borderRadius: 2, overflow: "hidden", width: 80 }}>
                <div style={{ width: `${pct}%`, height: "100%", background: color }} />
              </div>
            </div>

            {/* Calls */}
            <span style={{ fontSize: 11, color: "#374151", textAlign: "right" }}>{stats.calls}</span>
            {/* Out */}
            <span style={{ fontSize: 11, color: M.output.color, textAlign: "right" }}>{fmtK(stats.outputTokens)}</span>

            {/* Token Ledger mini */}
            <div style={{ paddingLeft: 16, display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                {ledger.map(({ id, value }) => {
                  const m = M[id];
                  return (
                    <div key={id} title={m.description}>
                      <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, marginBottom: 1, whiteSpace: "nowrap" }}>{m.label}</div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: value > 0 ? m.color : "#d1d5db", lineHeight: 1 }}>
                        {value > 0 ? fmtK(value) : "—"}
                      </div>
                    </div>
                  );
                })}
                {cacheRatio !== null && (
                  <div style={{ marginLeft: 4 }}>
                    <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, marginBottom: 1, whiteSpace: "nowrap" }}>{t("metrics.cacheRatio.label", M.cache_ratio.label)}</div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: M.cache_ratio.color, lineHeight: 1 }}>{fmtPct(cacheRatio)}</div>
                  </div>
                )}
              </div>
              {/* Bar: outer track = full width, inner fill = proportion of max */}
              <div style={{ height: 3, borderRadius: 2, background: "#f3f4f6", overflow: "hidden" }}>
                <div style={{ width: `${barWidthPct}%`, height: "100%", display: "flex", borderRadius: 2, overflow: "hidden" }}>
                  {ledger.filter(r => r.value > 0).map(({ id, value }) => (
                    <div key={id} style={{ flex: value, background: M[id].color }} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Sub-agent compression ratio helpers ──────────────────────────────────────
// A sub agent reads/processes a lot of context internally and returns a small
// summary to the parent. These helpers quantify that "compression" so a single
// glance answers: "how much context did this branch save the main thread?"

interface SubAgentCompression {
  consumed: number;       // total tokens the sub agent dealt with internally (proxy)
  returned: number;       // tokens written back into the parent context
  savedRatio: number;     // 1 - returned/consumed, clamped 0..1
}

function deriveSubAgentCompression(sa: SubAgentSummary): SubAgentCompression | null {
  // cacheRead is the dominant component of internal processing volume; it's the
  // same number we surface as "Cache R" elsewhere, so the math stays explainable.
  const consumed = sa.totalCacheRead;
  const returned = sa.totalOutputTokens;
  if (consumed <= 0 || returned <= 0 || returned >= consumed) return null;
  const savedRatio = Math.max(0, Math.min(1, 1 - returned / consumed));
  return { consumed, returned, savedRatio };
}

function CompressionCapsule({ sa, compact = false }: { sa: SubAgentSummary; compact?: boolean }) {
  const comp = deriveSubAgentCompression(sa);
  if (!comp) return null;
  const pct = Math.round(comp.savedRatio * 100);
  const barW = compact ? 36 : 56;
  return (
    <span
      title={`Sub agent processed ${fmtK(comp.consumed)} ctx internally and returned ${fmtK(comp.returned)} — main thread avoided ${fmtK(comp.consumed - comp.returned)} ctx.`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 9, color: "#047857",
        background: "#ecfdf5", border: "1px solid #a7f3d0",
        borderRadius: 3, padding: "1px 5px", whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: barW, height: 4, background: "#d1fae5", borderRadius: 2, overflow: "hidden", position: "relative" }}>
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: "#10b981" }} />
      </span>
      <span style={{ fontWeight: 700 }}>{pct}%</span>
      {!compact && <span style={{ color: "#059669" }}>saved</span>}
    </span>
  );
}

function HotspotChip({ icon, label, value, color }: { icon: string; label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6 }}>
      <span style={{ color, fontSize: 12 }}>{icon}</span>
      <span style={{ fontSize: 11, color: "#6b7280" }}>{label}:</span>
      <span style={{ fontSize: 11, fontWeight: 600, color }}>{value}</span>
    </div>
  );
}

type TimelineXMode = "linear" | "time";

function ContextTimelineChart({
  turns, isMock,
}: { turns: MockUserTurn[]; isMock: boolean }) {
  const { t } = useTranslation();
  const [xMode, setXMode] = useState<TimelineXMode>("linear");
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  const turnPoints = turns.map(turn => {
    const peak = Math.max(...turn.calls.map(c => c.contextSize), 0);
    const hasCompaction = turn.calls.some(c => c.isCompaction);
    const parseTs = (s: string) => {
      if (!s) return NaN;
      const t = s.length <= 8 ? new Date(`1970-01-01T${s}Z`).getTime() : new Date(s).getTime();
      return isNaN(t) ? NaN : t;
    };
    const firstMs = parseTs(turn.calls[0]?.timestamp ?? "");
    const lastMs  = parseTs(turn.calls[turn.calls.length - 1]?.timestamp ?? "");
    const durationMs = (!isNaN(firstMs) && !isNaN(lastMs)) ? Math.max(lastMs - firstMs, 0) : 0;
    return { turnId: turn.id, contextSize: peak, isCompaction: hasCompaction, firstMs, durationMs };
  });

  const peakCtx = Math.max(...turnPoints.map(p => p.contextSize), 0);

  // Build ECharts option based on current mode
  const buildOption = (mode: TimelineXMode): echarts.EChartsOption => {
    const nT = turnPoints.length;
    const lineColor = "#6366f1";

    const labelStyle = {
      fontSize: 9,
      borderWidth: 0,
      padding: [2, 4] as [number, number],
      borderRadius: 3,
    };

    // Shared markPoint data for max + final annotations
    const buildAnnotations = (
      maxIdx: number, maxVal: number, maxX: number | string,
      finalIdx: number, finalVal: number, finalX: number | string,
    ) => {
      const isSame = maxIdx === finalIdx;
      const pts: object[] = [];
      // max point
      pts.push({
        coord: [maxX, maxVal],
        symbol: "none",
        label: {
          show: true,
          formatter: `Max\n${fmtK(maxVal)}`,
          position: "top" as const,
          ...labelStyle,
          color: "#6366f1",
          backgroundColor: "#eef2ff",
        },
      });
      // final point (skip if same as max)
      if (!isSame) {
        pts.push({
          coord: [finalX, finalVal],
          symbol: "none",
          label: {
            show: true,
            formatter: `Final\n${fmtK(finalVal)}`,
            position: "top" as const,
            ...labelStyle,
            color: "#6b7280",
            backgroundColor: "#f3f4f6",
          },
        });
      }
      return pts;
    };

    // +Δ label shown above each point (skip first point, no delta)
    const deltaLabel = (values: number[]) => ({
      show: true,
      position: "top" as const,
      fontSize: 9,
      fontWeight: 500,
      padding: [1, 3] as [number, number],
      borderRadius: 3,
      borderWidth: 0,
      formatter: (params: unknown) => {
        const idx = (params as { dataIndex: number }).dataIndex;
        if (idx === 0) return "";
        const delta = values[idx] - values[idx - 1];
        if (delta <= 0) return "";
        return `+${fmtK(delta)}`;
      },
      color: "#6366f1",
      backgroundColor: "transparent",
    });

    if (mode === "linear" || nT <= 1) {
      const xLabels = turnPoints.map(p => `T${p.turnId}`);
      const values = turnPoints.map(p => p.contextSize);
      const compactionIndices = turnPoints
        .map((p, i) => p.isCompaction ? i : -1)
        .filter(i => i >= 0);

      const maxIdx = values.indexOf(Math.max(...values));
      const finalIdx = values.length - 1;
      const annotations = buildAnnotations(
        maxIdx, values[maxIdx], xLabels[maxIdx],
        finalIdx, values[finalIdx], xLabels[finalIdx],
      );

      return {
        grid: { top: 36, bottom: 28, left: 12, right: 44, containLabel: false },
        xAxis: {
          type: "category",
          data: xLabels,
          axisLabel: { fontSize: 10, color: "#9ca3af", interval: 0 },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          min: 0,
          axisLabel: {
            fontSize: 9,
            color: "#d1d5db",
            formatter: (v: number) => fmtK(v),
            inside: false,
          },
          splitLine: { lineStyle: { color: "#f3f4f6" } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [
          {
            type: "line",
            data: values,
            smooth: false,
            lineStyle: { color: lineColor, width: 1.5 },
            itemStyle: { color: lineColor },
            symbolSize: (_, params) =>
              compactionIndices.includes((params as { dataIndex: number }).dataIndex) ? 8 : 5,
            symbol: (_, params) =>
              compactionIndices.includes((params as { dataIndex: number }).dataIndex) ? "diamond" : "circle",
            areaStyle: { color: lineColor, opacity: 0.06 },
            label: deltaLabel(values),
            labelLayout: { hideOverlap: true },
            markPoint: {
              silent: true,
              data: [
                ...compactionIndices.map(i => ({
                  coord: [xLabels[i], values[i]],
                  itemStyle: { color: "#ef4444" },
                  symbol: "diamond",
                  symbolSize: 8,
                  label: { show: false },
                })),
                ...annotations,
              ],
            },
          },
        ],
        tooltip: {
          trigger: "axis",
          formatter: (params: unknown) => {
            const p = (params as Array<{ name: string; value: number }>)[0];
            if (!p) return "";
            const tp = turnPoints.find(t => `T${t.turnId}` === p.name);
            const compTag = tp?.isCompaction ? " ◆ compaction" : "";
            return `${p.name}: ${fmtK(p.value)}${compTag}`;
          },
          textStyle: { fontSize: 11 },
        },
      };
    } else {
      // Time mode: value axis using cumulative active time in seconds
      const hasTimestamps = turnPoints.every(p => !isNaN(p.firstMs));
      if (!hasTimestamps) {
        return buildOption("linear");
      }

      const cumActive: number[] = [0];
      for (let i = 1; i < nT; i++) {
        const prevEnd = turnPoints[i - 1].firstMs + turnPoints[i - 1].durationMs;
        cumActive.push(cumActive[i - 1] + turnPoints[i - 1].durationMs);
        void prevEnd; // idle gaps no longer displayed
      }

      const dataPoints = turnPoints.map((p, i) => ({
        value: [cumActive[i] / 1000, p.contextSize] as [number, number],
        isCompaction: p.isCompaction,
        turnId: p.turnId,
      }));

      const ctxValues = dataPoints.map(d => d.value[1]);
      const maxDpIdx = ctxValues.indexOf(Math.max(...ctxValues));
      const finalDpIdx = dataPoints.length - 1;
      const timeAnnotations = buildAnnotations(
        maxDpIdx, dataPoints[maxDpIdx].value[1], dataPoints[maxDpIdx].value[0],
        finalDpIdx, dataPoints[finalDpIdx].value[1], dataPoints[finalDpIdx].value[0],
      );

      return {
        grid: { top: 36, bottom: 28, left: 12, right: 44, containLabel: false },
        xAxis: {
          type: "value",
          min: 0,
          max: dataPoints[dataPoints.length - 1]?.value[0] ?? "dataMax",
          axisLabel: {
            fontSize: 9,
            color: "#9ca3af",
            formatter: (v: number) => {
              if (v < 60) return `${v}s`;
              return `${Math.round(v / 60)}m`;
            },
          },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          min: 0,
          axisLabel: {
            fontSize: 9,
            color: "#d1d5db",
            formatter: (v: number) => fmtK(v),
          },
          splitLine: { lineStyle: { color: "#f3f4f6" } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [
          {
            type: "line",
            data: dataPoints.map(d => d.value),
            smooth: false,
            lineStyle: { color: lineColor, width: 1.5 },
            itemStyle: {
              color: (params: unknown) => {
                const idx = (params as { dataIndex: number }).dataIndex;
                return dataPoints[idx]?.isCompaction ? "#ef4444" : lineColor;
              },
            },
            symbolSize: (_, params) => dataPoints[(params as { dataIndex: number }).dataIndex]?.isCompaction ? 8 : 5,
            symbol: (_, params) => dataPoints[(params as { dataIndex: number }).dataIndex]?.isCompaction ? "diamond" : "circle",
            areaStyle: { color: lineColor, opacity: 0.06 },
            label: deltaLabel(ctxValues),
            labelLayout: { hideOverlap: true },
            markPoint: { silent: true, data: timeAnnotations },
          },
        ],
        tooltip: {
          trigger: "axis",
          formatter: (params: unknown) => {
            const p = (params as Array<{ dataIndex: number; value: [number, number] }>)[0];
            if (!p) return "";
            const d = dataPoints[p.dataIndex];
            const compTag = d?.isCompaction ? " ◆" : "";
            return `T${d?.turnId}: ${fmtK(p.value[1])}${compTag}`;
          },
          textStyle: { fontSize: 11 },
        },
      };
    }
  };

  // Init chart once
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = echarts.init(chartRef.current, undefined, { renderer: "svg" });
    instanceRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(chartRef.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      instanceRef.current = null;
    };
  }, []);

  // Re-set option whenever mode or data changes — replacesMerge ensures X axis fully resets
  useEffect(() => {
    const chart = instanceRef.current;
    if (!chart || !turnPoints.length) return;
    chart.setOption(buildOption(xMode), { replaceMerge: ["xAxis", "yAxis", "series"] });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xMode, turns]);

  if (!turns.length) return null;

  return (
    <div style={{ overflow: "hidden" }}>
      {/* Mode toggle */}
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 10px 0", gap: 4 }}>
        {(["linear", "time"] as TimelineXMode[]).map(mode => (
          <button
            key={mode}
            onClick={() => setXMode(mode)}
            style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer",
              background: xMode === mode ? "#6366f1" : "transparent",
              color: xMode === mode ? "#fff" : "#9ca3af",
              border: `1px solid ${xMode === mode ? "#6366f1" : "#e5e7eb"}`,
            }}
          >
            {mode === "linear" ? t("sessionOverview.charts.xAxisLinear") : t("sessionOverview.charts.xAxisTime")}
          </button>
        ))}
      </div>

      <div ref={chartRef} style={{ width: "100%", height: 150 }} />

      {/* Footer annotation */}
      {!isMock && (
        <div style={{ padding: "2px 10px 6px", fontSize: 10, color: "#9ca3af", display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>{t("sessionOverview.charts.peak")}: <strong style={{ color: "#374151" }}>{fmtK(peakCtx)}</strong></span>
          {xMode === "time" && <span style={{ color: "#c4b5d5" }}>{t("sessionOverview.charts.xAxisTimeHint")}</span>}
        </div>
      )}
    </div>
  );
}

const INPUT_PREVIEW_CHARS = 120;
const OUTPUT_PREVIEW_CHARS = 200;

function fmtDuration(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function TurnCard({ turn, onClick }: { turn: MockUserTurn; onClick: () => void }) {
  const [inputExpanded, setInputExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [mdMode, setMdMode] = useState(true);

  const inputFull = turn.userInput;
  const inputNeedsExpand = inputFull.length > INPUT_PREVIEW_CHARS;
  const inputShown = inputNeedsExpand && !inputExpanded
    ? inputFull.slice(0, INPUT_PREVIEW_CHARS) + "…"
    : inputFull;

  const outputFull = turn.finalOutput ?? null;
  const outputNeedsExpand = outputFull !== null && outputFull.length > OUTPUT_PREVIEW_CHARS;
  const outputShown = outputFull
    ? outputNeedsExpand && !outputExpanded
      ? outputFull.slice(0, OUTPUT_PREVIEW_CHARS) + "…"
      : outputFull
    : null;

  const saCount = turn.calls.reduce((s, c) => s + c.subAgents.length, 0);

  return (
    <div style={{ marginBottom: 4 }}>
      {/* ── Turn header ── */}
      <div
        onClick={onClick}
        style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, cursor: "pointer" }}
      >
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {saCount > 0 && (
            <span title={`${saCount} sub agent${saCount > 1 ? "s" : ""}`} style={{
              display: "inline-flex", alignItems: "center", gap: 2,
              fontSize: 9, fontWeight: 700, color: "#4338ca",
              background: "#eef2ff", border: "1px dashed #a5b4fc",
              borderRadius: 4, padding: "1px 4px",
            }}><ForkIcon size={9} color="#4338ca" /> {saCount}</span>
          )}
          {turn.hasCompaction && <RiskBadge type="compaction" />}
          {turn.errorCount > 0 && (
            <span style={{ fontSize: 9, fontWeight: 700, color: "#fff", background: "#dc2626", borderRadius: 3, padding: "1px 4px" }}>
              {turn.errorCount}E
            </span>
          )}
          <span style={{ fontSize: 10, color: "#9ca3af" }}>›</span>
        </div>
      </div>

      {/* ── User bubble ── */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ position: "relative" }}>
          {/* left soft arrow */}
          <svg style={{ position: "absolute", left: -8, top: 8 }} width="9" height="14" viewBox="0 0 9 14" fill="none">
            <path d="M9 2 Q9 0 7 1 L1 7 L7 13 Q9 14 9 12 Z" fill="#eff6ff" stroke="#bfdbfe" strokeWidth="1" strokeLinejoin="round"/>
          </svg>
          <div style={{
            fontSize: 12, color: "#1e3a5f", lineHeight: 1.55,
            background: "#eff6ff", border: "1px solid #bfdbfe",
            borderRadius: "12px",
            padding: "8px 12px",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {inputShown}
          </div>
        </div>
        {inputNeedsExpand && (
          <button
            onClick={e => { e.stopPropagation(); setInputExpanded(v => !v); }}
            style={{ marginTop: 4, fontSize: 11, color: "#3b82f6", background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            {inputExpanded ? "Show less ↑" : "Show more ↓"}
          </button>
        )}
      </div>

      {/* ── Mid-turn injections (yellow) ── */}
      {turn.midTurnInjections?.map((inj, idx) => (
        <div key={idx} style={{ marginBottom: 6, paddingLeft: 8 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: "#d97706", marginBottom: 3, letterSpacing: "0.05em" }}>
            ↩ INTERRUPT · after call {inj.afterCallIndex}
          </div>
          <div style={{
            fontSize: 12, color: "#78350f", lineHeight: 1.5,
            background: "#fffbeb", border: "1px solid #fcd34d",
            borderRadius: "2px 12px 12px 12px",
            padding: "7px 11px",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {inj.text}
            {inj.timestamp && (
              <span style={{ display: "block", fontSize: 10, color: "#d97706", marginTop: 3 }}>
                {inj.timestamp.length >= 19 ? inj.timestamp.slice(11, 19) : inj.timestamp}
              </span>
            )}
          </div>
        </div>
      ))}

      {/* ── AI bubble ── */}
      {outputFull && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, marginBottom: 3 }}>
            <button
              onClick={e => { e.stopPropagation(); setMdMode(v => !v); }}
              style={{
                fontSize: 9, color: mdMode ? "#16a34a" : "#9ca3af",
                background: mdMode ? "#f0fdf4" : "#f3f4f6",
                border: "none", borderRadius: 3, padding: "1px 5px",
                cursor: "pointer", fontWeight: 600,
              }}
            >
              {mdMode ? "MD" : "TXT"}
            </button>
          </div>
          <div style={{ position: "relative" }}>
            {/* right soft arrow */}
            <svg style={{ position: "absolute", right: -8, top: 8 }} width="9" height="14" viewBox="0 0 9 14" fill="none">
              <path d="M0 2 Q0 0 2 1 L8 7 L2 13 Q0 14 0 12 Z" fill="#f0fdf4" stroke="#bbf7d0" strokeWidth="1" strokeLinejoin="round"/>
            </svg>
          <div style={{
            fontSize: 12, color: "#14532d", lineHeight: 1.6,
            background: "#f0fdf4", border: "1px solid #bbf7d0",
            borderRadius: "12px",
            padding: "8px 12px",
          }}>
            {mdMode ? (
              <div className="md-prose" style={{ fontSize: 12, lineHeight: 1.6 }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{outputShown ?? ""}</ReactMarkdown>
              </div>
            ) : (
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{outputShown}</div>
            )}
          </div>
          </div>
          {outputNeedsExpand && (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={e => { e.stopPropagation(); setOutputExpanded(v => !v); }}
                style={{ marginTop: 4, fontSize: 11, color: "#16a34a", background: "none", border: "none", cursor: "pointer", padding: 0 }}
              >
                {outputExpanded ? "Show less ↑" : "Show more ↓"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Agent Loop data types ────────────────────────────────────────────────────

// Derives real agent loop data from actual LlmCall fields.
// Tool names and details require proxy data; tool counts come from real JSONL.
function buildRealAgentLoop(turn: MockUserTurn): MockAgentLoopData {
  const toolGroups: MockToolGroup[] = [];
  const transitions: MockAgentLoopData["transitions"] = [];

  for (let i = 0; i < turn.calls.length; i++) {
    const c = turn.calls[i];
    if (c.isCompaction) continue;
    // We know how many tool calls happened after each LLM call from indexInTurn sequencing,
    // but tool names are not in the data model without proxy. Emit an opaque group per call
    // that had tool use (stop_reason === "tool_use").
    if (c.stopReason === "tool_use") {
      // toolCallCount is a turn-level field, not call-level — skip if unavailable
    }
  }

  for (let i = 0; i < turn.calls.length - 1; i++) {
    const c = turn.calls[i];
    const next = turn.calls[i + 1];
    const delta = next.contextSize - c.contextSize;
    if (Math.abs(delta) < 500) continue;
    let cause = "incremental";
    if (c.isCompaction) cause = "Compaction";
    else if (Math.abs(delta) > 5000) cause = "large tool output";
    else if (delta > 0) cause = "tool result";
    transitions.push({ fromCallId: c.id, toCallId: next.id, contextDelta: delta, dominantCause: cause });
  }

  const lastCall = turn.calls[turn.calls.length - 1];
  const status: MockAgentLoopData["status"] =
    !lastCall ? "completed"
    : lastCall.stopReason === "max_tokens" ? "interrupted"
    : lastCall.stopReason === "tool_use" ? "continued"
    : "completed";

  return { toolGroups, transitions, toolSummary: [], status };
}

// ─── Agent Loop Timeline component ───────────────────────────────────────────

const TIMELINE_INPUT_PREVIEW = 200;
const TIMELINE_OUTPUT_PREVIEW = 200;

function AgentLoopTimeline({
  turn, agentLoop, onSelectCall, onSubAgentClick,
}: { turn: MockUserTurn; agentLoop: MockAgentLoopData; onSelectCall: (c: MockLlmCall) => void; onSubAgentClick?: (sa: SubAgentSummary) => void }) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [inputExpanded, setInputExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const maxCtx = Math.max(...turn.calls.map(c => c.contextSize), 1);

  const inputNeedsExpand = turn.userInput.length > TIMELINE_INPUT_PREVIEW;
  const inputShown = inputNeedsExpand && !inputExpanded
    ? turn.userInput.slice(0, TIMELINE_INPUT_PREVIEW) + "…"
    : turn.userInput;

  const outputFull = turn.finalOutput ?? null;
  const outputNeedsExpand = outputFull !== null && outputFull.length > TIMELINE_OUTPUT_PREVIEW;
  const outputShown = outputFull
    ? (outputNeedsExpand && !outputExpanded ? outputFull.slice(0, TIMELINE_OUTPUT_PREVIEW) + "…" : outputFull)
    : null;

  return (
    <div style={{ position: "relative" }}>
      {/* Vertical spine */}
      <div style={{
        position: "absolute", left: 16, top: 0, bottom: 0,
        width: 2, background: "#e5e7eb", zIndex: 0,
      }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {/* User Input node */}
        <AgentLoopNode
          icon="👤" color="#6366f1" label="User Input"
          secondary={fmtDuration(turn.durationMs) || undefined}
          expandable={inputNeedsExpand}
          expanded={inputExpanded}
          onToggle={inputNeedsExpand ? () => setInputExpanded(v => !v) : undefined}
        >
          <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.5, background: "#f5f3ff", borderRadius: 6, padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {inputShown}
          </div>
        </AgentLoopNode>

        {/* For each call: Call node → Tool Group (if any) */}
        {turn.calls.map((call, idx) => {
          const tg = agentLoop.toolGroups.find(g => g.afterCallId === call.id);
          const isLast = idx === turn.calls.length - 1;
          const ctxPct = Math.round((call.contextSize / maxCtx) * 100);
          const transition = agentLoop.transitions.find(t => t.fromCallId === call.id);
          const isGroupExpanded = expandedGroup === (tg?.id ?? "");

          return (
            <div key={call.id}>
              {/* LLM Call node */}
              <AgentLoopNode
                icon={call.isCompaction ? "◆" : "⬡"}
                color={call.isCompaction ? "#ef4444" : call.isSignificant ? "#3b82f6" : "#6b7280"}
                label={`Call #${call.id}`}
                secondary={`${fmtK(call.contextSize)} ctx`}
                badge={call.significantDelta > 0 ? `+${fmtK(call.significantDelta)}` : call.significantDelta < 0 ? fmtK(call.significantDelta) : undefined}
                badgeColor={call.significantDelta > 2000 ? "#d97706" : call.significantDelta < 0 ? "#16a34a" : "#9ca3af"}
                onClick={() => onSelectCall(call)}
                interactive
              >
                {/* Mini context bar */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  <div style={{ flex: 1, height: 3, background: "#f3f4f6", borderRadius: 2, overflow: "hidden", maxWidth: 120 }}>
                    <div style={{ width: `${ctxPct}%`, height: "100%", background: call.isCompaction ? "#ef4444" : "#6366f1", opacity: 0.6 }} />
                  </div>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>
                    {Math.round(call.cacheRead / (call.contextSize || 1) * 100)}% cached
                  </span>
                  {call.stopReason && call.stopReason !== "tool_use" && (
                    <span style={{ fontSize: 10, color: "#16a34a", fontWeight: 600 }}>
                      {call.stopReason === "end_turn" ? "✓ end_turn" : call.stopReason}
                    </span>
                  )}
                  {call.isCompaction && <span style={{ fontSize: 10, color: "#ef4444", fontWeight: 600 }}>compaction</span>}
                </div>
              </AgentLoopNode>

              {/* Tool Group node (between calls) */}
              {tg && !isLast && (
                <AgentLoopNode
                  icon="⚙"
                  color={tg.tools.some(t => t.status !== "ok") ? "#dc2626" : tg.isParallel ? "#8b5cf6" : "#f59e0b"}
                  label={
                    tg.isParallel
                      ? `${tg.tools.length}× parallel tool calls`
                      : `${tg.tools.length} tool call${tg.tools.length > 1 ? "s" : ""}`
                  }
                  secondary={`+${fmtK(tg.totalOutputSize)} output`}
                  badge={tg.tools.some(t => t.status !== "ok") ? "error" : undefined}
                  badgeColor="#dc2626"
                  expandable
                  expanded={isGroupExpanded}
                  onToggle={() => setExpandedGroup(isGroupExpanded ? null : tg.id)}
                  mock
                >
                  {isGroupExpanded && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6 }}>
                      {tg.tools.map(t => (
                        <div key={t.id} style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "4px 8px", borderRadius: 5,
                          background: t.status !== "ok" ? "#fef2f2" : "#fafafa",
                          border: `1px solid ${t.status !== "ok" ? "#fecaca" : "#f3f4f6"}`,
                        }}>
                          {tg.isParallel && (
                            <span style={{ fontSize: 9, color: "#8b5cf6", fontWeight: 700 }}>∥</span>
                          )}
                          <span style={{ fontSize: 11, fontWeight: 600, color: "#374151", width: 44, flexShrink: 0 }}>{t.tool}</span>
                          <span style={{ fontSize: 11, color: "#6b7280", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.input}</span>
                          <span style={{ fontSize: 10, color: "#9ca3af" }}>{fmtK(t.outputSize)}</span>
                          <span style={{ fontSize: 10, color: "#9ca3af" }}>{fmtDuration(t.durationMs)}</span>
                          {t.status !== "ok" && (
                            <span style={{ fontSize: 10, color: "#dc2626", fontWeight: 700 }}>✗ {t.status}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </AgentLoopNode>
              )}

              {/* Transition annotation — only for significant deltas */}
              {transition && Math.abs(transition.contextDelta) > 2000 && (
                <div style={{ marginLeft: 40, marginBottom: 4, padding: "3px 8px", fontSize: 10, color: "#9ca3af", display: "flex", gap: 6 }}>
                  <span style={{ color: transition.contextDelta > 0 ? "#d97706" : "#16a34a", fontWeight: 600 }}>
                    {transition.contextDelta > 0 ? "+" : ""}{fmtK(transition.contextDelta)}
                  </span>
                  <span>from {transition.dominantCause}</span>
                </div>
              )}

              {/* ── Sub-agent branch nodes (git tree style, distinct from tool calls) ── */}
              {call.subAgents.length > 0 && (
                <div style={{ marginLeft: 32, marginBottom: 4, position: "relative" }}>
                  {/* Vertical connector from spine — dashed to convey "side branch" */}
                  <div style={{
                    position: "absolute", left: -16, top: 0, bottom: 8,
                    width: 0, borderLeft: "1.5px dashed #818cf8", opacity: 0.7,
                  }} />
                  {call.subAgents.map(sa => (
                    <div key={sa.agentFileId} style={{ display: "flex", alignItems: "flex-start", gap: 0, marginBottom: 6 }}>
                      {/* Branch elbow — dashed */}
                      <div style={{ width: 16, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                        <div style={{ width: 14, height: 12, borderLeft: "1.5px dashed #818cf8", borderBottom: "1.5px dashed #818cf8", borderBottomLeftRadius: 4, marginTop: 4 }} />
                      </div>
                      {/* Agent node — clickable, dashed-bordered to read as "branch" not "tool call" */}
                      <button
                        onClick={() => onSubAgentClick?.(sa)}
                        style={{
                          flex: 1, border: "1.5px dashed #818cf8", borderRadius: 8,
                          background: "linear-gradient(135deg, #f5f3ff 0%, #faf5ff 100%)",
                          padding: "6px 10px",
                          cursor: onSubAgentClick ? "pointer" : "default",
                          textAlign: "left", display: "flex", flexDirection: "column", gap: 3,
                        }}
                        onMouseEnter={e => { if (onSubAgentClick) e.currentTarget.style.background = "linear-gradient(135deg, #ede9fe 0%, #f3e8ff 100%)"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = "linear-gradient(135deg, #f5f3ff 0%, #faf5ff 100%)"; }}
                      >
                        {/* Row 1: branch icon + type + stats + arrow */}
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <ForkIcon size={11} color="#7c3aed" />
                          <span style={{ fontSize: 10, fontWeight: 700, color: "#5b21b6" }}>{sa.agentType}</span>
                          <span style={{ fontSize: 9, color: "#7c3aed" }}>{sa.llmCallCount}c · {sa.toolCallCount}t</span>
                          <span style={{ fontSize: 9, color: "#9ca3af" }}>{fmtDuration(sa.durationMs)}</span>
                          <span style={{ fontSize: 9, color: "#5b21b6", background: "#ede9fe", borderRadius: 3, padding: "1px 5px" }}>+{fmtK(sa.totalOutputTokens)}</span>
                          <CompressionCapsule sa={sa} />
                          {onSubAgentClick && <span style={{ fontSize: 10, color: "#a5b4fc", marginLeft: "auto" }}>›</span>}
                        </div>
                        {/* Row 2: description */}
                        {sa.description && (
                          <div style={{ fontSize: 10, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {sa.description}
                          </div>
                        )}
                        {/* Row 3: result preview */}
                        {sa.resultPreview && (
                          <div style={{ fontSize: 10, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "#fff", borderRadius: 4, padding: "2px 6px", border: "1px solid #e9d5ff" }}>
                            {sa.resultPreview.slice(0, 120)}{sa.resultPreview.length > 120 ? "…" : ""}
                          </div>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Terminal node — shows final output inline */}
        <AgentLoopNode
          icon={agentLoop.status === "completed" ? "✓" : agentLoop.status === "interrupted" ? "⚠" : "→"}
          color={agentLoop.status === "completed" ? "#16a34a" : agentLoop.status === "interrupted" ? "#d97706" : "#6366f1"}
          label={agentLoop.status === "completed" ? "Completed" : agentLoop.status === "interrupted" ? "Interrupted" : "Continued"}
          expandable={outputNeedsExpand}
          expanded={outputExpanded}
          onToggle={outputNeedsExpand ? () => setOutputExpanded(v => !v) : undefined}
          isTerminal
        >
          {outputShown && (
            <div className="md-prose" style={{ fontSize: 12, color: "#374151", lineHeight: 1.6, background: "#f0fdf4", borderRadius: 6, padding: "8px 10px", marginTop: 2 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{outputShown}</ReactMarkdown>
            </div>
          )}
        </AgentLoopNode>
      </div>
    </div>
  );
}

function AgentLoopNode({
  icon, color, label, secondary, badge, badgeColor,
  onClick, interactive, expandable, expanded, onToggle,
  isTerminal, mock, children,
}: {
  icon: string; color: string; label: string; secondary?: string;
  badge?: string; badgeColor?: string;
  onClick?: () => void; interactive?: boolean;
  expandable?: boolean; expanded?: boolean; onToggle?: () => void;
  isTerminal?: boolean; mock?: boolean;
  children?: React.ReactNode;
}) {
  const handleClick = onClick || onToggle;

  return (
    <div style={{ display: "flex", gap: 0, alignItems: "flex-start", position: "relative", zIndex: 1 }}>
      {/* Spine dot */}
      <div style={{ width: 32, flexShrink: 0, display: "flex", justifyContent: "center", paddingTop: 10 }}>
        <div style={{
          width: isTerminal ? 20 : 24, height: isTerminal ? 20 : 24,
          borderRadius: "50%", background: color, opacity: 0.15,
          display: "flex", alignItems: "center", justifyContent: "center",
          position: "relative",
        }}>
          <div style={{
            width: isTerminal ? 10 : 14, height: isTerminal ? 10 : 14,
            borderRadius: "50%", background: color,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{ fontSize: isTerminal ? 7 : 9, lineHeight: 1 }}>{icon}</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div
        onClick={handleClick}
        style={{
          flex: 1, paddingTop: 6, paddingBottom: 10, paddingRight: 4, minWidth: 0,
          cursor: handleClick ? "pointer" : "default",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: children ? 2 : 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>{label}</span>
          {secondary && <span style={{ fontSize: 11, color: "#9ca3af" }}>{secondary}</span>}
          {badge && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: badgeColor ?? "#d97706",
              background: badgeColor ? `${badgeColor}18` : "#fff7ed",
              borderRadius: 4, padding: "1px 5px",
            }}>{badge}</span>
          )}
          {mock && <MockBadge />}
          {expandable && (
            <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: "auto" }}>
              {expanded ? "▲" : "▼"}
            </span>
          )}
          {interactive && !expandable && (
            <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: "auto" }}>›</span>
          )}
        </div>
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

// ─── Shared SummaryMetricStrip ────────────────────────────────────────────────
// Used by both Session Overview and Turn Detail for consistent metric language.

interface MetricCard {
  label: string;
  value: string;
  sub?: string;          // small secondary value below main number
  color?: string;        // override value text color
  alert?: boolean;       // red background
  mock?: boolean;
  tooltip?: string;
}

function SummaryMetricStrip({ cards, columns = 4 }: { cards: MetricCard[]; columns?: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 8 }}>
      {cards.map(({ label, value, sub, color, alert, mock, tooltip }) => (
        <div key={label} title={tooltip} style={{
          background: alert ? "#fef2f2" : "#f9fafb",
          border: `1px solid ${alert ? "#fecaca" : "#e5e7eb"}`,
          borderRadius: 8, padding: "7px 10px", minWidth: 0,
        }}>
          <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {label}{mock && <MockBadge />}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: alert ? "#dc2626" : (color ?? "#111827"), lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {value}
            {sub && <span style={{ fontSize: 10, fontWeight: 400, color: "#9ca3af", marginLeft: 5 }}>{sub}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: "completed" | "interrupted" | "continued" }) {
  const cfg = {
    completed:   { color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", label: "Completed" },
    interrupted: { color: "#d97706", bg: "#fffbeb", border: "#fde68a", label: "Interrupted" },
    continued:   { color: "#6366f1", bg: "#eff6ff", border: "#c7d2fe", label: "Continued" },
  }[status];
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, color: cfg.color,
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      borderRadius: 4, padding: "2px 7px",
    }}>{cfg.label}</span>
  );
}

// ─── Section heading ──────────────────────────────────────────────────────────

function SectionLabel({ children, mock }: { children: React.ReactNode; mock?: boolean }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 6 }}>
      {children}{mock && <MockBadge />}
    </div>
  );
}

// ─── User Turn Detail Panel ───────────────────────────────────────────────────

// ─── Agent Loop Flow (horizontal trace view) ─────────────────────────────────

// ─── Tool chip color helpers ──────────────────────────────────────────────────
const TOOL_COLOR: Record<string, { fg: string; bg: string; border: string }> = {
  Read:    { fg: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe" },
  Bash:    { fg: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  Write:   { fg: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
  Edit:    { fg: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
  Glob:    { fg: "#6366f1", bg: "#eff6ff", border: "#c7d2fe" },
  Grep:    { fg: "#6366f1", bg: "#eff6ff", border: "#c7d2fe" },
  WebFetch:{ fg: "#8b5cf6", bg: "#faf5ff", border: "#ddd6fe" },
  Task:    { fg: "#0891b2", bg: "#ecfeff", border: "#a5f3fc" },
};
function toolChipStyle(name: string) {
  return TOOL_COLOR[name] ?? { fg: "#6b7280", bg: "#f9fafb", border: "#e5e7eb" };
}

// ─── Hybrid Agent Flow (main Turn view) ──────────────────────────────────────
//
// Three-lane SVG layout:
//   Top lane    : compact context strip (all calls, clickable)
//   Main lane   : User → [Call → Transition Bridge]* → Terminal
//   Bottom lane : duration / legend
//
// Transition Bridge = events between Call i and Call i+1:
//   tool group chips + duration + context delta arrow

// ─── D3 scales (module-level, shared) ────────────────────────────────────────

// Tool-name → colour  (reuses Tableau-10 palette, maps tool names deterministically)
const TOOL_NAMES_ORDERED = ["Read", "Bash", "Write", "Edit", "Glob", "Grep", "WebFetch", "Task", "Other"];
const toolColorScale = scaleOrdinal<string, string>(schemeTableau10).domain(TOOL_NAMES_ORDERED);

// Override the Tableau colours with our brand palette where defined
function d3ToolColor(name: string): string {
  const override = TOOL_COLOR[name];
  return override ? override.fg : toolColorScale(name);
}

// ─── Hybrid Agent Flow ────────────────────────────────────────────────────────

function AgentLoopFlow({
  turn, agentLoop, onSelectCall, onSubAgentClick,
}: { turn: MockUserTurn; agentLoop: MockAgentLoopData; onSelectCall: (c: MockLlmCall) => void; onSubAgentClick?: (sa: SubAgentSummary) => void }) {
  const [selectedTransitionIdx, setSelectedTransitionIdx] = useState<number | null>(null);

  const calls = turn.calls;
  const maxCtx = Math.max(...calls.map(c => c.contextSize), 1);
  const maxOutput = Math.max(...agentLoop.toolGroups.map(g => g.totalOutputSize), 1);

  // ── D3 scales ──────────────────────────────────────────────────────────
  // Call node height: linear scale ctx → px
  const callHeightScale = scaleLinear()
    .domain([0, maxCtx])
    .range([44, 100])
    .clamp(true);

  // Bridge (transition) height: sqrt scale so large outputs don't dominate
  const bridgeHeightScale = scaleSqrt()
    .domain([0, maxOutput])
    .range([32, 80])
    .clamp(true);

  // Bridge width: linear scale so wider = more total output
  const bridgeWidthScale = scaleLinear()
    .domain([0, maxOutput])
    .range([100, 170])
    .clamp(true);


  // ── Build call checkpoints ──────────────────────────────────────────────
  interface CallCheckpoint {
    call: MockLlmCall;
    ctxDelta: number;
    callH: number;      // D3-computed height
    isSignificant: boolean;
    nearLimit: boolean;
    tg: MockToolGroup | null;
  }

  const checkpoints: CallCheckpoint[] = calls.map((call, i) => {
    const prev = calls[i - 1];
    const ctxDelta = prev ? call.contextSize - prev.contextSize : call.contextSize;
    return {
      call,
      ctxDelta,
      callH: Math.round(callHeightScale(call.contextSize)),
      isSignificant: Math.abs(ctxDelta) > 2000,
      nearLimit: false,
      tg: agentLoop.toolGroups.find(g => g.afterCallId === call.id) ?? null,
    };
  });

  // ── Layout constants ────────────────────────────────────────────────────
  const CALL_W  = 80;
  const CONN_W  = 20;
  const USER_W  = 64;
  const TERM_W  = 54;
  const LABEL_H = 22;

  // ── Selected transition detail drawer ──────────────────────────────────
  const selectedTG = selectedTransitionIdx !== null
    ? checkpoints[selectedTransitionIdx]?.tg
    : null;

  return (
    <div style={{ background: "#fafafa", border: "1px solid #f3f4f6", borderRadius: 10, overflow: "hidden" }}>

      {/* ── Lane 1: context strip (D3 line chart) ──────────── */}
      <D3ContextStrip
        calls={calls}
        checkpoints={checkpoints}
        onSelectCall={onSelectCall}
      />

      {/* ── Lane 2: main agent loop flow ───────────────────── */}
      <div style={{ overflowX: "auto", padding: "0 12px" }}>
        {/* Outer column: stacks main flow row + per-spawn subagent branch rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: 0, minWidth: "fit-content" }}>

        {/* ── Main flow row ────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "flex-end", paddingTop: LABEL_H, paddingBottom: 8, gap: 0 }}>

          {/* User input node */}
          <FlowCallNode kind="user" label="User"
            subLabel={turn.userInput.slice(0, 16) + (turn.userInput.length > 16 ? "…" : "")}
            width={USER_W} height={48} />

          {checkpoints.map((cp, idx) => {
            const { call, ctxDelta, callH, tg } = cp;
            const isLast = idx === checkpoints.length - 1;
            const isSelectedTrans = selectedTransitionIdx === idx;
            const prevH = idx === 0 ? 48 : checkpoints[idx - 1].callH;
            // Does the PREVIOUS call have a subagent whose merge lands here?
            const prevCall = idx > 0 ? checkpoints[idx - 1].call : null;
            const isMergeTarget = (prevCall?.subAgents.length ?? 0) > 0;

            return (
              <React.Fragment key={call.id}>
                {/* D3 bezier arrow — tinted green when carrying a merge */}
                <D3FlowArrow
                  delta={ctxDelta}
                  significant={cp.isSignificant}
                  fromH={prevH}
                  toH={callH}
                  width={CONN_W}
                  mergeIn={isMergeTarget}
                />

                {/* Call checkpoint node — fork badge when spawning a subagent */}
                <div style={{ position: "relative" }}>
                  <FlowCallNode
                    kind={call.isCompaction ? "compaction" : cp.nearLimit ? "danger" : cp.isSignificant ? "significant" : "normal"}
                    label={`#${call.id}`}
                    subLabel={fmtK(call.contextSize)}
                    width={CALL_W}
                    height={callH}
                    cacheReadPct={call.contextSize > 0 ? call.cacheRead / call.contextSize : 0}
                    cacheWritePct={call.contextSize > 0 ? call.cacheWrite / call.contextSize : 0}
                    stopReason={call.stopReason}
                    ctxDelta={ctxDelta}
                    onClick={() => onSelectCall(call)}
                  />
                  {/* Fork indicator: violet badge marks the spawn point of a sub-agent branch */}
                  {call.subAgents.length > 0 && (
                    <div
                      title={`${call.subAgents.length} sub-agent branch${call.subAgents.length > 1 ? "es" : ""} spawned here`}
                      style={{
                        position: "absolute", bottom: -2, right: -2,
                        minWidth: 14, height: 14, padding: "0 3px", borderRadius: 7,
                        background: "#7c3aed", border: "2px solid #fff",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        gap: 1,
                      }}
                    >
                      <ForkIcon size={8} color="#fff" />
                      {call.subAgents.length > 1 && (
                        <span style={{ fontSize: 7, color: "#fff", lineHeight: 1, fontWeight: 700 }}>{call.subAgents.length}</span>
                      )}
                    </div>
                  )}
                  {/* Merge indicator: small badge on bottom-left of merge-target call */}
                  {isMergeTarget && (
                    <div style={{
                      position: "absolute", bottom: -2, left: -2,
                      width: 14, height: 14, borderRadius: "50%",
                      background: "#059669", border: "2px solid #fff",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <span style={{ fontSize: 7, color: "#fff", lineHeight: 1 }}>↑</span>
                    </div>
                  )}
                </div>

                {/* Transition bridge — height/width from D3 sqrt/linear scales */}
                {tg && !isLast && (
                  <TransitionBridge
                    group={tg}
                    ctxDelta={checkpoints[idx + 1]?.ctxDelta ?? 0}
                    selected={isSelectedTrans}
                    onSelect={() => setSelectedTransitionIdx(isSelectedTrans ? null : idx)}
                    height={Math.round(bridgeHeightScale(tg.totalOutputSize))}
                    width={Math.round(bridgeWidthScale(tg.totalOutputSize))}
                  />
                )}

                {/* No-tool spacer */}
                {!tg && !isLast && (
                  <div style={{ width: 10, alignSelf: "flex-end", height: callH, display: "flex", alignItems: "center" }}>
                    <div style={{ width: "100%", height: 1, background: "#e5e7eb" }} />
                  </div>
                )}
              </React.Fragment>
            );
          })}

          {/* Final arrow → terminal */}
          <D3FlowArrow delta={0} significant={false}
            fromH={checkpoints[checkpoints.length - 1]?.callH ?? 44}
            toH={44} width={CONN_W} />

          {/* Terminal node */}
          <FlowCallNode
            kind={agentLoop.status === "completed" ? "terminal-ok" : agentLoop.status === "interrupted" ? "terminal-warn" : "terminal-info"}
            label={agentLoop.status === "completed" ? "✓" : agentLoop.status === "interrupted" ? "⚠" : "→"}
            subLabel={agentLoop.status}
            width={TERM_W} height={44}
          />
        </div>{/* end main flow row */}

        {/* ── Sub-agent branch rows (one per spawn call, flat list of all agents) ──── */}
        {checkpoints.flatMap((cp, idx) => {
          if (!cp.call.subAgents.length) return [];
          const mergeCall = checkpoints[idx + 1]?.call ?? null;
          // x-offset: accumulated widths of user node + preceding checkpoints
          let xOffset = USER_W;
          for (let k = 0; k < idx; k++) {
            xOffset += CONN_W + CALL_W;
            const prevTG = agentLoop.toolGroups.find(g => g.afterCallId === checkpoints[k].call.id);
            if (k < checkpoints.length - 1) {
              xOffset += prevTG ? Math.round(bridgeWidthScale(prevTG.totalOutputSize)) : 10;
            }
          }
          xOffset += CONN_W;

          return cp.call.subAgents.map((sa, saIdx) => (
            <div key={`sa-branch-${cp.call.id}-${saIdx}`} style={{ display: "flex", alignItems: "center", paddingBottom: 6, marginLeft: xOffset }}>
              {/* Fork line down from spawn call — dashed to read as side branch */}
              <div style={{ width: CALL_W / 2, display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                <div style={{ width: 0, height: saIdx === 0 ? 10 : 4, borderLeft: "1.5px dashed #818cf8", opacity: 0.85 }} />
              </div>
              {/* Branch node — dashed border + violet wash to differentiate from tool calls */}
              <button
                onClick={() => onSubAgentClick?.(sa)}
                style={{
                  border: "1.5px dashed #818cf8", borderRadius: 8,
                  background: "linear-gradient(135deg, #f5f3ff 0%, #faf5ff 100%)",
                  padding: "5px 10px",
                  display: "flex", alignItems: "center", gap: 8,
                  minWidth: 0, cursor: onSubAgentClick ? "pointer" : "default",
                  textAlign: "left",
                }}
                onMouseEnter={e => { if (onSubAgentClick) e.currentTarget.style.background = "linear-gradient(135deg, #ede9fe 0%, #f3e8ff 100%)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "linear-gradient(135deg, #f5f3ff 0%, #faf5ff 100%)"; }}
              >
                <ForkIcon size={11} color="#7c3aed" />
                <span style={{ fontSize: 9, fontWeight: 700, color: "#5b21b6", whiteSpace: "nowrap" }}>
                  {sa.agentType}
                </span>
                <span style={{ fontSize: 9, color: "#7c3aed", whiteSpace: "nowrap" }}>
                  {sa.llmCallCount}c · {sa.toolCallCount}t
                </span>
                <span style={{ fontSize: 9, color: "#9ca3af", whiteSpace: "nowrap" }}>
                  {fmtDuration(sa.durationMs)}
                </span>
                <span style={{ fontSize: 9, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
                  {sa.description}
                </span>
                <span style={{ fontSize: 9, color: "#5b21b6", background: "#ede9fe", borderRadius: 3, padding: "1px 5px", whiteSpace: "nowrap", flexShrink: 0 }}>
                  +{fmtK(sa.totalOutputTokens)}
                </span>
                <CompressionCapsule sa={sa} compact />
                {onSubAgentClick && <span style={{ fontSize: 9, color: "#a5b4fc" }}>›</span>}
              </button>
              {mergeCall && saIdx === cp.call.subAgents.length - 1 && (
                <>
                  <div style={{ width: 16, height: 1.5, background: "#059669", opacity: 0.6, flexShrink: 0 }} />
                  <div style={{
                    fontSize: 9, fontWeight: 700, color: "#059669",
                    background: "#f0fdf4", border: "1px solid #a7f3d0",
                    borderRadius: 5, padding: "2px 6px", whiteSpace: "nowrap", flexShrink: 0,
                  }}>
                    →#{mergeCall.indexInTurn}
                    {mergeCall.significantDelta !== 0 && (
                      <span style={{ marginLeft: 3, color: "#6b7280" }}>
                        {mergeCall.significantDelta > 0 ? "+" : ""}{fmtK(mergeCall.significantDelta)}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          ));
        })}

        </div>{/* end outer column */}
      </div>

      {/* ── Transition detail drawer ────────────────────────── */}
      {selectedTG && selectedTransitionIdx !== null && (
        <TransitionDrawer
          group={selectedTG}
          fromCall={checkpoints[selectedTransitionIdx].call}
          toCall={checkpoints[selectedTransitionIdx + 1]?.call ?? null}
          onClose={() => setSelectedTransitionIdx(null)}
        />
      )}

      {/* ── Legend ─────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", padding: "6px 12px", borderTop: "1px solid #f3f4f6", background: "#f9fafb" }}>
        {[
          { color: "#a5b4fc", label: "Cache read" },
          { color: "#6366f1", label: "Cache write" },
          { color: "#3b82f6", label: "Significant Δ" },
          { color: "#ef4444", label: "◆ compaction" },
          { color: "#7c3aed", label: "∥ parallel" },
          { color: "#d97706", label: "Bash" },
          { color: "#3b82f6", label: "Read" },
          { color: "#16a34a", label: "Write/Edit" },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <div style={{ width: 7, height: 7, borderRadius: 1, background: color }} />
            <span style={{ fontSize: 9, color: "#9ca3af" }}>{label}</span>
          </div>
        ))}
        <span style={{ fontSize: 9, color: "#d1d5db", marginLeft: "auto" }}>
          Node height ∝ ctx size · Bridge width ∝ tool output <MockBadge />
        </span>
      </div>
    </div>
  );
}

// ─── D3 Context Strip ─────────────────────────────────────────────────────────
// Replaces the CSS bar chart with an SVG line chart using d3-shape curveCatmullRom

interface D3ContextStripProps {
  calls: MockLlmCall[];
  checkpoints: Array<{ call: MockLlmCall; ctxDelta: number; callH: number; isSignificant: boolean; nearLimit: boolean; tg: MockToolGroup | null }>;
  onSelectCall: (c: MockLlmCall) => void;
}

function D3ContextStrip({ calls, checkpoints, onSelectCall }: D3ContextStripProps) {
  const W = 600;
  const H = 40;
  const PAD = { l: 4, r: 4, t: 4, b: 14 };
  const chartW = W - PAD.l - PAD.r;
  const chartH = H - PAD.t - PAD.b;
  const n = calls.length;
  if (n === 0) return null;

  // x positions: evenly spaced
  const xScale = scaleLinear().domain([0, n - 1]).range([PAD.l, PAD.l + chartW]);
  const yScale = scaleLinear()
    .domain([0, Math.max(...calls.map(c => c.contextSize), 1)])
    .range([PAD.t + chartH, PAD.t]);

  // D3 line generator with Catmull-Rom curve for smoothness
  const lineGen = d3line<MockLlmCall>()
    .x((_, i) => xScale(i))
    .y(c => yScale(c.contextSize))
    .curve(curveCatmullRom.alpha(0.5));

  const pathD = lineGen(calls) ?? "";

  // Area fill path (close down to bottom)
  const areaBottom = PAD.t + chartH;
  const areaD = `${pathD} L${xScale(n - 1)},${areaBottom} L${xScale(0)},${areaBottom} Z`;

  return (
    <div style={{ padding: "8px 12px 0", borderBottom: "1px solid #f3f4f6" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em" }}>
          Context strip — {n} calls
        </span>
        <MockBadge />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block", cursor: "pointer" }}
        onClick={e => {
          // Map click x → call index
          const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
          const relX = (e.clientX - rect.left) / rect.width * W;
          const idx = Math.round((relX - PAD.l) / chartW * (n - 1));
          const c = calls[Math.max(0, Math.min(idx, n - 1))];
          if (c) onSelectCall(c);
        }}
      >
        {/* Compaction / significant markers */}
        {checkpoints.map((cp, i) => {
          if (!cp.call.isCompaction && !cp.isSignificant) return null;
          const x = xScale(i);
          return (
            <line key={cp.call.id} x1={x} y1={PAD.t} x2={x} y2={PAD.t + chartH}
              stroke={cp.call.isCompaction ? "#ef444450" : "#3b82f630"}
              strokeWidth={1} strokeDasharray="2,2" />
          );
        })}

        {/* Area fill */}
        <path d={areaD} fill="#6366f1" opacity={0.07} />

        {/* Line */}
        <path d={pathD} fill="none" stroke="#6366f1" strokeWidth={1.5} />

        {/* Dots at significant points */}
        {checkpoints.map((cp, i) => {
          if (!cp.isSignificant && !cp.call.isCompaction) return null;
          const x = xScale(i);
          const y = yScale(cp.call.contextSize);
          return (
            <circle key={cp.call.id} cx={x} cy={y} r={3}
              fill={cp.call.isCompaction ? "#ef4444" : "#3b82f6"} />
          );
        })}

        {/* Call labels (every Nth to avoid clutter) */}
        {calls.map((c, i) => {
          const step = n > 20 ? 4 : n > 10 ? 2 : 1;
          if (i % step !== 0 && i !== n - 1) return null;
          return (
            <text key={c.id} x={xScale(i)} y={H - 2} textAnchor="middle"
              fontSize={7} fill={c.isCompaction ? "#ef4444" : "#d1d5db"}>
              {c.isCompaction ? "◆" : `#${c.id}`}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Flow sub-components ──────────────────────────────────────────────────────

type FlowNodeKind = "user" | "normal" | "significant" | "danger" | "compaction" | "terminal-ok" | "terminal-warn" | "terminal-info";

const FLOW_NODE_STYLE: Record<FlowNodeKind, { border: string; bg: string; labelColor: string }> = {
  user:          { border: "#6366f1", bg: "#f5f3ff", labelColor: "#6366f1" },
  normal:        { border: "#e5e7eb", bg: "#f9fafb", labelColor: "#374151" },
  significant:   { border: "#93c5fd", bg: "#eff6ff", labelColor: "#2563eb" },
  danger:        { border: "#fdba74", bg: "#fff7ed", labelColor: "#ea580c" },
  compaction:    { border: "#fca5a5", bg: "#fef2f2", labelColor: "#dc2626" },
  "terminal-ok":   { border: "#86efac", bg: "#f0fdf4", labelColor: "#16a34a" },
  "terminal-warn": { border: "#fde68a", bg: "#fffbeb", labelColor: "#d97706" },
  "terminal-info": { border: "#c7d2fe", bg: "#eff6ff", labelColor: "#6366f1" },
};

function FlowCallNode({
  kind, label, subLabel, width, height,
  cacheReadPct = 0, cacheWritePct = 0,
  stopReason, onClick, ctxDelta,
}: {
  kind: FlowNodeKind; label: string; subLabel?: string;
  width: number; height: number;
  cacheReadPct?: number; cacheWritePct?: number;
  stopReason?: string | null; onClick?: () => void; ctxDelta?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const s = FLOW_NODE_STYLE[kind];

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, alignSelf: "flex-end" }}>
      {/* Delta label above */}
      <div style={{ height: 20, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
        {ctxDelta !== undefined && Math.abs(ctxDelta) > 500 && (
          <span style={{ fontSize: 9, fontWeight: 700, color: ctxDelta > 2000 ? "#d97706" : ctxDelta < -2000 ? "#16a34a" : "#9ca3af" }}>
            {ctxDelta > 0 ? "+" : ""}{fmtK(ctxDelta)}
          </span>
        )}
      </div>

      {/* Node box */}
      <div
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width, height, borderRadius: 8,
          background: hovered && onClick ? "#fff" : s.bg,
          border: `2px solid ${s.border}`,
          cursor: onClick ? "pointer" : "default",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "space-between",
          padding: "5px 4px", gap: 2,
          boxShadow: hovered && onClick ? "0 2px 10px rgba(99,102,241,0.15)" : "none",
          transition: "box-shadow 0.12s",
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 800, color: s.labelColor }}>{label}</span>

        {/* Cache bars */}
        {(cacheReadPct > 0 || cacheWritePct > 0) && (
          <div style={{ width: "80%", display: "flex", flexDirection: "column", gap: 2, flex: 1, justifyContent: "center" }}>
            <div style={{ height: 4, background: "#f3f4f6", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${Math.min(cacheReadPct * 100, 100)}%`, height: "100%", background: "#a5b4fc" }} />
            </div>
            <div style={{ height: 4, background: "#f3f4f6", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${Math.min(cacheWritePct * 100, 100)}%`, height: "100%", background: "#6366f180" }} />
            </div>
          </div>
        )}

        {subLabel && <span style={{ fontSize: 9, color: "#9ca3af", textAlign: "center" }}>{subLabel}</span>}

        {/* end_turn pill */}
        {stopReason && stopReason !== "tool_use" && stopReason !== null && (
          <div style={{ fontSize: 7, fontWeight: 700, color: "#16a34a", background: "#f0fdf4", borderRadius: 3, padding: "1px 3px" }}>
            end_turn
          </div>
        )}
      </div>
    </div>
  );
}

// D3-powered bezier arrow using linkHorizontal for smooth S-curve transitions
function D3FlowArrow({ delta, significant, fromH, toH, width, mergeIn = false }: {
  delta: number; significant: boolean; fromH: number; toH: number; width: number; mergeIn?: boolean;
}) {
  const H = Math.max(fromH, toH, 20);
  // Anchor midpoints: bottom-center of each node
  const y0 = H - fromH / 2;
  const y1 = H - toH / 2;

  // Manual cubic bezier (same as D3 linkHorizontal output)
  const mx = width / 2;
  const path = `M 0,${y0} C ${mx},${y0} ${mx},${y1} ${width},${y1}`;

  const color = mergeIn
    ? "#4ade80"
    : significant
      ? (delta > 0 ? "#93c5fd" : "#86efac")
      : "#e5e7eb";
  const strokeW = (significant || mergeIn) ? 2 : 1;

  // Arrowhead at target
  const arrowSize = 5;
  const tipX = width;
  const tipY = y1;

  return (
    <div style={{ width, alignSelf: "flex-end", height: H, flexShrink: 0 }}>
      <svg width={width} height={H} style={{ overflow: "visible", display: "block" }}>
        <path d={path} fill="none" stroke={color} strokeWidth={strokeW} />
        {/* Filled arrowhead */}
        <polygon
          points={`${tipX},${tipY} ${tipX - arrowSize},${tipY - arrowSize / 2} ${tipX - arrowSize},${tipY + arrowSize / 2}`}
          fill={color}
        />
      </svg>
    </div>
  );
}

function TransitionBridge({
  group, ctxDelta, selected, onSelect, width, height,
}: { group: MockToolGroup; ctxDelta: number; selected: boolean; onSelect: () => void; width: number; height: number }) {
  const [hovered, setHovered] = useState(false);
  const hasError   = group.tools.some(t => t.status !== "ok");
  const durationMs = group.tools.reduce((s, t) => s + t.durationMs, 0);
  const bridgeH    = height; // D3 sqrt-scale computed by parent

  const border = selected ? "#6366f1" : hasError ? "#fca5a5" : group.isParallel ? "#c4b5fd" : "#fde68a";
  const bg     = selected ? "#eff6ff" : hasError ? "#fef2f2" : group.isParallel ? "#f5f3ff" : "#fffbeb";

  // Aggregate tool chips
  const toolCounts = group.tools.reduce((acc, t) => {
    acc[t.tool] = (acc[t.tool] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div style={{ alignSelf: "flex-end", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      {/* Duration label above */}
      <div style={{ height: 20, display: "flex", alignItems: "flex-end" }}>
        <span style={{ fontSize: 9, color: "#9ca3af" }}>{fmtDuration(durationMs)}</span>
      </div>

      {/* Bridge box */}
      <div
        onClick={onSelect}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width, height: bridgeH, borderRadius: 6,
          background: hovered ? (selected ? "#dbeafe" : "#fffde7") : bg,
          border: `1.5px solid ${border}`,
          cursor: "pointer", padding: "4px 6px",
          display: "flex", flexDirection: "column", justifyContent: "space-between",
          boxShadow: selected ? "0 0 0 2px #6366f140" : "none",
          transition: "box-shadow 0.12s",
        }}
      >
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          {group.isParallel && <span style={{ fontSize: 9, fontWeight: 800, color: "#7c3aed" }}>∥</span>}
          {Object.entries(toolCounts).map(([toolName, count]) => {
            const tc = toolChipStyle(toolName);
            // Use D3 ordinal color as accent when brand palette has no entry
            const accentColor = d3ToolColor(toolName);
            return (
              <span key={toolName} style={{
                fontSize: 9, fontWeight: 700,
                color: tc.fg, background: tc.bg, borderRadius: 3,
                padding: "1px 4px",
                border: `1px solid ${tc.border}`,
                outline: tc === (TOOL_COLOR[toolName] ?? null) ? "none" : `1px solid ${accentColor}30`,
              }}>
                {toolName}{count > 1 ? ` ×${count}` : ""}
              </span>
            );
          })}
          {hasError && <span style={{ fontSize: 9, color: "#dc2626", fontWeight: 700 }}>✗</span>}
        </div>

        {/* Output + impact */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <span style={{ fontSize: 9, color: "#9ca3af" }}>+{fmtK(group.totalOutputSize)} out</span>
          {Math.abs(ctxDelta) > 500 && (
            <span style={{ fontSize: 9, fontWeight: 700, color: ctxDelta > 0 ? "#d97706" : "#16a34a" }}>
              ctx {ctxDelta > 0 ? "+" : ""}{fmtK(ctxDelta)}
            </span>
          )}
        </div>
      </div>

      <span style={{ fontSize: 8, color: "#d1d5db" }}>{group.isParallel ? "∥ parallel" : "sequential"}</span>
    </div>
  );
}

function TransitionDrawer({
  group, fromCall, toCall, onClose,
}: { group: MockToolGroup; fromCall: MockLlmCall; toCall: MockLlmCall | null; onClose: () => void }) {
  const dur = group.tools.reduce((s, t) => s + t.durationMs, 0);
  return (
    <div style={{ borderTop: "1px solid #e5e7eb", background: "#fff", padding: "12px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#374151" }}>
            Transition #{fromCall.id} → #{toCall?.id ?? "?"}
          </span>
          <span style={{ fontSize: 10, color: "#9ca3af" }}>{fmtDuration(dur)} total</span>
          <span style={{ fontSize: 10, color: "#9ca3af" }}>+{fmtK(group.totalOutputSize)} output</span>
          {group.isParallel && <span style={{ fontSize: 10, color: "#7c3aed", fontWeight: 700 }}>∥ parallel</span>}
        </div>
        <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 14, padding: 0 }}>×</button>
      </div>

      {/* Individual tool calls */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {group.tools.map(t => {
          const tc = toolChipStyle(t.tool);
          return (
            <div key={t.id} style={{
              display: "grid", gridTemplateColumns: "60px 1fr 56px 52px 48px",
              gap: 8, alignItems: "center",
              padding: "5px 10px", borderRadius: 6,
              background: t.status !== "ok" ? "#fef2f2" : "#f9fafb",
              border: `1px solid ${t.status !== "ok" ? "#fecaca" : "#f3f4f6"}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                {group.isParallel && <span style={{ fontSize: 8, color: "#7c3aed", fontWeight: 800 }}>∥</span>}
                <span style={{ fontSize: 10, fontWeight: 700, color: tc.fg, background: tc.bg, borderRadius: 3, padding: "1px 5px", border: `1px solid ${tc.border}` }}>
                  {t.tool}
                </span>
              </div>
              <span style={{ fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.input}</span>
              <span style={{ fontSize: 10, color: "#9ca3af", textAlign: "right" }}>+{fmtK(t.outputSize)}</span>
              <span style={{ fontSize: 10, color: "#9ca3af", textAlign: "right" }}>{fmtDuration(t.durationMs)}</span>
              <span style={{ fontSize: 10, fontWeight: 700, textAlign: "right", color: t.status === "ok" ? "#16a34a" : "#dc2626" }}>
                {t.status === "ok" ? "✓" : `✗ ${t.status}`}
              </span>
            </div>
          );
        })}
      </div>

      {toCall && (
        <div style={{ marginTop: 10, padding: "6px 10px", background: "#f0fdf4", borderRadius: 6, fontSize: 10, color: "#16a34a" }}>
          → These tool results were injected into <strong>Call #{toCall.id}</strong> context.
          Context changed by <strong>{toCall.significantDelta > 0 ? "+" : ""}{fmtK(toCall.significantDelta)}</strong>.
        </div>
      )}
    </div>
  );
}

type TurnView = "classic" | "flow";

function TurnViewToggle({ view, onChange }: { view: TurnView; onChange: (v: TurnView) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16 }}>
      <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600, letterSpacing: "0.05em" }}>VIEW</span>
      {(["classic", "flow"] as TurnView[]).map(v => {
        const active = view === v;
        const label = v === "classic" ? "Classic" : "Hybrid Flow";
        const desc  = v === "classic" ? "Vertical timeline + context strip" : "Call checkpoints + transition bridges · LLM ↔ Tool causality";
        return (
          <button key={v} onClick={() => onChange(v)} title={desc} style={{
            padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: active ? 700 : 400,
            cursor: "pointer",
            background: active ? "#6366f1" : "#f9fafb",
            color:  active ? "#fff" : "#6b7280",
            border: `1px solid ${active ? "#6366f1" : "#e5e7eb"}`,
            transition: "all 0.12s",
          }}>
            {label}
          </button>
        );
      })}
      <span style={{ fontSize: 10, color: "#d1d5db", marginLeft: 4 }}>
        {view === "classic" ? "Vertical timeline + context strip" : "Call checkpoints + transition bridges"}
      </span>
    </div>
  );
}

// ─── JSONL Call Chain ─────────────────────────────────────────────────────────

const TOOL_CHIP: Record<string, { bg: string; border: string; fg: string }> = {
  Read:     { bg: "#eff6ff", border: "#bfdbfe", fg: "#2563eb" },
  Write:    { bg: "#f0fdf4", border: "#bbf7d0", fg: "#16a34a" },
  Edit:     { bg: "#fff7ed", border: "#fed7aa", fg: "#ea580c" },
  Bash:     { bg: "#fffbeb", border: "#fde68a", fg: "#d97706" },
  Grep:     { bg: "#eff6ff", border: "#c7d2fe", fg: "#4f46e5" },
  Glob:     { bg: "#eff6ff", border: "#c7d2fe", fg: "#4f46e5" },
  Agent:    { bg: "#faf5ff", border: "#ddd6fe", fg: "#7c3aed" },
  WebFetch: { bg: "#ecfeff", border: "#a5f3fc", fg: "#0891b2" },
};
function toolChip(name: string) {
  return TOOL_CHIP[name] ?? { bg: "#f9fafb", border: "#e5e7eb", fg: "#6b7280" };
}

function fmtBytes(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

// ── Filter list (all known kinds; user can toggle) ────────────────────────────
const ALL_KINDS: IntervalEventKind[] = [
  "user:human", "user:tool_result", "user:command",
  "system:api_error", "system:local_command", "system:turn_duration",
  "system:stop_hook_summary", "system:away_summary",
  "attachment:skill_listing", "attachment:task_reminder", "attachment:queued_command",
  "attachment:edited_text_file", "attachment:file",
  "file-history-snapshot", "last-prompt", "unknown",
];

const KIND_LABEL: Record<IntervalEventKind, string> = {
  "user:human":               "User input",
  "user:tool_result":         "Tool result",
  "user:command":             "Command",
  "system:api_error":         "API error",
  "system:local_command":     "Local cmd",
  "system:turn_duration":     "Turn duration",
  "system:stop_hook_summary": "Stop hook",
  "system:away_summary":      "Away summary",
  "attachment:skill_listing": "Skills",
  "attachment:task_reminder": "Task reminder",
  "attachment:queued_command": "Queued msg",
  "attachment:edited_text_file": "File edited",
  "attachment:file":          "File attach",
  "file-history-snapshot":    "File snapshot",
  "last-prompt":              "Last prompt",
  "unknown":                  "Unknown",
};

const KIND_COLOR: Record<IntervalEventKind, { bg: string; border: string; fg: string }> = {
  "user:human":               { bg: "#f5f3ff", border: "#c4b5fd", fg: "#7c3aed" },
  "user:tool_result":         { bg: "#f0fdf4", border: "#86efac", fg: "#16a34a" },
  "user:command":             { bg: "#f8fafc", border: "#cbd5e1", fg: "#475569" },
  "system:api_error":         { bg: "#fef2f2", border: "#fca5a5", fg: "#dc2626" },
  "system:local_command":     { bg: "#f8fafc", border: "#e2e8f0", fg: "#64748b" },
  "system:turn_duration":     { bg: "#f8fafc", border: "#e2e8f0", fg: "#64748b" },
  "system:stop_hook_summary": { bg: "#f8fafc", border: "#e2e8f0", fg: "#64748b" },
  "system:away_summary":      { bg: "#fefce8", border: "#fde68a", fg: "#92400e" },
  "attachment:skill_listing": { bg: "#f8fafc", border: "#e2e8f0", fg: "#475569" },
  "attachment:task_reminder": { bg: "#fffbeb", border: "#fde68a", fg: "#92400e" },
  "attachment:queued_command": { bg: "#fff7ed", border: "#fed7aa", fg: "#c2410c" },
  "attachment:edited_text_file": { bg: "#ecfeff", border: "#a5f3fc", fg: "#0e7490" },
  "attachment:file":          { bg: "#f0f9ff", border: "#bae6fd", fg: "#0369a1" },
  "file-history-snapshot":    { bg: "#f8fafc", border: "#e2e8f0", fg: "#94a3b8" },
  "last-prompt":              { bg: "#f8fafc", border: "#e2e8f0", fg: "#64748b" },
  "unknown":                  { bg: "#f8fafc", border: "#e2e8f0", fg: "#94a3b8" },
};

// ── callDescription: one-line semantic summary of what a call did ─────────────
function callDescription(call: MockLlmCall): string {
  const tcs = call.toolCalls;
  if (tcs.length === 0) {
    if (call.assistantText) return "answered";
    if (call.stopReason === "end_turn") return "end_turn";
    return call.stopReason ?? "";
  }
  // Group tool names; count parallels
  const counts: Record<string, number> = {};
  for (const tc of tcs) counts[tc.name] = (counts[tc.name] ?? 0) + 1;
  const parts = Object.entries(counts).map(([name, n]) => n > 1 ? `${name} ×${n}` : name);
  return parts.join(" + ");
}

function toolUseIdsFromIntervalEvent(ev: IntervalEvent): string[] {
  if (ev.kind !== "user:tool_result") return [];
  try {
    const obj = JSON.parse(ev.rawJson) as { message?: { content?: unknown } };
    const content = obj.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .map(block => (block as { type?: string; tool_use_id?: string })?.type === "tool_result"
        ? (block as { tool_use_id?: string }).tool_use_id
        : null)
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

function shortToolUseId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 10)}...` : id;
}

function shortMessageId(id: string | null | undefined): string {
  if (!id) return "";
  return id.length > 18 ? `${id.slice(0, 10)}...${id.slice(-5)}` : id;
}

function formatJsonlLines(call: MockLlmCall): string {
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

function ChainNarrativeNode({
  kind, label, text, meta,
}: {
  kind: "user" | "interrupt" | "final";
  label: string;
  text: string;
  meta?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const limit = kind === "final" ? 420 : 300;
  const needsExpand = text.length > limit;
  const shown = needsExpand && !expanded ? text.slice(0, limit) + "..." : text;
  const tone = kind === "user"
    ? { bg: "#eff6ff", border: "#bfdbfe", fg: "#1e3a5f", dot: "#3b82f6" }
    : kind === "interrupt"
      ? { bg: "#fffbeb", border: "#fcd34d", fg: "#78350f", dot: "#d97706" }
      : { bg: "#f0fdf4", border: "#bbf7d0", fg: "#14532d", dot: "#16a34a" };

  if (!text.trim()) return null;

  return (
    <div style={{ position: "relative", zIndex: 1, marginBottom: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ flexShrink: 0, marginTop: 10, width: 24, display: "flex", justifyContent: "center" }}>
          <div style={{
            width: 13, height: 13, borderRadius: "50%", border: "2px solid #fff",
            background: tone.dot, boxShadow: `0 0 0 2px ${tone.border}`,
          }} />
        </div>
        <div style={{ flex: 1, border: `1px solid ${tone.border}`, borderRadius: 8, background: tone.bg, padding: "8px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: tone.fg, letterSpacing: "0.05em", textTransform: "uppercase" }}>{label}</span>
            {meta && <span style={{ fontSize: 10, color: "#94a3b8" }}>{meta}</span>}
          </div>
          <div style={{ fontSize: 12, color: tone.fg, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {shown}
          </div>
          {needsExpand && (
            <button
              onClick={() => setExpanded(v => !v)}
              style={{ marginTop: 5, fontSize: 10, color: tone.fg, background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 700 }}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ToolCallRow: tool_use request carried by the assistant response ───────────
function ToolCallRow({
  tc, active, onHoverToolUse,
}: {
  tc: ToolCallSlot;
  active: boolean;
  onHoverToolUse: (id: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const chip = toolChip(tc.name);

  return (
    <div style={{ marginBottom: 3 }}>
      <div
        onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
        onMouseEnter={() => onHoverToolUse(tc.toolUseId)}
        onMouseLeave={() => onHoverToolUse(null)}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "4px 8px",
          borderRadius: 6, cursor: "pointer",
          background: active ? "#fff7ed" : "#fafafa",
          border: `1px solid ${active ? "#f59e0b" : "#f0f0f0"}`,
          boxShadow: active ? "0 0 0 2px rgba(245,158,11,0.14)" : "none",
        }}
      >
        {/* Dispatch arrow */}
        <span style={{ fontSize: 9, color: active ? "#d97706" : "#9ca3af", flexShrink: 0 }}>↳</span>
        {/* Tool chip */}
        <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: chip.bg, border: `1px solid ${chip.border}`, color: chip.fg, flexShrink: 0 }}>
          {tc.name}
        </span>
        {/* Input preview — most important identifier */}
        <span style={{ fontSize: 11, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {tc.inputPreview.replace(/^\{?\s*"(?:command|file_path|pattern|query|prompt|url|description)"\s*:\s*"/, "").replace(/",?\s*.*$/, "").slice(0, 100)}
        </span>
        {/* Size badges */}
        <div style={{ display: "flex", gap: 5, flexShrink: 0, alignItems: "center" }}>
          {tc.inputSize > 0 && <span style={{ fontSize: 9, color: "#9ca3af" }}>in {fmtBytes(tc.inputSize)}</span>}
          <span style={{ fontSize: 9, color: "#c4c9d4" }}>{shortToolUseId(tc.toolUseId)}</span>
          <span style={{ fontSize: 9, color: "#d1d5db" }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && (
        <div style={{ marginLeft: 12, marginTop: 2, display: "flex", flexDirection: "column", gap: 3 }}>
          {/* INPUT — what was dispatched */}
          {tc.inputPreview && (
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderLeft: "3px solid #94a3b8", borderRadius: "0 5px 5px 0", padding: "5px 8px" }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: "#64748b", letterSpacing: "0.05em" }}>INPUT &nbsp;</span>
              <span style={{ fontSize: 9, color: "#94a3b8" }}>{fmtBytes(tc.inputSize)}</span>
              <pre style={{ margin: "3px 0 0", fontSize: 11, color: "#334155", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 100, overflow: "auto" }}>{tc.inputPreview}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── IntervalEventRow: non-tool JSONL events between calls ─────────────────────
function IntervalEventRow({
  ev, activeToolUseId, onHoverToolUse,
}: {
  ev: IntervalEvent;
  activeToolUseId: string | null;
  onHoverToolUse: (id: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const col = KIND_COLOR[ev.kind];
  const linkedToolUseIds = toolUseIdsFromIntervalEvent(ev);
  const linked = activeToolUseId != null && linkedToolUseIds.includes(activeToolUseId);
  const hoverLinkedId = linkedToolUseIds[0] ?? null;

  return (
    <div style={{ marginBottom: 2 }}>
      <div
        onClick={() => setExpanded(v => !v)}
        onMouseEnter={() => { if (hoverLinkedId) onHoverToolUse(hoverLinkedId); }}
        onMouseLeave={() => { if (hoverLinkedId) onHoverToolUse(null); }}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "3px 8px",
          borderRadius: 5, cursor: "pointer", opacity: linked ? 1 : 0.9,
          background: linked ? "#fff7ed" : col.bg,
          border: `1px solid ${linked ? "#f59e0b" : col.border}`,
          boxShadow: linked ? "0 0 0 2px rgba(245,158,11,0.14)" : "none",
        }}
      >
        <span style={{ fontSize: 9, fontWeight: 700, color: col.fg, flexShrink: 0, minWidth: 90 }}>
          {KIND_LABEL[ev.kind]}
        </span>
        {linkedToolUseIds.length > 0 && (
          <span style={{ fontSize: 9, color: linked ? "#d97706" : "#94a3b8", flexShrink: 0 }}>
            from {shortToolUseId(linkedToolUseIds[0])}
          </span>
        )}
        <span style={{ fontSize: 10, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {ev.contentPreview.slice(0, 120)}
        </span>
        {ev.contentSize > 0 && <span style={{ fontSize: 9, color: "#94a3b8", flexShrink: 0 }}>{fmtBytes(ev.contentSize)}</span>}
        <span style={{ fontSize: 9, color: "#d1d5db", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div style={{ marginLeft: 10, marginTop: 2, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 5, padding: "6px 8px" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: 9, color: "#64748b" }}>kind: <b>{ev.kind}</b></span>
            <span style={{ fontSize: 9, color: "#64748b" }}>line: {ev.lineIdx + 1}</span>
            {ev.timestamp && <span style={{ fontSize: 9, color: "#64748b" }}>{ev.timestamp.slice(11, 19)}</span>}
          </div>
          <pre style={{ margin: 0, fontSize: 10, color: "#334155", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 160, overflow: "auto" }}>
            {ev.rawJson.length > 1000 ? ev.rawJson.slice(0, 1000) + "\n…" : ev.rawJson}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── JsonlCallChain: main component ────────────────────────────────────────────
function JsonlCallChain({
  turn, onSelectCall, onSubAgentClick,
}: {
  turn: MockUserTurn;
  onSelectCall: (c: MockLlmCall) => void;
  onSubAgentClick?: (sa: import("./drilldown-types").SubAgentSummary) => void;
}) {
  // Filter state: null means "show all" (default); populated = active filter set
  const [hiddenKinds, setHiddenKinds] = useState<Set<IntervalEventKind>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [showFoldedSubAgentResults, setShowFoldedSubAgentResults] = useState(false);
  const [activeToolUseId, setActiveToolUseId] = useState<string | null>(null);

  if (!turn.calls.length) return null;

  const maxCtx = Math.max(...turn.calls.map(c => c.contextSize), 1);
  const subAgentByToolUseId = new Map<string, SubAgentSummary>();
  for (const call of turn.calls) {
    for (const sa of call.subAgents) {
      if (sa.toolUseId) subAgentByToolUseId.set(sa.toolUseId, sa);
    }
  }
  const finalOutput = turn.finalOutput?.trim()
    ? turn.finalOutput
    : ([...turn.calls].reverse().find(c => c.stopReason !== "tool_use" && c.assistantText)?.assistantText ?? "");
  const foldedSubAgentResultCount = turn.calls.reduce((sum, call) => {
    return sum + call.intervalEvents.filter(ev =>
      ev.kind === "user:tool_result"
      && toolUseIdsFromIntervalEvent(ev).some(id => subAgentByToolUseId.has(id))
    ).length;
  }, 0);

  function toggleKind(k: IntervalEventKind) {
    setHiddenKinds(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  return (
    <div>
      {/* ── Event graph filter bar ──────────────────────────────── */}
      <div style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={() => setFilterOpen(v => !v)}
          style={{
            fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer",
            border: "1px solid #e5e7eb", background: filterOpen ? "#6366f1" : "#f9fafb",
            color: filterOpen ? "#fff" : "#6b7280", fontWeight: 600,
          }}
        >
          Filter event graph {hiddenKinds.size > 0 && `(${hiddenKinds.size} hidden)`}
        </button>
        {hiddenKinds.size > 0 && (
          <button onClick={() => setHiddenKinds(new Set())} style={{ fontSize: 10, color: "#6366f1", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            show all
          </button>
        )}
        <span style={{ fontSize: 9, color: "#d1d5db", marginLeft: "auto" }}>
          {turn.calls.length} calls · {turn.calls.reduce((s, c) => s + c.intervalEvents.length, 0)} JSONL events
        </span>
        {foldedSubAgentResultCount > 0 && (
          <button
            onClick={() => setShowFoldedSubAgentResults(v => !v)}
            style={{ fontSize: 10, color: "#4f46e5", background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 5, cursor: "pointer", padding: "3px 8px", fontWeight: 700 }}
          >
            {showFoldedSubAgentResults ? "Fold sub-agent results" : `Show ${foldedSubAgentResultCount} folded sub-agent results`}
          </button>
        )}
      </div>

      {/* Filter panel */}
      {filterOpen && (
        <div style={{ marginBottom: 10, padding: "8px 10px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, display: "flex", flexWrap: "wrap", gap: 5 }}>
          {ALL_KINDS.map(k => {
            const hidden = hiddenKinds.has(k);
            const col = KIND_COLOR[k];
            return (
              <button
                key={k}
                onClick={() => toggleKind(k)}
                style={{
                  fontSize: 9, padding: "2px 7px", borderRadius: 4, cursor: "pointer",
                  background: hidden ? "#f3f4f6" : col.bg,
                  border: `1px solid ${hidden ? "#d1d5db" : col.border}`,
                  color: hidden ? "#9ca3af" : col.fg,
                  fontWeight: 600,
                  textDecoration: hidden ? "line-through" : "none",
                }}
              >
                {KIND_LABEL[k]}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Call chain ──────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0, position: "relative" }}>
        {/* Vertical spine */}
        <div style={{ position: "absolute", left: 11, top: 8, bottom: 8, width: 2, background: "#e5e7eb", zIndex: 0 }} />

        <ChainNarrativeNode
          kind="user"
          label="User input"
          text={turn.userInput}
          meta={turn.startedAt ? turn.startedAt.slice(11, 19) : undefined}
        />
        {turn.midTurnInjections
          .filter(inj => inj.afterCallIndex === 0)
          .map((inj, injIdx) => (
            <ChainNarrativeNode
              key={`inj-before-${injIdx}`}
              kind="interrupt"
              label="Mid-turn input"
              text={inj.text}
              meta={inj.timestamp ? `before C1 · ${inj.timestamp.slice(11, 19)}` : "before C1"}
            />
          ))}

        {turn.calls.map((call) => {
          const delta    = call.significantDelta;
          // Context bar: absolute width proportional to contextSize / maxCtx
          const ctxWidthPct = Math.round(call.contextSize / maxCtx * 100);
          // Segment percentages within the bar
          const readFrac  = call.contextSize > 0 ? call.cacheRead  / call.contextSize : 0;
          const writeFrac = call.contextSize > 0 ? call.cacheWrite / call.contextSize : 0;
          const freshFrac = call.contextSize > 0 ? call.freshIn    / call.contextSize : 0;

          const jsonlLines = formatJsonlLines(call);
          const frameCount = call.jsonlFrameLineIdxs?.length ?? 0;
          const matchedSubAgentIds = new Set(call.toolCalls.map(tc => tc.toolUseId).filter(id => subAgentByToolUseId.has(id)));
          const isFoldedSubAgentResult = (ev: IntervalEvent) =>
            ev.kind === "user:tool_result"
            && toolUseIdsFromIntervalEvent(ev).some(id => matchedSubAgentIds.has(id));
          const visibleIntervals = call.intervalEvents.filter(ev =>
            !hiddenKinds.has(ev.kind)
            && (showFoldedSubAgentResults || !isFoldedSubAgentResult(ev))
          );
          const hideAssistantTextAsFinal = Boolean(finalOutput && call.id === turn.calls[turn.calls.length - 1]?.id && call.stopReason !== "tool_use");

          return (
            <React.Fragment key={call.id}>
            <div id={`turn-${turn.id}-call-${call.id}`} style={{ position: "relative", zIndex: 1, marginBottom: 8 }}>

              {/* ── LLM Call card ───────────────────────────── */}
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                {/* Spine dot */}
                <div style={{ flexShrink: 0, marginTop: 10, width: 24, display: "flex", justifyContent: "center" }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: "50%", border: "2px solid #fff",
                    background: call.isCompaction ? "#ef4444" : call.isSignificant ? "#3b82f6" : "#6366f1",
                    boxShadow: "0 0 0 2px " + (call.isCompaction ? "#ef444440" : "#6366f140"),
                  }} />
                </div>

                {/* Card */}
                <div
                  onClick={() => onSelectCall(call)}
                  style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff", cursor: "pointer", overflow: "hidden" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "#6366f1"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "#e5e7eb"; }}
                >
                  {/* Header */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid #f3f4f6" }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>
                      C{call.indexInTurn}
                      {call.isCompaction && <span style={{ marginLeft: 5, fontSize: 10, color: "#ef4444" }}>◆</span>}
                    </span>
                    <span style={{ fontSize: 10, color: "#9ca3af", fontFamily: "monospace" }}>#{call.id}</span>
                    {jsonlLines && (
                      <span style={{ fontSize: 10, color: frameCount > 1 ? "#4f46e5" : "#94a3b8", background: frameCount > 1 ? "#eef2ff" : "#f9fafb", border: `1px solid ${frameCount > 1 ? "#c7d2fe" : "#e5e7eb"}`, borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>
                        {frameCount > 1 ? `${frameCount} frames ${jsonlLines}` : jsonlLines}
                      </span>
                    )}
                    {call.messageId && (
                      <span style={{ fontSize: 10, color: "#9ca3af", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        msg {shortMessageId(call.messageId)}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>{fmtK(call.contextSize)}</span>
                    {delta !== 0 && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 4, color: delta > 0 ? "#d97706" : "#16a34a", background: delta > 0 ? "#fffbeb" : "#f0fdf4" }}>
                        {delta > 0 ? "+" : ""}{fmtK(delta)}
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", fontSize: 10, color: call.stopReason === "end_turn" ? "#16a34a" : "#9ca3af", fontWeight: 600 }}>
                      {call.stopReason === "end_turn" ? "✓ end_turn" : call.stopReason === "tool_use" ? "⚙ tool_use" : (call.stopReason ?? "")}
                    </span>
                    <span style={{ fontSize: 10, color: "#d1d5db" }}>›</span>
                  </div>

                  {/* Context bar — ABSOLUTE width shows context size visually */}
                  <div style={{ padding: "6px 12px 7px" }}>
                    {/* Outer track = full Turn max context */}
                    <div style={{ height: 8, background: "#f3f4f6", borderRadius: 4, overflow: "hidden" }}>
                      {/* Inner fill = this call's contextSize / maxCtx */}
                      <div style={{ width: `${ctxWidthPct}%`, height: "100%", display: "flex", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ flex: readFrac,  background: "#a5b4fc" }} title={`cache_read ${fmtK(call.cacheRead)}`} />
                        <div style={{ flex: writeFrac, background: "#6366f1" }} title={`cache_write ${fmtK(call.cacheWrite)}`} />
                        <div style={{ flex: freshFrac, background: "#f97316" }} title={`fresh ${fmtK(call.freshIn)}`} />
                      </div>
                    </div>
                    {/* Legend */}
                    <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
                      {[
                        { color: "#a5b4fc", label: "read",  val: call.cacheRead,  pct: Math.round(readFrac * 100) },
                        { color: "#6366f1", label: "write", val: call.cacheWrite, pct: Math.round(writeFrac * 100) },
                        { color: "#f97316", label: "fresh", val: call.freshIn,    pct: Math.round(freshFrac * 100) },
                      ].map(({ color, label, val, pct }) => val > 0 ? (
                        <span key={label} style={{ fontSize: 9, color: "#6b7280", display: "flex", alignItems: "center", gap: 3 }}>
                          <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 1, background: color }} />
                          {label} {fmtK(val)} ({pct}%)
                        </span>
                      ) : null)}
                      <span style={{ fontSize: 9, color: "#9ca3af", marginLeft: "auto" }}>out {fmtK(call.outputTokens)}</span>
                    </div>
                  </div>

                  {/* Assistant text */}
	                  {call.assistantText && !hideAssistantTextAsFinal && (
	                    <div style={{ padding: "0 12px 7px" }}>
	                      <div style={{ fontSize: 9, fontWeight: 700, color: "#9ca3af", marginBottom: 2, letterSpacing: "0.04em" }}>ASSISTANT TEXT</div>
	                      <div style={{ fontSize: 11, color: "#374151", lineHeight: 1.55, background: "#f9fafb", borderRadius: 5, padding: "5px 8px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 72, overflow: "hidden" }}>
	                        {call.assistantText}
	                      </div>
	                    </div>
	                  )}

		                  {/* tool_use blocks are part of this assistant response. Sub-agent
		                      executions are rendered below as derived JSONL events. */}
		                  {call.toolCalls.length > 0 && (
	                    <div style={{ padding: "0 12px 7px" }}>
	                      <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 3, letterSpacing: "0.04em", fontWeight: 700 }}>
	                        TOOL_USE REQUESTS ({call.toolCalls.length})
	                      </div>
	                      {call.toolCalls.map((tc, ti) => (
	                        <ToolCallRow
	                          key={tc.toolUseId || ti}
	                          tc={tc}
	                          active={activeToolUseId === tc.toolUseId}
	                          onHoverToolUse={setActiveToolUseId}
	                        />
	                      ))}
	                    </div>
	                  )}
	                </div>
	              </div>

	              {/* ── Sub-agent JSONL events derived from Agent tool_use ─── */}
		              {call.subAgents.length > 0 && (
	                <div style={{ marginLeft: 32, marginTop: 3 }}>
                    <div style={{ fontSize: 9, color: "#818cf8", fontWeight: 800, letterSpacing: "0.04em", margin: "0 0 3px 8px" }}>
                      SUB-AGENT EVENTS
                    </div>
	                  {call.subAgents.map(sa => {
                      const active = activeToolUseId === sa.toolUseId;
                      const branchColor = active ? "#f59e0b" : "#6366f1";
                      return (
                    <div key={sa.agentFileId} style={{ display: "flex", alignItems: "flex-start", marginBottom: 4 }}>
                      <div style={{ width: 16, flexShrink: 0 }}>
                        <div style={{
                          width: 12,
                          height: 10,
                          borderLeft: `2px solid ${branchColor}`,
                          borderBottom: `2px solid ${branchColor}`,
                          borderBottomLeftRadius: 4,
                          marginTop: 4,
                          opacity: active ? 1 : 0.75,
                        }} />
                      </div>
                      <button
                        onClick={() => onSubAgentClick?.(sa)}
                        onMouseEnter={e => {
                          setActiveToolUseId(sa.toolUseId);
                          if (onSubAgentClick) e.currentTarget.style.background = "#fff7ed";
                        }}
                        onMouseLeave={e => {
                          setActiveToolUseId(null);
                          e.currentTarget.style.background = "#fafafe";
                        }}
                        style={{
                          flex: 1,
                          border: `1.5px solid ${branchColor}`,
                          borderRadius: 7,
                          background: active ? "#fff7ed" : "#fafafe",
                          padding: "5px 9px",
                          cursor: onSubAgentClick ? "pointer" : "default",
                          textAlign: "left",
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                          boxShadow: active ? "0 0 0 2px rgba(245,158,11,0.14)" : "none",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: "#4338ca" }}>{sa.agentType}</span>
                          <span style={{ fontSize: 9, color: "#6366f1" }}>{sa.llmCallCount}c · {sa.toolCallCount}t · {fmtDuration(sa.durationMs)}</span>
                          <span style={{ fontSize: 9, color: "#6366f1", background: "#eff6ff", borderRadius: 3, padding: "1px 5px" }}>+{fmtK(sa.totalOutputTokens)}</span>
                          <span style={{ fontSize: 9, color: active ? "#d97706" : "#c4c9d4", marginLeft: "auto" }}>{shortToolUseId(sa.toolUseId)}</span>
                          {onSubAgentClick && <span style={{ fontSize: 9, color: "#a5b4fc" }}>›</span>}
                        </div>
                        {sa.description && <div style={{ fontSize: 10, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sa.description}</div>}
                        {sa.resultPreview && <div style={{ fontSize: 10, color: "#374151", background: "#f5f3ff", borderRadius: 4, padding: "1px 5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sa.resultPreview.slice(0, 100)}{sa.resultPreview.length > 100 ? "…" : ""}</div>}
                      </button>
                    </div>
                      );
                    })}
                </div>
              )}

              {/* ── Interval events (filtered) ────────────────── */}
	              {visibleIntervals.length > 0 && (
	                <div style={{ marginLeft: 32, marginTop: 3 }}>
                    <div style={{ fontSize: 9, color: "#c4c9d4", fontWeight: 700, letterSpacing: "0.04em", margin: "0 0 3px 8px" }}>
                      JSONL EVENT GRAPH
                    </div>
	                  {visibleIntervals.map((ev, ei) => (
	                    <IntervalEventRow
	                      key={`${ev.lineIdx}-${ei}`}
	                      ev={ev}
	                      activeToolUseId={activeToolUseId}
	                      onHoverToolUse={setActiveToolUseId}
	                    />
	                  ))}
	                </div>
	              )}

            </div>
            {turn.midTurnInjections
              .filter(inj => inj.afterCallIndex === call.indexInTurn)
              .map((inj, injIdx) => (
                <ChainNarrativeNode
                  key={`inj-${call.id}-${injIdx}`}
                  kind="interrupt"
                  label="Mid-turn input"
                  text={inj.text}
                  meta={inj.timestamp ? `after C${call.indexInTurn} · ${inj.timestamp.slice(11, 19)}` : `after C${call.indexInTurn}`}
                />
              ))}
            </React.Fragment>
          );
        })}
        <ChainNarrativeNode
          kind="final"
          label="Final AI output"
          text={finalOutput}
          meta={turn.endedAt ? turn.endedAt.slice(11, 19) : undefined}
        />
      </div>
    </div>
  );
}

function UserTurnDetailPanel({
  turn, onSelectCall, isMockSession = false, onSubAgentClick, trailingInterTurnBlock = null, sessionId = "",
}: { turn: MockUserTurn; onSelectCall: (c: MockLlmCall) => void; isMockSession?: boolean; onSubAgentClick?: (sa: SubAgentSummary) => void; trailingInterTurnBlock?: InterTurnBlock | null; sessionId?: string }) {
  const { t } = useTranslation();

  const callsWithSubAgents = turn.calls.map((c, ci) => {
    // For mock sessions, inject mock sub-agent if none present
    const mockSa = isMockSession && c.subAgents.length === 0
      ? attachMockSubAgents(c, turn.id, ci)
      : null;
    return {
      ...c,
      subAgents: mockSa ? [mockSa] : c.subAgents,
    };
  });
  const enrichedTurn = { ...turn, calls: callsWithSubAgents };
  const agentLoop = buildRealAgentLoop(enrichedTurn);
  const dur = fmtDuration(turn.durationMs);
  const noTools = turn.toolCallCount === 0;
  const [minimapOpen, setMinimapOpen] = useState(!noTools);

  const turnSubAgents = callsWithSubAgents.flatMap(c => c.subAgents);

  const firstCtx    = turn.calls[0]?.contextSize ?? 0;
  const lastCtx     = turn.calls[turn.calls.length - 1]?.contextSize ?? 0;
  const netCtx      = lastCtx - firstCtx;

  const totalFreshIn  = turn.calls.reduce((s, c) => s + Math.max(c.contextSize - c.cacheRead - c.cacheWrite, 0), 0);
  const totalFreshOut = turn.calls.reduce((s, c) => s + c.outputTokens, 0);
  const cacheInputTotal = turn.cacheRead + turn.cacheWrite + totalFreshIn;
  const cacheRatio = cacheInputTotal > 0 ? turn.cacheRead / cacheInputTotal * 100 : null;

  const M = TOKEN_METRICS;
  const ledgerRows = [
    { id: "fresh_input", value: totalFreshIn },
    { id: "cache_read",  value: turn.cacheRead },
    { id: "cache_write", value: turn.cacheWrite },
    { id: "output",      value: totalFreshOut },
  ];
  const ledgerTotal = ledgerRows.reduce((s, r) => s + r.value, 0);

  const risks: Array<{ type: "compaction" | "unknown-spike" | "large-growth" | "near-limit" | "tool-heavy" }> = [];
  if (turn.hasCompaction)   risks.push({ type: "compaction" });
  if (turn.hasUnknownSpike) risks.push({ type: "unknown-spike" });
  const minimapAnchorId = `turn-${turn.id}-call-minimap`;

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>

      {/* ── Summary header — mirrors SessionOverviewPanel layout ──── */}
      <div style={{ marginBottom: 16 }}>

        {/* Row 1: title + activity stats */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 24, paddingBottom: 10, borderBottom: "1px solid #f3f4f6", flexWrap: "wrap" }}>
          {/* Turn label */}
          <div>
            <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{t("sessionOverview.turn.label")}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", lineHeight: 1 }}>{turn.id}</div>
          </div>

          {[
            { label: t("sessionOverview.activity.llmCalls"),  value: String(turn.llmCallCount) },
            { label: t("sessionOverview.activity.toolCalls"), value: String(turn.toolCallCount) },
            ...(turnSubAgents.length > 0
              ? [{ label: t("sessionOverview.badges.subAgents"), value: String(turnSubAgents.length), color: "#6366f1" as string | undefined }]
              : []),
            { label: t("sessionOverview.activity.duration"),  value: dur || "—" },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: color ?? "#111827", lineHeight: 1 }}>{value}</div>
            </div>
          ))}

          {/* Right side: event badges */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
            {(() => {
              const hasCommand = turn.calls.some(c => c.intervalEvents.some(e => e.kind === "user:command"));
              const hasUnknown = turn.calls.some(c => c.intervalEvents.some(e => e.kind === "unknown"));
              const subAgentCount = turn.calls.reduce((s, c) => s + c.subAgents.length, 0);
              type TBadge = { icon: React.ReactNode; label: string; color: string; border: string; bg: string };
              const tbadges: TBadge[] = [
                turn.hasCompaction ? { icon: BADGE_ICONS.compaction(9, "#ef4444"), label: t("sessionOverview.badges.compaction"), color: "#ef4444", border: "#fecaca", bg: "#fef2f2" } : null,
                turn.errorCount > 0 ? { icon: BADGE_ICONS.error(9, "#dc2626"), label: `${turn.errorCount}`, color: "#dc2626", border: "#fecaca", bg: "#fef2f2" } : null,
                subAgentCount > 0 ? { icon: BADGE_ICONS.subAgent(9, "#7c3aed"), label: `${subAgentCount}`, color: "#7c3aed", border: "#e9d5ff", bg: "#faf5ff" } : null,
                hasCommand ? { icon: BADGE_ICONS.command(9, "#d97706"), label: t("sessionOverview.badges.commands"), color: "#d97706", border: "#fde68a", bg: "#fffbeb" } : null,
                hasUnknown ? { icon: BADGE_ICONS.unknown(9, "#9ca3af"), label: t("sessionOverview.badges.unknown"), color: "#9ca3af", border: "#e5e7eb", bg: "#f9fafb" } : null,
              ].filter(Boolean) as TBadge[];
              return tbadges.map(b => (
                <span key={b.label} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9, fontWeight: 600, color: b.color, background: b.bg, border: `1px solid ${b.border}`, borderRadius: 4, padding: "2px 5px" }}>
                  {b.icon}{b.label}
                </span>
              ));
            })()}
          </div>
        </div>

        {/* Row 2: Token Ledger — identical to Session style */}
        <div style={{ paddingTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("dashboard.tokenLedger")}</span>
            {cacheRatio !== null && (
              <>
                <div style={{ width: 1, height: 10, background: "#e5e7eb" }} />
                <span style={{ fontSize: 9, fontWeight: 700, color: M.cache_ratio.color }}>
                  {t("metrics.cacheRatio.label", M.cache_ratio.label)} {fmtPct(cacheRatio)}
                </span>
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-end", marginBottom: 5 }}>
            {ledgerRows.map(({ id, value }) => {
              const m = M[id];
              return (
                <div key={id} title={m.description}>
                  <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, marginBottom: 2, whiteSpace: "nowrap" }}>{m.label}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: value > 0 ? m.color : "#d1d5db", lineHeight: 1 }}>
                    {value > 0 ? fmtK(value) : "—"}
                  </div>
                </div>
              );
            })}
          </div>
          {ledgerTotal > 0 && (
            <div style={{ height: 3, borderRadius: 2, overflow: "hidden", display: "flex", background: "#f3f4f6" }}>
              {ledgerRows.filter(r => r.value > 0).map(({ id, value }) => (
                <div key={id} style={{ flex: value, background: M[id].color }} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Call Minimap ──────────────────────────────────────────── */}
      <div id={minimapAnchorId} style={{ marginBottom: 20, scrollMarginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: minimapOpen ? 8 : 0 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em" }}>Call Minimap</span>
          <button
            onClick={() => setMinimapOpen(v => !v)}
            style={{ fontSize: 10, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: "0 4px", lineHeight: 1 }}
          >
            {minimapOpen ? "▲ hide" : "▼ show"}
          </button>
          {noTools && !minimapOpen && (
            <span style={{ fontSize: 9, color: "#d1d5db" }}>no tools — single call</span>
          )}
        </div>
        {minimapOpen && (
          <TurnMinimap
            turn={enrichedTurn}
            onSelectCall={id => {
              const anchor = document.getElementById(`turn-${turn.id}-call-${id}`);
              anchor?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          />
        )}
      </div>

      {/* ── Semantic call chain + raw JSONL event graph ────────────── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "6px 0",
          background: "#fff",
          borderTop: "1px solid #e5e7eb",
          borderBottom: "1px solid #e5e7eb",
          marginBottom: 12,
        }}>
          <SectionLabel>Semantic Call Chain</SectionLabel>
          <button
            type="button"
            onClick={() => document.getElementById(minimapAnchorId)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            style={{
              border: "1px solid #e5e7eb",
              background: "#fff",
              color: "#4f46e5",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            ↑ Minimap
          </button>
        </div>
        <JsonlCallChain
          turn={enrichedTurn}
          onSelectCall={onSelectCall}
          onSubAgentClick={onSubAgentClick}
        />
      </div>

      {/* ── Trailing inter-turn block (commands after this turn ended) ── */}
      {trailingInterTurnBlock && (
        <div style={{ marginBottom: 20 }}>
          <SectionLabel>After This Turn</SectionLabel>
          <InterTurnBlockDetail block={trailingInterTurnBlock} />
        </div>
      )}
    </div>
  );
}

// ─── LLM Call Detail Panel (v2) ───────────────────────────────────────────────

// ─── Trust badge ─────────────────────────────────────────────────────────────

function TrustBadge({ mode, proxy }: { mode: TrustMode; proxy?: MockLlmCall["proxy"] }) {
  const cfg: Record<TrustMode, { icon: string; label: string; detail: string; bg: string; border: string; color: string }> = {
    "proxy-exact": { icon: "✓", label: "Proxy exact",     detail: proxy ? `duration: ${fmtDuration(proxy.durationMs ?? 0)} · stop: ${proxy.resStopReason ?? "—"}` : "", bg: "#f0fdf4", border: "#bbf7d0", color: "#16a34a" },
    "jsonl-only":  { icon: "⚠", label: "JSONL observed",  detail: "Attribution estimated · No exact request payload · Link proxy to upgrade", bg: "#fffbeb", border: "#fde68a", color: "#d97706" },
    "mixed":       { icon: "~", label: "Mixed",            detail: "Partial proxy coverage · Some ranges estimated",                           bg: "#f0f9ff", border: "#bae6fd", color: "#0284c7" },
    "mock":        { icon: "◎", label: "Mock data",        detail: "UI mock — not computed from real session",                                 bg: "#f9fafb", border: "#e5e7eb", color: "#9ca3af" },
  };
  const c = cfg[mode];
  return (
    <div style={{ fontSize: 10, background: c.bg, border: `1px solid ${c.border}`, borderRadius: 5, padding: "5px 10px", marginBottom: 10, display: "flex", gap: 6, alignItems: "center" }}>
      <span style={{ fontWeight: 700, color: c.color }}>{c.icon} {c.label}</span>
      {c.detail && <span style={{ color: "#6b7280" }}>· {c.detail}</span>}
    </div>
  );
}

// ─── Confidence level helpers ─────────────────────────────────────────────────

const CONF_COLOR: Record<ConfidenceLevel, string> = {
  exact: "#16a34a", high: "#16a34a", medium: "#d97706", low: "#dc2626", unknown: "#9ca3af",
};
const CONF_ICON: Record<ConfidenceLevel, string> = {
  exact: "✓✓", high: "✓", medium: "~", low: "!", unknown: "?",
};

// ─── Attribution Flow (bridge-events overview) ────────────────────────────────

function AttributionFlowOverview({ ranges, bridges, onSelectRange }: {
  ranges: AttributedDiffRange[];
  bridges: MockBridgeEvent[];
  onSelectRange: (r: AttributedDiffRange) => void;
}) {
  const BRIDGE_CFG: Record<BridgeEventKind, { color: string; bg: string; icon: string }> = {
    user_input:         { color: "#6366f1", bg: "#f5f3ff", icon: "👤" },
    tool_use:           { color: "#d97706", bg: "#fffbeb", icon: "⚙" },
    tool_result:        { color: "#d97706", bg: "#fffbeb", icon: "📄" },
    system_injection:   { color: "#6b7280", bg: "#f9fafb", icon: "⚡" },
    compaction:         { color: "#ef4444", bg: "#fef2f2", icon: "◆" },
    assistant_response: { color: "#16a34a", bg: "#f0fdf4", icon: "💬" },
  };

  const addedTotal   = ranges.filter(r => r.changeType === "added").reduce((s, r) => s + r.tokens, 0);
  const removedTotal = ranges.filter(r => r.changeType === "removed").reduce((s, r) => s + Math.abs(r.tokens), 0);
  const retainedTotal = ranges.filter(r => r.changeType === "retained").reduce((s, r) => s + r.tokens, 0);

  return (
    <div style={{ background: "#f9fafb", border: "1px solid #f3f4f6", borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>
        Attribution Flow <MockBadge />
      </div>

      {/* Three-column layout: bridge events → impact → current */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 20px 1fr", gap: 0, alignItems: "start" }}>

        {/* Bridge events column */}
        <div>
          <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 600, marginBottom: 6 }}>BRIDGE EVENTS</div>
          {bridges.length > 0 ? bridges.map(b => {
            const cfg = BRIDGE_CFG[b.kind];
            return (
              <div key={b.id} style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 5, padding: "5px 8px", background: cfg.bg, border: `1px solid ${cfg.color}25`, borderLeft: `3px solid ${cfg.color}`, borderRadius: 5 }}>
                <span style={{ fontSize: 11, lineHeight: 1.2, flexShrink: 0 }}>{cfg.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: cfg.color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.label}</div>
                  {b.tokenImpact !== 0 && (
                    <div style={{ fontSize: 10, fontWeight: 700, color: b.tokenImpact > 0 ? "#d97706" : "#ef4444" }}>
                      {b.tokenImpact > 0 ? "+" : ""}{fmtK(b.tokenImpact)}
                    </div>
                  )}
                  <div style={{ fontSize: 9, color: "#9ca3af", marginTop: 1 }}>
                    {CONF_ICON[b.confidence.toLowerCase() as ConfidenceLevel] ?? "~"} {b.confidence}
                  </div>
                </div>
              </div>
            );
          }) : (
            <div style={{ fontSize: 10, color: "#9ca3af", fontStyle: "italic" }}>No bridge events extracted</div>
          )}
        </div>

        {/* Arrow */}
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 20, fontSize: 14, color: "#d1d5db" }}>›</div>

        {/* Impact summary column */}
        <div>
          <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 600, marginBottom: 6 }}>CURRENT PAYLOAD CHANGES</div>
          {[
            { label: "Added",    tokens: addedTotal,    color: "#16a34a", changeType: "added"    as ChangeType },
            { label: "Removed",  tokens: removedTotal,  color: "#dc2626", changeType: "removed"  as ChangeType },
            { label: "Retained", tokens: retainedTotal, color: "#9ca3af", changeType: "retained" as ChangeType },
          ].filter(g => g.tokens > 0).map(g => {
            const entries = ranges.filter(r => r.changeType === g.changeType);
            return (
              <div key={g.label} style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: g.color }}>{g.label}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: g.color }}>
                    {g.changeType === "removed" ? "−" : g.changeType === "added" ? "+" : ""}{fmtK(g.tokens)}
                  </span>
                </div>
                {entries.slice(0, 2).map(r => (
                  <div key={r.id} onClick={() => onSelectRange(r)} style={{ fontSize: 10, color: "#6b7280", padding: "2px 6px", borderRadius: 3, cursor: "pointer", marginBottom: 2, background: "#fff", border: "1px solid #f3f4f6" }}
                    onMouseEnter={e => { e.currentTarget.style.background = "#eff6ff"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}>
                    <span style={{ color: CATEGORY_COLORS[r.category] ?? "#6b7280" }}>●</span>{" "}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block", maxWidth: "90%" }}>
                      {r.textPreview.slice(0, 45)}…
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Attributed Diff Entries (main diff table) ────────────────────────────────

function AttributedDiffTable({ ranges, selectedId, onSelect }: {
  ranges: AttributedDiffRange[];
  selectedId: string | null;
  onSelect: (r: AttributedDiffRange) => void;
}) {
  const CHANGE_CFG: Record<ChangeType, { color: string; icon: string; bg: string }> = {
    added:        { color: "#16a34a", icon: "+", bg: "#f0fdf4" },
    removed:      { color: "#dc2626", icon: "−", bg: "#fef2f2" },
    changed:      { color: "#d97706", icon: "~", bg: "#fffbeb" },
    retained:     { color: "#9ca3af", icon: "·", bg: "transparent" },
    reclassified: { color: "#7c3aed", icon: "⇄", bg: "#faf5ff" },
    moved:        { color: "#3b82f6", icon: "→", bg: "#eff6ff" },
  };

  const groups: ChangeType[] = ["added", "changed", "removed", "reclassified", "retained"];
  const grouped = groups.map(ct => ({ ct, entries: ranges.filter(r => r.changeType === ct) })).filter(g => g.entries.length > 0);

  return (
    <div>
      {grouped.map(({ ct, entries }) => {
        const cfg = CHANGE_CFG[ct];
        return (
          <div key={ct} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: cfg.color }}>{cfg.icon}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: cfg.color, textTransform: "capitalize" }}>{ct}</span>
              <span style={{ fontSize: 10, color: "#9ca3af" }}>{entries.length} range{entries.length > 1 ? "s" : ""} · {fmtK(entries.reduce((s, r) => s + Math.abs(r.tokens), 0))} tokens</span>
            </div>
            <div style={{ border: "1px solid #f3f4f6", borderRadius: 7, overflow: "hidden" }}>
              {entries.map((r, i) => {
                const isSelected = r.id === selectedId;
                return (
                  <div key={r.id} onClick={() => onSelect(r)} style={{
                    padding: "9px 12px",
                    borderBottom: i < entries.length - 1 ? "1px solid #f9fafb" : "none",
                    background: isSelected ? "#eff6ff" : cfg.bg,
                    borderLeft: isSelected ? "3px solid #6366f1" : `3px solid ${cfg.color}40`,
                    cursor: "pointer",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#f9fafb"; }}
                  onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = isSelected ? "#eff6ff" : cfg.bg; }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      {/* Category dot */}
                      <div style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, marginTop: 3, background: CATEGORY_COLORS[r.category] ?? "#e5e7eb" }} />

                      <div style={{ flex: 1, minWidth: 0 }}>
                        {/* Header: category + source */}
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                          <span style={{ fontSize: 10, color: CATEGORY_COLORS[r.category] ?? "#6b7280", fontWeight: 600 }}>{r.category}</span>
                          {r.sourceEvent && (
                            <>
                              <span style={{ fontSize: 10, color: "#d1d5db" }}>·</span>
                              <span style={{ fontSize: 10, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sourceEvent.label}</span>
                            </>
                          )}
                        </div>
                        {/* Text preview */}
                        <div style={{ fontSize: 11, color: "#374151", fontFamily: "monospace", lineHeight: 1.5, background: isSelected ? "#dbeafe" : "#f9fafb", borderRadius: 4, padding: "4px 7px", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 72, overflow: "hidden" }}>
                          {r.textPreview.slice(0, 200)}
                        </div>
                        {/* Offset + confidence */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                          {r.currentRange && (
                            <span style={{ fontSize: 9, color: "#9ca3af", fontFamily: "monospace" }}>
                              chars {r.currentRange.startChar.toLocaleString()}–{r.currentRange.endChar.toLocaleString()}
                            </span>
                          )}
                          <span style={{ fontSize: 9, color: CONF_COLOR[r.confidence], fontWeight: 600 }}>
                            {CONF_ICON[r.confidence]} {r.confidence}
                          </span>
                        </div>
                      </div>

                      {/* Token count */}
                      <span style={{ fontSize: 12, fontWeight: 700, color: cfg.color, flexShrink: 0 }}>
                        {r.changeType === "added" ? "+" : r.changeType === "removed" ? "−" : ""}{fmtK(Math.abs(r.tokens))}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Attributed Diff Range Evidence Drawer ────────────────────────────────────

// ─── Call Inspector Overview (right panel, no selection) ──────────────────────

function CallInspectorOverview({
  call, attrRanges, payloadSegs, confPct, trustMode,
}: {
  call: MockLlmCall;
  attrRanges: AttributedDiffRange[];
  payloadSegs: PayloadSegment[];
  confPct: number;
  trustMode: TrustMode;
}) {
  const total = payloadSegs.reduce((s, g) => s + g.tokens, 0) || 1;

  const addedTokens    = attrRanges.filter(r => r.changeType === "added").reduce((s, r) => s + r.tokens, 0);
  const removedTokens  = Math.abs(attrRanges.filter(r => r.changeType === "removed").reduce((s, r) => s + r.tokens, 0));
  const retainedTokens = attrRanges.filter(r => r.changeType === "retained").reduce((s, r) => s + r.tokens, 0);
  const netDelta = addedTokens - removedTokens;

  const topContributors = [...attrRanges]
    .filter(r => r.changeType === "added" && r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 4);

  const confUnknown = attrRanges.filter(r => r.confidence === "unknown").length;
  const confMedium  = attrRanges.filter(r => r.confidence === "medium").length;
  const confHighN   = attrRanges.filter(r => r.confidence === "exact" || r.confidence === "high").length;

  return (
    <div style={{ padding: "14px 14px" }}>
      {/* Summary header */}
      <div style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", letterSpacing: "0.05em", marginBottom: 12, textTransform: "uppercase" }}>
        Call #{call.id} Summary
      </div>

      {/* Net delta block */}
      <div style={{ background: "#fff", border: "1px solid #f3f4f6", borderRadius: 7, padding: "10px 12px", marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {[
            { label: "Net Δ",    value: `${netDelta >= 0 ? "+" : ""}${fmtK(netDelta)}`,    color: netDelta > 0 ? "#d97706" : "#16a34a" },
            { label: "Added",    value: `+${fmtK(addedTokens)}`,    color: "#16a34a" },
            { label: "Removed",  value: removedTokens > 0 ? `−${fmtK(removedTokens)}` : "—", color: "#dc2626" },
            { label: "Retained", value: fmtK(retainedTokens),        color: "#9ca3af" },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <div style={{ fontSize: 12, fontWeight: 700, color }}>{value}</div>
              <div style={{ fontSize: 9, color: "#9ca3af" }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Top contributors */}
      {topContributors.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", marginBottom: 6 }}>Top Contributors</div>
          {topContributors.map(r => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
              <div style={{ width: 7, height: 7, borderRadius: 1, background: CATEGORY_COLORS[r.category] ?? "#e5e7eb", flexShrink: 0 }} />
              <span style={{ fontSize: 10, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.sourceEvent?.label ?? r.category}
              </span>
              <span style={{ fontSize: 10, fontWeight: 600, color: "#d97706", flexShrink: 0 }}>+{fmtK(r.tokens)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Payload composition mini-bar */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", marginBottom: 6 }}>Payload Composition</div>
        <div style={{ height: 10, display: "flex", borderRadius: 4, overflow: "hidden", gap: 0.5, marginBottom: 6 }}>
          {payloadSegs.map(seg => (
            <div key={seg.id}
              title={`${seg.category}: ${seg.label} · ${fmtK(seg.tokens)} (${Math.round(seg.tokens / total * 100)}%)`}
              style={{ width: `${seg.tokens / total * 100}%`, background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb", opacity: 0.85, minWidth: 1 }}
            />
          ))}
        </div>
        {payloadSegs.filter(s => s.tokens / total > 0.05).map(seg => (
          <div key={seg.id} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
            <div style={{ width: 7, height: 7, borderRadius: 1, background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb", flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seg.label}</span>
            <span style={{ fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>{Math.round(seg.tokens / total * 100)}%</span>
          </div>
        ))}
      </div>

      {/* Attribution quality */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", marginBottom: 6 }}>Attribution Quality</div>
        {[
          { label: "high / exact", count: confHighN, color: "#16a34a", pct: attrRanges.length > 0 ? Math.round(confHighN / attrRanges.length * 100) : 0 },
          { label: "medium",       count: confMedium, color: "#d97706", pct: attrRanges.length > 0 ? Math.round(confMedium / attrRanges.length * 100) : 0 },
          { label: "unknown",      count: confUnknown, color: "#9ca3af", pct: attrRanges.length > 0 ? Math.round(confUnknown / attrRanges.length * 100) : 0 },
        ].filter(g => g.count > 0).map(g => (
          <div key={g.label} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 10, color: g.color, fontWeight: 600, width: 72 }}>{g.label}</span>
            <div style={{ flex: 1, height: 4, background: "#f3f4f6", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${g.pct}%`, height: "100%", background: g.color, opacity: 0.7 }} />
            </div>
            <span style={{ fontSize: 9, color: "#9ca3af", width: 26, textAlign: "right" }}>{g.pct}%</span>
          </div>
        ))}
        {trustMode === "jsonl-only" && (
          <div style={{ fontSize: 9, color: "#d97706", marginTop: 6, fontStyle: "italic" }}>
            Link proxy to improve attribution quality
          </div>
        )}
      </div>

      <div style={{ fontSize: 9, color: "#c4b5fd", textAlign: "center", borderTop: "1px solid #f3f4f6", paddingTop: 10 }}>
        Select a segment to inspect source, offsets and evidence
      </div>
    </div>
  );
}

function AttributedRangeEvidenceDrawer({ range, onClear }: { range: AttributedDiffRange; onClear: () => void }) {
  const CHANGE_CFG: Record<ChangeType, { color: string; icon: string }> = {
    added: { color: "#16a34a", icon: "+" }, removed: { color: "#dc2626", icon: "−" },
    changed: { color: "#d97706", icon: "~" }, retained: { color: "#9ca3af", icon: "·" },
    reclassified: { color: "#7c3aed", icon: "⇄" }, moved: { color: "#3b82f6", icon: "→" },
  };
  const cfg = CHANGE_CFG[range.changeType];

  return (
    <div style={{ padding: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#374151" }}>Evidence</span>
        <button onClick={onClear} style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16, padding: 0, lineHeight: 1 }}>×</button>
      </div>

      {/* Change type + category */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: cfg.color, background: `${cfg.color}18`, borderRadius: 4, padding: "2px 7px" }}>
          {cfg.icon} {range.changeType}
        </span>
        <span style={{ fontSize: 10, fontWeight: 600, color: CATEGORY_COLORS[range.category] ?? "#6b7280", background: `${CATEGORY_COLORS[range.category] ?? "#e5e7eb"}18`, borderRadius: 4, padding: "2px 7px" }}>
          {range.category}
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, color: CONF_COLOR[range.confidence], background: `${CONF_COLOR[range.confidence]}15`, borderRadius: 4, padding: "2px 7px" }}>
          {CONF_ICON[range.confidence]} {range.confidence}
        </span>
      </div>

      {/* Metadata rows */}
      {[
        { label: "Tokens",  value: `${range.changeType === "added" ? "+" : range.changeType === "removed" ? "−" : ""}${fmtK(Math.abs(range.tokens))}` },
        range.cause ? { label: "Cause",   value: range.cause } : null,
        range.sourceEvent ? { label: "Source",  value: range.sourceEvent.label } : null,
        range.currentRange ? { label: "Chars",   value: `${range.currentRange.startChar.toLocaleString()}–${range.currentRange.endChar.toLocaleString()}` } : null,
        range.currentRange?.startByte != null ? { label: "Bytes",   value: `${range.currentRange.startByte.toLocaleString()}–${range.currentRange.endByte?.toLocaleString()}` } : null,
      ].filter(Boolean).map(item => (
        <div key={item!.label} style={{ display: "flex", gap: 8, padding: "4px 0", borderBottom: "1px solid #f3f4f6" }}>
          <span style={{ width: 56, flexShrink: 0, fontSize: 10, color: "#9ca3af" }}>{item!.label}</span>
          <span style={{ fontSize: 10, color: "#374151", wordBreak: "break-word" }}>{item!.value}</span>
        </div>
      ))}

      {/* Text preview */}
      <div style={{ marginTop: 10, padding: "8px 10px", background: "#f9fafb", borderRadius: 6, fontSize: 10, fontFamily: "monospace", color: "#374151", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 120, overflowY: "auto" }}>
        {range.textPreview}
      </div>

      {/* Evidence refs */}
      {range.evidenceRefs.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", marginBottom: 6 }}>Evidence references</div>
          {range.evidenceRefs.map((ref, i) => (
            <div key={i} style={{ padding: "5px 8px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 5, marginBottom: 4 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#16a34a" }}>{ref.label}</div>
              <div style={{ fontSize: 9, color: "#4b5563", marginTop: 2 }}>{ref.detail}</div>
            </div>
          ))}
        </div>
      )}

      {range.evidenceRefs.length === 0 && (
        <div style={{ marginTop: 8, fontSize: 10, color: "#9ca3af", fontStyle: "italic" }}>
          No direct evidence reference. Attribution is inferred.
        </div>
      )}
    </div>
  );
}

// ─── Real Segment Tree (proxy-backed, no mock) ────────────────────────────────
// Layout:
//   Level 0 — top bar: section blocks (System / Tools / Messages / …)
//   Default — collapsed overview: all sections listed with their segments
//   Level 1 — clicking a section → sub-bar + rich segment list
//   Level 2 — clicking a segment → detail panel with rawText

const SECTION_LABEL: Record<string, string> = {
  system: "System", tools: "Tools", messages: "Messages", metadata: "Metadata", unknown: "Unknown",
};
const SECTION_COLOR: Record<string, string> = {
  system: "#6366f1", tools: "#6b7280", messages: "#3b82f6", metadata: "#a855f7", unknown: "#94a3b8",
};
// Muted fill variants for sub-bar segments (same hue, lighter)
const SECTION_FILL: Record<string, string> = {
  system: "#c7d2fe", tools: "#d1d5db", messages: "#bfdbfe", metadata: "#e9d5ff", unknown: "#e2e8f0",
};
const CACHE_BADGE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  read:  { label: "cached",       color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
  write: { label: "cache write",  color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
};

function charsToTokens(chars: number): number { return Math.round(chars / 4); }

// Infer segment meta from category/label for display enrichment
function inferSegmentMeta(seg: import("./drilldown-types").CallSegment): {
  nature: "static" | "dynamic" | "rule-injected" | "tool-result" | "assistant" | "user" | null;
  sourceHint: string | null;
  isMock: boolean;
} {
  const cat = seg.category?.toLowerCase() ?? "";
  const label = seg.label?.toLowerCase() ?? "";

  // System segments: categorize by known patterns
  if (seg.section === "system") {
    if (cat.includes("memory") || label.includes("memory")) return { nature: "dynamic", sourceHint: "auto-memory", isMock: false };
    if (cat.includes("claude.md") || label.includes("claude.md")) return { nature: "static", sourceHint: "CLAUDE.md", isMock: false };
    if (cat.includes("reminder") || label.includes("reminder") || label.includes("task")) return { nature: "dynamic", sourceHint: "injected", isMock: false };
    if (cat.includes("rule") || label.includes("rule")) return { nature: "rule-injected", sourceHint: "rule-registry", isMock: false };
    if (cat.includes("context") || cat.includes("system_prompt") || cat.includes("system-prompt")) return { nature: "static", sourceHint: "system-prompt", isMock: false };
    return { nature: "static", sourceHint: null, isMock: true };
  }

  // Tools segments
  if (seg.section === "tools") {
    if (label.includes("mcp") || cat.includes("mcp")) return { nature: "dynamic", sourceHint: "MCP", isMock: false };
    if (label.includes("bash") || label.includes("read") || label.includes("write") || label.includes("edit"))
      return { nature: "static", sourceHint: "system-tools", isMock: false };
    return { nature: "static", sourceHint: "tools", isMock: true };
  }

  // Messages segments
  if (seg.section === "messages") {
    if (seg.role === "user" && (cat.includes("tool_result") || label.includes("tool_result")))
      return { nature: "tool-result", sourceHint: null, isMock: false };
    if (seg.role === "assistant") return { nature: "assistant", sourceHint: null, isMock: false };
    if (seg.role === "user") return { nature: "user", sourceHint: null, isMock: false };
    return { nature: null, sourceHint: null, isMock: true };
  }

  return { nature: null, sourceHint: null, isMock: true };
}

const NATURE_BADGE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  "static":        { label: "static",       color: "#374151", bg: "#f3f4f6", border: "#e5e7eb" },
  "dynamic":       { label: "dynamic",      color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  "rule-injected": { label: "rule",         color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
  "tool-result":   { label: "tool_result",  color: "#b45309", bg: "#fef3c7", border: "#fde68a" },
  "assistant":     { label: "assistant",    color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe" },
  "user":          { label: "user",         color: "#047857", bg: "#f0fdf4", border: "#bbf7d0" },
};

// Infer turn position for message segments from call context
function inferMessageTurnInfo(seg: import("./drilldown-types").CallSegment, call: MockLlmCall): {
  turnDesc: string | null;
  isMock: boolean;
} {
  if (seg.section !== "messages") return { turnDesc: null, isMock: false };

  // From label: often contains "Turn N" or message index heuristics
  const labelLower = seg.label.toLowerCase();
  if (labelLower.includes("turn")) {
    const m = seg.label.match(/turn\s*(\d+)/i);
    if (m) return { turnDesc: `Turn ${m[1]}`, isMock: false };
  }
  // Heuristic: if role is assistant, this is likely from a prior turn response
  if (seg.role === "assistant") return { turnDesc: `□ prior turn`, isMock: true };
  if (seg.role === "user" && (seg.category?.includes("tool_result") || seg.label.toLowerCase().includes("tool_result"))) {
    return { turnDesc: `□ turn #${call.indexInTurn} · tool_result`, isMock: true };
  }
  if (seg.role === "user") return { turnDesc: `□ turn #${call.indexInTurn}`, isMock: true };
  return { turnDesc: null, isMock: true };
}

// Compact segment row used in default overview and section drill-down
function SegmentRow({
  seg, secColor, totalCharsInSection, diffByHash, call, onClick,
}: {
  seg: import("./drilldown-types").CallSegment;
  secColor: string;
  totalCharsInSection: number;
  diffByHash: Map<string, { op: string; charDelta: number }>;
  call: MockLlmCall;
  onClick: () => void;
}) {
  const segPct    = Math.round(seg.charCount / totalCharsInSection * 100);
  const segTokens = charsToTokens(seg.charCount);
  const diffEntry = diffByHash.get(seg.rawHash);
  const cacheBadge = CACHE_BADGE[seg.cacheHint];
  const deltaStr = diffEntry && diffEntry.op !== "unchanged"
    ? (diffEntry.op === "added" ? "+" : diffEntry.op === "removed" ? "−" : diffEntry.charDelta >= 0 ? "+" : "") + fmtK(charsToTokens(Math.abs(diffEntry.charDelta)))
    : null;
  const deltaColor = diffEntry?.op === "removed" ? "#dc2626" : "#d97706";

  const meta = inferSegmentMeta(seg);
  const natureBadge = meta.nature ? NATURE_BADGE[meta.nature] : null;
  const turnInfo = inferMessageTurnInfo(seg, call);

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8, padding: "7px 12px",
        cursor: "pointer", background: "#fff",
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#f9fafb"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "#fff"; }}
    >
      {/* mini proportion bar */}
      <div style={{ width: 36, height: 4, background: "#f3f4f6", borderRadius: 2, overflow: "hidden", flexShrink: 0 }}>
        <div style={{ width: `${segPct}%`, height: "100%", background: secColor + "80" }} />
      </div>

      {/* label + sub-info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, overflow: "hidden" }}>
          <span style={{ fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {seg.label}
          </span>
          {meta.isMock && (
            <span title="Inferred / mock value" style={{ fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>□</span>
          )}
        </div>
        {(meta.sourceHint || turnInfo.turnDesc || seg.role) && (
          <div style={{ display: "flex", gap: 6, marginTop: 1, flexWrap: "wrap" }}>
            {seg.role && (
              <span style={{ fontSize: 9, color: "#9ca3af" }}>{seg.role}</span>
            )}
            {meta.sourceHint && (
              <span style={{ fontSize: 9, color: "#9ca3af" }}>{meta.sourceHint}</span>
            )}
            {turnInfo.turnDesc && (
              <span style={{ fontSize: 9, color: turnInfo.isMock ? "#d1d5db" : "#9ca3af" }}>{turnInfo.turnDesc}</span>
            )}
          </div>
        )}
      </div>

      {/* nature badge */}
      {natureBadge && (
        <span style={{ fontSize: 9, color: natureBadge.color, background: natureBadge.bg, border: `1px solid ${natureBadge.border}`, borderRadius: 3, padding: "1px 4px", flexShrink: 0, whiteSpace: "nowrap" }}>
          {natureBadge.label}
        </span>
      )}

      {/* delta */}
      {deltaStr && (
        <span style={{ fontSize: 10, fontWeight: 600, color: deltaColor, flexShrink: 0, width: 44, textAlign: "right" }}>{deltaStr}</span>
      )}

      {/* tokens + pct */}
      <span style={{ fontSize: 11, fontWeight: 600, color: "#374151", width: 40, textAlign: "right", flexShrink: 0 }}>~{fmtK(segTokens)}</span>
      <span style={{ fontSize: 10, color: "#9ca3af", width: 26, textAlign: "right", flexShrink: 0 }}>{segPct}%</span>

      {/* cache badge */}
      {cacheBadge
        ? <span style={{ fontSize: 9, color: cacheBadge.color, background: cacheBadge.bg, border: `1px solid ${cacheBadge.border}`, borderRadius: 3, padding: "1px 5px", flexShrink: 0, whiteSpace: "nowrap" }}>{cacheBadge.label}</span>
        : <span style={{ width: 54, flexShrink: 0 }} />
      }
    </div>
  );
}

function RealSegmentTree({
  segments, diff, call,
}: {
  segments: import("./drilldown-types").CallSegment[];
  diff: import("./drilldown-types").SegmentDiff[] | null;
  call: MockLlmCall;
}) {
  const SECTION_ORDER = ["system", "tools", "messages", "metadata", "unknown"] as const;

  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [activeSegId,   setActiveSegId]   = useState<string | null>(null);

  // diff lookup by rawHash
  const diffByHash = new Map<string, { op: string; charDelta: number }>();
  if (diff) for (const d of diff) if (d.rawHash) diffByHash.set(d.rawHash, { op: d.op, charDelta: d.charDelta });

  // group by section
  const bySection: Record<string, typeof segments> = {};
  for (const s of segments) {
    if (!bySection[s.section]) bySection[s.section] = [];
    bySection[s.section].push(s);
  }

  const totalChars = segments.reduce((s, g) => s + g.charCount, 0) || 1;
  const activeSectionSegs = activeSection ? (bySection[activeSection] ?? []) : [];
  const activeSegTotalChars = activeSectionSegs.reduce((s, g) => s + g.charCount, 0) || 1;
  const activeSeg = activeSegId ? activeSectionSegs.find(s => s.id === activeSegId) ?? null : null;

  function handleSectionClick(sec: string) {
    if (activeSection === sec) { setActiveSection(null); setActiveSegId(null); }
    else { setActiveSection(sec); setActiveSegId(null); }
  }
  function handleSegClick(segId: string) {
    setActiveSegId(prev => prev === segId ? null : segId);
  }

  return (
    <div>
      {/* ── Level 0: Top bar — one block per section ─────────────── */}
      <div style={{ height: 56, display: "flex", borderRadius: 8, overflow: "hidden", marginBottom: 10 }}>
        {SECTION_ORDER.filter(sec => bySection[sec]?.length).map(sec => {
          const secChars = bySection[sec].reduce((s, g) => s + g.charCount, 0);
          const secPct   = Math.round(secChars / totalChars * 100);
          const color    = SECTION_COLOR[sec];
          const isActive = activeSection === sec;
          return (
            <div
              key={sec}
              onClick={() => handleSectionClick(sec)}
              title={`${SECTION_LABEL[sec]}: ~${fmtK(charsToTokens(secChars))} (${secPct}%)`}
              style={{
                flex: secChars, minWidth: 0, cursor: "pointer",
                background: isActive ? color : color + "a0",
                display: "flex", flexDirection: "column", justifyContent: "center",
                padding: "0 10px", overflow: "hidden",
                borderRight: "2px solid rgba(255,255,255,0.15)",
                // removed outline
                transition: "background 0.12s",
              }}
              onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = color + "cc"; }}
              onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = color + "a0"; }}
            >
              {secPct >= 5 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {SECTION_LABEL[sec]}
                </span>
              )}
              {secPct >= 5 && (
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.85)", whiteSpace: "nowrap" }}>
                  ~{fmtK(charsToTokens(secChars))}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Default overview: all sections listed when no section is selected ── */}
      {!activeSection && (
        <div>
          {SECTION_ORDER.filter(sec => bySection[sec]?.length).map(sec => {
            const secSegs  = bySection[sec];
            const secChars = secSegs.reduce((s, g) => s + g.charCount, 0);
            const secPct   = Math.round(secChars / totalChars * 100);
            const secColor = SECTION_COLOR[sec];
            // Tools section: compute extra stats
            const toolCount = sec === "tools" ? secSegs.length : null;
            // Messages section: count by role
            const msgByRole = sec === "messages"
              ? secSegs.reduce<Record<string, number>>((acc, s) => {
                  const r = s.role ?? "unknown";
                  acc[r] = (acc[r] ?? 0) + 1;
                  return acc;
                }, {})
              : null;

            return (
              <div key={sec} style={{ marginBottom: 10 }}>
                {/* Section header row */}
                <button
                  onClick={() => handleSectionClick(sec)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 8,
                    padding: "6px 10px", background: secColor + "10",
                    border: `1px solid ${secColor}30`, borderRadius: 6,
                    cursor: "pointer", marginBottom: 2,
                  }}
                >
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: secColor, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>{SECTION_LABEL[sec]}</span>
                  <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 2 }}>~{fmtK(charsToTokens(secChars))}</span>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>{secPct}%</span>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>{secSegs.length} segment{secSegs.length !== 1 ? "s" : ""}</span>
                  {toolCount != null && (
                    <span style={{ fontSize: 9, color: "#6b7280", background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 3, padding: "1px 5px", marginLeft: 2 }}>
                      {toolCount} tools
                    </span>
                  )}
                  {msgByRole && Object.keys(msgByRole).length > 0 && (
                    <span style={{ display: "flex", gap: 4, marginLeft: 2 }}>
                      {Object.entries(msgByRole).map(([role, count]) => (
                        <span key={role} style={{ fontSize: 9, color: "#6b7280", background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 3, padding: "1px 5px" }}>
                          {count} {role}
                        </span>
                      ))}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", fontSize: 10, color: "#9ca3af" }}>▶ expand</span>
                </button>

              </div>
            );
          })}
        </div>
      )}

      {/* ── Level 1: Sub-bar for selected section ────────────────── */}
      {activeSection && activeSectionSegs.length > 0 && (() => {
        const secColor = SECTION_COLOR[activeSection];
        const secChars = activeSectionSegs.reduce((s, g) => s + g.charCount, 0);
        const secPct   = Math.round(secChars / totalChars * 100);
        return (
          <div style={{ marginBottom: 12 }}>
            {/* Section header with prominent back button */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <button onClick={() => handleSectionClick(activeSection)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: secColor }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>{SECTION_LABEL[activeSection]}</span>
                <span style={{ fontSize: 10, color: "#9ca3af" }}>~{fmtK(charsToTokens(secChars))} · {secPct}% · {activeSectionSegs.length} segments</span>
              </button>
              <button
                onClick={() => { setActiveSection(null); setActiveSegId(null); }}
                title="返回总览"
                style={{
                  marginLeft: "auto", display: "flex", alignItems: "center", gap: 4,
                  background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 5,
                  cursor: "pointer", fontSize: 11, color: "#374151", padding: "3px 8px", lineHeight: 1,
                }}
              >
                ← 返回
              </button>
            </div>

            {/* Sub-bar: one block per segment */}
            <div style={{ height: 32, display: "flex", borderRadius: 8, overflow: "hidden", gap: 2, marginBottom: 8 }}>
              {activeSectionSegs.map(seg => {
                const pct      = Math.round(seg.charCount / secChars * 100);
                const fillColor = SECTION_FILL[activeSection] ?? "#e5e7eb";
                const isActive  = activeSegId === seg.id;
                return (
                  <div
                    key={seg.id}
                    onClick={() => handleSegClick(seg.id)}
                    title={`${seg.label}: ~${fmtK(charsToTokens(seg.charCount))} (${pct}%)`}
                    style={{
                      flex: seg.charCount, minWidth: 4, cursor: "pointer",
                      background: isActive ? secColor : fillColor,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      overflow: "hidden", padding: "0 4px",
                      outline: isActive ? `2px solid ${secColor}` : "none",
                      outlineOffset: -2,
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = secColor + "60"; }}
                    onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = fillColor; }}
                  >
                    {pct >= 6 && (
                      <span style={{ fontSize: 9, color: isActive ? "#fff" : "#374151", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%", fontWeight: isActive ? 700 : 400 }}>
                        {seg.label.length > 20 ? seg.label.slice(0, 18) + "…" : seg.label}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Full segment list with enriched metadata */}
            {!activeSeg && (
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
                {activeSectionSegs.map((seg, i) => (
                  <div
                    key={seg.id}
                    style={{ borderBottom: i < activeSectionSegs.length - 1 ? "1px solid #f3f4f6" : "none" }}
                  >
                    <SegmentRow
                      seg={seg} secColor={secColor}
                      totalCharsInSection={activeSegTotalChars}
                      diffByHash={diffByHash}
                      call={call}
                      onClick={() => handleSegClick(seg.id)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Level 2: Segment detail panel ────────────────────────── */}
      {activeSeg && (() => {
        const secColor   = SECTION_COLOR[activeSection!];
        const cacheBadge = CACHE_BADGE[activeSeg.cacheHint];
        const segTokens  = charsToTokens(activeSeg.charCount);
        const segPct     = Math.round(activeSeg.charCount / activeSegTotalChars * 100);
        const diffEntry  = diffByHash.get(activeSeg.rawHash);
        const meta       = inferSegmentMeta(activeSeg);
        const natureBadge = meta.nature ? NATURE_BADGE[meta.nature] : null;
        const turnInfo   = inferMessageTurnInfo(activeSeg, call);

        return (
          <div style={{ border: `1px solid ${secColor}40`, borderLeft: `3px solid ${secColor}`, borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
            {/* Detail header */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", background: "#fafafa", borderBottom: "1px solid #f3f4f6" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {activeSeg.label}
                  </span>
                  {meta.isMock && <span title="Inferred / mock value" style={{ fontSize: 9, color: "#9ca3af" }}>□</span>}
                  {natureBadge && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: natureBadge.color, background: natureBadge.bg, border: `1px solid ${natureBadge.border}`, borderRadius: 3, padding: "1px 4px", flexShrink: 0 }}>
                      {natureBadge.label}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, color: "#374151" }}>~{fmtK(segTokens)} tokens</span>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>{segPct}% of section</span>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>{activeSeg.charCount.toLocaleString()} chars</span>
                  {activeSeg.category !== activeSeg.section && (
                    <span style={{ fontSize: 10, color: "#9ca3af" }}>{activeSeg.category}</span>
                  )}
                  {activeSeg.role && <span style={{ fontSize: 10, color: "#9ca3af" }}>role: {activeSeg.role}</span>}
                  {meta.sourceHint && (
                    <span style={{ fontSize: 10, color: "#6b7280" }}>source: {meta.sourceHint}</span>
                  )}
                  {turnInfo.turnDesc && (
                    <span style={{ fontSize: 10, color: turnInfo.isMock ? "#d1d5db" : "#9ca3af" }}>{turnInfo.turnDesc}</span>
                  )}
                  {cacheBadge && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: cacheBadge.color, background: cacheBadge.bg, border: `1px solid ${cacheBadge.border}`, borderRadius: 3, padding: "1px 5px" }}>
                      {cacheBadge.label}
                    </span>
                  )}
                  {diffEntry && diffEntry.op !== "unchanged" && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: diffEntry.op === "removed" ? "#dc2626" : "#d97706" }}>
                      {diffEntry.op === "added" ? "+" : diffEntry.op === "removed" ? "−" : diffEntry.charDelta >= 0 ? "+" : ""}
                      {fmtK(charsToTokens(Math.abs(diffEntry.charDelta)))} vs prev
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setActiveSegId(null)}
                title="返回 segment 列表"
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 5,
                  cursor: "pointer", fontSize: 11, color: "#374151", padding: "3px 8px", lineHeight: 1, flexShrink: 0,
                }}
              >
                ← 返回
              </button>
            </div>

            {/* rawText */}
            <div style={{ padding: "10px 14px" }}>
              <pre style={{
                fontSize: 10, fontFamily: "monospace", color: "#374151",
                background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6,
                padding: "10px 12px", maxHeight: 320, overflowY: "auto",
                whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.65, margin: 0,
              }}>
                {activeSeg.rawText.slice(0, 4000)}{activeSeg.rawText.length > 4000 ? "\n\n… (truncated, showing first 4000 chars)" : ""}
              </pre>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── Payload Map (segment minimap) ────────────────────────────────────────────

function PayloadMapTab({ segments, selectedSegId, onSelect }: {
  segments: PayloadSegment[];
  selectedSegId: string | null;
  onSelect: (s: PayloadSegment) => void;
}) {
  const total = segments.reduce((s, g) => s + g.tokens, 0) || 1;

  return (
    <div>
      {/* Payload minimap — horizontal stacked bar sorted by payload order */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", marginBottom: 6 }}>Payload order (char 0 → {fmtK(total * 4)} chars)</div>
        <div style={{ height: 20, display: "flex", borderRadius: 6, overflow: "hidden", gap: 0.5 }}>
          {segments.map(seg => (
            <div key={seg.id}
              onClick={() => onSelect(seg)}
              title={`${seg.category}: ${seg.label} · ${fmtK(seg.tokens)}`}
              style={{
                width: `${seg.tokens / total * 100}%`,
                background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb",
                cursor: "pointer", opacity: selectedSegId === seg.id ? 1 : 0.75,
                outline: selectedSegId === seg.id ? "2px solid #6366f1" : "none",
                transition: "opacity 0.1s",
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = "1"; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = selectedSegId === seg.id ? "1" : "0.75"; }}
            />
          ))}
        </div>
        {/* Ruler */}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
          <span style={{ fontSize: 8, color: "#d1d5db" }}>0</span>
          <span style={{ fontSize: 8, color: "#d1d5db" }}>{fmtK(total * 4)} chars</span>
        </div>
      </div>

      {/* Segment table */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 58px 44px 56px", padding: "5px 12px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
          {["Segment", "Tokens", "%", "Conf"].map(h => (
            <span key={h} style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600 }}>{h}</span>
          ))}
        </div>
        {segments.map((seg, i) => {
          const pct = Math.round(seg.tokens / total * 100);
          const isSelected = seg.id === selectedSegId;
          return (
            <div key={seg.id} onClick={() => onSelect(seg)} style={{
              display: "grid", gridTemplateColumns: "1fr 58px 44px 56px",
              padding: "8px 12px", alignItems: "center", cursor: "pointer",
              borderBottom: i < segments.length - 1 ? "1px solid #f3f4f6" : "none",
              background: isSelected ? "#eff6ff" : "transparent",
              borderLeft: isSelected ? "3px solid #6366f1" : "3px solid transparent",
            }}
            onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#f9fafb"; }}
            onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}>
              <div style={{ overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 7, height: 7, borderRadius: 1, background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb", flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seg.label}</span>
                </div>
                {seg.sourceEvent && (
                  <div style={{ fontSize: 9, color: "#9ca3af", marginLeft: 13, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {seg.sourceEvent.label}
                  </div>
                )}
                {seg.currentRange && (
                  <div style={{ fontSize: 8, color: "#d1d5db", marginLeft: 13, marginTop: 1, fontFamily: "monospace" }}>
                    chars {seg.currentRange.startChar.toLocaleString()}–{seg.currentRange.endChar.toLocaleString()}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11, color: "#374151" }}>{fmtK(seg.tokens)}</span>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>{pct}%</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: CONF_COLOR[seg.confidence] }}>{CONF_ICON[seg.confidence]} {seg.confidence}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Segment Evidence Drawer (Payload Map) ────────────────────────────────────

function PayloadSegmentEvidenceDrawer({ seg, onClear }: { seg: PayloadSegment; onClear: () => void }) {
  return (
    <div style={{ padding: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#374151" }}>Segment</span>
        <button onClick={onClear} style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16, padding: 0 }}>×</button>
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 10 }}>{seg.label}</div>
      {[
        { label: "Category",   value: <span style={{ color: CATEGORY_COLORS[seg.category] ?? "#374151", fontWeight: 600 }}>{seg.category}</span> },
        { label: "Tokens",     value: fmtK(seg.tokens) },
        { label: "First seen", value: seg.firstSeenCallId != null ? `Call #${seg.firstSeenCallId}` : "—" },
        { label: "Source",     value: seg.sourceEvent?.label ?? "—" },
        { label: "Chars",      value: seg.currentRange ? `${seg.currentRange.startChar.toLocaleString()}–${seg.currentRange.endChar.toLocaleString()}` : "—" },
        { label: "Confidence", value: <span style={{ color: CONF_COLOR[seg.confidence], fontWeight: 700 }}>{CONF_ICON[seg.confidence]} {seg.confidence}</span> },
      ].map(({ label, value }) => (
        <div key={label} style={{ display: "flex", gap: 8, padding: "5px 0", borderBottom: "1px solid #f3f4f6" }}>
          <span style={{ width: 72, flexShrink: 0, fontSize: 10, color: "#9ca3af" }}>{label}</span>
          <span style={{ fontSize: 11, color: "#374151" }}>{value}</span>
        </div>
      ))}
      {seg.content && (
        <div style={{ marginTop: 10, padding: "8px 10px", background: "#f9fafb", borderRadius: 6, fontSize: 10, fontFamily: "monospace", color: "#374151", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 120, overflowY: "auto" }}>
          {seg.content}
        </div>
      )}
    </div>
  );
}

// ─── LLM Call Detail Panel ────────────────────────────────────────────────────

type CallTab = "attribution" | "diff" | "raw";
type DiffMode = "segment" | "range" | "raw";

// ─── Attribution Tab ──────────────────────────────────────────────────────────

function PayloadCompositionBar({ segments, selectedId, onSelect }: {
  segments: PayloadSegment[];
  selectedId: string | null;
  onSelect: (s: PayloadSegment) => void;
}) {
  const total = segments.reduce((s, g) => s + g.tokens, 0) || 1;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ height: 22, display: "flex", borderRadius: 6, overflow: "hidden", gap: 1 }}>
        {segments.map(seg => (
          <div key={seg.id}
            onClick={() => onSelect(seg)}
            title={`${seg.category}: ${seg.label} · ${fmtK(seg.tokens)} (${Math.round(seg.tokens / total * 100)}%)`}
            style={{
              width: `${seg.tokens / total * 100}%`,
              background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb",
              cursor: "pointer",
              opacity: selectedId ? (selectedId === seg.id ? 1 : 0.5) : 0.85,
              outline: selectedId === seg.id ? "2px solid #6366f1" : "none",
              outlineOffset: -1,
              transition: "opacity 0.1s",
              minWidth: seg.tokens / total > 0.01 ? undefined : 2,
            }}
            onMouseEnter={e => { e.currentTarget.style.opacity = "1"; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = selectedId === seg.id ? "1" : selectedId ? "0.5" : "0.85"; }}
          />
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
        {segments.filter(s => s.tokens / total > 0.03).map(seg => (
          <div key={seg.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 7, height: 7, borderRadius: 1, background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb", flexShrink: 0 }} />
            <span style={{ fontSize: 9, color: "#6b7280" }}>{seg.category}</span>
            <span style={{ fontSize: 9, color: "#9ca3af" }}>{Math.round(seg.tokens / total * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AttributionTab({
  segments, ranges, selectedSegId, onSelectSeg,
}: {
  segments: PayloadSegment[];
  ranges: AttributedDiffRange[];
  selectedSegId: string | null;
  onSelectSeg: (s: PayloadSegment) => void;
}) {
  const total = segments.reduce((s, g) => s + g.tokens, 0) || 1;

  // Build delta map from diff ranges: category -> delta tokens
  const deltaByCategory: Record<string, number> = {};
  for (const r of ranges) {
    if (r.changeType === "added" || r.changeType === "changed") {
      deltaByCategory[r.category] = (deltaByCategory[r.category] ?? 0) + r.tokens;
    } else if (r.changeType === "removed") {
      deltaByCategory[r.category] = (deltaByCategory[r.category] ?? 0) + r.tokens; // negative
    }
  }

  // Build per-segment delta (best-effort: match by category)
  const segDeltaUsed: Record<string, number> = {};
  function getSegDelta(seg: PayloadSegment): number | null {
    const catTotal = deltaByCategory[seg.category];
    if (catTotal == null) return null;
    // Distribute delta proportionally among segments of same category
    const catSegs = segments.filter(s => s.category === seg.category);
    const catTokens = catSegs.reduce((s, g) => s + g.tokens, 0) || 1;
    const proportional = Math.round(catTotal * seg.tokens / catTokens);
    const alreadyUsed = segDeltaUsed[seg.category] ?? 0;
    segDeltaUsed[seg.category] = alreadyUsed + proportional;
    return proportional;
  }

  // Reset and compute all deltas in order
  const segDeltas = segments.map(seg => getSegDelta(seg));

  return (
    <div>
      <PayloadCompositionBar segments={segments} selectedId={selectedSegId} onSelect={onSelectSeg} />

      {/* Segment table */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 40px 70px 60px", padding: "5px 12px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
          {["Segment", "Tokens", "%", "Δ vs prev", "Conf"].map(h => (
            <span key={h} style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600 }}>{h}</span>
          ))}
        </div>
        {segments.map((seg, i) => {
          const pct = Math.round(seg.tokens / total * 100);
          const delta = segDeltas[i];
          const isSelected = seg.id === selectedSegId;
          return (
            <div key={seg.id} onClick={() => onSelectSeg(seg)} style={{
              display: "grid", gridTemplateColumns: "1fr 60px 40px 70px 60px",
              padding: "9px 12px", alignItems: "center", cursor: "pointer",
              borderBottom: i < segments.length - 1 ? "1px solid #f3f4f6" : "none",
              background: isSelected ? "#eff6ff" : "transparent",
              borderLeft: isSelected ? "3px solid #6366f1" : "3px solid transparent",
            }}
            onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#f9fafb"; }}
            onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}>
              <div style={{ overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 7, height: 7, borderRadius: 1, background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb", flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seg.label}</span>
                </div>
                {seg.sourceEvent && (
                  <div style={{ fontSize: 9, color: "#9ca3af", marginLeft: 13, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {seg.sourceEvent.label}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11, color: "#374151" }}>{fmtK(seg.tokens)}</span>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>{pct}%</span>
              <span style={{ fontSize: 10, fontWeight: 600, color: delta == null ? "#d1d5db" : delta > 0 ? "#d97706" : delta < 0 ? "#16a34a" : "#9ca3af" }}>
                {delta == null ? "—" : delta === 0 ? "·" : `${delta > 0 ? "+" : ""}${fmtK(delta)}`}
              </span>
              <span style={{ fontSize: 10, fontWeight: 700, color: CONF_COLOR[seg.confidence] }}>{CONF_ICON[seg.confidence]} {seg.confidence}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Diff op styling ─────────────────────────────────────────────────────────

const DIFF_OP_STYLE: Record<string, { color: string; bg: string; border: string; icon: string; label: string }> = {
  added:     { color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", icon: "+", label: "added" },
  removed:   { color: "#dc2626", bg: "#fef2f2", border: "#fecaca", icon: "−", label: "removed" },
  changed:   { color: "#d97706", bg: "#fffbeb", border: "#fde68a", icon: "~", label: "changed" },
  unchanged: { color: "#d1d5db", bg: "#f9fafb", border: "#e5e7eb", icon: "·", label: "unchanged" },
};

// ─── Derive cause of a diff segment from interval events ─────────────────────

interface SegmentCause {
  cause: string;
  detail: string | null;
  confidence: "high" | "medium" | "low" | "unknown";
  isMock: boolean;
  eventKind?: string;
}

function deriveSegmentCause(
  seg: import("./drilldown-types").SegmentDiff,
  intervalEvents: import("./drilldown-types").IntervalEvent[],
  call: MockLlmCall,
): SegmentCause {
  if (seg.op === "unchanged") {
    return { cause: "No change", detail: null, confidence: "high", isMock: false };
  }

  const hasHumanInput  = intervalEvents.some(e => e.kind === "user:human");
  const hasToolResult  = intervalEvents.some(e => e.kind === "user:tool_result");
  const hasCommand     = intervalEvents.some(e => e.kind === "user:command");
  const hasAttachment  = intervalEvents.some(e =>
    e.kind === "attachment:skill_listing" || e.kind === "attachment:task_reminder" ||
    e.kind === "attachment:queued_command" || e.kind === "attachment:edited_text_file" || e.kind === "attachment:file");
  const hasSnapshot    = intervalEvents.some(e => e.kind === "file-history-snapshot" || e.kind === "last-prompt");
  const hasAway        = intervalEvents.some(e => e.kind === "system:away_summary" || e.kind === "system:stop_hook_summary");

  const firstHuman     = intervalEvents.find(e => e.kind === "user:human");
  const firstTool      = intervalEvents.find(e => e.kind === "user:tool_result");
  const firstAttach    = intervalEvents.find(e =>
    e.kind === "attachment:skill_listing" || e.kind === "attachment:task_reminder" ||
    e.kind === "attachment:queued_command" || e.kind === "attachment:edited_text_file" || e.kind === "attachment:file");

  // messages section — added segments
  if (seg.section === "messages" && seg.op === "added") {
    const role = seg.role ?? "";
    if (role === "user" && (seg.category?.includes("tool_result") || seg.label?.toLowerCase().includes("tool_result"))) {
      if (hasToolResult) {
        return {
          cause: "Tool result injected",
          detail: firstTool?.contentPreview?.slice(0, 120) ?? null,
          confidence: "high", isMock: false, eventKind: "user:tool_result",
        };
      }
      return { cause: "□ Tool result (unmatched event)", detail: null, confidence: "low", isMock: true };
    }
    if (role === "user" && hasHumanInput) {
      return {
        cause: "User input",
        detail: firstHuman?.contentPreview?.slice(0, 120) ?? null,
        confidence: "high", isMock: false, eventKind: "user:human",
      };
    }
    if (role === "assistant") {
      return { cause: "Assistant response carried forward", detail: null, confidence: "high", isMock: false };
    }
    if (hasCommand) {
      return { cause: "Command injection", detail: null, confidence: "medium", isMock: false, eventKind: "user:command" };
    }
    return { cause: "□ New message (cause inferred)", detail: null, confidence: "low", isMock: true };
  }

  // messages section — removed segments (compaction or trimming)
  if (seg.section === "messages" && seg.op === "removed") {
    if (call.isCompaction) {
      return { cause: "□ Compaction (context trimmed)", detail: null, confidence: "low", isMock: true };
    }
    return { cause: "□ Message removed (unknown cause)", detail: null, confidence: "unknown", isMock: true };
  }

  // messages section — changed segments
  if (seg.section === "messages" && seg.op === "changed") {
    if (call.isCompaction) {
      return { cause: "□ Compaction (message modified)", detail: null, confidence: "low", isMock: true };
    }
    return { cause: "□ Message modified", detail: null, confidence: "unknown", isMock: true };
  }

  // system section
  if (seg.section === "system") {
    if (seg.op === "added" || seg.op === "changed") {
      if (hasAttachment) {
        return {
          cause: "Attachment injected",
          detail: firstAttach?.contentPreview?.slice(0, 120) ?? null,
          confidence: "medium", isMock: false, eventKind: firstAttach?.kind,
        };
      }
      if (hasSnapshot) {
        return { cause: "Context snapshot injected", detail: null, confidence: "medium", isMock: false, eventKind: "file-history-snapshot" };
      }
      if (hasAway) {
        return { cause: "□ Away/stop hook summary", detail: null, confidence: "low", isMock: true };
      }
      return { cause: "□ System prompt changed (cause inferred)", detail: null, confidence: "unknown", isMock: true };
    }
    if (seg.op === "removed") {
      return { cause: "□ System block removed", detail: null, confidence: "unknown", isMock: true };
    }
  }

  // tools section
  if (seg.section === "tools") {
    if (seg.op === "added")   return { cause: "□ New tool registered", detail: null, confidence: "unknown", isMock: true };
    if (seg.op === "removed") return { cause: "□ Tool unregistered", detail: null, confidence: "unknown", isMock: true };
    if (seg.op === "changed") return { cause: "□ Tool schema updated", detail: null, confidence: "unknown", isMock: true };
  }

  // fallback
  return { cause: "□ Unknown", detail: null, confidence: "unknown", isMock: true };
}

// ─── SegmentDiffTree ──────────────────────────────────────────────────────────
// Two levels:
//   Default  — 3 section rows (System / Tools / Messages) + diff summary badge
//   Section  — all segments in that section via DiffSegmentRow (expandable text)

function SegmentDiffTree({
  diff, call,
}: {
  diff: import("./drilldown-types").SegmentDiff[];
  call: MockLlmCall;
}) {
  const SECTION_ORDER = ["system", "tools", "messages", "metadata", "unknown"] as const;
  const [activeSection, setActiveSection] = useState<string | null>(null);

  const bySection: Record<string, import("./drilldown-types").SegmentDiff[]> = {};
  for (const d of diff) {
    if (!bySection[d.section]) bySection[d.section] = [];
    bySection[d.section].push(d);
  }

  const totalChars = diff.reduce((s, d) => s + d.charCount, 0) || 1;

  function sectionNetDelta(sec: string): number {
    return (bySection[sec] ?? []).reduce((s, d) => s + d.charDelta, 0);
  }
  function sectionHasChanges(sec: string): boolean {
    return (bySection[sec] ?? []).some(d => d.op !== "unchanged");
  }
  function sectionAddedCount(sec: string): number {
    return (bySection[sec] ?? []).filter(d => d.op === "added").length;
  }
  function sectionRemovedCount(sec: string): number {
    return (bySection[sec] ?? []).filter(d => d.op === "removed").length;
  }
  function sectionChangedCount(sec: string): number {
    return (bySection[sec] ?? []).filter(d => d.op === "changed").length;
  }

  const sections = SECTION_ORDER.filter(sec => bySection[sec]?.length);

  return (
    <div>
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div style={{ height: 36, display: "flex", borderRadius: 8, overflow: "hidden", gap: 2, marginBottom: 10 }}>
        {sections.map(sec => {
          const secChars = bySection[sec].reduce((s, d) => s + d.charCount, 0);
          const secPct   = Math.round(secChars / totalChars * 100);
          const color    = SECTION_COLOR[sec];
          const isActive = activeSection === sec;
          const hasChg   = sectionHasChanges(sec);
          const netDelta = sectionNetDelta(sec);
          return (
            <div
              key={sec}
              onClick={() => setActiveSection(isActive ? null : sec)}
              title={`${SECTION_LABEL[sec]}: ~${fmtK(charsToTokens(secChars))} (${secPct}%)${hasChg ? ` · Δ${netDelta > 0 ? "+" : ""}${fmtK(charsToTokens(Math.abs(netDelta)))}` : " · unchanged"}`}
              style={{
                flex: secChars, minWidth: 40, cursor: "pointer",
                background: isActive ? color : hasChg ? color + "90" : color + "40",
                display: "flex", flexDirection: "column", justifyContent: "center",
                padding: "0 10px", overflow: "hidden",
                outline: isActive ? `2px solid ${color}` : "none",
                outlineOffset: -2, transition: "background 0.12s", borderRadius: 0,
              }}
              onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = color + "c0"; }}
              onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = hasChg ? color + "90" : color + "40"; }}
            >
              {secPct >= 8 && (
                <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {SECTION_LABEL[sec]}
                </span>
              )}
              {secPct >= 5 && hasChg && (
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.9)", fontWeight: 600 }}>
                  {netDelta >= 0 ? "+" : "−"}{fmtK(charsToTokens(Math.abs(netDelta)))}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Default view: section summary rows ─────────────────────── */}
      {!activeSection && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
          {sections.map((sec, idx) => {
            const secSegs  = bySection[sec];
            const secChars = secSegs.reduce((s, d) => s + d.charCount, 0);
            const secPct   = Math.round(secChars / totalChars * 100);
            const secColor = SECTION_COLOR[sec];
            const hasChg   = sectionHasChanges(sec);
            const netDelta = sectionNetDelta(sec);
            const addedN   = sectionAddedCount(sec);
            const removedN = sectionRemovedCount(sec);
            const changedN = sectionChangedCount(sec);
            const isLast   = idx === sections.length - 1;

            return (
              <button
                key={sec}
                onClick={() => setActiveSection(sec)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 14px",
                  background: hasChg ? secColor + "08" : "#fff",
                  border: "none",
                  borderBottom: isLast ? "none" : "1px solid #f3f4f6",
                  cursor: "pointer", textAlign: "left",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = hasChg ? secColor + "14" : "#f9fafb"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = hasChg ? secColor + "08" : "#fff"; }}
              >
                {/* Color dot */}
                <div style={{ width: 10, height: 10, borderRadius: 2, background: secColor, opacity: hasChg ? 1 : 0.35, flexShrink: 0 }} />
                {/* Section name */}
                <span style={{ fontSize: 12, fontWeight: 700, color: hasChg ? "#111827" : "#9ca3af", minWidth: 72 }}>
                  {SECTION_LABEL[sec]}
                </span>
                {/* Size */}
                <span style={{ fontSize: 10, color: "#9ca3af" }}>~{fmtK(charsToTokens(secChars))}</span>
                <span style={{ fontSize: 10, color: "#d1d5db" }}>{secPct}%</span>
                {/* Diff badges */}
                <span style={{ display: "flex", gap: 5, marginLeft: 4 }}>
                  {!hasChg && <span style={{ fontSize: 10, color: "#d1d5db" }}>unchanged</span>}
                  {addedN > 0 && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: "#16a34a", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 3, padding: "1px 5px" }}>
                      +{addedN} added
                    </span>
                  )}
                  {removedN > 0 && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 3, padding: "1px 5px" }}>
                      −{removedN} removed
                    </span>
                  )}
                  {changedN > 0 && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: "#d97706", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 3, padding: "1px 5px" }}>
                      ~{changedN} changed
                    </span>
                  )}
                  {hasChg && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: netDelta > 0 ? "#d97706" : "#16a34a", marginLeft: 2 }}>
                      {netDelta > 0 ? "+" : "−"}{fmtK(charsToTokens(Math.abs(netDelta)))}
                    </span>
                  )}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: "#c4c9d4" }}>▶</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Section detail view ─────────────────────────────────────── */}
      {activeSection && (() => {
        const secSegs  = bySection[activeSection] ?? [];
        const secColor = SECTION_COLOR[activeSection];
        const secChars = secSegs.reduce((s, d) => s + d.charCount, 0);
        const netDelta = sectionNetDelta(activeSection);
        const hasChg   = sectionHasChanges(activeSection);

        return (
          <div>
            {/* Section header / breadcrumb */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <button
                onClick={() => setActiveSection(null)}
                style={{ background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 5, cursor: "pointer", fontSize: 11, color: "#374151", padding: "3px 8px", lineHeight: 1, display: "flex", alignItems: "center", gap: 4 }}
              >
                ← back
              </button>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: secColor, flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>{SECTION_LABEL[activeSection]}</span>
              <span style={{ fontSize: 10, color: "#9ca3af" }}>~{fmtK(charsToTokens(secChars))}</span>
              {hasChg && netDelta !== 0 && (
                <span style={{ fontSize: 10, fontWeight: 700, color: netDelta > 0 ? "#d97706" : "#16a34a" }}>
                  {netDelta > 0 ? "+" : "−"}{fmtK(charsToTokens(Math.abs(netDelta)))}
                </span>
              )}
            </div>

            {/* All segments via DiffSegmentRow */}
            {secSegs.map((seg, i) => {
              if (seg.op === "unchanged") {
                // Unchanged: compact single-line, no expand
                return (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "5px 10px",
                    marginBottom: 2, borderRadius: 5, background: "#f9fafb",
                    border: "1px solid #f3f4f6", opacity: 0.5,
                  }}>
                    <span style={{ fontSize: 10, color: "#9ca3af", width: 12, textAlign: "center", flexShrink: 0 }}>—</span>
                    <span style={{ fontSize: 11, color: "#6b7280", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {seg.label}{seg.role ? <span style={{ color: "#9ca3af" }}> · {seg.role}</span> : null}
                    </span>
                    <span style={{ fontSize: 10, color: "#9ca3af" }}>~{fmtK(charsToTokens(seg.charCount))}</span>
                  </div>
                );
              }
              const opColor = DIFF_OP_COLOR[seg.op];
              return (
                <div key={i} style={{ marginBottom: 4 }}>
                  <DiffSegmentRow d={seg} style={opColor} />
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

// ─── Diff vs Previous Tab ────────────────────────────────────────────────────

function DiffVsPreviousTab({
  diff, call, callDetailLoading, prevCallId,
}: {
  diff: import("./drilldown-types").SegmentDiff[] | null;
  call: MockLlmCall;
  callDetailLoading: boolean;
  prevCallId: number | null;
}) {
  const netDeltaTokens = call.significantDelta;
  const addedChars     = (diff ?? []).filter(d => d.op === "added").reduce((s, d) => s + d.charCount, 0);
  const removedChars   = (diff ?? []).filter(d => d.op === "removed").reduce((s, d) => s + Math.abs(d.charDelta), 0);
  const changedN       = (diff ?? []).filter(d => d.op === "changed").length;

  return (
    <div>
      {/* Summary strip */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginBottom: 14, padding: "0 2px", flexWrap: "wrap" }}>
        {prevCallId != null && (
          <span style={{ fontSize: 10, color: "#9ca3af" }}>vs Call #{prevCallId}</span>
        )}
        {diff ? (
          <>
            {[
              { label: "Net Δ",   value: `${netDeltaTokens >= 0 ? "+" : ""}${fmtK(netDeltaTokens)}`, color: netDeltaTokens > 0 ? "#d97706" : netDeltaTokens < 0 ? "#16a34a" : "#9ca3af" },
              { label: "Added",   value: addedChars > 0 ? `+${fmtK(charsToTokens(addedChars))}` : "—", color: "#16a34a" },
              { label: "Removed", value: removedChars > 0 ? `−${fmtK(charsToTokens(removedChars))}` : "—", color: "#dc2626" },
              { label: "Changed", value: changedN > 0 ? `${changedN} segs` : "—", color: "#d97706" },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                <span style={{ fontSize: 14, fontWeight: 700, color, lineHeight: 1 }}>{value}</span>
                <span style={{ fontSize: 9, color: "#9ca3af", marginTop: 2 }}>{label}</span>
              </div>
            ))}
          </>
        ) : (
          <span style={{ fontSize: 10, color: "#9ca3af" }}>
            {callDetailLoading ? "Computing diff…" : "No proxy data · diff not available"}
          </span>
        )}
      </div>

      {/* Tree */}
      {diff ? (
        <SegmentDiffTree diff={diff} call={call} />
      ) : (
        !callDetailLoading && (
          <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0", textAlign: "center" }}>
            No proxy data — enable proxy dump to see segment diff
          </div>
        )
      )}
      {callDetailLoading && (
        <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0", textAlign: "center" }}>Loading…</div>
      )}
    </div>
  );
}

// ─── Request Tab ─────────────────────────────────────────────────────────────

function RequestTab({
  call, callDetail, callDetailLoading,
}: {
  call: MockLlmCall;
  callDetail: CallDetail | null;
  callDetailLoading: boolean;
}) {
  const hasProxy = !!callDetail?.proxyRequestId;
  const observedSource = hasProxy ? "Proxy + JSONL" : "JSONL only";
  const reconstruction = hasProxy ? "exact" : "estimated";

  const messageCount = callDetail?.rawRequestJson
    ? (callDetail.rawRequestJson.messages as unknown[] | undefined)?.length ?? null
    : null;
  const toolCount = callDetail?.rawRequestJson
    ? (callDetail.rawRequestJson.tools as unknown[] | undefined)?.length ?? null
    : null;
  const systemBlocks = callDetail?.rawRequestJson
    ? (Array.isArray(callDetail.rawRequestJson.system)
        ? (callDetail.rawRequestJson.system as unknown[]).length
        : callDetail.rawRequestJson.system != null ? 1 : null)
    : null;

  return (
    <div>
      {/* Reconstruction status */}
      <div style={{
        background: hasProxy ? "#f0fdf4" : "#fffbeb",
        border: `1px solid ${hasProxy ? "#bbf7d0" : "#fde68a"}`,
        borderRadius: 8, padding: "10px 14px", marginBottom: 14,
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: hasProxy ? "#16a34a" : "#d97706" }}>
            {hasProxy ? "✓" : "⚠"} {hasProxy ? "Proxy exact" : "JSONL observed · reconstruction estimated"}
          </span>
        </div>
        <div style={{ fontSize: 10, color: "#6b7280" }}>
          {!hasProxy && "Exact request payload unavailable. The view below is estimated from JSONL events. Link proxy to upgrade to exact reconstruction."}
          {hasProxy && "Full request payload available from proxy."}
        </div>
      </div>

      {/* Reconstructed summary */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
        <div style={{ padding: "6px 12px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb", fontSize: 10, fontWeight: 700, color: "#6b7280", letterSpacing: "0.05em" }}>
          RECONSTRUCTED REQUEST SUMMARY
        </div>
        {[
          { label: "Observed source", value: observedSource },
          { label: "Reconstruction", value: reconstruction },
          { label: "Model", value: call.model || "—" },
          { label: "System blocks", value: callDetailLoading ? "…" : systemBlocks != null ? String(systemBlocks) : "—" },
          { label: "Messages", value: callDetailLoading ? "…" : messageCount != null ? String(messageCount) : "—" },
          { label: "Tools", value: callDetailLoading ? "…" : toolCount != null ? String(toolCount) : (call.toolNames.length > 0 ? String(call.toolNames.length) : "—") },
          { label: "Input context", value: fmtK(call.contextSize) },
          { label: "Cache control", value: call.cacheWrite > 0 ? "observed" : "—" },
        ].map(({ label, value }) => (
          <div key={label} style={{ display: "flex", padding: "7px 12px", borderBottom: "1px solid #f3f4f6" }}>
            <span style={{ width: 120, flexShrink: 0, fontSize: 11, color: "#9ca3af" }}>{label}</span>
            <span style={{ fontSize: 11, color: "#374151" }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Tool names if available */}
      {call.toolNames.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: "#6b7280", fontWeight: 600, marginBottom: 6 }}>Tool names observed</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {call.toolNames.map(name => (
              <span key={name} style={{ fontSize: 10, background: "#f3f4f6", color: "#374151", borderRadius: 4, padding: "2px 8px", fontFamily: "monospace" }}>{name}</span>
            ))}
          </div>
        </div>
      )}

      {/* Raw JSONL metadata as fallback */}
      <div style={{ fontSize: 10, color: "#6b7280", fontWeight: 600, marginBottom: 6 }}>JSONL Metadata</div>
      <pre style={{ fontSize: 10, fontFamily: "monospace", color: "#374151", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.5, marginBottom: 14 }}>
        {JSON.stringify({
          call_id: call.id, index_in_turn: call.indexInTurn,
          model: call.model, timestamp: call.timestamp,
          usage: { context_size: call.contextSize, fresh_in: call.contextSize - call.cacheRead - call.cacheWrite, cache_read: call.cacheRead, cache_write: call.cacheWrite, output_tokens: call.outputTokens },
          stop_reason: call.stopReason,
          ...(call.proxy ? { proxy_request_id: call.proxy.requestId, duration_ms: call.proxy.durationMs } : {}),
        }, null, 2)}
      </pre>
    </div>
  );
}

// ─── Proxy Diff View ──────────────────────────────────────────────────────────

const DIFF_OP_COLOR: Record<string, { bg: string; border: string; label: string; labelColor: string }> = {
  added:     { bg: "#f0fdf4", border: "#bbf7d0", label: "+", labelColor: "#16a34a" },
  removed:   { bg: "#fef2f2", border: "#fecaca", label: "−", labelColor: "#dc2626" },
  changed:   { bg: "#fffbeb", border: "#fde68a", label: "~", labelColor: "#d97706" },
  unchanged: { bg: "#f9fafb", border: "#e5e7eb", label: "=", labelColor: "#9ca3af" },
};

// ─── Line diff (git diff -U3 style) ──────────────────────────────────────────

type LineDiffKind = "context" | "added" | "removed";
interface LineDiffEntry { kind: LineDiffKind; text: string; }

function computeLineDiff(before: string, after: string, context = 3): LineDiffEntry[] {
  const aLines = before.split("\n");
  const bLines = after.split("\n");

  // LCS-based line diff (Myers simplified: O(n²) but fine for text < 5k lines)
  const m = aLines.length, n = bLines.length;
  // dp[i][j] = LCS length of aLines[0..i) and bLines[0..j)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = aLines[i-1] === bLines[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);

  // Traceback to get edit operations
  const ops: Array<{ op: "eq" | "del" | "ins"; text: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i-1] === bLines[j-1]) {
      ops.push({ op: "eq", text: aLines[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      ops.push({ op: "ins", text: bLines[j-1] }); j--;
    } else {
      ops.push({ op: "del", text: aLines[i-1] }); i--;
    }
  }
  ops.reverse();

  // Find changed line indices
  const changed = new Set<number>();
  let idx = 0;
  for (const op of ops) {
    if (op.op !== "eq") changed.add(idx);
    idx++;
  }

  // Select context lines around changes
  const visible = new Set<number>();
  for (const ci of changed) {
    for (let k = Math.max(0, ci - context); k <= Math.min(ops.length - 1, ci + context); k++)
      visible.add(k);
  }

  const result: LineDiffEntry[] = [];
  let prev = -1;
  for (let k = 0; k < ops.length; k++) {
    if (!visible.has(k)) continue;
    if (prev !== -1 && k > prev + 1) result.push({ kind: "context", text: "⋯" });
    const op = ops[k];
    result.push({ kind: op.op === "ins" ? "added" : op.op === "del" ? "removed" : "context", text: op.text });
    prev = k;
  }
  return result;
}

const SECTION_ORDER = ["system", "tools", "messages", "metadata", "unknown"];

function ProxyDiffView({ diff }: { diff: SegmentDiff[] }) {
  // Group by section
  const bySec: Record<string, SegmentDiff[]> = {};
  for (const d of diff) {
    if (!bySec[d.section]) bySec[d.section] = [];
    bySec[d.section].push(d);
  }

  // Summary counts
  const added   = diff.filter(d => d.op === "added").length;
  const removed = diff.filter(d => d.op === "removed").length;
  const changed = diff.filter(d => d.op === "changed").length;
  const totalDelta = diff.reduce((s, d) => s + d.charDelta, 0);

  return (
    <div>
      {/* Summary bar */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        {added > 0   && <span style={{ fontSize: 11, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 4, padding: "2px 7px", color: "#16a34a", fontWeight: 600 }}>+{added} added</span>}
        {removed > 0 && <span style={{ fontSize: 11, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 4, padding: "2px 7px", color: "#dc2626", fontWeight: 600 }}>−{removed} removed</span>}
        {changed > 0 && <span style={{ fontSize: 11, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 4, padding: "2px 7px", color: "#d97706", fontWeight: 600 }}>~{changed} changed</span>}
        <span style={{ fontSize: 11, color: "#6b7280", marginLeft: "auto" }}>
          Δ {totalDelta > 0 ? "+" : ""}{totalDelta.toLocaleString()} chars
        </span>
      </div>

      {SECTION_ORDER.filter(s => bySec[s]).map(section => (
        <div key={section} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
            {section}
          </div>
          {bySec[section].map((d, i) => {
            if (d.op === "unchanged") return null; // skip unchanged to reduce noise
            const style = DIFF_OP_COLOR[d.op];
            return (
              <DiffSegmentRow key={i} d={d} style={style} />
            );
          })}
          {bySec[section].every(d => d.op === "unchanged") && (
            <div style={{ fontSize: 10, color: "#9ca3af", fontStyle: "italic" }}>no changes</div>
          )}
        </div>
      ))}
    </div>
  );
}

function DiffSegmentRow({ d, style }: { d: SegmentDiff; style: { bg: string; border: string; label: string; labelColor: string } }) {
  const [expanded, setExpanded] = useState(false);
  const hasText = d.rawText.length > 0;

  // For changed segments, compute line diff lazily
  const lineDiff = expanded && d.op === "changed" && d.prevRawText !== undefined
    ? computeLineDiff(d.prevRawText, d.rawText)
    : null;

  // Skip trivial changes (abs(charDelta) <= 5 and op=changed) — show as collapsed only
  const isTrivial = d.op === "changed" && Math.abs(d.charDelta) <= 5;

  return (
    <div style={{ background: style.bg, border: `1px solid ${style.border}`, borderRadius: 6, marginBottom: 6, overflow: "hidden" }}>
      {/* Header row */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: hasText ? "pointer" : "default" }}
        onClick={() => hasText && setExpanded(e => !e)}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: style.labelColor, width: 14, textAlign: "center", flexShrink: 0 }}>{style.label}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {d.label}
          {d.role && <span style={{ marginLeft: 6, fontSize: 10, color: "#9ca3af", fontWeight: 400 }}>{d.role}</span>}
          {isTrivial && <span style={{ marginLeft: 6, fontSize: 9, color: "#9ca3af", fontWeight: 400 }}>trivial</span>}
        </span>
        <span style={{ fontSize: 10, color: style.labelColor, fontWeight: 600, flexShrink: 0 }}>
          {d.charDelta > 0 ? "+" : ""}{d.charDelta !== 0 ? d.charDelta.toLocaleString() + "c" : d.charCount.toLocaleString() + "c"}
        </span>
        {hasText && (
          <span style={{ fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
        )}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${style.border}` }}>
          {/* changed: git-diff style line view */}
          {lineDiff ? (
            <div style={{ fontFamily: "monospace", fontSize: 10, lineHeight: 1.5 }}>
              {lineDiff.map((line, i) => {
                const bg = line.kind === "added" ? "#dcfce7" : line.kind === "removed" ? "#fee2e2" : "transparent";
                const color = line.kind === "added" ? "#15803d" : line.kind === "removed" ? "#b91c1c" : "#6b7280";
                const prefix = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
                if (line.text === "⋯") {
                  return (
                    <div key={i} style={{ padding: "1px 8px", color: "#9ca3af", fontSize: 9, background: "#f9fafb" }}>
                      ⋯
                    </div>
                  );
                }
                return (
                  <div key={i} style={{ display: "flex", background: bg, padding: "0 8px" }}>
                    <span style={{ color, fontWeight: 700, width: 12, flexShrink: 0, userSelect: "none" }}>{prefix}</span>
                    <span style={{ color, whiteSpace: "pre-wrap", wordBreak: "break-all", flex: 1 }}>{line.text}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            /* added/removed: show full text */
            <pre style={{ fontSize: 10, fontFamily: "monospace", color: "#374151", padding: "8px 10px", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0, maxHeight: 400, overflowY: "auto" }}>
              {d.rawText.slice(0, 6000)}{d.rawText.length > 6000 ? "\n… (truncated)" : ""}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Attribution section: Request / Response 双向归因 ───────────────────────
// 子 tab 切换 Request / Response。
//   - Request: AttributionTreePanel（origin tree）
//   - Response: ResponseTreePanel（response wire body）

type AttributionSide = "request" | "response";

function AttributionSection({
  call, sessionId, onLinkCall,
}: {
  call: MockLlmCall;
  sessionId: string;
  onLinkCall?: (callId: number) => void;
}) {
  const { t } = useTranslation();
  const [side, setSide] = useState<AttributionSide>("request");

  return (
    <div>
      {/* Request / Response 子 tab */}
      <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
        {([
          { id: "request" as const,  label: t("attribution.request") },
          { id: "response" as const, label: t("attribution.response") },
        ]).map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setSide(id)}
            style={{
              fontSize: 11, padding: "5px 14px",
              background: side === id ? "#eef2ff" : "transparent",
              border: `1px solid ${side === id ? "#c7d2fe" : "#e5e7eb"}`,
              borderRadius: 5, cursor: "pointer",
              color: side === id ? "#4338ca" : "#6b7280",
              fontWeight: side === id ? 700 : 500,
            }}
          >{label}</button>
        ))}
      </div>

      {side === "request" ? (
        <AttributionTreePanel sessionId={sessionId} callId={call.id} />
      ) : (
        <ResponseTreePanel
          sessionId={sessionId}
          callId={call.id}
          onLinkCall={onLinkCall}
        />
      )}
    </div>
  );
}

function LlmCallDetailPanel({
  call, sessionId, mode = "main", onShowTurnContext, onLinkCall,
}: {
  call: MockLlmCall;
  onSelectEntry: (e: MockDiffEntry) => void;
  sessionId: string;
  mode?: "main" | "panel";
  onShowTurnContext?: () => void;
  /** 双向 link 回调：点击 Response 中的 forwarding link 时触发，传入下游 call id */
  onLinkCall?: (callId: number) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CallTab>("attribution");
  const [callDetail, setCallDetail] = useState<CallDetail | null>(null);
  const [callDetailLoading, setCallDetailLoading] = useState(true);

  // Load eagerly on mount — needed for Attribution (real segments) from first render
  useEffect(() => {
    if (callDetail?.callId === call.id) return;
    setCallDetailLoading(true);
    apiV2.callDetail(sessionId, call.id)
      .then(d => setCallDetail(d))
      .catch(() => setCallDetail(null))
      .finally(() => setCallDetailLoading(false));
  }, [call.id, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasProxy = !!callDetail?.proxyRequestId;
  const freshIn  = call.contextSize - call.cacheRead - call.cacheWrite;
  const nearLimit = false;
  const prevCallId = call.id > 1 ? call.id - 1 : null;

  // Real segments from proxy — used for Attribution tab
  const realSegments = callDetail?.segments ?? null;

  // incomingDiff → AttributedDiffRange (for Diff tab)
  const attrRanges: AttributedDiffRange[] = call.incomingDiff.map(d => ({
    id: d.id,
    changeType: d.changeType as ChangeType,
    textPreview: d.label,
    tokens: d.delta,
    category: d.category,
    cause: d.cause,
    confidence: (d.confidence === "High" ? "high" : d.confidence === "Medium" ? "medium" : d.confidence === "Low" ? "low" : "unknown") as ConfidenceLevel,
    evidenceRefs: d.evidence ? [{ kind: "jsonl" as const, label: d.evidence, detail: d.evidence }] : [],
  }));

  const response = buildMockCallResponse(call);

  const TAB_DEFS: Array<{ id: CallTab; label: string }> = [
    { id: "attribution",    label: t("callTab.attribution") },
    { id: "diff",           label: t("callTab.diff") },
    { id: "raw",            label: t("callTab.raw") },
  ];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: mode === "panel" ? "12px 14px" : "16px 22px", minWidth: 0 }}>

      {/* ── Header ──────────────────────────────── */}
      <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid #f3f4f6" }}>

        {/* Title row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "#111827" }}>C{call.indexInTurn}</span>
          <span style={{ fontSize: 10, color: "#9ca3af" }}>#{call.id}</span>
          {call.isCompaction && <RiskBadge type="compaction" />}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {onShowTurnContext && (
              <button onClick={onShowTurnContext} style={{ border: "1px solid #dbeafe", background: "#eff6ff", color: "#2563eb", borderRadius: 5, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                Show in turn
              </button>
            )}
            {call.model && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 7, height: 7, borderRadius: 2, background: modelColor(call.model), flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: "#6b7280" }}>{shortModelName(call.model)}</span>
              </div>
            )}
            <span style={{ fontSize: 10, color: "#9ca3af" }}>{call.timestamp ? fmtDateShort(call.timestamp) : "—"}</span>
            {call.stopReason && (
              <span style={{ fontSize: 9, color: "#6b7280", background: "#f3f4f6", borderRadius: 3, padding: "1px 6px" }}>stop: {call.stopReason}</span>
            )}
            {call.proxy?.durationMs != null && (
              <span style={{ fontSize: 9, color: "#6b7280" }}>{call.proxy.durationMs >= 1000 ? `${(call.proxy.durationMs / 1000).toFixed(1)}s` : `${call.proxy.durationMs}ms`}</span>
            )}
            {!callDetailLoading && !hasProxy && (
              <span style={{ fontSize: 9, color: "#d97706", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 3, padding: "1px 6px" }}>
                no proxy
              </span>
            )}
          </div>
        </div>

        {/* Activity row — flat, same style as session overview */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 24, paddingBottom: 10, borderBottom: "1px solid #f3f4f6", flexWrap: "wrap" }}>
          {[
            { label: "Context",   value: fmtK(call.contextSize),
              color: nearLimit ? "#ea580c" : undefined,
              tooltip: "Total input context" },
            { label: "Δ vs prev", value: `${call.significantDelta >= 0 ? "+" : ""}${fmtK(call.significantDelta)}`,
              color: call.significantDelta > 10000 ? "#dc2626" : call.significantDelta > 2000 ? "#d97706" : call.significantDelta < -2000 ? "#16a34a" : undefined,
              tooltip: "Context size delta vs previous call" },
            { label: "Tool Calls", value: String(call.toolCalls?.length ?? 0), color: undefined, tooltip: "" },
          ].map(({ label, value, color, tooltip }) => (
            <div key={label} title={tooltip}>
              <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: color ?? "#111827", lineHeight: 1 }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Token Ledger — same compact style as session overview */}
        {(() => {
          const M = TOKEN_METRICS;
          const ledger = [
            { id: "fresh_input", value: freshIn },
            { id: "cache_read",  value: call.cacheRead },
            { id: "cache_write", value: call.cacheWrite },
            { id: "output",      value: call.outputTokens },
          ];
          const total = freshIn + call.cacheRead + call.cacheWrite + call.outputTokens;
          const inputTotal = freshIn + call.cacheRead;
          const cacheRatio = inputTotal > 0 ? call.cacheRead / inputTotal * 100 : null;
          return (
            <div style={{ paddingTop: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("dashboard.tokenLedger")}</span>
                {cacheRatio !== null && (
                  <>
                    <div style={{ width: 1, height: 10, background: "#e5e7eb" }} />
                    <span style={{ fontSize: 9, fontWeight: 700, color: M.cache_ratio.color }}>{t("metrics.cacheRatio.label", M.cache_ratio.label)} {fmtPct(cacheRatio)}</span>
                  </>
                )}
              </div>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-end", marginBottom: 5 }}>
                {ledger.map(({ id, value }) => {
                  const m = M[id];
                  return (
                    <div key={id} title={m.description}>
                      <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, marginBottom: 2 }}>{m.label}</div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: value > 0 ? m.color : "#d1d5db", lineHeight: 1 }}>{value > 0 ? fmtK(value) : "—"}</div>
                    </div>
                  );
                })}
              </div>
              {total > 0 && (
                <div style={{ height: 3, borderRadius: 2, overflow: "hidden", display: "flex", background: "#f3f4f6" }}>
                  {ledger.filter(r => r.value > 0).map(({ id, value }) => (
                    <div key={id} style={{ flex: value, background: M[id].color }} />
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* ── Tabs ──────────────────────────────────── */}
      <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb", marginBottom: 14, gap: 0 }}>
        {TAB_DEFS.map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: "6px 12px", fontSize: 11, fontWeight: tab === id ? 700 : 400,
            color: tab === id ? "#6366f1" : "#6b7280",
            background: "none", border: "none",
            borderBottom: tab === id ? "2px solid #6366f1" : "2px solid transparent",
            cursor: "pointer", marginBottom: -1, whiteSpace: "nowrap",
          }}>{label}</button>
        ))}
      </div>

      {/* ══ Attribution (Request / Response) ═════════ */}
      {tab === "attribution" && (
        <AttributionSection
          call={call}
          sessionId={sessionId}
          onLinkCall={onLinkCall}
        />
      )}

      {/* ══ Diff vs Previous ══════════════════════════ */}
      {tab === "diff" && (
        <DiffPanel
          sessionId={sessionId}
          callId={call.id}
          prevCallId={prevCallId}
        />
      )}

      {/* ══ Raw / Evidence ═══════════════════════════ */}
      {tab === "raw" && (
        <div>
          {callDetailLoading && <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0" }}>Loading…</div>}
          {!callDetailLoading && (() => {
            const hp = !!callDetail?.proxyRequestId;
            return (
              <>
                <div style={{ fontSize: 10, background: hp ? "#f0fdf4" : "#fffbeb", border: `1px solid ${hp ? "#bbf7d0" : "#fde68a"}`, borderRadius: 5, padding: "5px 10px", marginBottom: 12, color: "#374151" }}>
                  {hp ? "Proxy — full request body available." : "JSONL only — no request payload."}
                </div>
                <SectionLabel>JSONL Metadata</SectionLabel>
                <pre style={{ fontSize: 10, fontFamily: "monospace", color: "#374151", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.5, marginBottom: 14 }}>
                  {JSON.stringify({ call_id: call.id, index_in_turn: call.indexInTurn, model: call.model, timestamp: call.timestamp, usage: { context_size: call.contextSize, fresh_in: freshIn, cache_read: call.cacheRead, cache_write: call.cacheWrite, output_tokens: call.outputTokens }, stop_reason: call.stopReason, ...(call.proxy ? { proxy_request_id: call.proxy.requestId, duration_ms: call.proxy.durationMs } : {}) }, null, 2)}
                </pre>
                {hp && callDetail?.diff && (
                  <>
                    <SectionLabel>Proxy Segment Diff vs Previous</SectionLabel>
                    <ProxyDiffView diff={callDetail.diff} />
                  </>
                )}
                {hp && callDetail?.rawRequestJson && (
                  <>
                    <SectionLabel>Proxy Request Body</SectionLabel>
                    <pre style={{ fontSize: 10, fontFamily: "monospace", color: "#374151", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.5 }}>
                      {JSON.stringify(callDetail.rawRequestJson, null, 2)}
                    </pre>
                  </>
                )}
              </>
            );
          })()}
        </div>
      )}

    </div>
  );
}



// ─── Sub-Agent Session Panel ──────────────────────────────────────────────────

function SubAgentSessionPanel({
  drilldown,
  loadState,
  parentLabel,
  onReturnToParent,
}: {
  drilldown: SessionDrilldown | null;
  loadState: "loading" | "ok" | "error";
  parentLabel?: string;          // e.g. "Turn 3"
  onReturnToParent?: () => void; // closes sub-turn, returns to parent turn detail
}) {
  const { t } = useTranslation();
  // Default-select the sub agent's first turn — a sub agent is conceptually one
  // turn of work, so the Turn detail view (not the Session overview) is the
  // right landing surface. Multi-turn agents still get a mini nav to switch.
  const firstTurn = drilldown?.turns[0] ?? null;
  const [innerTurn, setInnerTurn] = useState<UserTurn | null>(firstTurn);
  const [innerCall, setInnerCall] = useState<LlmCall | null>(null);

  // Re-default when the drilldown payload changes (clicking a different sub agent).
  useEffect(() => {
    setInnerTurn(drilldown?.turns[0] ?? null);
    setInnerCall(null);
  }, [drilldown?.sessionId]);

  if (loadState === "loading") {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
        Loading sub-agent session…
      </div>
    );
  }
  if (loadState === "error" || !drilldown) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#dc2626", fontSize: 13 }}>
        Failed to load sub-agent session.
      </div>
    );
  }

  const turns = drilldown.turns;
  const multiTurn = turns.length > 1;

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", flexDirection: "column" }}>
      {/* Back-to-parent bar — closes the loop so the user always knows the way home */}
      {onReturnToParent && parentLabel && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 16px", background: "#faf5ff",
          borderBottom: "1px dashed #c4b5fd", flexShrink: 0,
        }}>
          <button
            onClick={onReturnToParent}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 11, fontWeight: 600, color: "#5b21b6",
              background: "#ede9fe", border: "1px solid #c4b5fd",
              borderRadius: 4, padding: "2px 8px", cursor: "pointer",
            }}
          >
            <span style={{ fontSize: 12, lineHeight: 1 }}>↩</span>
            {t("sessionOverview.subAgent.backTo", { name: parentLabel })}
          </button>
          <span style={{ fontSize: 10, color: "#7c3aed", letterSpacing: "0.04em" }}>
            <ForkIcon size={10} color="#7c3aed" /> {t("sessionOverview.subAgent.sideBranch")} · {turns.length} · {drilldown.subAgents.length > 0 ? t("sessionOverview.subAgent.nested", { n: drilldown.subAgents.length }) : t("sessionOverview.subAgent.leaf")}
          </span>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Mini left nav — only shown when the sub agent has multiple turns */}
        {multiTurn && (
          <div style={{ width: 160, borderRight: "1px solid #f3f4f6", overflowY: "auto", flexShrink: 0, background: "#fafafa" }}>
            <div style={{ padding: "10px 10px 4px", fontSize: 9, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>SUB-AGENT TURNS</div>
            {turns.map(t => (
              <div
                key={t.id}
                onClick={() => { setInnerTurn(t); setInnerCall(null); }}
                style={{
                  padding: "6px 10px", cursor: "pointer",
                  background: innerTurn?.id === t.id ? "#ede9fe" : "transparent",
                  borderLeft: innerTurn?.id === t.id ? "2px solid #7c3aed" : "2px solid transparent",
                }}
                onMouseEnter={e => { if (innerTurn?.id !== t.id) e.currentTarget.style.background = "#f9fafb"; }}
                onMouseLeave={e => { if (innerTurn?.id !== t.id) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>Turn {t.id}</div>
                <div style={{ fontSize: 10, color: "#9ca3af" }}>{t.llmCallCount} calls · {t.netContextDelta > 0 ? "+" : ""}{fmtK(t.netContextDelta)}</div>
              </div>
            ))}
          </div>
        )}

        {/* Main content — default lands on Turn detail (reuses Turn page) */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {innerTurn && !innerCall && (
            <UserTurnDetailPanel
              turn={innerTurn}
              onSelectCall={c => setInnerCall(c)}
              isMockSession={false}
            />
          )}
          {innerCall && (
            <LlmCallDetailPanel
              call={innerCall}
              onSelectEntry={() => {}}
              sessionId={drilldown.sessionId}
            />
          )}
          {!innerTurn && (
            <div style={{ padding: 40, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
              This sub agent recorded no turns.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type NavLevel = "session" | "turn" | "inter-turn" | "call" | "subagent";

type InspectorState =
  | { type: "hotspots" }
  | { type: "turn-rollup"; turn: MockUserTurn }
  | { type: "call-diff"; call: MockLlmCall }
  | { type: "evidence"; entry: MockDiffEntry };

type LinkedPanelState =
  | { type: "call"; call: MockLlmCall; turn: MockUserTurn }
  | { type: "turn-excerpt"; turn: MockUserTurn; focusCall: MockLlmCall | null };

interface Props {
  session: SessionV2;
  onClose: () => void;
}

export function SessionDetailV2({ session, onClose }: Props) {
  const { t } = useTranslation();
  const [drilldown, setDrilldown] = useState<SessionDrilldown | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    setLoadState("loading");
    apiV2.sessionDrilldown(session.session_id)
      .then(data => { setDrilldown(data); setLoadState("ok"); })
      .catch(() => setLoadState("error"));
  }, [session.session_id]);

  const turns: UserTurn[] = drilldown?.turns ?? buildFallbackTurns();
  const interTurnBlocks: InterTurnBlock[] = drilldown?.interTurnBlocks ?? [];
  const isMockData = drilldown === null;

  const [navLevel, setNavLevel] = useState<NavLevel>("session");
  const [selectedTurn, setSelectedTurn] = useState<MockUserTurn | null>(null);
  const [selectedInterTurnBlock, setSelectedInterTurnBlock] = useState<InterTurnBlock | null>(null);
  const [selectedCall, setSelectedCall] = useState<MockLlmCall | null>(null);
  const [inspector, setInspector] = useState<InspectorState>({ type: "hotspots" });
  const [selectedSubAgent, setSelectedSubAgent] = useState<SubAgentSummary | null>(null);
  const [subAgentDrilldown, setSubAgentDrilldown] = useState<SessionDrilldown | null>(null);
  const [subAgentLoadState, setSubAgentLoadState] = useState<"loading" | "ok" | "error">("loading");
  const [linkedPanel, setLinkedPanel] = useState<LinkedPanelState | null>(null);
  const [linkedPanelPinned, setLinkedPanelPinned] = useState(false);

  const title = getSessionDisplayName(session, drilldown?.title);

  function findTurnForCall(callId: number): MockUserTurn | null {
    return turns.find(t => t.calls.some(c => c.id === callId)) ?? selectedTurn ?? null;
  }

  function openLinkedCall(call: MockLlmCall, turnHint?: MockUserTurn | null) {
    const turn = turnHint ?? findTurnForCall(call.id);
    if (!turn) {
      handleSelectCall(call);
      return;
    }
    setLinkedPanel({ type: "call", call, turn });
  }

  function openLinkedTurnExcerpt(turn: MockUserTurn, focusCall: MockLlmCall | null) {
    setLinkedPanel({ type: "turn-excerpt", turn, focusCall });
  }

  function closeLinkedPanel() {
    setLinkedPanel(null);
    setLinkedPanelPinned(false);
  }

  function openLinkedPanelAsMain() {
    if (!linkedPanel) return;
    if (linkedPanel.type === "call") {
      setSelectedTurn(linkedPanel.turn);
      setSelectedCall(linkedPanel.call);
      setNavLevel("call");
      setInspector({ type: "call-diff", call: linkedPanel.call });
    } else {
      setSelectedTurn(linkedPanel.turn);
      setSelectedCall(null);
      setNavLevel("turn");
      setInspector({ type: "turn-rollup", turn: linkedPanel.turn });
    }
    setLinkedPanel(null);
  }

  function handleSelectTurn(turn: MockUserTurn) {
    setSelectedTurn(turn);
    setSelectedCall(null);
    setNavLevel("turn");
    if (!linkedPanelPinned) setLinkedPanel(null);
    setInspector({ type: "turn-rollup", turn });
  }

  function handleSelectCall(call: MockLlmCall) {
    setSelectedCall(call);
    setNavLevel("call");
    if (!linkedPanelPinned) setLinkedPanel(null);
    setInspector({ type: "call-diff", call });
  }

  function handleLinkCallFromTurn(call: MockLlmCall) {
    openLinkedCall(call, selectedTurn);
    setInspector({ type: "call-diff", call });
  }

  function handleSelectEntry(entry: MockDiffEntry) {
    setInspector({ type: "evidence", entry });
  }

  function handleNavSession() {
    setNavLevel("session");
    setSelectedTurn(null);
    setSelectedInterTurnBlock(null);
    setSelectedCall(null);
    setLinkedPanel(null);
    setLinkedPanelPinned(false);
    setInspector({ type: "hotspots" });
  }

  function handleSelectInterTurnBlock(block: InterTurnBlock) {
    setSelectedInterTurnBlock(block);
    setSelectedTurn(null);
    setSelectedCall(null);
    setNavLevel("inter-turn");
    if (!linkedPanelPinned) setLinkedPanel(null);
  }

  function handleNavTurn(turn: MockUserTurn) {
    setSelectedTurn(turn);
    setSelectedCall(null);
    setNavLevel("turn");
    if (!linkedPanelPinned) setLinkedPanel(null);
    setInspector({ type: "turn-rollup", turn });
  }

  function handleSelectSubAgent(sa: SubAgentSummary) {
    setSelectedSubAgent(sa);
    setNavLevel("subagent");
    if (!linkedPanelPinned) setLinkedPanel(null);
    setSubAgentDrilldown(null);
    setSubAgentLoadState("loading");
    apiV2.subAgentDrilldown(session.session_id, sa.agentFileId)
      .then(data => { setSubAgentDrilldown(data); setSubAgentLoadState("ok"); })
      .catch(() => setSubAgentLoadState("error"));
  }

  // Return from a sub-agent side branch to its parent turn — closes the loop
  // so the breadcrumb / "Back to T<n>" affordance always lands somewhere real.
  function handleReturnFromSubAgent() {
    setSelectedSubAgent(null);
    if (selectedTurn) {
      setNavLevel("turn");
      setInspector({ type: "turn-rollup", turn: selectedTurn });
    } else {
      setNavLevel("session");
      setInspector({ type: "hotspots" });
    }
  }

  const allCallsForNav = selectedTurn?.calls ?? [];

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "flex-start", justifyContent: "flex-end" }}
      onClick={onClose}
    >
      <div
        style={{
          width: linkedPanel ? "calc(100vw - 64px)" : "calc(100vw - 200px)",
          maxWidth: linkedPanel ? 1560 : 1200,
          height: "100%",
          background: "#fff",
          boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
          display: "flex",
          flexDirection: "column",
          transition: "width 180ms ease, max-width 180ms ease",
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid #e5e7eb", flexShrink: 0, background: "#fff", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
            <button onClick={handleNavSession} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, flexShrink: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: navLevel === "session" ? "#6366f1" : "#111827" }}>{title}</span>
            </button>
            {title !== session.session_id && (
              <span style={{ fontSize: 10, color: "#9ca3af", fontFamily: "monospace", flexShrink: 0 }}>{session.session_id}</span>
            )}
            {selectedTurn && (
              <>
                <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
                <button onClick={() => navLevel === "subagent" ? handleReturnFromSubAgent() : handleNavTurn(selectedTurn)}
                  style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, flexShrink: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: navLevel === "turn" && !selectedCall ? "#6366f1" : "#374151" }}>Turn {selectedTurn.id}</span>
                </button>
              </>
            )}
            {selectedCall && (
              <>
                <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#6366f1", flexShrink: 0 }}>
                  C{selectedCall.indexInTurn}
                  <span style={{ fontSize: 10, fontWeight: 400, color: "#9ca3af", marginLeft: 4 }}>#{selectedCall.id}</span>
                </span>
              </>
            )}
            {selectedSubAgent && navLevel === "subagent" && (
              <>
                <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, fontWeight: 600, color: "#7c3aed", flexShrink: 0 }}>
                  <ForkIcon size={12} color="#7c3aed" />
                  {selectedSubAgent.agentType}
                </span>
              </>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {loadState === "loading" && (
              <span style={{ fontSize: 10, color: "#6366f1", background: "#eff6ff", borderRadius: 4, padding: "2px 8px" }}>{t("sessionOverview.status.loading")}</span>
            )}
            {loadState === "error" && (
              <span style={{ fontSize: 10, color: "#dc2626", background: "#fef2f2", borderRadius: 4, padding: "2px 8px" }}>{t("sessionOverview.status.error")}</span>
            )}
            <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", color: "#9ca3af", fontSize: 20, lineHeight: 1, padding: 4 }}>×</button>
          </div>
        </div>

        {/* Body: Left Nav + Main + Inspector */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Left Nav */}
          <div style={{ width: 200, borderRight: "1px solid #e5e7eb", overflowY: "auto", flexShrink: 0, background: "#fafafa" }}>
            <div style={{ padding: "12px 12px 4px", fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>{t("sessionOverview.nav.session")}</div>
            <NavItem
              label={t("sessionOverview.nav.overview")}
              active={navLevel === "session"}
              onClick={handleNavSession}
            />

            <div style={{ padding: "10px 12px 4px", fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>{t("sessionOverview.nav.userTurns")}</div>
            {(() => {
              return turns.map(turn => {
                const isThisTurnSelected = selectedTurn?.id === turn.id;
                const turnInput = turn.userInput.trim();
                const turnLabel = `T${turn.id} ${turnInput.slice(0, 18).trimEnd()}${turnInput.length > 18 ? "…" : ""}`;
                // sub-agent forks in this turn
                const subAgentCount = turn.calls.reduce((s, c) => s + (c.subAgents?.length ?? 0), 0);
                const hasCommand = turn.calls.some(c => c.intervalEvents.some(e => e.kind === "user:command"));
                const hasUnknown = turn.calls.some(c => c.intervalEvents.some(e => e.kind === "unknown"));
                const turnBadges = (
                  <>
                    {turn.hasCompaction && BADGE_ICONS.compaction(10, "#ef4444")}
                    {turn.errorCount > 0 && BADGE_ICONS.error(10, "#dc2626")}
                    {subAgentCount > 0 && BADGE_ICONS.subAgent(10, "#7c3aed")}
                    {hasCommand && BADGE_ICONS.command(10, "#d97706")}
                    {hasUnknown && BADGE_ICONS.unknown(10, "#9ca3af")}
                  </>
                );
                return (
                  <React.Fragment key={`turn-${turn.id}`}>
                    <NavItem
                      label={turnLabel}
                      sublabel={`${turn.netContextDelta > 0 ? "+" : ""}${fmtK(turn.netContextDelta)} · ${turn.llmCallCount} calls${turn.toolCallCount > 0 ? ` · ${turn.toolCallCount} tools` : ""}`}
                      active={navLevel === "turn" && isThisTurnSelected && !selectedCall}
                      badges={turnBadges}
                      onClick={() => handleSelectTurn(turn)}
                    />
                    {isThisTurnSelected && allCallsForNav.length > 0 && allCallsForNav.map(call => (
                      <NavItem
                        key={call.id}
                        indent
                        label={call.isCompaction ? `C${call.indexInTurn} ◆` : `C${call.indexInTurn}`}
                        sublabel={`#${call.id} · ${call.isSignificant ? `+${fmtK(call.significantDelta ?? 0)}` : fmtK(call.contextSize)}`}
                        active={
                          selectedCall?.id === call.id
                          || (linkedPanel?.type === "call" && linkedPanel.call.id === call.id)
                          || (linkedPanel?.type === "turn-excerpt" && linkedPanel.focusCall?.id === call.id)
                        }
                        badge={call.isCompaction ? undefined : undefined}
                        badgeColor="#ef4444"
                        onClick={() => handleSelectCall(call)}
                      />
                    ))}
                  </React.Fragment>
                );
              });
            })()}
          </div>

          {/* Main Canvas */}
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
            {navLevel === "session" && (
              <SessionOverviewPanel turns={turns} drilldown={drilldown} onSelectTurn={handleSelectTurn} />
            )}
            {navLevel === "turn" && selectedTurn && !selectedCall && (
              <UserTurnDetailPanel turn={selectedTurn} onSelectCall={handleLinkCallFromTurn} isMockSession={isMockData} onSubAgentClick={handleSelectSubAgent}
                trailingInterTurnBlock={interTurnBlocks.find(b => b.prevTurnId === selectedTurn.id && b.nextTurnId !== selectedTurn.id) ?? null}
                sessionId={session.session_id}
              />
            )}
            {navLevel === "inter-turn" && selectedInterTurnBlock && (
              <InterTurnBlockPanel block={selectedInterTurnBlock} />
            )}
            {navLevel === "call" && selectedCall && (
              <LlmCallDetailPanel
                call={selectedCall}
                onSelectEntry={handleSelectEntry}
                sessionId={session.session_id}
                onShowTurnContext={() => {
                  const turn = findTurnForCall(selectedCall.id);
                  if (turn) openLinkedTurnExcerpt(turn, selectedCall);
                }}
                onLinkCall={(cid) => {
                  const target = turns.flatMap(t => t.calls).find(c => c.id === cid);
                  const targetTurn = target ? turns.find(t => t.calls.some(c => c.id === cid)) : null;
                  if (target && targetTurn) openLinkedTurnExcerpt(targetTurn, target);
                }}
              />
            )}
            {navLevel === "subagent" && (
              <SubAgentSessionPanel
                drilldown={subAgentDrilldown}
                loadState={subAgentLoadState}
                parentLabel={selectedTurn ? `Turn ${selectedTurn.id}` : undefined}
                onReturnToParent={selectedTurn ? handleReturnFromSubAgent : undefined}
              />
            )}
          </div>

          <LinkedContextPanel
            panel={linkedPanel}
            pinned={linkedPanelPinned}
            sessionId={session.session_id}
            onClose={closeLinkedPanel}
            onTogglePin={() => setLinkedPanelPinned(v => !v)}
            onOpenAsMain={openLinkedPanelAsMain}
            onSelectCall={(call, turn) => openLinkedCall(call, turn)}
            onShowTurnContext={(turn, focusCall) => openLinkedTurnExcerpt(turn, focusCall)}
            onSelectEntry={handleSelectEntry}
            onLinkCall={(cid) => {
              const target = turns.flatMap(t => t.calls).find(c => c.id === cid);
              const targetTurn = target ? turns.find(t => t.calls.some(c => c.id === cid)) : null;
              if (target && targetTurn) openLinkedTurnExcerpt(targetTurn, target);
            }}
          />

        </div>
      </div>
    </div>
  );
}

function LinkedContextPanel({
  panel,
  pinned,
  sessionId,
  onClose,
  onTogglePin,
  onOpenAsMain,
  onSelectCall,
  onShowTurnContext,
  onSelectEntry,
  onLinkCall,
}: {
  panel: LinkedPanelState | null;
  pinned: boolean;
  sessionId: string;
  onClose: () => void;
  onTogglePin: () => void;
  onOpenAsMain: () => void;
  onSelectCall: (call: MockLlmCall, turn: MockUserTurn) => void;
  onShowTurnContext: (turn: MockUserTurn, focusCall: MockLlmCall | null) => void;
  onSelectEntry: (entry: MockDiffEntry) => void;
  onLinkCall?: (callId: number) => void;
}) {
  const open = panel !== null;
  const title = !panel
    ? ""
    : panel.type === "call"
      ? `Call #${panel.call.id}`
      : `Turn ${panel.turn.id} context`;
  const subtitle = !panel
    ? ""
    : panel.type === "call"
      ? `Linked from Turn ${panel.turn.id}`
      : panel.focusCall
        ? `Focused around Call #${panel.focusCall.id}`
        : "Transaction excerpt";

  return (
    <aside
      style={{
        width: open ? "min(560px, 42vw)" : 0,
        minWidth: open ? 420 : 0,
        flexShrink: 0,
        borderLeft: open ? "1px solid #e5e7eb" : "0 solid transparent",
        background: "#fff",
        overflow: "hidden",
        transition: "width 180ms ease, min-width 180ms ease, border-color 180ms ease",
        boxShadow: open ? "-8px 0 18px rgba(15, 23, 42, 0.06)" : "none",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {panel && (
        <>
          <div style={{
            flexShrink: 0,
            padding: "10px 12px",
            borderBottom: "1px solid #e5e7eb",
            background: "#fafafa",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {title}
                </span>
                <span style={{
                  fontSize: 9,
                  color: pinned ? "#7c3aed" : "#64748b",
                  border: `1px solid ${pinned ? "#ddd6fe" : "#e5e7eb"}`,
                  background: pinned ? "#f5f3ff" : "#fff",
                  borderRadius: 4,
                  padding: "1px 5px",
                  whiteSpace: "nowrap",
                }}>
                  {pinned ? "pinned" : "linked"}
                </span>
              </div>
              <div style={{ fontSize: 10, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
                {subtitle}
              </div>
            </div>
            <button
              onClick={onTogglePin}
              style={linkedPanelButtonStyle(pinned ? "active" : "neutral")}
              title="Keep this panel open while navigating"
            >
              Pin
            </button>
            <button
              onClick={onOpenAsMain}
              style={linkedPanelButtonStyle("primary")}
              title="Promote linked content into the main view"
            >
              Open as main
            </button>
            <button
              onClick={onClose}
              style={linkedPanelButtonStyle("ghost")}
              title="Close linked panel"
            >
              ×
            </button>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex" }}>
            {panel.type === "call" ? (
              <LlmCallDetailPanel
                call={panel.call}
                onSelectEntry={onSelectEntry}
                sessionId={sessionId}
                mode="panel"
                onShowTurnContext={() => onShowTurnContext(panel.turn, panel.call)}
                onLinkCall={onLinkCall}
              />
            ) : (
              <LinkedTurnExcerptPanel
                turn={panel.turn}
                focusCall={panel.focusCall}
                onSelectCall={onSelectCall}
              />
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function linkedPanelButtonStyle(kind: "primary" | "active" | "neutral" | "ghost"): React.CSSProperties {
  const base: React.CSSProperties = {
    borderRadius: 5,
    padding: "3px 7px",
    fontSize: 10,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
  if (kind === "primary") return { ...base, border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4338ca" };
  if (kind === "active") return { ...base, border: "1px solid #c4b5fd", background: "#f5f3ff", color: "#6d28d9" };
  if (kind === "neutral") return { ...base, border: "1px solid #e5e7eb", background: "#fff", color: "#64748b" };
  return { ...base, border: "1px solid #e5e7eb", background: "#fff", color: "#94a3b8", fontSize: 14, lineHeight: 1, padding: "1px 7px" };
}

function LinkedTurnExcerptPanel({
  turn,
  focusCall,
  onSelectCall,
}: {
  turn: MockUserTurn;
  focusCall: MockLlmCall | null;
  onSelectCall: (call: MockLlmCall, turn: MockUserTurn) => void;
}) {
  // After mount, scroll the focused call into view if provided.
  // UserTurnDetailPanel renders each call with an anchor `turn-${id}-call-${cid}`.
  useEffect(() => {
    if (!focusCall) return;
    const id = `turn-${turn.id}-call-${focusCall.id}`;
    // Defer to next frame so the panel has actually mounted.
    const handle = requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(handle);
  }, [turn.id, focusCall?.id]);

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "#fff" }}>
      <UserTurnDetailPanel
        turn={turn}
        onSelectCall={(c) => onSelectCall(c, turn)}
      />
    </div>
  );
}

function NavItem({
  label, sublabel, active, badge, badgeColor, badges, onClick, indent,
}: {
  label: string; sublabel?: string; active: boolean;
  badge?: string; badgeColor?: string;
  badges?: React.ReactNode;  // multi-badge slot replaces single badge when provided
  onClick: () => void;
  indent?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: indent ? "5px 10px 5px 28px" : "7px 12px 7px 16px",
        cursor: "pointer",
        background: active ? "#eff6ff" : "transparent",
        borderLeft: active ? "2px solid #6366f1" : "2px solid transparent",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 4,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = "#f3f4f6"; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: indent ? 11 : 12,
          color: active ? "#6366f1" : "#374151",
          fontWeight: active ? 600 : 400,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{label}</div>
        {sublabel && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1 }}>{sublabel}</div>}
      </div>
      {badges
        ? <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>{badges}</div>
        : badge && <span style={{ fontSize: 10, color: badgeColor, fontWeight: 700, flexShrink: 0 }}>{badge}</span>
      }
    </div>
  );
}

function InterTurnNavItem({ block, active, onClick }: { block: InterTurnBlock; active: boolean; onClick: () => void }) {
  const exitLabel = block.label.includes("/exit") || !block.enteredContext;
  return (
    <div
      onClick={onClick}
      style={{
        padding: "3px 12px 3px 22px",
        cursor: "pointer",
        background: active ? "#faf5ff" : "transparent",
        borderLeft: active ? "2px solid #a78bfa" : "2px solid transparent",
        display: "flex", alignItems: "center", gap: 5,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = "#f9fafb"; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ fontSize: 9, color: exitLabel ? "#94a3b8" : "#a78bfa", flexShrink: 0 }}>
        {exitLabel ? "⏎" : "⌘"}
      </span>
      <span style={{
        fontSize: 10,
        color: active ? "#7c3aed" : "#9ca3af",
        fontStyle: "italic",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        flex: 1,
      }}>
        {block.label}
      </span>
      {!block.enteredContext && (
        <span style={{ fontSize: 9, color: "#cbd5e1", flexShrink: 0 }} title="Session ended before this entered context">∅</span>
      )}
    </div>
  );
}

// ─── InterTurnBlock detail (shared between inline Turn view and full panel) ───

function InterTurnBlockDetail({ block }: { block: InterTurnBlock }) {
  const kindLabel: Record<string, string> = {
    "user:command": "cmd",
    "system:local_command": "sys",
    "user:human": "inject",
    "file-history-snapshot": "snapshot",
  };
  return (
    <div style={{ border: "1px solid #e9d5ff", borderRadius: 8, background: "#faf5ff", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #e9d5ff", background: "#f3e8ff" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed" }}>{block.label}</span>
        <span style={{ fontSize: 10, color: "#a78bfa" }}>·</span>
        <span style={{ fontSize: 10, color: "#a78bfa" }}>{block.events.length} event{block.events.length > 1 ? "s" : ""}</span>
        {!block.enteredContext && (
          <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: "auto", fontStyle: "italic" }}>did not enter context (session ended)</span>
        )}
        {block.enteredContext && (
          <span style={{ fontSize: 10, color: "#a78bfa", marginLeft: "auto", fontStyle: "italic" }}>entered context in next turn</span>
        )}
      </div>
      <div style={{ padding: "8px 12px" }}>
        {block.events.map((ev, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0", borderBottom: i < block.events.length - 1 ? "1px solid #f3e8ff" : "none" }}>
            <span style={{
              fontSize: 9, fontWeight: 700, color: "#a78bfa",
              background: "#ede9fe", borderRadius: 3, padding: "1px 4px",
              flexShrink: 0, marginTop: 2,
            }}>
              {kindLabel[ev.kind] ?? ev.kind.split(":")[1] ?? ev.kind}
            </span>
            <span style={{ fontSize: 11, color: "#374151", wordBreak: "break-all", fontFamily: "monospace", lineHeight: 1.5 }}>
              {ev.contentPreview || <span style={{ color: "#d1d5db" }}>—</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Full-page inter-turn block panel (shown in main canvas) ─────────────────

function InterTurnBlockPanel({ block }: { block: InterTurnBlock }) {
  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid #f3f4f6" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#7c3aed" }}>
            {block.label}
          </span>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>inter-turn commands</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { label: "Events", value: String(block.events.length) },
            { label: "After Turn", value: block.prevTurnId !== null ? `T${block.prevTurnId}` : "session start",
              color: block.prevTurnId === null ? "#9ca3af" : undefined },
            { label: "Before Turn", value: block.nextTurnId !== null ? `T${block.nextTurnId}` : "session end",
              color: block.nextTurnId === null ? "#9ca3af" : undefined },
            { label: "Entered Context", value: block.enteredContext ? "yes" : "no",
              color: block.enteredContext ? "#16a34a" : "#94a3b8" },
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              padding: "5px 10px", background: "#faf5ff", borderRadius: 6,
              border: "1px solid #e9d5ff", minWidth: 64,
            }}>
              <span style={{ fontSize: 9, color: "#9ca3af", marginBottom: 2 }}>{label}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: color ?? "#7c3aed" }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
      <InterTurnBlockDetail block={block} />
    </div>
  );
}
