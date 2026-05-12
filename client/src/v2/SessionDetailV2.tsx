import React, { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
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
  MOCK_SUB_AGENTS, attachMockSubAgents,
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

// Local aliases for brevity (same as drilldown-types, no local re-declaration needed)
type MockDiffEntry = DiffEntry;
// LlmCall fields added in drilldown-types are optional in the raw fallback
// data below; normalizeTurns() fills them in.
type RawMockCall = Omit<LlmCall,
  "indexInTurn" | "model" | "stopReason" | "proxy" | "subAgents" |
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
  const biggestTurn = [...turns].sort((a, b) => b.netContextDelta - a.netContextDelta)[0];
  const biggestPeak = [...turns].sort((a, b) => b.peakContext - a.peakContext)[0];
  const unknownTurn = [...turns].sort((a, b) => b.unknownDelta - a.unknownDelta)[0];
  const compactionTurns = turns.filter(t => t.hasCompaction || t.calls.some(c => c.isCompaction));

  return (
    <div style={{ padding: "16px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.06em", marginBottom: 12 }}>
        SESSION HOTSPOTS <MockBadge />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <HotspotCard icon="↑" label="Largest growth" value={`Turn ${biggestTurn.id} · +${fmtK(biggestTurn.netContextDelta)}`} color="#d97706" />
        <HotspotCard icon="⚡" label="Peak context" value={`Turn ${biggestPeak.id} · ${fmtK(biggestPeak.peakContext)}`} color="#6366f1" />
        <HotspotCard icon="?" label="Largest unknown" value={`Turn ${unknownTurn.id} · +${fmtK(unknownTurn.unknownDelta)}`} color="#94a3b8" />
        {compactionTurns.length > 0 && (
          <HotspotCard icon="◆" label="Compaction turns" value={compactionTurns.map(t => `Turn ${t.id}`).join(", ")} color="#ef4444" />
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

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* ── Token / call metrics ───────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        {/* Row 0: Model chip (when single model — multi-model uses ModelBreakdownBlock below) */}
        {modelBreakdown && Object.keys(modelBreakdown).length === 1 && (() => {
          const [[m]] = Object.entries(modelBreakdown);
          const color = modelColor(m);
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>{shortModelName(m)}</span>
              <span style={{ fontSize: 10, color: "#9ca3af" }}>·</span>
              <span style={{ fontSize: 10, color: "#9ca3af" }}>{sm?.totalLlmCalls ?? "?"} calls</span>
            </div>
          );
        })()}

        <SummaryMetricStrip columns={7} cards={[
          { label: "User Turns",  value: String(drilldown?.turns.length ?? turns.length), mock: isMock },
          { label: "LLM Calls",   value: String(totalCalls),                    mock: isMock },
          { label: "Tool Calls",  value: String(totalToolCalls),                mock: isMock },
          { label: "Sub Agents",  value: String(sm?.subAgentCount ?? 0),        mock: isMock,
            color: (sm?.subAgentCount ?? 0) > 0 ? "#6366f1" : undefined },
          { label: "Duration",    value: durationStr,                           mock: isMock },
          { label: "Cache Read",  value: fmtK(totalCacheRead),  mock: isMock,
            tooltip: "Σ cache_read_input_tokens across all calls — billing unit" },
          { label: "Cache Write", value: fmtK(totalCacheWrite), mock: isMock,
            tooltip: "Σ cache_creation_input_tokens across all calls — billing unit" },
          { label: "Fresh In",    value: totalFreshIn !== null ? fmtK(totalFreshIn) : "—", mock: isMock,
            tooltip: "每次 LLM call 相比上一次新增的 token 总量（context 增量累加）" },
          { label: "Fresh Out",   value: totalFreshOut !== null ? fmtK(totalFreshOut) : "—", mock: isMock,
            tooltip: "Σ output_tokens across all calls — billing unit" },
          { label: "Cache Ratio", value: fmtPct(cacheRatio),
            tooltip: "Last call: cache_read / context_size", mock: isMock },
          { label: "Context",
            value: `${fmtK(peakContext)} / ${fmtK(sm?.lastContext ?? peakContext)}`,
            mock: isMock,
            tooltip: "peak context / final context (last LLM call)" },
          { label: "Compactions", value: String(sm?.compactionCount ?? compactionTurns.length), mock: isMock,
            color: (sm?.compactionCount ?? compactionTurns.length) > 0 ? "#ef4444" : undefined,
            tooltip: "Number of turns where a context compaction occurred" },
          { label: "Errors",       value: String(systemErrors ?? 0),
            alert: systemErrors !== null && systemErrors > 0, mock: isMock },
          { label: "Started",
            value: sm ? fmtDateShort(sm.firstEventAt) : "—",
            mock: isMock,
            tooltip: sm?.firstEventAt ?? "" },
          { label: "Last Active",
            value: sm ? fmtDateShort(sm.lastEventAt) : "—",
            mock: isMock,
            tooltip: sm?.lastEventAt ?? "" },
        ]} />
      </div>

      {/* Compaction hotspot chips */}
      {!isMock && compactionTurns.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <HotspotChip icon="◆" label="Compaction" value={compactionTurns.map(t => `Turn ${t.id}`).join(", ")} color="#ef4444" />
        </div>
      )}

      {/* Model Breakdown — only show when there are multiple models */}
      {modelBreakdown && Object.keys(modelBreakdown).length > 1 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Models</div>
          <ModelBreakdownBlock breakdown={modelBreakdown} />
        </div>
      )}

      {/* Context Overview Timeline */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
          Context Timeline {isMock && <MockBadge />}
        </div>
        <ContextTimelineChart turns={turns} isMock={isMock} />
      </div>

      {/* Top context contributors */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
          Top Context Contributors {isMock && <MockBadge />}
        </div>
        {isMock ? (
          <div style={{ border: "1px dashed #d1d5db", borderRadius: 8, padding: "10px 14px", background: "#fafafa" }}>
            {[
              { label: "Tool Output", pct: 42 },
              { label: "Assistant History", pct: 28 },
              { label: "System", pct: 18 },
              { label: "Unknown", pct: 7 },
              { label: "Other", pct: 5 },
            ].map(item => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: CATEGORY_COLORS[item.label] ?? "#e5e7eb" }} />
                <span style={{ fontSize: 11, color: "#374151", flex: 1 }}>{item.label}</span>
                <div style={{ width: 80, height: 5, background: "#f3f4f6", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${item.pct}%`, height: "100%", background: CATEGORY_COLORS[item.label] ?? "#e5e7eb" }} />
                </div>
                <span style={{ fontSize: 10, color: "#9ca3af", width: 28, textAlign: "right" }}>{item.pct}%</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ border: "1px dashed #d1d5db", borderRadius: 8, padding: "10px 14px", background: "#fafafa", fontSize: 11, color: "#9ca3af" }}>
            Attribution is not computed yet. {drilldown?.hasProxyData ? "Proxy data is available, but request-payload attribution still needs block matching." : "Enable proxy capture to compute this later."}
          </div>
        )}
      </div>

      {/* Sub Agents section */}
      {(() => {
        const sas = drilldown?.subAgents ?? (isMock ? MOCK_SUB_AGENTS : []);
        if (sas.length === 0) return null;

        // Derive spawn/merge context from turns for each sub agent
        // spawnCall = the LlmCall that has call.subAgent.toolUseId === sa.toolUseId
        // mergeCall = the call immediately after the spawn call in the same turn
        interface SAContext {
          spawnedAt?: { turnId: number; callId: number; callIndex: number };
          mergedBefore?: { callId: number; callIndex: number };
          mergeContextDelta?: number;
        }
        const saContextMap = new Map<string, SAContext>();
        for (const turn of turns) {
          for (let ci = 0; ci < turn.calls.length; ci++) {
            const call = turn.calls[ci];
            const mergeCall = turn.calls[ci + 1] ?? null;
            for (const sa of call.subAgents) {
              saContextMap.set(sa.toolUseId, {
                spawnedAt: { turnId: turn.id, callId: call.id, callIndex: call.indexInTurn },
                mergedBefore: mergeCall ? { callId: mergeCall.id, callIndex: mergeCall.indexInTurn } : undefined,
                mergeContextDelta: mergeCall ? mergeCall.significantDelta : undefined,
              });
            }
          }
        }

        return (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
              Sub Agents
              <span style={{ fontSize: 10, fontWeight: 400, color: "#6366f1", background: "#eff6ff", borderRadius: 4, padding: "1px 6px" }}>
                {sas.length} spawned
              </span>
              {isMock && <MockBadge />}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {sas.map(sa => {
                const ctx = saContextMap.get(sa.toolUseId);
                return (
                  <SubAgentCard
                    key={sa.agentFileId}
                    sa={sa}
                    spawnedAt={ctx?.spawnedAt}
                    mergedBefore={ctx?.mergedBefore}
                    mergeContextDelta={ctx?.mergeContextDelta}
                  />
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Tool Distribution */}
      {(() => {
        const dist = drilldown?.toolDistribution ?? [];
        if (dist.length === 0) return null;
        const maxCount = dist[0].count;
        return (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Tool Usage</div>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px", background: "#fff" }}>
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
      <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>User Turns</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {turns.map(turn => (
          <TurnCard key={turn.id} turn={turn} onClick={() => onSelectTurn(turn)} />
        ))}
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
  const entries = Object.entries(breakdown).sort((a, b) => b[1].calls - a[1].calls);
  const totalCalls = entries.reduce((s, [, v]) => s + v.calls, 0);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
      {/* Global header row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr repeat(4, auto)", gap: 0, background: "#f9fafb", padding: "6px 12px", borderBottom: "1px solid #e5e7eb" }}>
        {["Model", "Calls", "Out", "Cache R", "Cache W"].map(h => (
          <span key={h} style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", textAlign: "right", paddingLeft: 12 }}>{h}</span>
        ))}
      </div>
      {entries.map(([model, stats]) => {
        const pct = totalCalls > 0 ? Math.round((stats.calls / totalCalls) * 100) : 0;
        const color = modelColor(model);
        return (
          <div key={model} style={{ display: "grid", gridTemplateColumns: "1fr repeat(4, auto)", gap: 0, padding: "7px 12px", borderBottom: "1px solid #f3f4f6", alignItems: "center" }}>
            {/* Model name + bar */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>{shortModelName(model)}</span>
                <span style={{ fontSize: 10, color: "#9ca3af" }}>{pct}%</span>
              </div>
              {/* Usage bar against context window */}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ flex: 1, height: 3, background: "#f3f4f6", borderRadius: 2, overflow: "hidden", maxWidth: 120 }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: color }} />
                </div>
              </div>
            </div>
            <span style={{ fontSize: 11, color: "#374151", textAlign: "right", paddingLeft: 12 }}>{stats.calls}</span>
            <span style={{ fontSize: 11, color: "#374151", textAlign: "right", paddingLeft: 12 }}>{fmtK(stats.outputTokens)}</span>
            <span style={{ fontSize: 11, color: "#374151", textAlign: "right", paddingLeft: 12 }}>{fmtK(stats.cacheRead)}</span>
            <span style={{ fontSize: 11, color: "#374151", textAlign: "right", paddingLeft: 12 }}>{fmtK(stats.cacheWrite)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── SubAgentCard ─────────────────────────────────────────────────────────────

function SubAgentCard({ sa, spawnedAt, mergedBefore, mergeContextDelta }: {
  sa: SubAgentSummary;
  spawnedAt?: { turnId: number; callId: number; callIndex: number };
  mergedBefore?: { callId: number; callIndex: number };
  mergeContextDelta?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const dur = fmtDuration(sa.durationMs);
  return (
    <div style={{ border: "1px solid #c7d2fe", borderRadius: 8, background: "#fafafa", overflow: "hidden" }}>
      {/* Header */}
      <div
        onClick={() => setExpanded(v => !v)}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", cursor: "pointer", background: "#eff6ff" }}
        onMouseEnter={e => (e.currentTarget.style.background = "#e0e7ff")}
        onMouseLeave={e => (e.currentTarget.style.background = "#eff6ff")}
      >
        <span style={{ fontSize: 13 }}>🤖</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#4338ca" }}>Sub Agent</span>
            <span style={{ fontSize: 10, color: "#6366f1", background: "#e0e7ff", borderRadius: 3, padding: "1px 5px" }}>{sa.agentType}</span>
            {dur && <span style={{ fontSize: 10, color: "#9ca3af" }}>{dur}</span>}
          </div>
          <div style={{ fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {sa.description}
          </div>
          {/* Spawn / merge context */}
          {(spawnedAt || mergedBefore) && (
            <div style={{ display: "flex", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
              {spawnedAt && (
                <span style={{ fontSize: 9, color: "#6366f1", background: "#eff6ff", borderRadius: 3, padding: "1px 5px", border: "1px solid #c7d2fe" }}>
                  spawned Turn {spawnedAt.turnId} / Call #{spawnedAt.callIndex}
                </span>
              )}
              {mergedBefore && (
                <span style={{ fontSize: 9, color: "#059669", background: "#f0fdf4", borderRadius: 3, padding: "1px 5px", border: "1px solid #a7f3d0" }}>
                  merged before Call #{mergedBefore.callIndex}
                  {mergeContextDelta !== undefined && mergeContextDelta !== 0 && (
                    <> · {mergeContextDelta > 0 ? "+" : ""}{fmtK(mergeContextDelta)} ctx</>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 12, flexShrink: 0 }}>
          {[
            { label: "LLM", value: String(sa.llmCallCount) },
            { label: "Tools", value: String(sa.toolCallCount) },
            { label: "Cache R", value: fmtK(sa.totalCacheRead) },
            { label: "Out", value: fmtK(sa.totalOutputTokens) },
          ].map(({ label, value }) => (
            <div key={label} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "#9ca3af" }}>{label}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#4338ca" }}>{value}</div>
            </div>
          ))}
        </div>
        <span style={{ fontSize: 10, color: "#9ca3af", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
      </div>
      {/* Expanded: result preview */}
      {expanded && sa.resultPreview && (
        <div style={{ padding: "10px 12px", borderTop: "1px solid #c7d2fe" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>RESULT</div>
          <div style={{ fontSize: 11, color: "#374151", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {sa.resultPreview}
          </div>
        </div>
      )}
    </div>
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
  const [xMode, setXMode] = useState<TimelineXMode>("linear");

  if (!turns.length) return null;

  // ── One data point per Turn ─────────────────────────────────────
  // peak context, compaction flag, first/last call timestamps for active duration
  const turnPoints = turns.map(turn => {
    const peak = Math.max(...turn.calls.map(c => c.contextSize), 0);
    const hasCompaction = turn.calls.some(c => c.isCompaction);
    const parseTs = (s: string) => {
      if (!s) return NaN;
      // Support both "HH:MM:SS" and full ISO strings
      const t = s.length <= 8 ? new Date(`1970-01-01T${s}Z`).getTime() : new Date(s).getTime();
      return isNaN(t) ? NaN : t;
    };
    const firstMs = parseTs(turn.calls[0]?.timestamp ?? "");
    const lastMs  = parseTs(turn.calls[turn.calls.length - 1]?.timestamp ?? "");
    const durationMs = (!isNaN(firstMs) && !isNaN(lastMs)) ? Math.max(lastMs - firstMs, 0) : 0;
    return { turnId: turn.id, contextSize: peak, isCompaction: hasCompaction, firstMs, durationMs };
  });

  if (turnPoints.length === 0) return null;

  // ── SVG dimensions ──────────────────────────────────────────────
  const W = 600, H = 110, PAD = { t: 10, b: 22, l: 6, r: 36 };
  const chartW = W - PAD.l - PAD.r;
  const chartH = H - PAD.t - PAD.b;

  // ── Y axis ──────────────────────────────────────────────────────
  const peakCtxRaw = Math.max(...turnPoints.map(p => p.contextSize), 0);
  const yMax = Math.max(Math.ceil(peakCtxRaw / 50_000) * 50_000, 50_000);

  const toY = (v: number) => PAD.t + chartH - (v / yMax) * chartH;

  // ── X axis: two modes ───────────────────────────────────────────
  // Mode A (linear): equal spacing per turn index
  // Mode B (time): x = cumulative active time (sum of turn durations); idle gaps
  //   between turns are excluded from the axis but annotated as "+Xm" markers.
  const nT = turnPoints.length;
  let xs: number[];
  // idleGaps[i] = idle ms between turn i-1 and turn i (for i >= 1), in time mode
  let idleGaps: number[] = new Array(nT).fill(0);

  if (xMode === "linear" || nT <= 1) {
    xs = turnPoints.map((_, i) => PAD.l + (i / Math.max(nT - 1, 1)) * chartW);
  } else {
    const hasTimestamps = turnPoints.every(p => !isNaN(p.firstMs) && p.durationMs >= 0);
    if (!hasTimestamps) {
      xs = turnPoints.map((_, i) => PAD.l + (i / Math.max(nT - 1, 1)) * chartW);
    } else {
      // Compute idle gaps and cumulative active durations
      for (let i = 1; i < nT; i++) {
        const prevEnd = turnPoints[i - 1].firstMs + turnPoints[i - 1].durationMs;
        idleGaps[i] = Math.max(0, turnPoints[i].firstMs - prevEnd);
      }
      // Cumulative active time at the start of each turn
      const cumActive: number[] = [0];
      for (let i = 1; i < nT; i++) {
        cumActive.push(cumActive[i - 1] + turnPoints[i - 1].durationMs);
      }
      const totalActive = cumActive[nT - 1] + turnPoints[nT - 1].durationMs || 1;
      xs = cumActive.map(t => PAD.l + (t / totalActive) * chartW);
    }
  }

  const ys = turnPoints.map(p => toY(p.contextSize));
  const pathD = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");

  const peakCtx = peakCtxRaw;
  const lineColor = "#6366f1";

  const tickStep = 50_000;
  const yTicks = Array.from({ length: Math.floor(yMax / tickStep) + 1 }, (_, i) => i * tickStep)
    .filter(v => v <= yMax);

  function fmtIdle(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `+${s}s`;
    const m = Math.round(s / 60);
    return `+${m}m`;
  }

  return (
    <div style={{ border: isMock ? "1px dashed #d1d5db" : "1px solid #e5e7eb", borderRadius: 8, background: "#fafafa", overflow: "hidden" }}>
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
            {mode === "linear" ? "Linear" : "Time"}
          </button>
        ))}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 130, display: "block" }}>
        {/* Y-axis grid lines + labels */}
        {yTicks.map(v => {
          const y = toY(v);
          return (
            <g key={v}>
              <line x1={PAD.l} y1={y} x2={PAD.l + chartW} y2={y}
                stroke="#f3f4f6" strokeWidth={0.75}
              />
              <text x={W - PAD.r + 2} y={y + 3} fontSize={8} fill="#d1d5db">
                {fmtK(v)}
              </text>
            </g>
          );
        })}

        {/* Area fill */}
        <path
          d={`${pathD} L${xs[nT - 1].toFixed(1)},${(PAD.t + chartH).toFixed(1)} L${PAD.l.toFixed(1)},${(PAD.t + chartH).toFixed(1)} Z`}
          fill={lineColor} opacity={0.06}
        />

        {/* Main line */}
        <path d={pathD} fill="none" stroke={lineColor} strokeWidth={1.5} />

        {/* Time mode: idle gap markers between turns */}
        {xMode === "time" && turnPoints.map((_, i) => {
          if (i === 0 || idleGaps[i] < 30_000) return null; // skip tiny gaps < 30s
          const x = xs[i];
          const midY = PAD.t + chartH / 2;
          return (
            <g key={i}>
              {/* vertical dashed separator */}
              <line x1={x - 1} y1={PAD.t} x2={x - 1} y2={PAD.t + chartH}
                stroke="#e5e7eb" strokeWidth={1} strokeDasharray="3,3" />
              {/* idle label */}
              <text x={x - 4} y={midY} textAnchor="end" fontSize={8} fill="#d1d5db">
                {fmtIdle(idleGaps[i])}
              </text>
            </g>
          );
        })}

        {/* Turn dots + compaction markers */}
        {turnPoints.map((p, i) => (
          <circle key={i} cx={xs[i]} cy={ys[i]} r={2.5}
            fill={p.isCompaction ? "#ef4444" : lineColor} opacity={0.85} />
        ))}
        {turnPoints.map((p, i) => p.isCompaction ? (
          <text key={i} x={xs[i]} y={ys[i] - 5} textAnchor="middle" fontSize={9} fill="#ef4444">◆</text>
        ) : null)}

        {/* X axis labels */}
        {turnPoints.map((p, i) => (
          <text key={i} x={xs[i]} y={H - 4} textAnchor="middle" fontSize={9} fill="#9ca3af">T{p.turnId}</text>
        ))}
      </svg>

      {/* Footer annotation */}
      {!isMock && (
        <div style={{ padding: "2px 10px 6px", fontSize: 10, color: "#9ca3af", display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>Peak: <strong style={{ color: "#374151" }}>{fmtK(peakCtx)}</strong></span>
          {xMode === "time" && <span style={{ color: "#c4b5d5" }}>X axis = cumulative active time (user idle excluded)</span>}
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

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff", overflow: "hidden" }}>
      {/* Header row */}
      <div
        onClick={onClick}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #f3f4f6" }}
        onMouseEnter={e => (e.currentTarget.style.background = "#fafafa")}
        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", flexShrink: 0 }}>Turn {turn.id}</span>
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {turn.hasCompaction && <RiskBadge type="compaction" />}
          {turn.errorCount > 0 && (
            <span style={{
              fontSize: 9, fontWeight: 700, color: "#fff",
              background: "#dc2626", borderRadius: 3, padding: "1px 4px",
              letterSpacing: "0.04em",
            }}>
              {turn.errorCount}E
            </span>
          )}
        </div>
        <span style={{ fontSize: 10, color: "#9ca3af", flexShrink: 0 }}>›</span>
      </div>

      {/* Body: input + output */}
      <div style={{ padding: "10px 14px" }}>
        {/* User input */}
        <div style={{ marginBottom: outputFull ? 10 : 0 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", letterSpacing: "0.05em", marginBottom: 4 }}>USER</div>
          <div style={{
            fontSize: 12, color: "#374151", lineHeight: 1.55,
            background: "#f9fafb", borderRadius: 6, padding: "8px 10px",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {inputShown}
          </div>
          {inputNeedsExpand && (
            <button
              onClick={e => { e.stopPropagation(); setInputExpanded(v => !v); }}
              style={{ marginTop: 4, fontSize: 11, color: "#6366f1", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              {inputExpanded ? "Show less ↑" : "Show more ↓"}
            </button>
          )}
        </div>

        {/* Mid-turn injections */}
        {turn.midTurnInjections && turn.midTurnInjections.length > 0 && (
          <div style={{ marginTop: 8, marginBottom: outputFull ? 10 : 0 }}>
            {turn.midTurnInjections.map((inj, idx) => (
              <div key={idx} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}>
                <div style={{
                  flexShrink: 0, fontSize: 9, fontWeight: 600, color: "#f59e0b",
                  background: "#fffbeb", border: "1px solid #fde68a",
                  borderRadius: 4, padding: "2px 5px", marginTop: 1, letterSpacing: "0.04em",
                }}>
                  INJECTED
                </div>
                <div style={{
                  fontSize: 12, color: "#92400e", lineHeight: 1.5,
                  background: "#fffbeb", borderRadius: 6, padding: "6px 10px",
                  whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1,
                  borderLeft: "2px solid #f59e0b",
                }}>
                  {inj.text}
                  {inj.timestamp && (
                    <span style={{ display: "block", fontSize: 10, color: "#d97706", marginTop: 3 }}>
                      after call {inj.afterCallIndex} · {inj.timestamp.length >= 19 ? inj.timestamp.slice(11, 19) : inj.timestamp}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Model output */}
        {outputFull && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", letterSpacing: "0.05em" }}>ASSISTANT</div>
              <button
                onClick={e => { e.stopPropagation(); setMdMode(v => !v); }}
                style={{
                  fontSize: 9, color: mdMode ? "#6366f1" : "#9ca3af",
                  background: mdMode ? "#eff6ff" : "#f3f4f6",
                  border: "none", borderRadius: 3, padding: "1px 5px",
                  cursor: "pointer", fontWeight: 600, letterSpacing: "0.03em",
                }}
              >
                {mdMode ? "MD" : "TXT"}
              </button>
            </div>
            <div style={{
              fontSize: 12, color: "#374151", lineHeight: 1.6,
              background: "#eff6ff", borderRadius: 6, padding: "8px 10px",
              borderLeft: "3px solid #6366f1",
              ...(mdMode ? {} : { whiteSpace: "pre-wrap", wordBreak: "break-word" }),
            }}>
              {mdMode ? (
                <div className="md-prose" style={{ fontSize: 12, lineHeight: 1.6 }}>
                  <ReactMarkdown>{outputShown ?? ""}</ReactMarkdown>
                </div>
              ) : (
                outputShown
              )}
            </div>
            {outputNeedsExpand && (
              <button
                onClick={e => { e.stopPropagation(); setOutputExpanded(v => !v); }}
                style={{ marginTop: 4, fontSize: 11, color: "#6366f1", background: "none", border: "none", cursor: "pointer", padding: 0 }}
              >
                {outputExpanded ? "Show less ↑" : "Show more ↓"}
              </button>
            )}
          </div>
        )}
      </div>
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

              {/* ── Sub-agent branch nodes (git tree style) ── */}
              {call.subAgents.length > 0 && (
                <div style={{ marginLeft: 32, marginBottom: 4, position: "relative" }}>
                  {/* Vertical connector from spine */}
                  <div style={{
                    position: "absolute", left: -16, top: 0, bottom: 8,
                    width: 1.5, background: "#6366f1", opacity: 0.35,
                  }} />
                  {call.subAgents.map((sa, saIdx) => (
                    <div key={sa.agentFileId} style={{ display: "flex", alignItems: "flex-start", gap: 0, marginBottom: 6 }}>
                      {/* Branch elbow */}
                      <div style={{ width: 16, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                        <div style={{ width: 14, height: 12, borderLeft: "1.5px solid #6366f180", borderBottom: "1.5px solid #6366f180", borderBottomLeftRadius: 4, marginTop: 4 }} />
                      </div>
                      {/* Agent node — clickable */}
                      <button
                        onClick={() => onSubAgentClick?.(sa)}
                        style={{
                          flex: 1, border: "1.5px solid #6366f1", borderRadius: 8,
                          background: "#fafafe", padding: "6px 10px",
                          cursor: onSubAgentClick ? "pointer" : "default",
                          textAlign: "left", display: "flex", flexDirection: "column", gap: 3,
                        }}
                        onMouseEnter={e => { if (onSubAgentClick) e.currentTarget.style.background = "#eff6ff"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = "#fafafe"; }}
                      >
                        {/* Row 1: type + stats + arrow */}
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: "#4338ca" }}>{sa.agentType}</span>
                          <span style={{ fontSize: 9, color: "#6366f1" }}>{sa.llmCallCount}c · {sa.toolCallCount}t</span>
                          <span style={{ fontSize: 9, color: "#9ca3af" }}>{fmtDuration(sa.durationMs)}</span>
                          <span style={{ fontSize: 9, color: "#6366f1", background: "#eff6ff", borderRadius: 3, padding: "1px 5px" }}>+{fmtK(sa.totalOutputTokens)}</span>
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
                          <div style={{ fontSize: 10, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "#f5f3ff", borderRadius: 4, padding: "2px 6px" }}>
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
              <ReactMarkdown>{outputShown}</ReactMarkdown>
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
                  {/* Fork indicator: small badge on bottom-right of spawn call */}
                  {call.subAgents.length > 0 && (
                    <div style={{
                      position: "absolute", bottom: -2, right: -2,
                      width: 14, height: 14, borderRadius: "50%",
                      background: "#6366f1", border: "2px solid #fff",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <span style={{ fontSize: 7, color: "#fff", lineHeight: 1 }}>↓</span>
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
              {/* Fork line down from spawn call */}
              <div style={{ width: CALL_W / 2, display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                <div style={{ width: 1.5, height: saIdx === 0 ? 10 : 4, background: "#6366f1", opacity: 0.5 }} />
              </div>
              {/* Branch node — clickable */}
              <button
                onClick={() => onSubAgentClick?.(sa)}
                style={{
                  border: "1.5px solid #6366f1", borderRadius: 8,
                  background: "#fafafe", padding: "5px 10px",
                  display: "flex", alignItems: "center", gap: 8,
                  minWidth: 0, cursor: onSubAgentClick ? "pointer" : "default",
                  textAlign: "left",
                }}
                onMouseEnter={e => { if (onSubAgentClick) e.currentTarget.style.background = "#eff6ff"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "#fafafe"; }}
              >
                <span style={{ fontSize: 9, fontWeight: 700, color: "#4338ca", whiteSpace: "nowrap" }}>
                  {sa.agentType}
                </span>
                <span style={{ fontSize: 9, color: "#6366f1", whiteSpace: "nowrap" }}>
                  {sa.llmCallCount}c · {sa.toolCallCount}t
                </span>
                <span style={{ fontSize: 9, color: "#9ca3af", whiteSpace: "nowrap" }}>
                  {fmtDuration(sa.durationMs)}
                </span>
                <span style={{ fontSize: 9, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
                  {sa.description}
                </span>
                <span style={{ fontSize: 9, color: "#6366f1", background: "#eff6ff", borderRadius: 3, padding: "1px 5px", whiteSpace: "nowrap", flexShrink: 0 }}>
                  +{fmtK(sa.totalOutputTokens)}
                </span>
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
  "attachment:skill_listing", "attachment:task_reminder", "attachment:file",
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
  "attachment:file":          { bg: "#f0f9ff", border: "#bae6fd", fg: "#0369a1" },
  "file-history-snapshot":    { bg: "#f8fafc", border: "#e2e8f0", fg: "#94a3b8" },
  "last-prompt":              { bg: "#f8fafc", border: "#e2e8f0", fg: "#64748b" },
  "unknown":                  { bg: "#f8fafc", border: "#e2e8f0", fg: "#94a3b8" },
};

// ── ToolCallRow: dispatched from call + result injected into next ─────────────
function ToolCallRow({ tc }: { tc: ToolCallSlot }) {
  const [expanded, setExpanded] = useState(false);
  const chip = toolChip(tc.name);
  const hasOutput = tc.outputSize > 0;

  return (
    <div style={{ marginBottom: 3 }}>
      <div
        onClick={() => setExpanded(v => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "4px 8px",
          borderRadius: 6, cursor: "pointer",
          background: tc.isError ? "#fef2f2" : "#fafafa",
          border: `1px solid ${tc.isError ? "#fecaca" : "#f0f0f0"}`,
        }}
        onMouseEnter={e => { e.currentTarget.style.background = tc.isError ? "#fee2e2" : "#f3f4f6"; }}
        onMouseLeave={e => { e.currentTarget.style.background = tc.isError ? "#fef2f2" : "#fafafa"; }}
      >
        {/* Dispatch arrow */}
        <span style={{ fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>↳</span>
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
          {hasOutput && <span style={{ fontSize: 9, fontWeight: 600, color: tc.outputSize > 10_000 ? "#d97706" : "#059669" }}>out {fmtBytes(tc.outputSize)}</span>}
          {tc.isError && <span style={{ fontSize: 9, fontWeight: 700, color: "#dc2626", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 3, padding: "1px 4px" }}>ERR</span>}
          {!hasOutput && !tc.isError && <span style={{ fontSize: 9, color: "#d1d5db" }}>no result</span>}
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
          {/* OUTPUT — what was injected back */}
          {hasOutput && (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderLeft: "3px solid #22c55e", borderRadius: "0 5px 5px 0", padding: "5px 8px" }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: "#16a34a", letterSpacing: "0.05em" }}>RESULT &nbsp;</span>
              <span style={{ fontSize: 9, color: "#86efac" }}>{fmtBytes(tc.outputSize)} injected → next call</span>
              <pre style={{ margin: "3px 0 0", fontSize: 11, color: "#166534", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 140, overflow: "auto" }}>
                {tc.outputPreview}{tc.outputSize > 300 ? "\n…" : ""}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── IntervalEventRow: non-tool JSONL events between calls ─────────────────────
function IntervalEventRow({ ev }: { ev: IntervalEvent }) {
  const [expanded, setExpanded] = useState(false);
  const col = KIND_COLOR[ev.kind];

  return (
    <div style={{ marginBottom: 2 }}>
      <div
        onClick={() => setExpanded(v => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "3px 8px",
          borderRadius: 5, cursor: "pointer", opacity: 0.9,
          background: col.bg, border: `1px solid ${col.border}`,
        }}
        onMouseEnter={e => { e.currentTarget.style.opacity = "1"; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = "0.9"; }}
      >
        <span style={{ fontSize: 9, fontWeight: 700, color: col.fg, flexShrink: 0, minWidth: 90 }}>
          {KIND_LABEL[ev.kind]}
        </span>
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
            <span style={{ fontSize: 9, color: "#64748b" }}>line: {ev.lineIdx}</span>
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

  if (!turn.calls.length) return null;

  const maxCtx = Math.max(...turn.calls.map(c => c.contextSize), 1);

  function toggleKind(k: IntervalEventKind) {
    setHiddenKinds(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  return (
    <div>
      {/* ── Filter bar ──────────────────────────────────────────── */}
      <div style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={() => setFilterOpen(v => !v)}
          style={{
            fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer",
            border: "1px solid #e5e7eb", background: filterOpen ? "#6366f1" : "#f9fafb",
            color: filterOpen ? "#fff" : "#6b7280", fontWeight: 600,
          }}
        >
          ⚙ Filter events {hiddenKinds.size > 0 && `(${hiddenKinds.size} hidden)`}
        </button>
        {hiddenKinds.size > 0 && (
          <button onClick={() => setHiddenKinds(new Set())} style={{ fontSize: 10, color: "#6366f1", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            show all
          </button>
        )}
        <span style={{ fontSize: 9, color: "#d1d5db", marginLeft: "auto" }}>
          {turn.calls.length} calls · {turn.calls.reduce((s, c) => s + c.intervalEvents.length, 0)} events
        </span>
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

        {turn.calls.map((call, idx) => {
          const delta    = call.significantDelta;
          // Context bar: absolute width proportional to contextSize / maxCtx
          const ctxWidthPct = Math.round(call.contextSize / maxCtx * 100);
          // Segment percentages within the bar
          const readFrac  = call.contextSize > 0 ? call.cacheRead  / call.contextSize : 0;
          const writeFrac = call.contextSize > 0 ? call.cacheWrite / call.contextSize : 0;
          const freshFrac = call.contextSize > 0 ? call.freshIn    / call.contextSize : 0;

          const visibleIntervals = call.intervalEvents.filter(ev => !hiddenKinds.has(ev.kind));

          return (
            <div key={call.id} style={{ position: "relative", zIndex: 1, marginBottom: 8 }}>

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
                      Call #{call.id}
                      {call.isCompaction && <span style={{ marginLeft: 5, fontSize: 10, color: "#ef4444" }}>◆</span>}
                    </span>
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
                  {call.assistantText && (
                    <div style={{ padding: "0 12px 7px" }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: "#9ca3af", marginBottom: 2, letterSpacing: "0.04em" }}>ASSISTANT TEXT</div>
                      <div style={{ fontSize: 11, color: "#374151", lineHeight: 1.55, background: "#f9fafb", borderRadius: 5, padding: "5px 8px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 72, overflow: "hidden" }}>
                        {call.assistantText}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── Dispatched tool calls ─────────────────────── */}
              {call.toolCalls.length > 0 && (
                <div style={{ marginLeft: 32, marginTop: 3 }}>
                  <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 3, letterSpacing: "0.04em", fontWeight: 600 }}>
                    DISPATCHED ({call.toolCalls.length})
                  </div>
                  {call.toolCalls.map((tc, ti) => (
                    <ToolCallRow key={tc.toolUseId || ti} tc={tc} />
                  ))}
                </div>
              )}

              {/* ── Sub-agent branches ────────────────────────── */}
              {call.subAgents.length > 0 && (
                <div style={{ marginLeft: 32, marginTop: 3 }}>
                  {call.subAgents.map(sa => (
                    <div key={sa.agentFileId} style={{ display: "flex", alignItems: "flex-start", marginBottom: 4 }}>
                      <div style={{ width: 16, flexShrink: 0 }}>
                        <div style={{ width: 12, height: 10, borderLeft: "1.5px solid #6366f180", borderBottom: "1.5px solid #6366f180", borderBottomLeftRadius: 4, marginTop: 4 }} />
                      </div>
                      <button
                        onClick={() => onSubAgentClick?.(sa)}
                        style={{ flex: 1, border: "1.5px solid #6366f1", borderRadius: 7, background: "#fafafe", padding: "5px 9px", cursor: onSubAgentClick ? "pointer" : "default", textAlign: "left", display: "flex", flexDirection: "column", gap: 2 }}
                        onMouseEnter={e => { if (onSubAgentClick) e.currentTarget.style.background = "#eff6ff"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = "#fafafe"; }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: "#4338ca" }}>{sa.agentType}</span>
                          <span style={{ fontSize: 9, color: "#6366f1" }}>{sa.llmCallCount}c · {sa.toolCallCount}t · {fmtDuration(sa.durationMs)}</span>
                          <span style={{ fontSize: 9, color: "#6366f1", background: "#eff6ff", borderRadius: 3, padding: "1px 5px" }}>+{fmtK(sa.totalOutputTokens)}</span>
                          {onSubAgentClick && <span style={{ fontSize: 9, color: "#a5b4fc", marginLeft: "auto" }}>›</span>}
                        </div>
                        {sa.description && <div style={{ fontSize: 10, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sa.description}</div>}
                        {sa.resultPreview && <div style={{ fontSize: 10, color: "#374151", background: "#f5f3ff", borderRadius: 4, padding: "1px 5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sa.resultPreview.slice(0, 100)}{sa.resultPreview.length > 100 ? "…" : ""}</div>}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Interval events (filtered) ────────────────── */}
              {visibleIntervals.length > 0 && (
                <div style={{ marginLeft: 32, marginTop: 3 }}>
                  {visibleIntervals.map((ev, ei) => (
                    <IntervalEventRow key={`${ev.lineIdx}-${ei}`} ev={ev} />
                  ))}
                </div>
              )}

            </div>
          );
        })}
      </div>
    </div>
  );
}

function UserTurnDetailPanel({
  turn, onSelectCall, isMockSession = false, onSubAgentClick, trailingInterTurnBlock = null,
}: { turn: MockUserTurn; onSelectCall: (c: MockLlmCall) => void; isMockSession?: boolean; onSubAgentClick?: (sa: SubAgentSummary) => void; trailingInterTurnBlock?: InterTurnBlock | null }) {

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

  const turnSubAgents = callsWithSubAgents.flatMap(c => c.subAgents);

  const firstCtx = turn.calls[0]?.contextSize ?? 0;
  const lastCtx  = turn.calls[turn.calls.length - 1]?.contextSize ?? 0;
  const netCtx   = lastCtx - firstCtx;
  const netCtxStr = `${netCtx >= 0 ? "+" : ""}${fmtK(netCtx)}`;

  const freshIn = turn.calls.reduce((s, c) => s + Math.max(c.contextSize - c.cacheRead - c.cacheWrite, 0), 0);
  const cacheInputTotal = turn.cacheRead + turn.cacheWrite + freshIn;
  const cacheRatio = cacheInputTotal > 0 ? turn.cacheRead / cacheInputTotal * 100 : null;

  const risks: Array<{ type: "compaction" | "unknown-spike" | "large-growth" | "near-limit" | "tool-heavy" }> = [];
  if (turn.hasCompaction)   risks.push({ type: "compaction" });
  if (turn.hasUnknownSpike) risks.push({ type: "unknown-spike" });

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>

      {/* ── Summary header ────────────────────────────────────────── */}
      <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid #f3f4f6" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>Turn {turn.id}</span>
          <StatusBadge status={agentLoop.status} />
          {dur && <span style={{ fontSize: 11, color: "#9ca3af" }}>{dur}</span>}
          {risks.length > 0 && (
            <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
              {risks.map(r => <RiskBadge key={r.type} type={r.type} />)}
            </div>
          )}
        </div>

        {/* Metrics — compact single row */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { label: "LLM Calls",    value: String(turn.llmCallCount) },
            { label: "Tool Calls",   value: String(turn.toolCallCount) },
            { label: "Duration",     value: dur || "—" },
            { label: "Peak Context", value: fmtK(turn.peakContext) },
            { label: "Context Δ",   value: netCtxStr, color: netCtx < 0 ? "#16a34a" : undefined },
            { label: "Cache Read",   value: fmtK(turn.cacheRead) },
            { label: "Cache Write",  value: fmtK(turn.cacheWrite) },
            { label: "Cache Ratio",  value: fmtPct(cacheRatio) },
            ...(turnSubAgents.length > 0 ? [{ label: "Sub Agents", value: String(turnSubAgents.length), color: "#6366f1" as string | undefined }] : []),
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              padding: "5px 10px", background: "#f9fafb", borderRadius: 6,
              border: "1px solid #f3f4f6", minWidth: 64,
            }}>
              <span style={{ fontSize: 9, color: "#9ca3af", marginBottom: 2, whiteSpace: "nowrap" }}>{label}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: color ?? "#111827" }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Call Minimap ──────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <SectionLabel>Call Minimap</SectionLabel>
        <TurnMinimap
          turn={enrichedTurn}
          onSelectCall={id => { const c = enrichedTurn.calls.find(x => x.id === id); if (c) onSelectCall(c); }}
        />
      </div>

      {/* ── JSONL Event Chain ─────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <SectionLabel>Call Chain</SectionLabel>
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
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.05em", marginBottom: 12, textTransform: "uppercase", fontSize: 10 as unknown as number }}>
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
//   Level 1 — clicking a section block → sub-bar of its segments appears below
//   Level 2 — clicking a segment in the sub-bar → detail panel below

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
      <div style={{ height: 40, display: "flex", borderRadius: 10, overflow: "hidden", gap: 3, marginBottom: 10 }}>
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
                flex: secChars, minWidth: 32, cursor: "pointer",
                background: isActive ? color : color + "90",
                display: "flex", flexDirection: "column", justifyContent: "center",
                padding: "0 8px", overflow: "hidden",
                outline: isActive ? `2px solid ${color}` : "none",
                outlineOffset: -2,
                transition: "background 0.12s",
              }}
              onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = color + "c0"; }}
              onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = color + "90"; }}
            >
              {secPct >= 8 && (
                <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {SECTION_LABEL[sec]}
                </span>
              )}
              {secPct >= 5 && (
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.8)", whiteSpace: "nowrap" }}>
                  ~{fmtK(charsToTokens(secChars))}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Summary legend below top bar (no section selected) */}
      {!activeSection && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
          {SECTION_ORDER.filter(sec => bySection[sec]?.length).map(sec => {
            const secChars = bySection[sec].reduce((s, g) => s + g.charCount, 0);
            const secPct   = Math.round(secChars / totalChars * 100);
            return (
              <button
                key={sec}
                onClick={() => handleSectionClick(sec)}
                style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", padding: 0 }}
              >
                <div style={{ width: 9, height: 9, borderRadius: 2, background: SECTION_COLOR[sec] }} />
                <span style={{ fontSize: 11, color: "#374151" }}>{SECTION_LABEL[sec]}</span>
                <span style={{ fontSize: 10, color: "#9ca3af" }}>{secPct}%</span>
              </button>
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
            {/* Section header — click to collapse */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <button onClick={() => handleSectionClick(activeSection)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: secColor }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>{SECTION_LABEL[activeSection]}</span>
                <span style={{ fontSize: 10, color: "#9ca3af" }}>~{fmtK(charsToTokens(secChars))} · {secPct}% · {activeSectionSegs.length} segments</span>
              </button>
              <button onClick={() => { setActiveSection(null); setActiveSegId(null); }} style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "#9ca3af", lineHeight: 1, padding: "0 2px" }}>×</button>
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

            {/* Segment list — summary rows, no rawText yet */}
            {!activeSeg && (
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
                {activeSectionSegs.map((seg, i) => {
                  const segPct    = Math.round(seg.charCount / activeSegTotalChars * 100);
                  const segTokens = charsToTokens(seg.charCount);
                  const diffEntry = diffByHash.get(seg.rawHash);
                  const cacheBadge = CACHE_BADGE[seg.cacheHint];
                  const deltaStr = diffEntry && diffEntry.op !== "unchanged"
                    ? (diffEntry.op === "added" ? "+" : diffEntry.op === "removed" ? "−" : diffEntry.charDelta >= 0 ? "+" : "") + fmtK(charsToTokens(Math.abs(diffEntry.charDelta)))
                    : null;
                  const deltaColor = diffEntry?.op === "removed" ? "#dc2626" : "#d97706";

                  return (
                    <div
                      key={seg.id}
                      onClick={() => handleSegClick(seg.id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "7px 12px",
                        borderBottom: i < activeSectionSegs.length - 1 ? "1px solid #f3f4f6" : "none",
                        cursor: "pointer", background: "#fff",
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#f9fafb"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "#fff"; }}
                    >
                      {/* mini proportion bar */}
                      <div style={{ width: 48, height: 4, background: "#f3f4f6", borderRadius: 2, overflow: "hidden", flexShrink: 0 }}>
                        <div style={{ width: `${segPct}%`, height: "100%", background: secColor + "80" }} />
                      </div>
                      <span style={{ fontSize: 11, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {seg.label}
                      </span>
                      {seg.role && <span style={{ fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>{seg.role}</span>}
                      {deltaStr && <span style={{ fontSize: 10, fontWeight: 600, color: deltaColor, flexShrink: 0, width: 48, textAlign: "right" }}>{deltaStr}</span>}
                      <span style={{ fontSize: 11, fontWeight: 600, color: "#374151", width: 42, textAlign: "right", flexShrink: 0 }}>~{fmtK(segTokens)}</span>
                      <span style={{ fontSize: 10, color: "#9ca3af", width: 28, textAlign: "right", flexShrink: 0 }}>{segPct}%</span>
                      {cacheBadge
                        ? <span style={{ fontSize: 9, color: cacheBadge.color, background: cacheBadge.bg, border: `1px solid ${cacheBadge.border}`, borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>{cacheBadge.label}</span>
                        : <span style={{ width: 58 }} />
                      }
                    </div>
                  );
                })}
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

        return (
          <div style={{ border: `1px solid ${secColor}40`, borderLeft: `3px solid ${secColor}`, borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
            {/* Detail header */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", background: "#fafafa", borderBottom: "1px solid #f3f4f6" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {activeSeg.label}
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {[
                    { label: "~" + fmtK(segTokens) + " tokens", color: "#374151" },
                    { label: segPct + "% of section",            color: "#9ca3af" },
                    { label: activeSeg.charCount.toLocaleString() + " chars", color: "#9ca3af" },
                    activeSeg.category !== activeSeg.section ? { label: activeSeg.category, color: "#9ca3af" } : null,
                    activeSeg.role ? { label: activeSeg.role, color: "#9ca3af" } : null,
                  ].filter(Boolean).map(item => (
                    <span key={item!.label} style={{ fontSize: 10, color: item!.color }}>{item!.label}</span>
                  ))}
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
              <button onClick={() => setActiveSegId(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#9ca3af", lineHeight: 1, padding: "0 2px", flexShrink: 0 }}>×</button>
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

type CallTab = "attribution" | "diff" | "request" | "response-tools" | "raw";
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

// ─── Diff vs Previous Tab ────────────────────────────────────────────────────

function DiffVsPreviousTab({
  ranges, diff, callDetailLoading, prevCallId,
  selectedRangeId, onSelectRange,
}: {
  ranges: AttributedDiffRange[];
  diff: import("./drilldown-types").SegmentDiff[] | null;
  callDetailLoading: boolean;
  prevCallId: number | null;
  selectedRangeId: string | null;
  onSelectRange: (r: AttributedDiffRange) => void;
}) {
  const [mode, setMode] = useState<DiffMode>("segment");

  const addedTokens    = ranges.filter(r => r.changeType === "added").reduce((s, r) => s + r.tokens, 0);
  const removedTokens  = Math.abs(ranges.filter(r => r.changeType === "removed").reduce((s, r) => s + r.tokens, 0));
  const retainedTokens = ranges.filter(r => r.changeType === "retained").reduce((s, r) => s + r.tokens, 0);
  const netDelta = addedTokens - removedTokens;

  // Sort added ranges by token count descending for "top contributors"
  const topContributors = [...ranges]
    .filter(r => r.changeType === "added" && r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  return (
    <div>
      {/* Summary strip */}
      <div style={{ background: "#f9fafb", border: "1px solid #f3f4f6", borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
        {prevCallId != null && (
          <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 8 }}>Compared with Call #{prevCallId}</div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 12 }}>
          {[
            { label: "Net Δ",    value: `${netDelta >= 0 ? "+" : ""}${fmtK(netDelta)}`,     color: netDelta > 0 ? "#d97706" : "#16a34a" },
            { label: "Added",    value: `+${fmtK(addedTokens)}`,    color: "#16a34a" },
            { label: "Removed",  value: removedTokens > 0 ? `−${fmtK(removedTokens)}` : "—", color: "#dc2626" },
            { label: "Retained", value: fmtK(retainedTokens),        color: "#9ca3af" },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color }}>{value}</div>
              <div style={{ fontSize: 9, color: "#9ca3af", marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
        {topContributors.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: "#6b7280", fontWeight: 600, marginBottom: 6 }}>Top contributors</div>
            {topContributors.map(r => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <div style={{ width: 7, height: 7, borderRadius: 1, background: CATEGORY_COLORS[r.category] ?? "#e5e7eb", flexShrink: 0 }} />
                <span style={{ fontSize: 10, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.sourceEvent?.label ?? r.category}
                </span>
                <span style={{ fontSize: 10, fontWeight: 600, color: "#d97706", flexShrink: 0 }}>+{fmtK(r.tokens)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mode selector */}
      <div style={{ display: "flex", gap: 2, marginBottom: 12, background: "#f3f4f6", borderRadius: 6, padding: 3, width: "fit-content" }}>
        {(["segment", "range", "raw"] as DiffMode[]).map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: "4px 10px", fontSize: 10, fontWeight: mode === m ? 700 : 400,
            color: mode === m ? "#6366f1" : "#6b7280",
            background: mode === m ? "#fff" : "transparent",
            border: "none", borderRadius: 4, cursor: "pointer",
            boxShadow: mode === m ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
          }}>
            {m === "segment" ? "Segment" : m === "range" ? "Range" : "Raw"}
          </button>
        ))}
      </div>

      {/* Segment mode — reuse AttributedDiffTable */}
      {mode === "segment" && (
        <AttributedDiffTable ranges={ranges} selectedId={selectedRangeId} onSelect={onSelectRange} />
      )}

      {/* Range mode — show attributed ranges with char offsets */}
      {mode === "range" && (
        <div>
          {ranges.filter(r => r.changeType !== "retained").map((r, i) => {
            const CHANGE_CFG: Record<string, { color: string; icon: string; bg: string }> = {
              added: { color: "#16a34a", icon: "+", bg: "#f0fdf4" },
              removed: { color: "#dc2626", icon: "−", bg: "#fef2f2" },
              changed: { color: "#d97706", icon: "~", bg: "#fffbeb" },
              reclassified: { color: "#7c3aed", icon: "⇄", bg: "#faf5ff" },
              moved: { color: "#3b82f6", icon: "→", bg: "#eff6ff" },
            };
            const cfg = CHANGE_CFG[r.changeType] ?? { color: "#9ca3af", icon: "·", bg: "#f9fafb" };
            const isSelected = r.id === selectedRangeId;
            return (
              <div key={r.id} onClick={() => onSelectRange(r)} style={{
                padding: "8px 12px", borderRadius: 6, marginBottom: 6, cursor: "pointer",
                background: isSelected ? "#eff6ff" : cfg.bg,
                border: `1px solid ${isSelected ? "#6366f1" : cfg.color + "30"}`,
                borderLeft: `3px solid ${isSelected ? "#6366f1" : cfg.color}`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: cfg.color, width: 14 }}>{cfg.icon}</span>
                  <span style={{ fontSize: 10, color: CATEGORY_COLORS[r.category] ?? "#6b7280", fontWeight: 600 }}>{r.category}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sourceEvent?.label ?? r.textPreview.slice(0, 40)}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: cfg.color, flexShrink: 0 }}>
                    {r.changeType === "added" ? "+" : r.changeType === "removed" ? "−" : ""}{fmtK(Math.abs(r.tokens))}
                  </span>
                </div>
                {(r.currentRange || r.previousRange) && (
                  <div style={{ fontSize: 9, color: "#9ca3af", fontFamily: "monospace", marginLeft: 22, marginTop: 2 }}>
                    {r.currentRange && `chars ${r.currentRange.startChar.toLocaleString()}–${r.currentRange.endChar.toLocaleString()}`}
                    {r.previousRange && r.currentRange && " (prev: "}
                    {r.previousRange && !r.currentRange && "prev: "}
                    {r.previousRange && `${r.previousRange.startChar.toLocaleString()}–${r.previousRange.endChar.toLocaleString()}`}
                    {r.previousRange && r.currentRange && ")"}
                    <span style={{ marginLeft: 8, color: CONF_COLOR[r.confidence], fontWeight: 700 }}>{CONF_ICON[r.confidence]} {r.confidence}</span>
                  </div>
                )}
              </div>
            );
          })}
          {ranges.filter(r => r.changeType !== "retained").length === 0 && (
            <div style={{ fontSize: 11, color: "#9ca3af", textAlign: "center", padding: "24px 0" }}>No changed ranges</div>
          )}
        </div>
      )}

      {/* Raw mode — proxy diff */}
      {mode === "raw" && (
        <div>
          {callDetailLoading && <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0" }}>Loading proxy diff…</div>}
          {!callDetailLoading && !diff && (
            <div style={{ fontSize: 11, color: "#9ca3af", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 5, padding: "8px 10px" }}>
              No proxy data available. Run with proxy enabled to see raw segment diff.
            </div>
          )}
          {!callDetailLoading && diff && <ProxyDiffView diff={diff} />}
        </div>
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

function LlmCallDetailPanel({
  call, sessionId,
}: { call: MockLlmCall; onSelectEntry: (e: MockDiffEntry) => void; sessionId: string }) {
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
    { id: "attribution",    label: "Attribution" },
    { id: "diff",           label: "Diff vs Previous" },
    { id: "request",        label: "Request" },
    { id: "response-tools", label: "Response & Tools" },
    { id: "raw",            label: "Raw / Evidence" },
  ];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px", minWidth: 0 }}>

      {/* ── Compact Header ──────────────────────── */}
      <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid #f3f4f6" }}>

        {/* Title row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>Call #{call.id}</span>
          <span style={{ fontSize: 10, color: "#9ca3af" }}>#{call.indexInTurn} in turn</span>
          {call.isCompaction && <RiskBadge type="compaction" />}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>{call.model ? shortModelName(call.model) : "—"}</span>
            <span style={{ fontSize: 10, color: "#9ca3af" }}>
              {call.timestamp ? fmtDateShort(call.timestamp) : "—"}
            </span>
            {call.stopReason && (
              <span style={{ fontSize: 9, color: "#6b7280", background: "#f3f4f6", borderRadius: 3, padding: "1px 6px" }}>
                stop: {call.stopReason}
              </span>
            )}
            {call.proxy?.durationMs != null && (
              <span style={{ fontSize: 9, color: "#6b7280" }}>{call.proxy.durationMs >= 1000 ? `${(call.proxy.durationMs / 1000).toFixed(1)}s` : `${call.proxy.durationMs}ms`}</span>
            )}
            {/* Proxy status — only show when loaded and no proxy */}
            {!callDetailLoading && !hasProxy && (
              <span style={{ fontSize: 9, color: "#d97706", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 3, padding: "1px 6px" }}>
                no proxy · <a href="/settings" style={{ color: "#d97706", textDecoration: "underline" }}>enable dump</a>
              </span>
            )}
          </div>
        </div>

        {/* Inline metric row — compact, single line */}
        <div style={{ display: "flex", gap: 0, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
          {[
            { label: "Context",     value: fmtK(call.contextSize),
              color: nearLimit ? "#ea580c" : "#111827",
              tooltip: "Total input context (fresh + cache_read + cache_write)" },
            { label: "Δ vs prev",   value: `${call.significantDelta >= 0 ? "+" : ""}${fmtK(call.significantDelta)}`,
              color: call.significantDelta > 10000 ? "#dc2626" : call.significantDelta > 2000 ? "#d97706" : call.significantDelta < -2000 ? "#16a34a" : "#111827",
              tooltip: "Context size delta vs previous call" },
            { label: "Cache Read",  value: fmtK(call.cacheRead),  color: "#111827", tooltip: "cache_read_input_tokens" },
            { label: "Cache Write", value: fmtK(call.cacheWrite), color: "#111827", tooltip: "cache_creation_input_tokens" },
            { label: "Fresh In",    value: fmtK(freshIn),         color: "#111827", tooltip: "Non-cached input (context − cache_read − cache_write)" },
            { label: "Fresh Out",   value: fmtK(call.outputTokens), color: "#111827", tooltip: "output_tokens" },
          ].map(({ label, value, color, tooltip }, i, arr) => (
            <div key={label} title={tooltip} style={{
              flex: 1, padding: "6px 10px", borderRight: i < arr.length - 1 ? "1px solid #e5e7eb" : "none",
              minWidth: 0,
            }}>
              <div style={{ fontSize: 9, color: "#9ca3af", whiteSpace: "nowrap", marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
            </div>
          ))}
        </div>
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

      {/* ══ Attribution ══════════════════════════════ */}
      {tab === "attribution" && (
        callDetailLoading ? (
          <div style={{ fontSize: 11, color: "#9ca3af", padding: "32px 0", textAlign: "center" }}>Loading…</div>
        ) : realSegments ? (
          <RealSegmentTree
            segments={realSegments}
            diff={callDetail?.diff ?? null}
            call={call}
          />
        ) : (
          <div style={{ padding: "24px 0", textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>No proxy data — segment breakdown unavailable</div>
            <div style={{ fontSize: 10, color: "#9ca3af" }}>
              Token counts from JSONL:{" "}
              <span style={{ fontWeight: 600, color: "#374151" }}>{fmtK(call.contextSize)}</span> context ·{" "}
              <span style={{ fontWeight: 600, color: "#374151" }}>{fmtK(call.cacheRead)}</span> cache read ·{" "}
              <span style={{ fontWeight: 600, color: "#374151" }}>{fmtK(call.cacheWrite)}</span> cache write ·{" "}
              <span style={{ fontWeight: 600, color: "#374151" }}>{fmtK(freshIn)}</span> fresh in
            </div>
            <div style={{ marginTop: 14, fontSize: 10, color: "#d97706" }}>
              <a href="/settings" style={{ color: "#d97706" }}>Enable proxy dump</a> to see per-segment breakdown
            </div>
          </div>
        )
      )}

      {/* ══ Diff vs Previous ══════════════════════════ */}
      {tab === "diff" && (
        <DiffVsPreviousTab
          ranges={attrRanges}
          diff={callDetail?.diff ?? null}
          callDetailLoading={callDetailLoading}
          prevCallId={prevCallId}
          selectedRangeId={null}
          onSelectRange={() => {}}
        />
      )}

      {/* ══ Request ════════════════════════════════════ */}
      {tab === "request" && (
        <RequestTab call={call} callDetail={callDetail} callDetailLoading={callDetailLoading} />
      )}

      {/* ══ Response & Tools ═══════════════════════════ */}
      {tab === "response-tools" && (
        <div>
          <SectionLabel>Produced</SectionLabel>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
            {response.hasThinking && (
              <div style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6", background: "#faf5ff" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", background: "#f3e8ff", borderRadius: 3, padding: "1px 5px" }}>thinking</span>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>Extended Thinking</span>
                </div>
                <div style={{ fontSize: 11, color: "#7c3aed", fontStyle: "italic", lineHeight: 1.5 }}>
                  {response.thinkingPreview}<span style={{ color: "#c4b5fd" }}> … [redacted]</span>
                </div>
              </div>
            )}
            {response.toolUseBlocks.map(tu => (
              <div key={tu.id} style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6", background: "#fffbeb" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#d97706", background: "#fef3c7", borderRadius: 3, padding: "1px 5px" }}>tool_use</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#92400e" }}>{tu.name}</span>
                  <code style={{ fontSize: 10, color: "#9ca3af" }}>{tu.id}</code>
                </div>
                <pre style={{ fontSize: 10, color: "#374151", margin: 0, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.5 }}>{tu.input}</pre>
              </div>
            ))}
            <div style={{ padding: "8px 14px", background: "#f9fafb", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 9, color: "#6b7280", background: "#e5e7eb", borderRadius: 3, padding: "1px 5px" }}>stop: {response.stopReason}</span>
              <span style={{ fontSize: 10, color: "#9ca3af" }}>{fmtK(response.outputTokens)} output tokens</span>
            </div>
            {response.textOutput && (
              <div style={{ padding: "10px 14px", background: "#f0fdf4", borderTop: "1px solid #f3f4f6" }}>
                <div style={{ fontSize: 12, color: "#14532d", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{response.textOutput}</div>
              </div>
            )}
          </div>
          <SectionLabel>Feeds Next Call</SectionLabel>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
            {response.toolUseBlocks.map(tu => (
              <div key={tu.id} style={{ padding: "8px 14px", borderBottom: "1px solid #f3f4f6", display: "flex", gap: 10 }}>
                <span style={{ fontSize: 10, color: "#d97706", fontWeight: 700, width: 80, flexShrink: 0, paddingTop: 1 }}>tool_result</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>{tu.name}() → Tool Output</div>
                  <div style={{ fontSize: 10, color: "#9ca3af" }}>{tu.id}</div>
                </div>
              </div>
            ))}
            {response.textOutput && (
              <div style={{ padding: "8px 14px", borderBottom: "1px solid #f3f4f6", display: "flex", gap: 10 }}>
                <span style={{ fontSize: 10, color: "#16a34a", fontWeight: 700, width: 80, flexShrink: 0, paddingTop: 1 }}>→ history</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>Assistant response → history</div>
                  <div style={{ fontSize: 10, color: "#9ca3af" }}>+{fmtK(response.outputTokens)} tokens</div>
                </div>
              </div>
            )}
            {call.cacheWrite > 0 && (
              <div style={{ padding: "8px 14px", display: "flex", gap: 10 }}>
                <span style={{ fontSize: 10, color: "#6366f1", fontWeight: 700, width: 80, flexShrink: 0, paddingTop: 1 }}>cache write</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>→ cache read next call</div>
                  <div style={{ fontSize: 10, color: "#9ca3af" }}>{fmtK(call.cacheWrite)} tokens</div>
                </div>
              </div>
            )}
          </div>
        </div>
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
}: {
  drilldown: SessionDrilldown | null;
  loadState: "loading" | "ok" | "error";
}) {
  const [innerTurn, setInnerTurn] = useState<UserTurn | null>(null);
  const [innerCall, setInnerCall] = useState<LlmCall | null>(null);

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

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* Mini left nav for sub-session turns */}
      <div style={{ width: 160, borderRight: "1px solid #f3f4f6", overflowY: "auto", flexShrink: 0, background: "#fafafa" }}>
        <div style={{ padding: "10px 10px 4px", fontSize: 9, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>SUB-SESSION TURNS</div>
        {turns.map(t => (
          <div
            key={t.id}
            onClick={() => { setInnerTurn(t); setInnerCall(null); }}
            style={{
              padding: "6px 10px", cursor: "pointer",
              background: innerTurn?.id === t.id ? "#eff6ff" : "transparent",
              borderLeft: innerTurn?.id === t.id ? "2px solid #6366f1" : "2px solid transparent",
            }}
            onMouseEnter={e => { if (innerTurn?.id !== t.id) e.currentTarget.style.background = "#f9fafb"; }}
            onMouseLeave={e => { if (innerTurn?.id !== t.id) e.currentTarget.style.background = "transparent"; }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>Turn {t.id}</div>
            <div style={{ fontSize: 10, color: "#9ca3af" }}>{t.llmCallCount} calls · {t.netContextDelta > 0 ? "+" : ""}{fmtK(t.netContextDelta)}</div>
          </div>
        ))}
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {!innerTurn && (
          <SessionOverviewPanel turns={turns} drilldown={drilldown} onSelectTurn={t => { setInnerTurn(t); setInnerCall(null); }} />
        )}
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

interface Props {
  session: SessionV2;
  onClose: () => void;
}

export function SessionDetailV2({ session, onClose }: Props) {
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

  const title = getSessionDisplayName(session, drilldown?.title);

  function handleSelectTurn(turn: MockUserTurn) {
    setSelectedTurn(turn);
    setSelectedCall(null);
    setNavLevel("turn");
    setInspector({ type: "turn-rollup", turn });
  }

  function handleSelectCall(call: MockLlmCall) {
    setSelectedCall(call);
    setNavLevel("call");
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
    setInspector({ type: "hotspots" });
  }

  function handleSelectInterTurnBlock(block: InterTurnBlock) {
    setSelectedInterTurnBlock(block);
    setSelectedTurn(null);
    setSelectedCall(null);
    setNavLevel("inter-turn");
  }

  function handleNavTurn(turn: MockUserTurn) {
    setSelectedTurn(turn);
    setSelectedCall(null);
    setNavLevel("turn");
    setInspector({ type: "turn-rollup", turn });
  }

  function handleSelectSubAgent(sa: SubAgentSummary) {
    setSelectedSubAgent(sa);
    setNavLevel("subagent");
    setSubAgentDrilldown(null);
    setSubAgentLoadState("loading");
    apiV2.subAgentDrilldown(session.session_id, sa.agentFileId)
      .then(data => { setSubAgentDrilldown(data); setSubAgentLoadState("ok"); })
      .catch(() => setSubAgentLoadState("error"));
  }

  const allCallsForNav = selectedTurn?.calls ?? [];

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "flex-start", justifyContent: "flex-end" }}
      onClick={onClose}
    >
      <div
        style={{ width: "calc(100vw - 200px)", maxWidth: 1200, height: "100%", background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.12)", display: "flex", flexDirection: "column" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid #e5e7eb", flexShrink: 0, background: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button onClick={handleNavSession} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: navLevel === "session" ? "#6366f1" : "#374151" }}>{title}</span>
            </button>
            {selectedTurn && (
              <>
                <span style={{ color: "#d1d5db" }}>›</span>
                <button onClick={() => handleNavTurn(selectedTurn)} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: navLevel === "turn" && !selectedCall ? "#6366f1" : "#374151" }}>Turn {selectedTurn.id}</span>
                </button>
              </>
            )}
            {selectedCall && (
              <>
                <span style={{ color: "#d1d5db" }}>›</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#6366f1" }}>Call #{selectedCall.id}</span>
              </>
            )}
            {selectedSubAgent && navLevel === "subagent" && (
              <>
                <span style={{ color: "#d1d5db" }}>›</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#6366f1" }}>{selectedSubAgent.agentType}</span>
              </>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {loadState === "loading" && (
              <span style={{ fontSize: 10, color: "#6366f1", background: "#eff6ff", borderRadius: 4, padding: "2px 8px" }}>loading…</span>
            )}
            {loadState === "error" && (
              <span style={{ fontSize: 10, color: "#dc2626", background: "#fef2f2", borderRadius: 4, padding: "2px 8px" }}>API error — showing mock</span>
            )}
            {loadState === "ok" && isMockData && (
              <span style={{ fontSize: 10, color: "#9ca3af", background: "#f9fafb", border: "1px dashed #d1d5db", borderRadius: 4, padding: "2px 6px" }}>mock data</span>
            )}
            {loadState === "ok" && !isMockData && (
              <span style={{ fontSize: 10, color: "#16a34a", background: "#f0fdf4", borderRadius: 4, padding: "2px 8px" }}>
                {drilldown!.hasProxyData ? "real + proxy" : "real · no proxy"}
              </span>
            )}
            <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", color: "#9ca3af", fontSize: 20, lineHeight: 1, padding: 4 }}>×</button>
          </div>
        </div>

        {/* Body: Left Nav + Main + Inspector */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Left Nav */}
          <div style={{ width: 200, borderRight: "1px solid #e5e7eb", overflowY: "auto", flexShrink: 0, background: "#fafafa" }}>
            <div style={{ padding: "12px 12px 4px", fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>SESSION</div>
            <NavItem
              label="Overview"
              active={navLevel === "session"}
              onClick={handleNavSession}
            />

            <div style={{ padding: "10px 12px 4px", fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>USER TURNS</div>
            {(() => {
              // Build an interleaved list: turns + interTurnBlocks sorted by position
              // interTurnBlocks with nextTurnId go before that turn; prevTurnId-only go after last turn
              const items: Array<{ type: "turn"; turn: MockUserTurn } | { type: "itb"; block: InterTurnBlock }> = [];
              for (const turn of turns) {
                // Insert any interTurnBlock that comes before this turn (nextTurnId === turn.id)
                for (const block of interTurnBlocks) {
                  if (block.nextTurnId === turn.id) {
                    items.push({ type: "itb", block });
                  }
                }
                items.push({ type: "turn", turn });
              }
              // Append trailing blocks (nextTurnId === null, after last turn)
              for (const block of interTurnBlocks) {
                if (block.nextTurnId === null && block.prevTurnId !== null) {
                  items.push({ type: "itb", block });
                }
              }

              return items.map(item => {
                if (item.type === "turn") {
                  const turn = item.turn;
                  const isThisTurnSelected = selectedTurn?.id === turn.id;
                  const turnInput = turn.userInput.trim();
                  const turnLabel = `T${turn.id} ${turnInput.slice(0, 14).trimEnd()}${turnInput.length > 14 ? "…" : ""}`;
                  return (
                    <React.Fragment key={`turn-${turn.id}`}>
                      <NavItem
                        label={turnLabel}
                        sublabel={`${turn.netContextDelta > 0 ? "+" : ""}${fmtK(turn.netContextDelta)} · ${turn.llmCallCount} calls`}
                        active={navLevel === "turn" && isThisTurnSelected && !selectedCall}
                        badge={turn.hasCompaction ? "C" : turn.errorCount > 0 ? "E" : turn.hasUnknownSpike ? "!" : undefined}
                        badgeColor={turn.hasCompaction ? "#ef4444" : turn.errorCount > 0 ? "#dc2626" : "#94a3b8"}
                        onClick={() => handleSelectTurn(turn)}
                      />
                      {isThisTurnSelected && allCallsForNav.length > 0 && allCallsForNav.map(call => (
                        <NavItem
                          key={call.id}
                          indent
                          label={call.isCompaction ? `#${call.id} compact` : `#${call.id}`}
                          sublabel={call.isSignificant ? `+${fmtK(call.significantDelta ?? 0)}` : fmtK(call.contextSize)}
                          active={selectedCall?.id === call.id}
                          badge={call.isCompaction ? "◆" : call.isSignificant ? "●" : undefined}
                          badgeColor={call.isCompaction ? "#ef4444" : "#3b82f6"}
                          onClick={() => handleSelectCall(call)}
                        />
                      ))}
                    </React.Fragment>
                  );
                } else {
                  const block = item.block;
                  const isSelected = navLevel === "inter-turn" && selectedInterTurnBlock?.index === block.index;
                  return (
                    <InterTurnNavItem
                      key={`itb-${block.index}`}
                      block={block}
                      active={isSelected}
                      onClick={() => handleSelectInterTurnBlock(block)}
                    />
                  );
                }
              });
            })()}
          </div>

          {/* Main Canvas */}
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
            {navLevel === "session" && (
              <SessionOverviewPanel turns={turns} drilldown={drilldown} onSelectTurn={handleSelectTurn} />
            )}
            {navLevel === "turn" && selectedTurn && !selectedCall && (
              <UserTurnDetailPanel turn={selectedTurn} onSelectCall={handleSelectCall} isMockSession={isMockData} onSubAgentClick={handleSelectSubAgent}
                trailingInterTurnBlock={interTurnBlocks.find(b => b.prevTurnId === selectedTurn.id && b.nextTurnId !== selectedTurn.id) ?? null}
              />
            )}
            {navLevel === "inter-turn" && selectedInterTurnBlock && (
              <InterTurnBlockPanel block={selectedInterTurnBlock} />
            )}
            {navLevel === "call" && selectedCall && (
              <LlmCallDetailPanel call={selectedCall} onSelectEntry={handleSelectEntry} sessionId={session.session_id} />
            )}
            {navLevel === "subagent" && (
              <SubAgentSessionPanel drilldown={subAgentDrilldown} loadState={subAgentLoadState} />
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

function NavItem({
  label, sublabel, active, badge, badgeColor, onClick, indent,
}: {
  label: string; sublabel?: string; active: boolean;
  badge?: string; badgeColor?: string; onClick: () => void;
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
      {badge && <span style={{ fontSize: 10, color: badgeColor, fontWeight: 700, flexShrink: 0 }}>{badge}</span>}
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
            { label: "After Turn", value: block.prevTurnId !== null ? `T${block.prevTurnId}` : "—" },
            { label: "Before Turn", value: block.nextTurnId !== null ? `T${block.nextTurnId}` : "none" },
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
