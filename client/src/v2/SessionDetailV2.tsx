import { useTranslation } from "react-i18next";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { scaleLinear, scaleSqrt, line as d3line, curveCatmullRom } from "d3";
import { TurnMinimap } from "./TurnMinimap";
import type { SessionV2 } from "./types";
import type { DiffEntry, IntervalEvent, IntervalEventKind, LlmCall, ModelStats, SessionDrilldown, ToolCallSlot, UserTurn, InterTurnBlock, CompactEvent, CallDetail } from "./drilldown-types";
import { apiV2 } from "./api";
import proxyMissingUrl from "../assets/proxy-missing.png";
import {
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
import { AttributionTreeLensPanel } from "./AttributionTreeLensPanel";
import { ResponseTreePanel } from "./ResponseTreePanel";
// DiffPanel / CachePanel 旧入口已合并到 AttributionTreeLensPanel 的多 lens 视角中。
// 这两个组件文件保留但不再有 tab 入口。
import { TOKEN_METRICS } from "./metricRegistry";
import {
  HeaderStatRow,
  UnifiedHeader,
  StatusBadgeStrip,
  type StatusBadge,
  type StatusBadgeKind,
} from "./shared/HeaderStats";
import { CallLedger } from "./shared/CallLedger";
import { EventUnitCard, ForwardArrowIcon, LinkIcon, SegmentView } from "./shared/EventUnitCard";
import { AttributionGraphProvider, AuditBoundaryStatus, LinkedPanelScope, useAttributionGraph } from "./attribution-graph-context";
import { SegmentedToggle } from "./shared/SegmentedToggle";
import { getToolPalette } from "./shared/toolRegistry";
import { CHART_COLORS, TOOLTIP_PRESET, brandAreaGradient } from "./shared/chart-theme";
import { CodeBlock } from "./shared/CodeBlock";
import { EVENT_PALETTES } from "./shared/eventPalette";
import { NoProxyDot } from "./shared/NoProxyDot";

// Local aliases for brevity (same as drilldown-types, no local re-declaration needed)
type MockDiffEntry = DiffEntry;
// LlmCall fields added in drilldown-types are optional in the raw fallback
// data below; normalizeTurns() fills them in.
type RawMockCall = Omit<LlmCall,
  "indexInTurn" | "messageId" | "apiRequestId" | "jsonlLineIdx" | "jsonlFrameLineIdxs" |
  "model" | "stopReason" | "proxy" | "proxyMatchMode" | "subAgents" |
  "isCompaction" | "isUnknownHeavy" | "isSignificant" | "significantDelta" | "freshIn" |
  "toolNames" | "toolCalls" | "assistantText" | "intervalEvents"
> & {
  isCompaction?: boolean; isUnknownHeavy?: boolean; isSignificant?: boolean;
  significantDelta?: number; freshIn?: number; toolNames?: string[];
};
type RawMockTurn = Omit<UserTurn, "startedAt" | "endedAt" | "hasCompaction" | "hasUnknownSpike" | "finalOutput" | "durationMs" | "midTurnInjections" | "errorCount" | "userInputLineIdx" | "calls"> & {
  hasCompaction?: boolean; hasUnknownSpike?: boolean; errorCount?: number; midTurnInjections?: UserTurn["midTurnInjections"]; userInputLineIdx?: number | null; calls: RawMockCall[];
};
type MockLlmCall = LlmCall;
type MockUserTurn = UserTurn;

function normalizeTurns(raw: RawMockTurn[]): UserTurn[] {
  return raw.map((t) => ({
    startedAt: "",
    endedAt: "",
    finalOutput: null,
    durationMs: 0,
    userInputLineIdx: t.userInputLineIdx ?? null,
    hasCompaction: t.hasCompaction ?? false,
    hasUnknownSpike: t.hasUnknownSpike ?? false,
    errorCount: t.errorCount ?? 0,
    ...t,
    midTurnInjections: t.midTurnInjections ?? [],
    calls: t.calls.map((c, ci) => ({
      ...c,
      indexInTurn: ci + 1,
      messageId: null,
      apiRequestId: null,
      jsonlLineIdx: null,
      jsonlFrameLineIdxs: [],
      model: "claude-opus-4-7",
      stopReason: "end_turn" as const,
      proxy: null,
      proxyMatchMode: "unmatched" as const,
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
  noProxy: (_size: number, color: string) => (
    <span style={{
      width: 5, height: 5, borderRadius: "50%",
      background: color, display: "inline-block", flexShrink: 0,
    }} />
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

// Bridge between StatusBadgeStrip (which takes a renderIcon callback so the
// shared module doesn't depend on SessionDetailV2) and BADGE_ICONS above.
function renderStatusIcon(kind: StatusBadgeKind, px: number, color: string): React.ReactNode {
  switch (kind) {
    case "compaction": return BADGE_ICONS.compaction(px, color);
    case "error":      return BADGE_ICONS.error(px, color);
    case "subAgent":   return BADGE_ICONS.subAgent(px, color);
    case "command":    return BADGE_ICONS.command(px, color);
    case "unknown":    return BADGE_ICONS.unknown(px, color);
    case "noProxy":    return BADGE_ICONS.noProxy(px, color);
  }
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
        <HotspotCard icon="↑" label={t("sessionOverview.hotspots.largestGrowth")} value={`${t("sessionOverview.turn.label")} ${biggestTurn.id} · +${fmtK(biggestTurn.netContextDelta)}`} color="#d97706" />
        <HotspotCard icon="▲" label={t("sessionOverview.hotspots.peakContext")} value={`${t("sessionOverview.turn.label")} ${biggestPeak.id} · ${fmtK(biggestPeak.peakContext)}`} color="#6366f1" />
        <HotspotCard icon="?" label={t("sessionOverview.hotspots.largestUnknown")} value={`${t("sessionOverview.turn.label")} ${unknownTurn.id} · +${fmtK(unknownTurn.unknownDelta)}`} color="#94a3b8" />
        {compactionTurns.length > 0 && (
          <HotspotCard icon="◆" label={t("sessionOverview.hotspots.compactionTurns")} value={compactionTurns.map(turn => `${t("sessionOverview.turn.label")} ${turn.id}`).join(", ")} color="#ef4444" />
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
  // totalFreshIn ≡ SUM of every call's API usage.input_tokens — the
  // non-cached fresh input (1x billing). The server now sums the actual
  // usage field directly (post-fix), so we trust sm.totalFreshIn; fallback
  // computes the same value locally from each call's freshIn field.
  const totalFreshIn = sm?.totalFreshIn ?? turns.reduce(
    (s, t) => s + t.calls.reduce((cs, c) => cs + c.freshIn, 0),
    0,
  );
  const totalFreshOut    = sm?.totalFreshOut    ?? null;
  const systemErrors     = sm?.systemErrorCount ?? null;
  const durationStr      = sm?.durationStr      ?? "—";
  // Re-derive cache ratio from the locally-computed totals so denominator
  // matches what we render (input + cacheRead + cacheWrite). Falls back to
  // the server's cacheRatio when no calls are available.
  const cacheInputTotal  = totalFreshIn + totalCacheRead + totalCacheWrite;
  const cacheRatio       = cacheInputTotal > 0
    ? (totalCacheRead / cacheInputTotal) * 100
    : sm?.cacheRatio ?? null;
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
    const noProxyCalls     = turns.reduce((s, t) => s + t.calls.filter(c => c.proxyMatchMode === "unmatched").length, 0);
    return { compactionCount, errorCount, subAgentTurns, subAgentTotal, commandTurns, unknownTurns, noProxyCalls };
  }, [turns, compactionTurns]);

  const [modelsExpanded, setModelsExpanded] = React.useState(false);
  const multiModel = modelBreakdown && Object.keys(modelBreakdown).length > 1;
  const singleModel = modelBreakdown && Object.keys(modelBreakdown).length === 1
    ? Object.keys(modelBreakdown)[0] : null;

  // Build status badges (icon + count, unified across Session/Turn/Call/nav)
  const sessionStatusBadges: StatusBadge[] = (() => {
    if (isMock) return [];
    const { compactionCount, errorCount, subAgentTotal, commandTurns, unknownTurns, noProxyCalls } = badgeSummary;
    const items: StatusBadge[] = [];
    if (compactionCount > 0) items.push({ kind: "compaction", count: compactionCount, tooltip: t("sessionOverview.badges.compaction") });
    if (errorCount > 0)      items.push({ kind: "error",      count: errorCount,      tooltip: t("sessionOverview.badges.errors") });
    if (subAgentTotal > 0)   items.push({ kind: "subAgent",   count: subAgentTotal,   tooltip: t("sessionOverview.badges.subAgents") });
    if (commandTurns > 0)    items.push({ kind: "command",    count: commandTurns,    tooltip: t("sessionOverview.badges.commands") });
    if (unknownTurns > 0)    items.push({ kind: "unknown",    count: unknownTurns,    tooltip: t("sessionOverview.badges.unknown") });
    if (noProxyCalls > 0)    items.push({ kind: "noProxy",    count: noProxyCalls,    tooltip: t("sessionOverview.badges.noProxyDetail", { count: noProxyCalls }) });
    return items;
  })();

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* ── Overview: stats · ledger · badges in one flex row ─────── */}
      <UnifiedHeader
        stats={[
          { label: t("sessionOverview.activity.userTurns"), value: String(drilldown?.turns.length ?? turns.length) },
          { label: t("sessionOverview.activity.llmCalls"),  value: String(totalCalls) },
          { label: t("sessionOverview.activity.toolCalls"), value: String(totalToolCalls) },
          { label: t("sessionOverview.activity.duration"),  value: durationStr },
        ]}
        ledger={{
          mode: "aggregate",
          freshIn: totalFreshIn ?? 0,
          cacheRead: totalCacheRead,
          cacheWrite: totalCacheWrite,
          output: totalFreshOut ?? 0,
          cacheRatio,
        }}
        rightSlot={
          <>
            <StatusBadgeStrip badges={sessionStatusBadges} renderIcon={renderStatusIcon} />
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
                  fontSize: 11, padding: "3px 8px", borderRadius: 6,
                  border: "1px solid #e5e7eb", background: modelsExpanded ? "#eef2ff" : "#f9fafb",
                  color: modelsExpanded ? "#6366f1" : "#6b7280", cursor: "pointer",
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
          </>
        }
      />


      {/* Models expanded panel — kept outside UnifiedHeader since it spans full width */}
      {multiModel && modelsExpanded && (
        <div style={{ marginTop: -8, marginBottom: 12 }}>
          <ModelBreakdownBlock breakdown={modelBreakdown!} />
        </div>
      )}

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
              {dist.map(entry => {
                const accent = getToolPalette(entry.name).accent;
                return (
                  <div key={entry.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <span style={{ fontSize: 11, color: "#374151", width: 120, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                    <div style={{ flex: 1, height: 5, background: "#f3f4f6", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ width: `${(entry.count / maxCount) * 100}%`, height: "100%", background: accent, borderRadius: 2 }} />
                    </div>
                    <span style={{ fontSize: 11, color: "#6b7280", width: 36, textAlign: "right", flexShrink: 0 }}>{entry.count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* User Turn List — timeline + bordered card (mirrors Turn detail's
          Call list). The old USER/AGENT side rails are gone; the dialog feel
          lives inside each card via the blue/green bubbles. */}
      <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>{t("sessionOverview.charts.userTurns")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 0, position: "relative" }}>
        {/* Vertical spine — same geometry as the Call list spine, so the
            two views read as one design system. */}
        <div style={{ position: "absolute", left: 11, top: 8, bottom: 8, width: 2, background: "#e5e7eb", zIndex: 0 }} />

        {turns.map((turn) => {
          // Spine dot color: red on hard problems, indigo otherwise.
          const dotColor = (turn.hasCompaction || turn.errorCount > 0) ? "#ef4444" : "#6366f1";
          return (
            <div key={turn.id} style={{ position: "relative", zIndex: 1, marginBottom: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                {/* Spine dot — anchors this turn to the timeline */}
                <div style={{ flexShrink: 0, marginTop: 10, width: 24, display: "flex", justifyContent: "center" }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: "50%",
                    border: "2px solid #fff",
                    background: dotColor,
                    boxShadow: `0 0 0 2px ${dotColor}40`,
                  }} />
                </div>
                {/* Card body */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <TurnCard turn={turn} onClick={() => onSelectTurn(turn)} />
                </div>
              </div>
            </div>
          );
        })}
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

  const COL = "44px"; // Calls only — Output already in token ledger

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
        <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", textAlign: "right", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("sessionOverview.models.calls")}</span>
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
    const lineColor = CHART_COLORS.brand;

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
      const pts: { name: string; coord: (number | string)[]; symbol: string; label: object }[] = [];
      // max point
      pts.push({
        name: "max",
        coord: [maxX, maxVal],
        symbol: "none",
        label: {
          show: true,
          formatter: `Max\n${fmtK(maxVal)}`,
          position: "top" as const,
          ...labelStyle,
          color: CHART_COLORS.brand,
          backgroundColor: "#eef2ff",
        },
      });
      // final point (skip if same as max)
      if (!isSame) {
        pts.push({
          name: "final",
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
      color: CHART_COLORS.brand,
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
          axisLabel: { fontSize: 10, color: CHART_COLORS.axisLabel, interval: 0 },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          min: 0,
          axisLabel: {
            fontSize: 9,
            color: CHART_COLORS.axisLabel,
            formatter: (v: number) => fmtK(v),
            inside: false,
          },
          splitLine: { lineStyle: { color: CHART_COLORS.splitLine } },
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
            areaStyle: { color: brandAreaGradient() },
            label: deltaLabel(values),
            labelLayout: { hideOverlap: true },
            markPoint: {
              silent: true,
              data: [
                ...compactionIndices.map(i => ({
                  name: `compaction-${i}`,
                  coord: [xLabels[i], values[i]],
                  itemStyle: { color: CHART_COLORS.compaction },
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
          ...TOOLTIP_PRESET,
          trigger: "axis",
          formatter: (params: unknown) => {
            const p = (params as Array<{ name: string; value: number }>)[0];
            if (!p) return "";
            const tp = turnPoints.find(t => `T${t.turnId}` === p.name);
            const compTag = tp?.isCompaction ? " ◆ compaction" : "";
            return `${p.name}: ${fmtK(p.value)}${compTag}`;
          },
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
            color: CHART_COLORS.axisLabel,
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
            color: CHART_COLORS.axisLabel,
            formatter: (v: number) => fmtK(v),
          },
          splitLine: { lineStyle: { color: CHART_COLORS.splitLine } },
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
                return dataPoints[idx]?.isCompaction ? CHART_COLORS.compaction : lineColor;
              },
            },
            symbolSize: (_, params) => dataPoints[(params as { dataIndex: number }).dataIndex]?.isCompaction ? 8 : 5,
            symbol: (_, params) => dataPoints[(params as { dataIndex: number }).dataIndex]?.isCompaction ? "diamond" : "circle",
            areaStyle: { color: brandAreaGradient() },
            label: deltaLabel(ctxValues),
            labelLayout: { hideOverlap: true },
            markPoint: { silent: true, data: timeAnnotations },
          },
        ],
        tooltip: {
          ...TOOLTIP_PRESET,
          trigger: "axis",
          formatter: (params: unknown) => {
            const p = (params as Array<{ dataIndex: number; value: [number, number] }>)[0];
            if (!p) return "";
            const d = dataPoints[p.dataIndex];
            const compTag = d?.isCompaction ? " ◆" : "";
            return `T${d?.turnId}: ${fmtK(p.value[1])}${compTag}`;
          },
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
      <div style={{ padding: "6px 10px 0" }}>
        <SegmentedToggle<TimelineXMode>
          value={xMode}
          onChange={setXMode}
          options={[
            { id: "linear", label: t("sessionOverview.charts.xAxisLinear") },
            { id: "time",   label: t("sessionOverview.charts.xAxisTime") },
          ]}
        />
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
  const { t } = useTranslation();
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

  // Status badges — same source-of-truth + same icon+count format as the
  // call card in UserTurnDetailPanel and the nav row.
  const saCount = turn.calls.reduce((s, c) => s + c.subAgents.length, 0);
  const commandCount = turn.calls.reduce(
    (s, c) => s + c.intervalEvents.filter(e => e.kind === "user:command").length, 0);
  const unknownCount = turn.calls.reduce(
    (s, c) => s + c.intervalEvents.filter(e => e.kind === "unknown").length, 0);
  const noProxyCountCard = turn.calls.filter(c => c.proxyMatchMode === "unmatched").length;
  const turnCardBadges: StatusBadge[] = [];
  if (turn.hasCompaction)    turnCardBadges.push({ kind: "compaction", count: 1,               tooltip: t("sessionOverview.badges.compaction") });
  if (turn.errorCount > 0)   turnCardBadges.push({ kind: "error",      count: turn.errorCount, tooltip: t("sessionOverview.badges.errors") });
  if (saCount > 0)           turnCardBadges.push({ kind: "subAgent",   count: saCount,         tooltip: t("sessionOverview.badges.subAgents") });
  if (commandCount > 0)      turnCardBadges.push({ kind: "command",    count: commandCount,    tooltip: t("sessionOverview.badges.commands") });
  if (unknownCount > 0)      turnCardBadges.push({ kind: "unknown",    count: unknownCount,    tooltip: t("sessionOverview.badges.unknown") });
  if (noProxyCountCard > 0)  turnCardBadges.push({ kind: "noProxy",    count: noProxyCountCard, tooltip: t("sessionOverview.badges.noProxyDetail", { count: noProxyCountCard }) });

  const netDelta = turn.netContextDelta;
  const deltaTxt = netDelta !== 0 ? `${netDelta > 0 ? "+" : ""}${fmtK(netDelta)}` : "";
  const startedAtShort = turn.startedAt
    ? new Date(turn.startedAt).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  // One bordered card — header + dialog body — mirroring the LLM Call card
  // structure inside the Turn detail. The header strip is the click target
  // (drill into the turn); the body keeps the user/agent dialog feel via
  // blue/green bubbles so it still reads as a conversation.
  return (
    <div
      style={{
        border: "1px solid #e5e7eb", borderRadius: 8,
        background: "#fff", overflow: "hidden",
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "#6366f1"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "#e5e7eb"; }}
    >
      {/* ── Header — same layout as Call card header ── */}
      <div
        onClick={onClick}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "7px 12px", borderBottom: "1px solid #f3f4f6",
          cursor: "pointer",
        }}
      >
        {/* Left: Turn label + timestamp (replaces the dropped horizontal divider) */}
        <span style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>
          {t("sessionOverview.turn.label")} {turn.id}
        </span>
        {startedAtShort && (
          <span style={{ fontSize: 10, color: "#9ca3af" }}>{startedAtShort}</span>
        )}
        {deltaTxt && (
          <span style={{
            fontSize: 10, fontWeight: 700,
            padding: "1px 5px", borderRadius: 4,
            color: netDelta > 0 ? "#d97706" : "#16a34a",
            background: netDelta > 0 ? "#fffbeb" : "#f0fdf4",
          }}>
            {deltaTxt}
          </span>
        )}
        <span style={{ fontSize: 11, color: "#9ca3af" }}>
          {turn.llmCallCount} {t("terms.callsSuffix")}
        </span>
        {turn.toolCallCount > 0 && (
          <span style={{ fontSize: 11, color: "#9ca3af" }}>
            · {turn.toolCallCount} {t("terms.toolsSuffix")}
          </span>
        )}
        {turn.durationMs > 0 && (
          <span style={{ fontSize: 11, color: "#9ca3af" }}>
            · {fmtDuration(turn.durationMs)}
          </span>
        )}
        {/* Right: badges + chevron */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <StatusBadgeStrip badges={turnCardBadges} renderIcon={renderStatusIcon} />
          <span style={{ fontSize: 10, color: "#d1d5db" }}>›</span>
        </div>
      </div>

      {/* ── Dialog body — bubbles preserve the conversation feel even though
            the USER / AGENT side rails are gone. User left-aligned, agent
            right-aligned. Max-width capped well under 100% on both sides so
            the two parties don't visually pull to opposite edges of the
            card — keeps the conversation feeling close. ── */}
      <div style={{ padding: "10px 12px" }}>
        {/* User bubble — left aligned, blue */}
        <div style={{ display: "flex", marginBottom: 6 }}>
          <div style={{ maxWidth: "78%" }}>
            <div style={{
              fontSize: 12, color: "#1e3a5f", lineHeight: 1.55,
              background: "#eff6ff", border: "1px solid #bfdbfe",
              borderRadius: 8,
              padding: "8px 12px",
              whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}>
              {inputShown}
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
        </div>

        {/* Mid-turn injections — yellow, left aligned just like user */}
        {turn.midTurnInjections?.map((inj, idx) => (
          <div key={idx} style={{ display: "flex", marginBottom: 6 }}>
            <div style={{ maxWidth: "78%" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "#d97706", marginBottom: 3, letterSpacing: "0.05em" }}>
                ↩ INTERRUPT · after call {inj.afterCallIndex}
              </div>
              <div style={{
                fontSize: 12, color: "#78350f", lineHeight: 1.5,
                background: "#fffbeb", border: "1px solid #fcd34d",
                borderRadius: 8,
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
          </div>
        ))}

        {/* AI bubble — right aligned, green */}
        {outputFull && (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <div style={{ maxWidth: "78%" }}>
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
              <div style={{
                fontSize: 12, color: "#14532d", lineHeight: 1.6,
                background: "#f0fdf4", border: "1px solid #bbf7d0",
                borderRadius: 8,
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
  const { t } = useTranslation();
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
          icon="👤" color="#6366f1" label={t("terms.userInput")}
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
                          padding: "4px 8px", borderRadius: 6,
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
// Palettes live in shared/toolRegistry — call `getToolPalette(name)` for either
// chip ({fg,bg,border}) or accent (solid) use.
function toolChipStyle(name: string) {
  return getToolPalette(name);
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

// Tool-name → colour — single source via toolRegistry.
function d3ToolColor(name: string): string {
  return getToolPalette(name).accent;
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
    <div style={{ background: "#fafafa", border: "1px solid #f3f4f6", borderRadius: 8, overflow: "hidden" }}>

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
                        minWidth: 14, height: 14, padding: "0 3px", borderRadius: 6,
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
                    borderRadius: 6, padding: "2px 6px", whiteSpace: "nowrap", flexShrink: 0,
                  }}>
                    →#{mergeCall.id}
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
            return (
              <span key={toolName} style={{
                fontSize: 9, fontWeight: 700,
                color: tc.fg, background: tc.bg, borderRadius: 3,
                padding: "1px 4px",
                border: `1px solid ${tc.border}`,
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

function toolChip(name: string) {
  return getToolPalette(name);
}

function fmtBytes(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

// Best-effort JSON parse for hand-off to the JSON tree viewer. Returns
// `undefined` on failure so the segment falls back to text-only mode
// (no "原始 JSON" toggle shown). Avoids surfacing parse errors to the UI.
function tryParseJson(s: string): unknown {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
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
  "user:skill_injection":     "激活 SKILL",
  "user:compact_summary":     "Compact summary",
  "system:api_error":         "API error",
  "system:local_command":     "Local cmd",
  "system:compact_boundary":  "Compact boundary",
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

const KIND_COLOR = EVENT_PALETTES;

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
  kind, label, text, meta, lineIdx,
}: {
  kind: "user" | "interrupt" | "final";
  label: string;
  text: string;
  meta?: string;
  /** Optional jsonl line for the underlying event. When provided, the
   *  node reads the session attribution graph and surfaces a jump chip
   *  pointing at the call that first put this content into a prompt.
   *  Skip for kind="final" — the final assistant text isn't a jsonl-side
   *  event the user can attribute back to. */
  lineIdx?: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();
  const { getEventAnnotation, onJumpToCall } = useAttributionGraph();
  const limit = kind === "final" ? 420 : 300;
  const needsExpand = text.length > limit;
  const shown = needsExpand && !expanded ? text.slice(0, limit) + "..." : text;
  const tone = kind === "user"
    ? { bg: "#eff6ff", border: "#bfdbfe", fg: "#1e3a5f", dot: "#3b82f6" }
    : kind === "interrupt"
      ? { bg: "#fffbeb", border: "#fcd34d", fg: "#78350f", dot: "#d97706" }
      : { bg: "#f0fdf4", border: "#bbf7d0", fg: "#14532d", dot: "#16a34a" };

  if (!text.trim()) return null;

  // Reverse-attribution chip — only meaningful for jsonl-backed nodes
  // (user input + mid-turn injections). `final` is assistant text emitted
  // by the LLM, not an event to attribute to a call's prompt.
  const annotation = lineIdx != null ? getEventAnnotation(lineIdx) : null;
  const jumpTarget = annotation?.firstSeenInCall ?? null;
  const handleJump = (onJumpToCall && jumpTarget != null && lineIdx != null)
    ? () => onJumpToCall(jumpTarget, "request", { lineIdx })
    : undefined;

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
            {handleJump && (
              <button
                type="button"
                onClick={handleJump}
                title={`打开 call #${jumpTarget} 的 Request 视图，自动定位这条 user_input 对应的 leaf`}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#4338ca"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "#4f46e5"; }}
                style={{
                  marginLeft: "auto",
                  display: "inline-flex", alignItems: "center", gap: 5,
                  border: "none", background: "#4f46e5", color: "#fff",
                  borderRadius: 4, padding: "3px 9px",
                  fontSize: 10, fontWeight: 700, lineHeight: 1.3,
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(79,70,229,0.25)",
                  transition: "background 0.12s",
                  letterSpacing: "0.02em",
                }}
              >
                <LinkIcon />
                {t("terms.firstInjectedAtCall", { callId: jumpTarget })}
              </button>
            )}
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
  tc, callId, active, onHoverToolUse,
}: {
  tc: ToolCallSlot;
  /** The LLM call that emitted this tool_use — its response is where the
   *  `›` jump opens (the user's mental model: "this Tool Use came back in
   *  call #N's response"). */
  callId: number;
  active: boolean;
  onHoverToolUse: (id: string | null) => void;
}) {
  const chip = toolChip(tc.name);
  const { t } = useTranslation();
  const { onJumpToCall, highlightedToolUseId } = useAttributionGraph();
  // Amber flash outline when an Attribution-leaf back-link targets this
  // specific tool_use row. Mirrors `IntervalEventRow`'s `isFlashing` /
  // boxShadow pattern. Cleared automatically after ~2s by the context.
  const isFlashing = highlightedToolUseId !== null && highlightedToolUseId === tc.toolUseId;

  // Extract the tool_use's `description` field (the human intent label
  // Claude Code attaches to most tool calls — "List top-level entries",
  // "Read package.json", …). Shown as a subtitle on the card so users
  // can scan intent without parsing the wire JSON. Falls back to other
  // common scalar fields (command / file_path / …) so e.g. Read calls
  // without an explicit description still surface their file_path.
  const description = (() => {
    const raw = tc.inputPreview ?? "";
    if (!raw) return undefined;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (typeof obj.description === "string" && obj.description.trim()) {
        return obj.description.trim();
      }
      for (const key of ["command", "file_path", "pattern", "query", "prompt", "url"]) {
        const v = obj[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    } catch { /* inputPreview may be truncated/non-JSON — no subtitle */ }
    return undefined;
  })();

  // Skill 工具结构化参数：input schema 已被 cli.js 定为 { skill: string, args?: string }
  // （SkillTool.ts:291 zod schema 固定）—— LLM 不能传其他字段，所以解析永远安全。
  // 解析失败时 fallback 到通用 INPUT 渲染（保险，不破坏其他工具）。
  const skillRequest: { preview: string; segments: { label: string; content: string; monospace: boolean }[] } | undefined = (() => {
    if (tc.name !== "Skill") return undefined;
    try {
      const obj = JSON.parse(tc.inputPreview) as { skill?: string; args?: string };
      if (typeof obj.skill !== "string") return undefined;
      const segments: { label: string; content: string; monospace: boolean }[] = [
        {
          label: "",
          content: t("skillInvocation.requestLoad", { skill: obj.skill }),
          monospace: false,
        },
      ];
      if (typeof obj.args === "string" && obj.args.length > 0) {
        segments.push({
          label: "",
          content: t("skillInvocation.argsLabel", { args: obj.args }),
          monospace: false,
        });
      }
      return {
        preview: t("skillInvocation.requestLoad", { skill: obj.skill }),
        segments,
      };
    } catch {
      return undefined;
    }
  })();

  return (
    <div
      data-tool-use-id={tc.toolUseId}
      style={{
        marginBottom: 3,
        borderRadius: 6,
        boxShadow: isFlashing ? "0 0 0 3px rgba(245,158,11,0.45)" : "none",
        transition: "box-shadow 350ms ease",
      }}
    >
      <EventUnitCard
        // dot color is the *event type* (Tool Use = orange), not the tool's
        // individual chip color — tool identity is conveyed by the `title`
        // chip + tool name text. This keeps the type-color visual anchor
        // ("orange = tool_use anywhere in the app") intact across calls.
        color="#f59e0b"
        kindLabel="Tool Use"
        title={tc.name}
        // tool_use 是 LLM 输出的 wire 字段 —— direction 应为 "out"。
        // 不再展示 `toolu_xxx` shortId：那是 Anthropic API 服务端生成的
        // 配对 token，不属于 LLM 语义产出。要看 wire 原物，通过 jump chip
        // 跳到右侧 ResponseTreePanel（那里是 HTTP response 权威 view）。
        size={{ bytes: tc.inputSize, direction: "out" }}
        preview={skillRequest?.preview ?? description}
        description={skillRequest?.preview ?? description}
        segments={
          skillRequest
            // Skill 工具：把 INPUT raw JSON 替换为结构化两行展示
            //   请求加载 SKILL: {skill}
            //   args: {args}    （没有 args 时不显示）
            // 用户的关注点是"请求做什么"，不是 wire JSON 长什么样。
            ? skillRequest.segments
            : tc.inputPreview
              ? [
                  {
                    label: "INPUT", content: tc.inputPreview,
                    monospace: true, truncateAt: 600,
                    // 不在这里提供"原始 JSON" tab —— 左侧是事件流派生 view（来自 parser
                    // 加工后的 ToolCallSlot.inputPreview，已被截到 300 字符）。要看真正
                    // 的原始 wire response，请用 jump chip 跳到右侧 ResponseTreePanel。
                  },
                ]
              : []
        }
        active={active}
        onMouseEnter={() => onHoverToolUse(tc.toolUseId)}
        onMouseLeave={() => onHoverToolUse(null)}
        onJump={onJumpToCall ? () => onJumpToCall(callId, "response", { toolUseId: tc.toolUseId }) : undefined}
        jumpLabel={t("terms.returnedByCall", { callId })}
        jumpTooltip={t("terms.openCallResponseTooltip", { callId })}
      />
      {/* SkillInvocationChip（之前版本）已撤销 —— 改由 IntervalEventRow 在两条
          后续 jsonl 行（user:tool_result 的 "Launching skill: ..." + user:skill_injection
          的 SKILL.md body）上特化渲染，避免把"请求"和"结果"塞到同一张卡片。 */}
    </div>
  );
}

// Kinds where `contentPreview` is just `JSON.stringify(...)` of the same
// payload the JSON tree shows. Rendering a "渲染|原始 JSON" toggle on those
// is misleading — both views would carry the same info, the text one just
// less readable. For `unknown` the preview is the truncated raw JSON itself,
// so the toggle is even more confusing. These rows default to the JSON tree
// view and hide the toggle entirely.
const RAW_ONLY_KINDS: ReadonlySet<IntervalEventKind> = new Set([
  "unknown",
  "system:api_error",
  "system:stop_hook_summary",
]);

// ── IntervalEventRow: non-tool JSONL events between calls ─────────────────────
function IntervalEventRow({
  ev, producingCallId, activeToolUseId, onHoverToolUse,
}: {
  ev: IntervalEvent;
  /**
   * The call this event belongs to in the JSONL stream (i.e. the call whose
   * `intervalEvents` array contains it). For `user:tool_result` rows this
   * is the call that *emitted* the tool_use → its response holds the block
   * we want to back-link to. Undefined for events without a parent call
   * scope (e.g. inter-turn renders).
   */
  producingCallId?: number;
  activeToolUseId: string | null;
  onHoverToolUse: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const col = KIND_COLOR[ev.kind];
  const linkedToolUseIds = toolUseIdsFromIntervalEvent(ev);
  const linked = activeToolUseId != null && linkedToolUseIds.includes(activeToolUseId);
  const hoverLinkedId = linkedToolUseIds[0] ?? null;
  // tool_result events get the i18n-aware Agent-execution-result label;
  // other kinds keep their static KIND_LABEL string.
  const kindLabel = ev.kind === "user:tool_result"
    ? t("terms.toolResultLabel")
    : t(`eventKinds.${ev.kind.replace(/[:-]/g, "_")}`, { defaultValue: KIND_LABEL[ev.kind] });
  // tool_result is the *output* fed back to the LLM; other kinds don't fit
  // input/output framing — leave bare bytes (direction undefined).
  const direction: "in" | "out" | undefined = ev.kind === "user:tool_result" ? "out" : undefined;

  // ── Skill-related 特化渲染 ───────────────────────────────────────────────
  // 三种 case 的识别依据全部是 cli.js 写入的确定性字段：
  //   (a) user:tool_result + contentPreview 命中 "Launching skill: ..." → inline 加载中
  //   (b) user:tool_result + contentPreview 命中 `Skill "..." completed (forked execution)` → forked
  //   (c) user:skill_injection（parser 在 isMeta && sourceToolUseID 时打的 kind）→ SKILL.md 注入
  //
  // 这里只覆盖 preview / segments 这两层 UI 字段，**不改** kindLabel — 用户要求
  // "Tool Result 保持不变，更清晰"。skill_injection 的 kindLabel 走默认 i18n
  // (eventKinds.user_skill_injection = "激活 SKILL")。
  const skillFormat: { preview: string; segmentContent: string; segmentLabel: string; defaultExpanded: boolean; footnote?: string } | null = (() => {
    if (ev.kind === "user:tool_result") {
      // (a) Launching skill: {name}
      const launchMatch = /^Launching skill:\s*(.+?)\s*$/m.exec(ev.contentPreview);
      if (launchMatch) {
        const skill = ev.skillName ?? launchMatch[1];
        return {
          preview: t("skillInvocation.launching", { skill }),
          segmentContent: ev.contentPreview,
          segmentLabel: "",
          defaultExpanded: true, // 单行短文本，默认就显示
        };
      }
      // (b) Skill "name" completed (forked execution).\n\nResult:\n...
      const forkedMatch = /^Skill "([^"]+)" completed \(forked execution\)\./.exec(ev.contentPreview);
      if (forkedMatch) {
        const skill = ev.skillName ?? forkedMatch[1];
        const size = ev.contentSize >= 1000 ? `${(ev.contentSize / 1000).toFixed(1)}k` : `${ev.contentSize}b`;
        return {
          preview: t("skillInvocation.forkedExecuted", { skill, size }),
          segmentContent: ev.contentPreview,
          segmentLabel: "Result",
          defaultExpanded: false,
          footnote: t("skillInvocation.forkedTodoLink"),
        };
      }
    }
    if (ev.kind === "user:skill_injection") {
      const skill = ev.skillName ?? "(unknown)";
      // contentPreview 被 parser 强制截到 300 字符，但 SKILL.md 通常 5KB 量级 ——
      // 从 rawJson（携带完整 jsonl 行 JSON）里提取 message.content 的 text 块拼出
      // 全量正文。零后端改动，rawJson 本来就传到前端了。
      let fullText = ev.contentPreview;
      try {
        const obj = JSON.parse(ev.rawJson) as { message?: { content?: unknown } };
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          const parts: string[] = [];
          for (const blk of content as Array<{ type?: string; text?: string }>) {
            if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
          }
          if (parts.length > 0) fullText = parts.join("\n\n");
        } else if (typeof content === "string") {
          fullText = content;
        }
      } catch { /* fall back to truncated preview */ }
      return {
        preview: t("skillInvocation.activatedSkill", { skill }),
        segmentContent: fullText,
        segmentLabel: t("skillInvocation.viewSkillMd"),
        defaultExpanded: false, // 默认折叠
      };
    }
    return null;
  })();

  // ── Reverse-attribution lookup ────────────────────────────────────────
  // Each jsonl event may already have been audited by the session graph:
  //   - indexed → render normal + jump to firstSeenInCall
  //   - pending → yellow tint + "暂未消费"
  //   - skipped → dim + "仅元数据"
  // When the graph hasn't loaded yet annotation === null and the card
  // renders without any impact treatment.
  const { getEventAnnotation, onJumpToCall, highlightedLineIdx } = useAttributionGraph();
  const annotation = getEventAnnotation(ev.lineIdx);
  const isFlashing = highlightedLineIdx === ev.lineIdx;
  const impact = annotation ? {
    state: annotation.contextImpact,
    firstSeenInCall: annotation.firstSeenInCall,
    consumedByCallIds: annotation.consumedByCallIds,
    // Audit-gap caveat from server: firstSeen value here is unreliable
    // because unaudited calls (no proxy) exist before the earliest audited
    // call.
    firstSeenIsAfterAuditGap: annotation.firstSeenIsAfterAuditGap,
  } : undefined;
  // All event kinds (including tool_result) forward-jump to the first call
  // that consumed this jsonl line — opens the Attribution tab and auto-selects
  // the matching leaf so the user can see exactly where in the request it landed.
  const consumerJumpTarget = annotation?.firstSeenInCall ?? null;
  const handleJump = onJumpToCall && consumerJumpTarget != null
    ? () => onJumpToCall(consumerJumpTarget, "request", { lineIdx: ev.lineIdx })
    : undefined;
  const jumpLabel = consumerJumpTarget != null
    ? t("terms.firstInjectedAtCall", { callId: consumerJumpTarget })
    : undefined;
  const jumpTooltip = consumerJumpTarget != null
    ? t("terms.openAttributionAtLine", { callId: consumerJumpTarget })
    : undefined;

  return (
    <div
      data-jsonl-line={ev.lineIdx}
      style={{
        marginBottom: 2,
        borderRadius: 6,
        // Flash outline driven by AttributionGraphContext.flashEvent —
        // lights up for ~2s when a reverse-jump (Call leaf → Turn view)
        // targets this row's jsonl line.
        boxShadow: isFlashing ? "0 0 0 3px rgba(245,158,11,0.45)" : "none",
        transition: "box-shadow 350ms ease",
      }}
    >
      <EventUnitCard
        color={col.fg}
        bg={col.bg}
        border={col.border}
        kindLabel={kindLabel}
        size={ev.contentSize > 0 ? { bytes: ev.contentSize, direction } : undefined}
        timestamp={ev.timestamp}
        preview={skillFormat?.preview ?? ev.contentPreview.slice(0, 120)}
        defaultExpanded={skillFormat ? skillFormat.defaultExpanded : undefined}
        segments={[
          {
            label: skillFormat
              ? skillFormat.segmentLabel
              : (direction === "out" ? "OUTPUT" : "CONTENT"),
            content: skillFormat
              ? skillFormat.segmentContent
              : (ev.contentPreview && ev.contentPreview.length > 0 ? ev.contentPreview : ev.rawJson),
            // skill_injection 的 SKILL.md 通常 5-10KB —— 给一个足够大的阈值，
            // 让用户展开后能看到完整内容（SegmentView 仍提供 "展开全部" 按钮兜底）。
            monospace: true,
            truncateAt: skillFormat ? 20000 : 1000,
            // Whole-jsonl-line raw view — collapsible tree of the parsed
            // line object (parentUuid / message / toolUseResult / …). Lets
            // users drill into structural fields without parsing the
            // truncated text mentally.
            rawJson: tryParseJson(ev.rawJson),
            // unknown / api_error / stop_hook_summary: preview is a
            // truncated stringify of the same payload → skip the misleading
            // "渲染" tab, go straight to the JSON tree.
            rawOnly: RAW_ONLY_KINDS.has(ev.kind),
          },
        ]}
        coordinate={{ kind: "jsonl", line: ev.lineIdx + 1 }}
        impact={impact}
        active={linked}
        onMouseEnter={() => { if (hoverLinkedId) onHoverToolUse(hoverLinkedId); }}
        onMouseLeave={() => { if (hoverLinkedId) onHoverToolUse(null); }}
        onJump={handleJump}
        jumpLabel={jumpLabel}
        jumpTooltip={jumpTooltip}
      />
      {/* forked 模式 footnote: "跳转 sub-agent：TODO" 占位文字（最简实现，无跳转） */}
      {skillFormat?.footnote && (
        <div style={{
          marginTop: 2,
          marginLeft: 18,
          fontSize: 10,
          fontStyle: "italic",
          color: "#92400e",
        }}>
          {skillFormat.footnote}
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
  const { t } = useTranslation();
  // Filter state: null means "show all" (default); populated = active filter set
  const [hiddenKinds, setHiddenKinds] = useState<Set<IntervalEventKind>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [showFoldedSubAgentResults, setShowFoldedSubAgentResults] = useState(false);
  const [activeToolUseId, setActiveToolUseId] = useState<string | null>(null);
  // Per-sub-agent expanded state. Default = collapsed (one-line preview);
  // toggling via the header chevron shows full description / full result
  // (no truncation, no maxHeight cap). Keyed by toolUseId.
  const [expandedSubAgentIds, setExpandedSubAgentIds] = useState<Set<string>>(new Set());
  const toggleSubAgentExpanded = useCallback((toolUseId: string) => {
    setExpandedSubAgentIds(prev => {
      const next = new Set(prev);
      if (next.has(toolUseId)) next.delete(toolUseId);
      else next.add(toolUseId);
      return next;
    });
  }, []);

  // When `onJumpToCall` fires from anywhere, the Provider sets
  // highlightedCallId. The matching call card flashes an amber outline so
  // the user can visually confirm where the jump landed.
  //
  // `linkedPanelMode` (set by LinkedPanelScope wrapping right-side
  // popups) suppresses forward-jump UI inside this Turn render so a click
  // here never spawns another right-side panel — strict one-direction
  // (left → right) flow.
  const { highlightedCallId, linkedPanelMode, onJumpToCall } = useAttributionGraph();

  if (!turn.calls.length) return null;

  // Bar length scale for the per-call CallLedger thumbnail — bar width =
  // this call's total billable tokens / max total across the Turn, so
  // adjacent rows are visually comparable. Use the non-overlapping bucket
  // breakdown CallLedger renders: API input_tokens (= ctx − read − write) +
  // cache_read + cache_write + output. Avoids the previous bug where
  // `c.freshIn` (parser's "context growth") double-counted cached content
  // and produced inflated bar widths.
  const maxCallTotal = Math.max(
    ...turn.calls.map(c => {
      const apiInputTokens = Math.max(0, c.contextSize - c.cacheRead - c.cacheWrite);
      return apiInputTokens + c.cacheRead + c.cacheWrite + c.outputTokens;
    }),
    1,
  );
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
            fontSize: 10, padding: "3px 10px", borderRadius: 6, cursor: "pointer",
            border: "1px solid #e5e7eb", background: filterOpen ? "#6366f1" : "#f9fafb",
            color: filterOpen ? "#fff" : "#6b7280", fontWeight: 600,
          }}
        >
          {t("terms.filterEventGraph")} {hiddenKinds.size > 0 && t("terms.hiddenCount", { n: hiddenKinds.size })}
        </button>
        {hiddenKinds.size > 0 && (
          <button onClick={() => setHiddenKinds(new Set())} style={{ fontSize: 10, color: "#6366f1", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            {t("terms.showAll")}
          </button>
        )}
        <span style={{ fontSize: 9, color: "#d1d5db", marginLeft: "auto" }}>
          {t("terms.jsonlEventCount", {
            calls: turn.calls.length,
            events: turn.calls.reduce((s, c) => s + c.intervalEvents.length, 0),
          })}
        </span>
        {foldedSubAgentResultCount > 0 && (
          <button
            onClick={() => setShowFoldedSubAgentResults(v => !v)}
            style={{ fontSize: 10, color: "#4f46e5", background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 6, cursor: "pointer", padding: "3px 8px", fontWeight: 700 }}
          >
            {showFoldedSubAgentResults
              ? t("terms.foldSubAgentResults")
              : t("terms.showFoldedSubAgentResults", { n: foldedSubAgentResultCount })}
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
                {t(`eventKinds.${k.replace(/[:-]/g, "_")}`, { defaultValue: KIND_LABEL[k] })}
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
          label={t("terms.userInput")}
          text={turn.userInput}
          meta={turn.startedAt ? turn.startedAt.slice(11, 19) : undefined}
          lineIdx={turn.userInputLineIdx}
        />
        {turn.midTurnInjections
          .filter(inj => inj.afterCallIndex === 0)
          .map((inj, injIdx) => {
            const firstCallId = turn.calls[0]?.id;
            const anchor = firstCallId != null ? `before #${firstCallId}` : "before first call";
            return (
              <ChainNarrativeNode
                key={`inj-before-${injIdx}`}
                kind="interrupt"
                label="Mid-turn input"
                text={inj.text}
                meta={inj.timestamp ? `${anchor} · ${inj.timestamp.slice(11, 19)}` : anchor}
              />
            );
          })}

        {turn.calls.map((call, callArrIdx) => {
          // Consumer-call lookup for sub-agent results.
          // Anthropic API flow: assistant call N emits tool_use → tool_result
          // for the sub-agent is bundled into call N+1's user-side input.
          // So "the call that received this sub-agent's result" = the next
          // call in the same turn. If `call` is the last call of the turn,
          // the result wasn't consumed (no follow-up assistant call) and
          // we hide the jump-to-consumer button.
          const consumerCall = turn.calls[callArrIdx + 1] ?? null;
          // Look up the JSONL lineIdx of each sub-agent's tool_result so the
          // jump can auto-locate the matching leaf inside the consumer call's
          // Attribution Tree (request lens). Mirrors how IntervalEventRow
          // passes `{ lineIdx }` to onJumpToCall — same mechanism, just
          // wired in from the sub-agent card. Build a Map once per call,
          // keyed by toolUseId, so each sub-agent renders without rescanning.
          const toolResultLineIdxByToolUseId = (() => {
            const m = new Map<string, number>();
            for (const ev of call.intervalEvents) {
              if (ev.kind !== "user:tool_result") continue;
              for (const tuid of toolUseIdsFromIntervalEvent(ev)) {
                if (!m.has(tuid)) m.set(tuid, ev.lineIdx);
              }
            }
            return m;
          })();
          const delta    = call.significantDelta;
          // jsonlLines is shown only in the #id tooltip now; the proportional
          // context bar was replaced by the shared CallLedger (rendered below
          // with maxCallTotal as its scale).
          const jsonlLines = formatJsonlLines(call);
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
            <div
              id={`turn-${turn.id}-call-${call.id}`}
              style={{
                position: "relative", zIndex: 1, marginBottom: 8,
                borderRadius: 8,
                // Flash outline driven by AttributionGraphContext: lights up
                // for ~2s after a jump points to this call.
                boxShadow: highlightedCallId === call.id ? "0 0 0 3px rgba(245,158,11,0.45)" : "none",
                transition: "box-shadow 350ms ease",
              }}>

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

                {/* Card — header row stays a simple flex; the "查看详情"
                    chip is the LAST flex item using the same indigo-solid
                    jump-chip style as EventUnitCard's link button, so all
                    "click here to navigate" affordances in the app share
                    one visual language. Whole-card click intentionally not
                    wired and hover-border removed — the chip is the only
                    interactive surface, no need to hint otherwise. */}
                <div
                  style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff", overflow: "hidden" }}
                >
                  {/* Header row — title / ctx / delta / 查看详情 button.
                      Every chip uses fontSize 10 + lineHeight 1 + matching
                      padding so the row height is governed by the title's
                      font metrics alone, not by any chip's borders. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid #f3f4f6" }}>
                    <span
                      style={{ fontSize: 12, fontWeight: 700, color: "#111827", lineHeight: 1 }}
                      title={
                        call.messageId
                          ? `message: ${call.messageId}${jsonlLines ? ` · jsonl ${jsonlLines}` : ""}`
                          : jsonlLines ? `jsonl ${jsonlLines}` : undefined
                      }
                    >
                      {t("terms.callLabel")} {call.id}
                      {call.isCompaction && <span style={{ marginLeft: 5, fontSize: 10, color: "#ef4444" }}>◆</span>}
                    </span>
                    <span style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1 }}>{fmtK(call.contextSize)}</span>
                    {delta !== 0 && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 4, lineHeight: 1, color: delta > 0 ? "#d97706" : "#16a34a", background: delta > 0 ? "#fffbeb" : "#f0fdf4" }}>
                        {delta > 0 ? "+" : ""}{fmtK(delta)}
                      </span>
                    )}
                    {!linkedPanelMode && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onSelectCall(call); }}
                        title="查看完整 request / response / 原始结构"
                        onMouseEnter={(e) => { e.currentTarget.style.background = "#4338ca"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "#4f46e5"; }}
                        style={{
                          marginLeft: "auto",
                          display: "inline-flex", alignItems: "center", gap: 5,
                          border: "none", background: "#4f46e5", color: "#fff",
                          borderRadius: 4,
                          padding: "3px 9px", fontSize: 10, fontWeight: 700,
                          lineHeight: 1.3, letterSpacing: "0.02em",
                          cursor: "pointer",
                          boxShadow: "0 1px 2px rgba(79,70,229,0.25)",
                          transition: "background 0.12s",
                        }}
                      >
                        <LinkIcon />
                        {t("terms.viewDetails")}
                      </button>
                    )}
                  </div>

                  {/* Token ledger — Call thumbnail uses CallLedger (compact,
                      two-group "历史复用 / 本轮新处理" semantics) since each
                      row represents a single LLM call. Bar width is scaled
                      to the Turn's largest call total so adjacent rows are
                      visually comparable. `freshIn` here is the strict
                      API-reported uncached input (= ctx − cacheRead −
                      cacheWrite); the parser's `call.freshIn` field tracks
                      "context growth since previous call" which conflates
                      cache-loaded content with truly new tokens and would
                      mismatch the Call header's value. */}
                  <div style={{ padding: "8px 12px 9px" }}>
                    <CallLedger
                      size="compact"
                      maxTotal={maxCallTotal}
                      freshIn={Math.max(0, call.contextSize - call.cacheRead - call.cacheWrite)}
                      cacheRead={call.cacheRead}
                      cacheWrite={call.cacheWrite}
                      output={call.outputTokens}
                    />
                  </div>

                  {/* Assistant text */}
	                  {call.assistantText && !hideAssistantTextAsFinal && (
	                    <div style={{ padding: "0 12px 7px" }}>
	                      <div style={{ fontSize: 9, fontWeight: 700, color: "#9ca3af", marginBottom: 2, letterSpacing: "0.04em" }}>{t("terms.assistantResponseText").toUpperCase()}</div>
	                      <div style={{ fontSize: 11, color: "#374151", lineHeight: 1.55, background: "#f9fafb", borderRadius: 6, padding: "5px 8px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 72, overflow: "hidden" }}>
	                        {call.assistantText}
	                      </div>
	                    </div>
	                  )}

		                  {/* tool_use blocks are part of this assistant response. Sub-agent
		                      executions are rendered below as derived JSONL events. */}
		                  {call.toolCalls.length > 0 && (
	                    <div style={{ padding: "0 12px 7px" }}>
	                      <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 3, letterSpacing: "0.04em", fontWeight: 700 }}>
	                        {t("terms.toolUseRequests", { count: call.toolCalls.length })}
	                      </div>
	                      {call.toolCalls.map((tc, ti) => (
	                        <ToolCallRow
	                          key={tc.toolUseId || ti}
	                          tc={tc}
	                          callId={call.id}
	                          active={activeToolUseId === tc.toolUseId}
	                          onHoverToolUse={setActiveToolUseId}
	                        />
	                      ))}
	                    </div>
	                  )}
	                </div>
	              </div>

	              {/* ── Sub-agent JSONL events derived from Agent tool_use ───
	                  Block aligns flush with the LLM call card above (both at
	                  marginLeft: 32 from the spine container). Each row has:
	                    · Body (left, flex:1): stats + description + result
	                      preview. Truncated by default; click `▾ 展开` at the
	                      bottom to inline-expand into full text + extra stats.
	                    · Two consistent action chips (right column):
	                        - Purple `查看完整` → opens sub-agent detail
	                        - Blue `🔗 #N`     → jumps to consumer call's
	                          request in the right-side LinkedPanel
	                      Both chips use the same shape / LinkIcon / typography;
	                      only the color differentiates intent. */}
		              {call.subAgents.length > 0 && (
	                <div style={{ marginLeft: 32, marginTop: 3 }}>
                    <div style={{ fontSize: 9, color: "#818cf8", fontWeight: 800, letterSpacing: "0.04em", margin: "0 0 3px 0" }}>
                      ↳ {t("terms.subAgentEvents")}
                    </div>
	                  {call.subAgents.map(sa => {
                      const active = activeToolUseId === sa.toolUseId;
                      const branchColor = active ? "#f59e0b" : "#6366f1";
                      const handleHoverEnter = () => setActiveToolUseId(sa.toolUseId);
                      const handleHoverLeave = () => setActiveToolUseId(null);
                      const expanded = expandedSubAgentIds.has(sa.toolUseId);
                      // Show the toggle whenever there's actual body content
                      // (description or result preview). Even short content
                      // benefits from the toggle so users can fold large
                      // sub-agent rows back down once they've read them.
                      const hasBodyContent = !!sa.description || !!sa.resultPreview;
                      return (
                      <div
                        key={sa.agentFileId}
                        onMouseEnter={handleHoverEnter}
                        onMouseLeave={handleHoverLeave}
                        style={{
                          width: "100%",
                          marginBottom: 4,
                          border: `1px solid ${branchColor}`,
                          borderLeftWidth: 3,
                          borderRadius: 6,
                          background: active ? "#fff7ed" : "#fafafe",
                          boxShadow: active ? "0 0 0 2px rgba(245,158,11,0.14)" : "none",
                          overflow: "hidden",
                        }}
                      >
                        {/* Header row — stats on the left, two consistent
                            action chips on the right. No collapse/expand —
                            content below is always fully shown. */}
                        <div style={{
                          display: "flex", alignItems: "center", gap: 6,
                          padding: "5px 9px",
                          borderBottom: (sa.description || sa.resultPreview) ? "1px solid #f3f4f6" : "none",
                        }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: "#4338ca" }}>{sa.agentType}</span>
                          <span style={{ fontSize: 9, color: "#6366f1" }}>{sa.llmCallCount}c · {sa.toolCallCount}t · {fmtDuration(sa.durationMs)}</span>
                          <span style={{ fontSize: 9, color: "#6366f1", background: "#eff6ff", borderRadius: 3, padding: "1px 5px" }}>+{fmtK(sa.totalOutputTokens)}</span>
                          <span style={{ fontSize: 9, color: active ? "#d97706" : "#c4c9d4" }}>{shortToolUseId(sa.toolUseId)}</span>
                          <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
                            {/* Expand / collapse toggle — plain text + arrow,
                                same shape as the CALL MINIMAP "▾ show / ▴ hide"
                                pattern. Default = collapsed; user toggles to
                                see full description + full result. */}
                            {hasBodyContent && (
                              <button
                                type="button"
                                onClick={() => toggleSubAgentExpanded(sa.toolUseId)}
                                style={{
                                  fontSize: 10, color: "#9ca3af",
                                  background: "none", border: "none", cursor: "pointer",
                                  padding: "0 4px", lineHeight: 1,
                                }}
                              >
                                {expanded ? t("terms.hide") : t("terms.show")}
                              </button>
                            )}
                            {/* Chip 1: 紫色 "查看完整" — opens sub-agent drawer.
                                Uses a forward-jump arrow icon (↗) rather than
                                the chain LinkIcon, since this is a "navigate
                                INTO another scope" action rather than a
                                "cross-reference link". */}
                            {onSubAgentClick && (
                              <button
                                type="button"
                                onClick={() => onSubAgentClick(sa)}
                                title={t("sessionOverview.subAgent.viewSubAgentDetailTooltip", { agentType: sa.agentType })}
                                onMouseEnter={(e) => { e.currentTarget.style.background = "#6d28d9"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = "#7c3aed"; }}
                                style={{
                                  display: "inline-flex", alignItems: "center", gap: 5,
                                  border: "none", background: "#7c3aed", color: "#fff",
                                  borderRadius: 4, padding: "3px 9px",
                                  fontSize: 10, fontWeight: 700, lineHeight: 1.3,
                                  letterSpacing: "0.02em",
                                  cursor: "pointer", whiteSpace: "nowrap",
                                  boxShadow: "0 1px 2px rgba(124,58,237,0.25)",
                                  transition: "background 0.12s",
                                }}
                              >
                                <ForwardArrowIcon />
                                {t("sessionOverview.subAgent.viewFullSubAgent")}
                              </button>
                            )}
                            {/* Chip 2: 蓝色 "首次注入于 Call #N" — opens
                                consumer call in right-side LinkedPanel. Uses
                                the chain LinkIcon (cross-reference semantics),
                                matching the JSONL event "首次注入于" pattern. */}
                            {consumerCall && onJumpToCall && !linkedPanelMode && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const lineIdx = toolResultLineIdxByToolUseId.get(sa.toolUseId);
                                  onJumpToCall(consumerCall.id, "request",
                                    lineIdx != null ? { lineIdx } : undefined);
                                }}
                                title={t("sessionOverview.subAgent.jumpToConsumerTooltip", { callId: consumerCall.id })}
                                onMouseEnter={(e) => { e.currentTarget.style.background = "#1d4ed8"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = "#2563eb"; }}
                                style={{
                                  display: "inline-flex", alignItems: "center", gap: 5,
                                  border: "none", background: "#2563eb", color: "#fff",
                                  borderRadius: 4, padding: "3px 9px",
                                  fontSize: 10, fontWeight: 700, lineHeight: 1.3,
                                  letterSpacing: "0.02em",
                                  cursor: "pointer", whiteSpace: "nowrap",
                                  boxShadow: "0 1px 2px rgba(37,99,235,0.25)",
                                  transition: "background 0.12s",
                                }}
                              >
                                <LinkIcon />
                                {t("sessionOverview.subAgent.firstInjectedAt", { callId: consumerCall.id })}
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Body — description + result.
                            Collapsed (default): each block is one-line ellipsis.
                            Expanded: full text, no maxHeight cap, no slice. */}
                        {hasBodyContent && (
                          <div style={{ padding: "5px 9px", display: "flex", flexDirection: "column", gap: 3 }}>
                            {sa.description && (
                              <div style={{
                                fontSize: 10, color: "#6b7280",
                                ...(expanded
                                  ? { whiteSpace: "pre-wrap", wordBreak: "break-word" }
                                  : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
                              }}>
                                {sa.description}
                              </div>
                            )}
                            {sa.resultPreview && (
                              <div style={{
                                fontSize: 10, color: "#374151",
                                background: "#f5f3ff", borderRadius: 4, padding: "4px 7px",
                                ...(expanded
                                  ? { whiteSpace: "pre-wrap", wordBreak: "break-word" }
                                  : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
                              }}>
                                {expanded ? (sa.result ?? sa.resultPreview) : sa.resultPreview}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      );
                    })}
                </div>
              )}

              {/* ── Interval events (filtered) ────────────────── */}
	              {visibleIntervals.length > 0 && (
	                <div style={{ marginLeft: 32, marginTop: 3 }}>
                    <div style={{ fontSize: 9, color: "#c4c9d4", fontWeight: 700, letterSpacing: "0.04em", margin: "0 0 3px 8px" }}>
                      {t("terms.jsonlEventGraph")}
                    </div>
	                  {visibleIntervals.map((ev, ei) => (
	                    <IntervalEventRow
	                      key={`${ev.lineIdx}-${ei}`}
	                      ev={ev}
	                      producingCallId={call.id}
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
                  meta={inj.timestamp ? `after #${call.id} · ${inj.timestamp.slice(11, 19)}` : `after #${call.id}`}
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
  onClose, onOpenAsMain,
}: {
  turn: MockUserTurn;
  onSelectCall: (c: MockLlmCall) => void;
  isMockSession?: boolean;
  onSubAgentClick?: (sa: SubAgentSummary) => void;
  trailingInterTurnBlock?: InterTurnBlock | null;
  sessionId?: string;
  /** Chrome buttons — same shape as LlmCallDetailPanel. Each button is
   *  rendered only when its callback is wired. Linked panel passes both;
   *  main view leaves them undefined. */
  onClose?: () => void;
  onOpenAsMain?: () => void;
}) {
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
  // In linked-panel mode the user is "drilling into" the turn from a leaf
  // back-link — the summary header is just chrome taking vertical space.
  // Start collapsed. In main mode start expanded for the overview-first
  // feel. Either mode: chevron toggles.
  const { linkedPanelMode } = useAttributionGraph();
  const [summaryCollapsed, setSummaryCollapsed] = useState(linkedPanelMode);
  // Minimap default-state: expanded in the main Turn view (overview-first
  // feel — you want the heat map without an extra click), collapsed when
  // the Turn is opened as a linked panel from a Call detail (the call list
  // is already in focus; the bird's-eye nav would just steal vertical
  // space). Tool-less turns also collapse since there's nothing to map.
  const noTools = turn.toolCallCount === 0;
  const [minimapOpen, setMinimapOpen] = useState(!linkedPanelMode && !noTools);
  const minimapAnchorId = `turn-${turn.id}-call-minimap`;

  const turnSubAgents = callsWithSubAgents.flatMap(c => c.subAgents);

  const firstCtx    = turn.calls[0]?.contextSize ?? 0;
  const lastCtx     = turn.calls[turn.calls.length - 1]?.contextSize ?? 0;
  const netCtx      = lastCtx - firstCtx;

  const totalFreshIn  = turn.calls.reduce((s, c) => s + Math.max(c.contextSize - c.cacheRead - c.cacheWrite, 0), 0);
  const totalFreshOut = turn.calls.reduce((s, c) => s + c.outputTokens, 0);
  const cacheInputTotal = turn.cacheRead + turn.cacheWrite + totalFreshIn;
  const cacheRatio = cacheInputTotal > 0 ? turn.cacheRead / cacheInputTotal * 100 : null;

  const risks: Array<{ type: "compaction" | "unknown-spike" | "large-growth" | "near-limit" | "tool-heavy" }> = [];
  if (turn.hasCompaction)   risks.push({ type: "compaction" });
  if (turn.hasUnknownSpike) risks.push({ type: "unknown-spike" });

  // Status badges (icon + count, unified format across the app)
  const turnStatusBadges: StatusBadge[] = (() => {
    const subAgentCount = turn.calls.reduce((s, c) => s + c.subAgents.length, 0);
    const commandCount = turn.calls.reduce(
      (s, c) => s + c.intervalEvents.filter(e => e.kind === "user:command").length, 0);
    const unknownCount = turn.calls.reduce(
      (s, c) => s + c.intervalEvents.filter(e => e.kind === "unknown").length, 0);
    const items: StatusBadge[] = [];
    if (turn.hasCompaction)   items.push({ kind: "compaction", count: 1,              tooltip: t("sessionOverview.badges.compaction") });
    if (turn.errorCount > 0)  items.push({ kind: "error",      count: turn.errorCount,tooltip: t("sessionOverview.badges.errors") });
    if (subAgentCount > 0)    items.push({ kind: "subAgent",   count: subAgentCount,  tooltip: t("sessionOverview.badges.subAgents") });
    if (commandCount > 0)     items.push({ kind: "command",    count: commandCount,   tooltip: t("sessionOverview.badges.commands") });
    if (unknownCount > 0)     items.push({ kind: "unknown",    count: unknownCount,   tooltip: t("sessionOverview.badges.unknown") });
    const noProxyCount = turn.calls.filter(c => c.proxyMatchMode === "unmatched").length;
    if (noProxyCount > 0)     items.push({ kind: "noProxy",    count: noProxyCount,   tooltip: t("sessionOverview.badges.noProxyDetail", { count: noProxyCount })});
    return items;
  })();

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* ── Summary header — stats · ledger · badges, single row ────
          In linked-panel mode this starts collapsed (one-line gist) so
          the call timeline gets the vertical space; click 展开 ▾ to
          unfold. */}
      {summaryCollapsed ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "6px 10px", marginBottom: 16,
          background: "#fafafa", border: "1px solid #f3f4f6", borderRadius: 6,
          fontSize: 11, color: "#6b7280",
        }}>
          <span style={{ fontWeight: 700, color: "#374151" }}>{t("sessionOverview.turn.label")} {turn.id}</span>
          <span>{turn.llmCallCount} {t("terms.callsSuffix")}</span>
          <span>{turn.toolCallCount} {t("terms.toolsSuffix")}</span>
          {turnSubAgents.length > 0 && <span style={{ color: "#a855f7" }}>{turnSubAgents.length} {t("terms.subAgentsSuffix")}</span>}
          {dur && <span>{dur}</span>}
          {cacheRatio != null && <span>{t("terms.cacheSuffix")} <strong style={{ color: "#374151" }}>{cacheRatio.toFixed(0)}%</strong></span>}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            {onOpenAsMain && (
              <button
                type="button"
                onClick={onOpenAsMain}
                title={t("terms.openAsMain")}
                style={{ border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4338ca", borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
              >
                {t("terms.openAsMain")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setSummaryCollapsed(false)}
              title={t("terms.turnExpand")}
              style={{
                background: "transparent", border: "none",
                cursor: "pointer", fontSize: 11, color: "#6366f1", fontWeight: 600,
                padding: "0 4px",
              }}
            >
              {t("terms.turnExpand")}
            </button>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                title="关闭"
                style={{
                  border: "1px solid #e5e7eb", background: "#fff", color: "#64748b",
                  borderRadius: 6, padding: "1px 7px", fontSize: 14, lineHeight: 1,
                  cursor: "pointer", fontWeight: 700,
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
      ) : (
        <div style={{ position: "relative" }}>
          <UnifiedHeader
            leadingLabel={{ label: t("sessionOverview.turn.label"), value: String(turn.id) }}
            stats={[
              { label: t("sessionOverview.activity.llmCalls"),  value: String(turn.llmCallCount) },
              { label: t("sessionOverview.activity.toolCalls"), value: String(turn.toolCallCount) },
              ...(turnSubAgents.length > 0
                ? [{ label: t("sessionOverview.badges.subAgents"), value: String(turnSubAgents.length), color: "#a855f7" }]
                : []),
              { label: t("sessionOverview.activity.duration"),  value: dur || "—" },
            ]}
            ledger={{
              mode: "aggregate",
              freshIn: totalFreshIn,
              cacheRead: turn.cacheRead,
              cacheWrite: turn.cacheWrite,
              output: totalFreshOut,
              cacheRatio,
            }}
            rightSlot={
              <StatusBadgeStrip badges={turnStatusBadges} renderIcon={renderStatusIcon} />
            }
          />
          {/* Chrome actions — Open as main / 折叠 / 关闭. All abs-positioned
              top-right of the UnifiedHeader so they overlay the badge slot
              without changing the header layout. linkedPanelMode triggers
              the collapse chevron + close (main view's overview stays
              sticky-expanded). */}
          {(linkedPanelMode || onOpenAsMain || onClose) && (
            <div style={{ position: "absolute", top: 4, right: 4, display: "flex", alignItems: "center", gap: 6 }}>
              {onOpenAsMain && (
                <button
                  type="button"
                  onClick={onOpenAsMain}
                  title="Promote linked content into the main view"
                  style={{ border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4338ca", borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
                >
                  {t("terms.openAsMain")}
                </button>
              )}
              {linkedPanelMode && (
                <button
                  type="button"
                  onClick={() => setSummaryCollapsed(true)}
                  title="折叠 turn 概览"
                  style={{
                    background: "transparent", border: "none",
                    cursor: "pointer", fontSize: 11, color: "#9ca3af",
                    padding: "2px 6px",
                  }}
                >
                  折叠 ▴
                </button>
              )}
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  title="关闭"
                  style={{
                    border: "1px solid #e5e7eb", background: "#fff", color: "#64748b",
                    borderRadius: 6, padding: "1px 7px", fontSize: 14, lineHeight: 1,
                    cursor: "pointer", fontWeight: 700,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Call Minimap (heat map) ──────────────────────────────────
          Bird's-eye view: context step line + per-call tool heatmap.
          Default-state computed at mount: expanded in main view, collapsed
          when this Turn is rendered as a linked panel (linkedPanelMode).
          Toggle hide/show is sticky for this Turn's mount lifetime.
          Click on any cell or line marker jumps to the corresponding Call
          card via the anchor `turn-${turn.id}-call-${callId}`. */}
      {!noTools && (
        <div id={minimapAnchorId} style={{ marginBottom: 16, scrollMarginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: minimapOpen ? 8 : 0 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em" }}>
              {t("terms.callMinimap")}
            </span>
            <button
              onClick={() => setMinimapOpen(v => !v)}
              style={{ fontSize: 10, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: "0 4px", lineHeight: 1 }}
            >
              {minimapOpen ? t("terms.hide") : t("terms.show")}
            </button>
          </div>
          {minimapOpen && (
            <TurnMinimap
              turn={enrichedTurn}
              onSelectCall={id => {
                // Click on a heatmap cell / context line column → scroll the
                // corresponding LLM Call card into view. The anchor id is
                // produced by ChainView when rendering each call row.
                const anchor = document.getElementById(`turn-${turn.id}-call-${id}`);
                anchor?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            />
          )}
        </div>
      )}

      {/* ── Semantic call chain + raw JSONL event graph ────────────── */}
      <div style={{ marginBottom: 20 }}>
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
    <div style={{ fontSize: 10, background: c.bg, border: `1px solid ${c.border}`, borderRadius: 6, padding: "5px 10px", marginBottom: 10, display: "flex", gap: 6, alignItems: "center" }}>
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
              <div key={b.id} style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 5, padding: "5px 8px", background: cfg.bg, border: `1px solid ${cfg.color}25`, borderLeft: `3px solid ${cfg.color}`, borderRadius: 6 }}>
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
            <div style={{ border: "1px solid #f3f4f6", borderRadius: 6, overflow: "hidden" }}>
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
      <div style={{ background: "#fff", border: "1px solid #f3f4f6", borderRadius: 6, padding: "10px 12px", marginBottom: 12 }}>
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
            <div key={i} style={{ padding: "5px 8px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, marginBottom: 4 }}>
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

const NATURE_BADGE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  "static":        { label: "static",       color: "#374151", bg: "#f3f4f6", border: "#e5e7eb" },
  "dynamic":       { label: "dynamic",      color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  "rule-injected": { label: "rule",         color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
  "tool-result":   { label: "tool_result",  color: "#b45309", bg: "#fef3c7", border: "#fde68a" },
  "assistant":     { label: "assistant",    color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe" },
  "user":          { label: "user",         color: "#047857", bg: "#f0fdf4", border: "#bbf7d0" },
};

// Infer turn position for message segments from call context

// Compact segment row used in default overview and section drill-down


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

// Four-tab top-level structure for Call detail. Attribution and diff are
// surfaced as the first two tabs so they're immediately reachable — they're
// the most-used analytical views. Response and raw structure follow.
// Diff / Cache 已合并进 attribution tab 的多 lens 视角；不再有独立 tab。
type CallTab = "attribution" | "response" | "raw";
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


// ─── SegmentDiffTree ──────────────────────────────────────────────────────────
// Two levels:
//   Default  — 3 section rows (System / Tools / Messages) + diff summary badge
//   Section  — all segments in that section via DiffSegmentRow (expandable text)


// ─── Diff vs Previous Tab ────────────────────────────────────────────────────


// ─── Request Tab ─────────────────────────────────────────────────────────────

function RequestTab({
  call, callDetail, callDetailLoading,
}: {
  call: MockLlmCall;
  callDetail: CallDetail | null;
  callDetailLoading: boolean;
}) {
  const { t } = useTranslation();
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
      <div style={{ fontSize: 10, color: "#6b7280", fontWeight: 600, marginBottom: 6 }}>{t("terms.jsonlMetadata")}</div>
      <CodeBlock variant="json" style={{ marginBottom: 14 }}>
        {JSON.stringify({
          call_id: call.id, index_in_turn: call.indexInTurn,
          model: call.model, timestamp: call.timestamp,
          usage: { context_size: call.contextSize, fresh_in: call.contextSize - call.cacheRead - call.cacheWrite, cache_read: call.cacheRead, cache_write: call.cacheWrite, output_tokens: call.outputTokens },
          stop_reason: call.stopReason,
          ...(call.proxy ? { proxy_request_id: call.proxy.requestId, duration_ms: call.proxy.durationMs } : {}),
        }, null, 2)}
      </CodeBlock>
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



// TODO(remove-after-tab-refactor): AttributionSection is no longer rendered
// anywhere — the new top-level tab structure (请求 / 响应 / 原始结构) lifts
// the Request/Response split out and renders AttributionTreeLensPanel /
// ResponseTreePanel directly. The classic 经典/Lens 预览 sub-toggle inside
// is also gone (Lens is the only mode now). Kept here purely so accidental
// callers fail loudly; safe to delete next pass.
//
// ─── Attribution section: Request / Response 双向归因 ───────────────────────
// 子 tab 切换 Request / Response。
//   - Request: AttributionTreePanel（origin tree）
//   - Response: ResponseTreePanel（response wire body）

type AttributionSide = "request" | "response";

function AttributionSection({
  call, sessionId, onLinkCall, onLinkSource,
}: {
  call: MockLlmCall;
  sessionId: string;
  onLinkCall?: (callId: number) => void;
  onLinkSource?: (sourceCallId: number, sourceTurnId?: number) => void;
}) {
  const { t } = useTranslation();
  const [side, setSide] = useState<AttributionSide>("request");
  // Side-path 切换：经典 = 现有 AttributionTreePanel（仅 Audit 过滤）；
  // Lens 预览 = AttributionTreeLensPanel（多 lens 切换：来源 / 缓存 / Audit）。
  // 默认走经典版以保兼容；用户可随时切到 Lens 预览体验，不影响原视图。
  const [requestVariant, setRequestVariant] = useState<"classic" | "lens">("classic");

  return (
    <div>
      {/* Request / Response 子 tab */}
      <div style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <SegmentedToggle<AttributionSide>
          value={side}
          onChange={setSide}
          align="start"
          size="md"
          variant="soft"
          options={[
            { id: "request",  label: t("attribution.request") },
            { id: "response", label: t("attribution.response") },
          ]}
        />
        {side === "request" && (
          <SegmentedToggle<"classic" | "lens">
            value={requestVariant}
            onChange={setRequestVariant}
            align="start"
            size="sm"
            variant="soft"
            options={[
              { id: "classic", label: "经典", title: "原 Audit 过滤视图（默认）" },
              { id: "lens",    label: "Lens 预览", title: "多视角切换（来源 / 缓存 / Audit）" },
            ]}
          />
        )}
      </div>

      {side === "request" ? (
        requestVariant === "lens" ? (
          <AttributionTreeLensPanel sessionId={sessionId} callId={call.id} onLinkSource={onLinkSource} />
        ) : (
          <AttributionTreePanel sessionId={sessionId} callId={call.id} onLinkSource={onLinkSource} />
        )
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

// ─── 无 proxy 数据时的空状态 ──────────────────────────────────────────────────
// raw tab 在 callDetail.proxyRequestId == null 时整页渲染本组件。
// 配图位置：client/src/assets/proxy-missing.png（占位文件可为空 0 字节；
// onError 会自动隐藏 <img>，不会出现破图标）。
type ProxyV2Phase = "idle" | "starting" | "running" | "stopping";

interface ProxyV2Status {
  phase: ProxyV2Phase;
  active: boolean;
  port: number;
  pid: number | null;
}

function navigateToProxyTab() {
  window.dispatchEvent(new CustomEvent("dashboard:navigate", { detail: { tab: "proxy-v2" } }));
}

// 状态徽标：绿点 = 代理运行中；灰点 = 代理未启动。比之前那个橙色 warning box
// 更克制，"运行中" 和 "未启动" 用同一种 pill 容器，只换颜色。
function ProxyStatusPill({ running, label }: { running: boolean; label: string }) {
  const dotColor = running ? "#10b981" : "#9ca3af";
  const textColor = running ? "#047857" : "#6b7280";
  const bg       = running ? "#ecfdf5" : "#f3f4f6";
  const border   = running ? "#a7f3d0" : "#e5e7eb";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "3px 10px", borderRadius: 999,
      background: bg, border: `1px solid ${border}`,
      color: textColor, fontSize: 11, fontWeight: 600,
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: 999, background: dotColor,
        boxShadow: running ? "0 0 0 3px rgba(16,185,129,0.15)" : "none",
      }} />
      {label}
    </span>
  );
}

// 内联 link 风格：用于「打开代理设置 →」「去启动」等跳转，使代理 tab 一键可达。
function InlineLink({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: "none", background: "transparent", padding: 0,
        color: "#6366f1", fontWeight: 600, fontSize: "inherit",
        cursor: "pointer", textDecoration: "none",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
      onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
    >
      {children}
    </button>
  );
}

function ProxyMissingEmptyState() {
  const { t } = useTranslation();
  const [imgOk, setImgOk] = useState(true);
  const [status, setStatus] = useState<ProxyV2Status | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // 拉一次当前 proxy 状态。后续如果用户点了「启动」，按钮内部会主动再拉。
  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-v2/status")
      .then((r) => r.json())
      .then((d: ProxyV2Status) => { if (!cancelled) setStatus(d); })
      .catch(() => { /* 网络错误也算 stopped 处理 */ })
      .finally(() => { if (!cancelled) setLoadingStatus(false); });
    return () => { cancelled = true; };
  }, []);

  const handleStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const r = await fetch("/api/proxy-v2/start", { method: "POST" });
      const next = await r.json() as ProxyV2Status & { lastError?: string | null };
      setStatus(next);
      if (next.lastError) setStartError(next.lastError);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  // running = phase 是 running 或 starting；都视作"代理已在工作 / 即将工作"
  const isRunning = status?.phase === "running" || status?.phase === "starting";

  // 列表项：左侧一个柔和的小圆点充当 marker，避免直接使用 ⚠ / · 这种突兀符号。
  const renderBullet = (content: React.ReactNode) => (
    <li style={{
      display: "flex", gap: 10, alignItems: "flex-start",
      fontSize: 12, lineHeight: 1.65, color: "#4b5563",
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: 999, background: "#cbd5e1",
        marginTop: 8, flexShrink: 0,
      }} />
      <span style={{ flex: 1 }}>{content}</span>
    </li>
  );

  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      textAlign: "center", padding: "32px 24px", gap: 16,
    }}>
      {imgOk && (
        <img
          src={proxyMissingUrl}
          alt=""
          onError={() => setImgOk(false)}
          style={{ maxWidth: 220, width: "100%", height: "auto", opacity: 0.95 }}
        />
      )}

      {loadingStatus ? (
        <div style={{ fontSize: 12, color: "#9ca3af" }}>
          {t("rawTab.noProxyStatusChecking")}
        </div>
      ) : isRunning ? (
        // ─── 代理已在运行 ───────────────────────────────────────────────────
        // 解释为什么这条 call 仍然没数据，并给出两条 actionable 建议（重启 /
        // 配置第三方域名）。第二条带 inline link 直跳代理 tab。
        <>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1f2937" }}>
            {t("rawTab.noProxyTitleRunning")}
          </div>
          <ProxyStatusPill running label={t("rawTab.noProxyStatusRunning")} />
          <ul style={{
            listStyle: "none", padding: 0, margin: "4px 0 0 0",
            maxWidth: 480, textAlign: "left",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            {renderBullet(t("rawTab.noProxyRunningHintRestart"))}
            {renderBullet(
              <>
                {t("rawTab.noProxyRunningHintThirdParty", {
                  tab: t("nav.proxy"),
                  section: t("proxyTraffic.captureTargets"),
                })}{" "}
                <InlineLink onClick={navigateToProxyTab}>
                  {t("rawTab.noProxyOpenProxyTab")}
                </InlineLink>
              </>,
            )}
          </ul>
        </>
      ) : (
        // ─── 代理未启动 ─────────────────────────────────────────────────────
        // 主 CTA = 内置「启动代理」按钮；副 CTA = 「去启动」inline link 跳到
        // 代理 tab 让用户看更多上下文后再启动。重启提示作为 bullet 收敛。
        <>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1f2937" }}>
            {t("rawTab.noProxyTitleStopped")}
          </div>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 10,
          }}>
            <ProxyStatusPill running={false} label={t("rawTab.noProxyStatusStopped")} />
            <InlineLink onClick={navigateToProxyTab}>
              {t("rawTab.noProxyGoStart")} →
            </InlineLink>
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.65, color: "#4b5563", maxWidth: 480 }}>
            {t("rawTab.noProxyBodyStopped")}
          </div>
          <button
            type="button"
            onClick={handleStart}
            disabled={starting}
            style={{
              padding: "8px 18px", borderRadius: 8,
              border: "none",
              background: starting ? "#c7d2fe" : "#6366f1",
              color: "#fff", fontWeight: 600, fontSize: 13,
              cursor: starting ? "not-allowed" : "pointer",
              minWidth: 120,
            }}
          >
            {starting ? t("rawTab.noProxyStartButtonBusy") : t("rawTab.noProxyStartButton")}
          </button>
          {startError && (
            <div style={{
              fontSize: 11, color: "#991b1b",
              background: "#fef2f2", border: "1px solid #fecaca",
              borderRadius: 6, padding: "6px 10px", maxWidth: 480,
            }}>
              {t("rawTab.noProxyStartFailed", { error: startError })}
            </div>
          )}
          <ul style={{
            listStyle: "none", padding: 0, margin: "4px 0 0 0",
            maxWidth: 480, textAlign: "left",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            {renderBullet(t("rawTab.noProxyRestartHint"))}
          </ul>
        </>
      )}
    </div>
  );
}

// ─── 原始数据 tab ─────────────────────────────────────────────────────────────

function RawCopyButton({ text }: { text: string }) {
  const [copiedAt, setCopiedAt] = useState<number>(0);
  const isCopied = copiedAt > 0 && Date.now() - copiedAt < 1500;
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(
      () => { setCopiedAt(Date.now()); setTimeout(() => setCopiedAt(0), 1500); },
      () => {},
    );
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={isCopied ? "已复制" : "复制"}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        border: "1px solid",
        borderColor: isCopied ? "#16a34a" : "#d1d5db",
        background: isCopied ? "#dcfce7" : "transparent",
        color: isCopied ? "#15803d" : "#9ca3af",
        borderRadius: 3, fontSize: 9, fontWeight: 600,
        padding: "1px 6px", cursor: "pointer", lineHeight: 1.3,
        flexShrink: 0,
        transition: "background 0.12s, border-color 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => { if (!isCopied) { e.currentTarget.style.borderColor = "#9ca3af"; e.currentTarget.style.color = "#374151"; } }}
      onMouseLeave={(e) => { if (!isCopied) { e.currentTarget.style.borderColor = "#d1d5db"; e.currentTarget.style.color = "#9ca3af"; } }}
    >
      {isCopied ? (
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {isCopied ? "已复制" : "复制"}
    </button>
  );
}

function RawTab({ call, freshIn, callDetail, callDetailLoading }: {
  call: MockLlmCall;
  freshIn: number;
  callDetail: CallDetail | null;
  callDetailLoading: boolean;
}) {
  const { t } = useTranslation();
  const jsonlText = JSON.stringify(
    { call_id: call.id, index_in_turn: call.indexInTurn, model: call.model, timestamp: call.timestamp, usage: { context_size: call.contextSize, fresh_in: freshIn, cache_read: call.cacheRead, cache_write: call.cacheWrite, output_tokens: call.outputTokens }, stop_reason: call.stopReason, ...(call.proxy ? { proxy_request_id: call.proxy.requestId, duration_ms: call.proxy.durationMs } : {}) },
    null, 2,
  );
  const requestText = callDetail?.rawRequestJson
    ? JSON.stringify(callDetail.rawRequestJson, null, 2)
    : null;

  if (callDetailLoading) {
    return <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0" }}>Loading…</div>;
  }

  return (
    <>
      <div style={{ fontSize: 10, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: "5px 10px", marginBottom: 12, color: "#374151" }}>
        Proxy — full request body available.
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {t("terms.jsonlMetadata")}
        </div>
        <RawCopyButton text={jsonlText} />
      </div>
      <CodeBlock variant="json" style={{ marginBottom: 14 }}>
        {jsonlText}
      </CodeBlock>

      {requestText && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {t("terms.proxyRequestBody")}
            </div>
            <RawCopyButton text={requestText} />
          </div>
          <CodeBlock variant="json">
            {requestText}
          </CodeBlock>
        </>
      )}
    </>
  );
}

function LlmCallDetailPanel({
  call, prevCall, sessionId, agentFileId, mode = "main", requestedTab, jumpVersion,
  onShowTurnContext, onLinkCall, onLinkSource,
  onClose, onOpenAsMain,
}: {
  call: MockLlmCall;
  /** Previous LlmCall (id = call.id − 1). Optional — when present and the
   *  call has cache token data, DiffPanel renders a cache-impact row. */
  prevCall?: MockLlmCall | null;
  onSelectEntry: (e: MockDiffEntry) => void;
  sessionId: string;
  /** Present iff this call belongs to a sub-agent — routes all downstream
   *  panel API calls (callDetail / attributionTree / responseTree / diffTree)
   *  through their sub-agent variants. Parent (main) sessions leave undefined. */
  agentFileId?: string;
  mode?: "main" | "panel";
  /** Initial / forced tab. When `jumpVersion` bumps, this overrides the
   *  user's prior manual tab choice — so a fresh "返回于 call #N Response"
   *  click always lands on the response tab even if the user previously
   *  switched away. */
  requestedTab?: CallTab;
  /** Counter that bumps each time the dispatcher fires a new jump. The
   *  panel useEffect listens to this so it can force-reset the tab even
   *  when call.id + requestedTab look identical to the previous render. */
  jumpVersion?: number;
  onShowTurnContext?: () => void;
  /** 双向 link 回调：点击 Response 中的 forwarding link 时触发，传入下游 call id */
  onLinkCall?: (callId: number) => void;
  /** 反向 link 回调：点击 Request 中某个 leaf（jsonl 来源带 sourceCallId）时触发，
   *  跳到产生这个 tool_use/tool_result 的源 call。仅在 main 模式提供——
   *  panel 模式下省略以避免链接面板再派生面板（无限嵌套）。*/
  onLinkSource?: (sourceCallId: number, sourceTurnId?: number) => void;
  /**
   * Chrome-bar callbacks. When provided, render the corresponding button in
   * a top frame above the panel header. Same shape used by the linked-panel
   * wrapper (LinkedContextPanel) so the bar reads identically in both
   * contexts. Each button is hidden when its callback is undefined — main
   * mode typically gets `onClose` only (open-as-main is meaningless there
   * and stays hidden by default).
   */
  onClose?: () => void;
  onOpenAsMain?: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CallTab>(requestedTab ?? "attribution");
  const [callDetail, setCallDetail] = useState<CallDetail | null>(null);
  const [callDetailLoading, setCallDetailLoading] = useState(true);
  // Top ledger summary: in main mode it starts expanded for the at-a-glance
  // overview, then auto-collapses on first interaction. In panel mode the
  // user is "drilling into" something specific — the summary is just chrome
  // taking vertical space, so it starts collapsed. Either mode, user can
  // click the chevron to toggle.
  const [summaryCollapsed, setSummaryCollapsed] = useState(mode === "panel");
  const collapseSummary = () => { if (!summaryCollapsed) setSummaryCollapsed(true); };
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Load eagerly on mount — needed for Attribution (real segments) from first render
  useEffect(() => {
    if (callDetail?.callId === call.id) return;
    setCallDetailLoading(true);
    const fetcher = agentFileId
      ? apiV2.subAgentCallDetail(sessionId, agentFileId, call.id)
      : apiV2.callDetail(sessionId, call.id);
    fetcher
      .then(d => setCallDetail(d))
      .catch(() => setCallDetail(null))
      .finally(() => setCallDetailLoading(false));
  }, [call.id, sessionId, agentFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset summary state when switching to a different call (panel reuse).
  // Re-initializes per mode (panel = collapsed, main = expanded).
  useEffect(() => { setSummaryCollapsed(mode === "panel"); }, [call.id, mode]);

  // Force-apply the requested tab on every fresh jump (jumpVersion bumps).
  // Listening on jumpVersion alone — rather than [requestedTab] — means
  // even if the dispatcher sends the same tab twice in a row, we still
  // reset (the user may have manually switched between them). Without this
  // hard reset the user's manual selection would "stick" and the next
  // jump would land on the wrong tab.
  useEffect(() => {
    if (requestedTab && jumpVersion != null) setTab(requestedTab);
  }, [jumpVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to top whenever the displayed call changes (call switch or fresh
  // jump) so the header is always visible and the user doesn't land mid-page.
  useEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, [call.id, jumpVersion]);

  const hasProxy = !!callDetail?.proxyRequestId;
  const freshIn  = call.contextSize - call.cacheRead - call.cacheWrite;
  const nearLimit = false;
  const prevCallId = call.id > 1 ? call.id - 1 : null;

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

  const TAB_DEFS: Array<{ id: CallTab; label: string }> = [
    { id: "attribution", label: t("callTab.attribution") },     // 请求（含 来源/Diff/Cache/Audit 多 lens）
    { id: "response",    label: t("callTab.responseAnalysis") },// 响应分析
    { id: "raw",         label: t("callTab.raw") },             // 原始数据
  ];

  return (
    <div ref={scrollContainerRef} style={{ flex: 1, overflowY: "auto", padding: mode === "panel" ? "12px 14px" : "16px 22px", minWidth: 0 }}>

      {/* ── Header ──────────────────────────────── */}
      {/* No outer paddingBottom/border here — UnifiedHeader below provides
          the divider line, so we don't stack two borders. */}
      <div>

        {/* Title row — single global call id everywhere.
            Right-side action chips adapt to mode:
              · main mode  → 查看所在轮次 + 关闭
              · panel mode → Open as main + 关闭
            Both modes share the trailing `×` close button so the same
            shape reads across left/right views. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "#111827" }}>
            {t("terms.callLabel")} {call.id}
          </span>
          {call.isCompaction && <RiskBadge type="compaction" />}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {/* Mode-specific primary action. onOpenAsMain takes precedence
                (panel mode); falls back to onShowTurnContext (main mode);
                neither shown if neither callback provided. */}
            {onOpenAsMain ? (
              <button
                onClick={onOpenAsMain}
                style={{ border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4338ca", borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
                title={t("terms.openAsMain")}
              >
                {t("terms.openAsMain")}
              </button>
            ) : onShowTurnContext && (
              <button onClick={onShowTurnContext} style={{ border: "1px solid #c7d2fe", background: "#eef2ff", color: "#6366f1", borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                {t("terms.showInTurn")}
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
              <NoProxyDot title={t("rawTab.noProxyDotTooltip")} />
            )}
            {/* Single chevron toggles ledger collapse/expand. Lives in the
                title row so the position is stable across both states (the
                old inline "展开 ▾" / absolute "收起 ▴" pair jumped between
                the summary's compact bar and the UnifiedHeader's top-right
                corner — the latter even overlapped OUTPUT). */}
            <button
              type="button"
              onClick={() => setSummaryCollapsed(v => !v)}
              title={summaryCollapsed ? "展开 token ledger" : "折叠 token ledger"}
              style={{
                border: "1px solid #e5e7eb", background: "#fff", color: "#64748b",
                borderRadius: 6, padding: "1px 7px", fontSize: 11, lineHeight: 1.2,
                cursor: "pointer", fontWeight: 600,
              }}
            >
              {summaryCollapsed ? "ledger ▾" : "ledger ▴"}
            </button>
            {onClose && (
              <button
                onClick={onClose}
                title="关闭"
                style={{
                  border: "1px solid #e5e7eb", background: "#fff", color: "#64748b",
                  borderRadius: 6, padding: "1px 7px", fontSize: 14, lineHeight: 1,
                  cursor: "pointer", fontWeight: 700,
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>

        {(() => {
          // Cache hit ratio — denominator includes cache_write so the value
          // matches the Turn / Session header and the CallLedger thumbnail
          // inside the call card. Previously this used (fresh + cacheRead)
          // only, which dropped cache_write from the denominator and produced
          // a different number than the Turn-level view of the same call.
          const inputTotal = freshIn + call.cacheRead + call.cacheWrite;
          const cacheRatio = inputTotal > 0 ? call.cacheRead / inputTotal * 100 : null;
          // Call-level status badges — currently only "compaction" is meaningful
          // at this granularity. Kept here so Call shares the same right-slot
          // shape as Session/Turn (even when empty the slot stays consistent).
          const callBadges: StatusBadge[] = call.isCompaction
            ? [{ kind: "compaction", count: 1, tooltip: t("sessionOverview.badges.compaction") }]
            : [];
          // The first call in a session has no previous call → Δ vs prev is
          // meaningless (would just echo contextSize). Hide that stat entirely
          // in both collapsed and expanded summaries when prevCallId is null.
          const isFirstCall = prevCallId == null;
          if (summaryCollapsed) {
            return (
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "6px 10px", borderTop: "1px solid #f3f4f6",
                borderBottom: "1px solid #f3f4f6",
                fontSize: 11, color: "#6b7280",
              }}>
                <span>{t("terms.ctxSuffix")} <strong style={{ color: "#374151" }}>{fmtK(call.contextSize)}</strong></span>
                {!isFirstCall && (
                  <span>Δ <strong style={{ color: "#374151" }}>{call.significantDelta >= 0 ? "+" : ""}{fmtK(call.significantDelta)}</strong></span>
                )}
                <span>{t("terms.toolsSuffix")} <strong style={{ color: "#374151" }}>{call.toolCalls?.length ?? 0}</strong></span>
                <span>{t("terms.cacheSuffix")} <strong style={{ color: "#374151" }}>{cacheRatio != null ? `${cacheRatio.toFixed(0)}%` : "—"}</strong></span>
              </div>
            );
          }
          return (
            <UnifiedHeader
              stats={[
                { label: "Context",   value: fmtK(call.contextSize),
                  color: nearLimit ? "#ea580c" : undefined,
                  tooltip: "Total input context (fresh + cache_read + cache_write)" },
                ...(isFirstCall ? [] : [{
                  label: "Δ vs prev",
                  value: `${call.significantDelta >= 0 ? "+" : ""}${fmtK(call.significantDelta)}`,
                  color: call.significantDelta > 10000 ? "#dc2626" : call.significantDelta > 2000 ? "#d97706" : call.significantDelta < -2000 ? "#16a34a" : undefined,
                  // The Δ reflects *total prompt size* change, including
                  // content loaded from cache. So a first-after-compaction
                  // call can show a huge Δ (e.g. +130k) even when "Input"
                  // is tiny (e.g. 6) — the bulk came from cache_read, not
                  // fresh tokens. This tooltip surfaces that distinction.
                  tooltip: "Prompt size delta vs previous call. Includes cache_read + cache_write, so it can be much larger than Input when most content is served from cache (e.g. first call after a compaction).",
                }]),
                { label: "Tool Calls", value: String(call.toolCalls?.length ?? 0) },
              ]}
              ledger={{
                mode: "call",
                freshIn,
                cacheRead: call.cacheRead,
                cacheWrite: call.cacheWrite,
                output: call.outputTokens,
                cacheRatio,
              }}
              rightSlot={callBadges.length > 0
                ? <StatusBadgeStrip badges={callBadges} renderIcon={renderStatusIcon} />
                : undefined}
            />
          );
        })()}
      </div>

      {/* No proxy — all three tabs collapse to the same prompt because
          Attribution / Diff / Raw all rely on the captured request body.
          Show the prompt once instead of repeating it under three tab labels. */}
      {!callDetailLoading && !hasProxy ? (
        <ProxyMissingEmptyState />
      ) : (
        <>
          {/* ── Tabs ────────────────────────────────────
              onClickCapture on the wrapper folds the top ledger summary on
              the first interaction the user makes anywhere inside the call
              detail body (tab switch, attribution drill-in, ...) so the
              tree gets more vertical room. The chevron in the collapsed
              summary lets users re-expand. */}
          <div onClickCapture={collapseSummary} style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb", marginBottom: 14, gap: 0 }}>
            {TAB_DEFS.map(({ id, label }) => (
              <button key={id} onClick={() => { setTab(id); collapseSummary(); }} style={{
                padding: "6px 12px", fontSize: 11, fontWeight: tab === id ? 700 : 400,
                color: tab === id ? "#6366f1" : "#6b7280",
                background: "none", border: "none",
                borderBottom: tab === id ? "2px solid #6366f1" : "2px solid transparent",
                cursor: "pointer", marginBottom: -1, whiteSpace: "nowrap",
              }}>{label}</button>
            ))}
          </div>

          {/* ══ Attribution — 多 lens 统一视图（来源 / Diff / 缓存 / Audit） ══ */}
          {tab === "attribution" && (
            <AttributionTreeLensPanel
              sessionId={sessionId}
              agentFileId={agentFileId}
              callId={call.id}
              prevCallId={prevCallId}
              onLinkSource={onLinkSource}
            />
          )}

          {/* ══ Response — assistant blocks (thinking / text / tool_use) ══ */}
          {tab === "response" && (
            <ResponseTreePanel
              sessionId={sessionId}
              agentFileId={agentFileId}
              callId={call.id}
              onLinkCall={onLinkCall}
            />
          )}

          {/* ══ Raw / Evidence ═══════════════════════════ */}
          {tab === "raw" && (
            <RawTab
              call={call}
              freshIn={freshIn}
              callDetail={callDetail}
              callDetailLoading={callDetailLoading}
            />
          )}
          </div>
        </>
      )}

    </div>
  );
}



// ─── Sub-Agent Session Panel ──────────────────────────────────────────────────

function SubAgentSessionPanel({
  drilldown,
  loadState,
  parentSessionId,
  agentFileId,
  parentLabel,
  onReturnToParent,
}: {
  drilldown: SessionDrilldown | null;
  loadState: "loading" | "ok" | "error";
  /** Parent session id — used for proxy/attribution lookups on sub-agent calls
   *  (sub-agent proxy rows live under the parent session id). */
  parentSessionId: string;
  /** Identifies which sub-agent JSONL the inner panels should route their
   *  call-detail / attribution-tree / response-tree / diff-tree fetches to. */
  agentFileId: string;
  parentLabel?: string;          // e.g. "Turn 3"
  onReturnToParent?: () => void; // closes sub-turn, returns to parent turn detail
}) {
  const { t } = useTranslation();

  // Internal nav state mirrors the main session's pattern: turn ↔ call.
  // Sub-agents skip the "session overview" level — we land directly on
  // the first turn, since a sub-agent is conceptually one (or a few) turns
  // of focused work. Multi-turn agents get the same left-rail switcher.
  const firstTurn = drilldown?.turns[0] ?? null;
  const [innerTurn, setInnerTurn] = useState<UserTurn | null>(firstTurn);
  const [innerCall, setInnerCall] = useState<LlmCall | null>(null);

  // Re-default when the drilldown payload changes (clicking a different sub agent).
  useEffect(() => {
    setInnerTurn(drilldown?.turns[0] ?? null);
    setInnerCall(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drilldown?.sessionId]);

  if (loadState === "loading") {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
        {t("sessionOverview.subAgent.loading")}
      </div>
    );
  }
  if (loadState === "error" || !drilldown) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#dc2626", fontSize: 13 }}>
        {t("sessionOverview.subAgent.loadFailed")}
      </div>
    );
  }

  const turns = drilldown.turns;
  const turnPrefix = t("sessionOverview.turn.label");
  const callPrefix = t("terms.callLabel");

  function handleSelectTurn(turn: UserTurn) {
    setInnerTurn(turn);
    setInnerCall(null);
  }
  function handleSelectCall(call: LlmCall) {
    setInnerCall(call);
  }

  // Cross-link kill-switch for the sub-agent scope (see earlier comment):
  // empty sessionId skips the attribution-graph API fetch; null onJumpToCall
  // suppresses every "↗ jump to call #N" UI inside descendant components.
  // Re-enabling is Phase 2 (banner explains).
  return (
    <AttributionGraphProvider sessionId="" onJumpToCall={null}>
      <div style={{ display: "flex", flex: 1, overflow: "hidden", flexDirection: "column" }}>
        {/* ── Top breadcrumb-style bar: back-to-parent + side-branch meta ── */}
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
            {/* Mini inline breadcrumb so the position inside the sub-agent
                is always visible — parallels the main session's header. */}
            {innerTurn && (
              <>
                <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
                <span style={{
                  fontSize: 11, fontWeight: 600,
                  color: !innerCall ? "#6366f1" : "#374151",
                  cursor: innerCall ? "pointer" : "default",
                }}
                  onClick={() => { if (innerCall) setInnerCall(null); }}
                >
                  {turnPrefix} {innerTurn.id}
                </span>
              </>
            )}
            {innerCall && (
              <>
                <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: "#6366f1" }}>
                  {callPrefix} {innerCall.id}
                </span>
              </>
            )}
          </div>
        )}

        {/* ── Body: 200px left nav + Main Canvas — same structure as main session ── */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Left nav — NavItem rows, one per sub-agent turn, with badges +
              indented Call sub-rows under the currently selected turn.
              Mirrors SessionDetailV2's left rail (lines ~5495+) but scoped
              to this sub-agent's drilldown. */}
          <div style={{ width: 200, borderRight: "1px solid #e5e7eb", overflowY: "auto", flexShrink: 0, background: "#fafafa" }}>
            <div style={{ padding: "12px 12px 4px", fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>
              {t("sessionOverview.subAgent.turnsHeader")}
            </div>
            {turns.map(turn => {
              const isThisTurnSelected = innerTurn?.id === turn.id;
              const turnInput = turn.userInput.trim();
              const preview = turnInput.slice(0, 16).trimEnd() + (turnInput.length > 16 ? "…" : "");
              const turnLabel = (
                <>
                  <strong style={{ fontWeight: 700, color: isThisTurnSelected ? "#4338ca" : "#111827" }}>
                    {turnPrefix} {turn.id}
                  </strong>
                  {preview && (
                    <span style={{ fontWeight: 400, color: "#9ca3af", marginLeft: 6 }}>
                      {preview}
                    </span>
                  )}
                </>
              );
              const subAgentCount = turn.calls.reduce((s, c) => s + (c.subAgents?.length ?? 0), 0);
              const commandCount = turn.calls.reduce(
                (s, c) => s + c.intervalEvents.filter(e => e.kind === "user:command").length, 0);
              const unknownCount = turn.calls.reduce(
                (s, c) => s + c.intervalEvents.filter(e => e.kind === "unknown").length, 0);
              const navBadgeItems: StatusBadge[] = [];
              if (turn.hasCompaction)   navBadgeItems.push({ kind: "compaction", count: 1,              tooltip: t("sessionOverview.badges.compaction") });
              if (turn.errorCount > 0)  navBadgeItems.push({ kind: "error",      count: turn.errorCount,tooltip: t("sessionOverview.badges.errors") });
              if (subAgentCount > 0)    navBadgeItems.push({ kind: "subAgent",   count: subAgentCount,  tooltip: t("sessionOverview.badges.subAgents") });
              if (commandCount > 0)     navBadgeItems.push({ kind: "command",    count: commandCount,   tooltip: t("sessionOverview.badges.commands") });
              if (unknownCount > 0)     navBadgeItems.push({ kind: "unknown",    count: unknownCount,   tooltip: t("sessionOverview.badges.unknown") });
              const turnBadges = (
                <StatusBadgeStrip badges={navBadgeItems} size="compact" renderIcon={renderStatusIcon} />
              );
              return (
                <React.Fragment key={`sa-turn-${turn.id}`}>
                  <NavItem
                    label={turnLabel}
                    sublabel={`${turn.netContextDelta > 0 ? "+" : ""}${fmtK(turn.netContextDelta)} · ${turn.llmCallCount} ${t("terms.callsSuffix")}${turn.toolCallCount > 0 ? ` · ${turn.toolCallCount} ${t("terms.toolsSuffix")}` : ""}`}
                    active={isThisTurnSelected && !innerCall}
                    badges={turnBadges}
                    onClick={() => handleSelectTurn(turn)}
                  />
                  {isThisTurnSelected && turn.calls.map(call => {
                    const toolCount = call.toolCalls?.length ?? 0;
                    const deltaTxt = call.isSignificant && call.significantDelta !== 0
                      ? ` · ${call.significantDelta > 0 ? "+" : ""}${fmtK(call.significantDelta)}`
                      : "";
                    const toolsTxt = toolCount > 0
                      ? ` · ${toolCount} ${t("terms.toolsSuffix")}`
                      : "";
                    return (
                      <NavItem
                        key={`sa-call-${call.id}`}
                        indent
                        label={call.isCompaction ? `${callPrefix} ${call.id} ◆` : `${callPrefix} ${call.id}`}
                        sublabel={`${fmtK(call.contextSize)}${deltaTxt}${toolsTxt}`}
                        active={innerCall?.id === call.id}
                        onClick={() => handleSelectCall(call)}
                      />
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>

          {/* Main Canvas — reuses the exact same Turn/Call panels as the
              main session, so all interactions (Token ledger hover, Diff vs
              prev, sub-agent fork, etc.) work identically. */}
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
            {innerTurn && !innerCall && (
              <UserTurnDetailPanel
                turn={innerTurn}
                onSelectCall={handleSelectCall}
                isMockSession={false}
                sessionId={parentSessionId}
              />
            )}
            {innerCall && (
              <LlmCallDetailPanel
                call={innerCall}
                onSelectEntry={() => {}}
                sessionId={parentSessionId}
                agentFileId={agentFileId}
                onClose={() => setInnerCall(null)}
              />
            )}
            {!innerTurn && (
              <div style={{ padding: 40, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
                {t("sessionOverview.subAgent.empty")}
              </div>
            )}
          </div>
        </div>
      </div>
    </AttributionGraphProvider>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type NavLevel = "session" | "turn" | "inter-turn" | "call" | "subagent" | "compact-event";

type InspectorState =
  | { type: "hotspots" }
  | { type: "turn-rollup"; turn: MockUserTurn }
  | { type: "call-diff"; call: MockLlmCall }
  | { type: "evidence"; entry: MockDiffEntry };

type LinkedPanelState =
  | {
      type: "call";
      call: MockLlmCall;
      turn: MockUserTurn;
      /** Tab the panel should land on when this jump is applied. Combined
       *  with `jumpVersion` to force-override the user's prior manual tab
       *  selection on every fresh jump (not just on call id change). */
      requestedTab?: CallTab;
      /** Bumps on every dispatched jump so panels useEffect can detect
       *  "another jump fired even if the call/tab look identical" and
       *  reset to the requested tab. */
      jumpVersion?: number;
    }
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
  const compactEvents: CompactEvent[] = drilldown?.compactEvents ?? [];
  const isMockData = drilldown === null;

  const [navLevel, setNavLevel] = useState<NavLevel>("session");
  const [selectedTurn, setSelectedTurn] = useState<MockUserTurn | null>(null);
  const [selectedInterTurnBlock, setSelectedInterTurnBlock] = useState<InterTurnBlock | null>(null);
  // /compact event 选中状态。点击 left rail 的 🗜 行只切换高亮 —— 详情面板在
  // 后续 task 接入；目前只让用户能视觉确认"点击位置 = 这个 compact"。
  const [selectedCompactEventIdx, setSelectedCompactEventIdx] = useState<number | null>(null);
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

  function openLinkedCall(
    call: MockLlmCall,
    turnHint?: MockUserTurn | null,
    requestedTab?: CallTab,
  ) {
    const turn = turnHint ?? findTurnForCall(call.id);
    if (!turn) {
      handleSelectCall(call);
      return;
    }
    setLinkedPanel({
      type: "call", call, turn, requestedTab,
      jumpVersion: Date.now(),
    });
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

  // ── Attribution graph wiring ────────────────────────────────────────────
  // Build a fast lookup so EventUnitCard's `›` jump button can resolve a
  // bare callId (e.g. firstSeenInCall from a JsonlEventAnnotation) to a
  // MockLlmCall and open the linked panel. turns may be a fallback array
  // before drilldown lands — the closure stays correct because turns is
  // referenced fresh each render.
  const callById = useMemo(() => {
    const m = new Map<number, MockLlmCall>();
    for (const turn of turns) {
      for (const call of turn.calls) m.set(call.id, call);
    }
    return m;
  }, [turns]);

  const onJumpToCall = useCallback((callId: number, lens?: "request" | "response") => {
    const call = callById.get(callId);
    if (!call) return;
    // Map the lens hint to a Call detail tab. We translate "request" → the
    // attribution tab (the canonical "first-prompt" view) and "response" →
    // ResponseTreePanel. No hint defaults to whatever the panel was showing.
    const tab: CallTab | undefined =
      lens === "response" ? "response"
      : lens === "request" ? "attribution"
      : undefined;
    openLinkedCall(call, undefined, tab);
  }, [callById]); // openLinkedCall is closure-stable enough at this scope; turns flow through callById

  return (
    <AttributionGraphProvider sessionId={session.session_id} onJumpToCall={onJumpToCall}>
    <div
      style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "flex-start", justifyContent: "flex-end" }}
      onClick={onClose}
    >
      <div
        style={{
          // Drawer width is responsive to "how much canvas does this state
          // need":
          //   · linkedPanel open → widest (1560px) since right panel eats
          //     a big chunk
          //   · subagent open → 1480px because the sub-agent view has its
          //     own 200px left nav + breadcrumb + amber notice
          //   · default (session / turn / call) → 1480px so unified lens
          //     view has room to breathe (旧版 1200 太挤；用户反馈调宽)
          // The viewport-relative form (calc(100vw - Npx)) is the lower
          // bound when the screen is narrow; the maxWidth caps it on a
          // wide screen so the drawer doesn't stretch to absurd widths.
          width: linkedPanel
            ? "calc(100vw - 64px)"
            : navLevel === "subagent"
              ? "calc(100vw - 96px)"
              : "calc(100vw - 120px)",
          maxWidth: linkedPanel ? 1560 : navLevel === "subagent" ? 1480 : 1480,
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
                  <span style={{ fontSize: 13, fontWeight: 600, color: navLevel === "turn" && !selectedCall ? "#6366f1" : "#374151" }}>{t("sessionOverview.turn.label")} {selectedTurn.id}</span>
                </button>
              </>
            )}
            {selectedCall && (
              <>
                <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#6366f1", flexShrink: 0 }}>
                  {t("terms.callLabel")} {selectedCall.id}
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
            <AuditBoundaryStatus />
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
              const turnPrefix = t("sessionOverview.turn.label");
              const callPrefix = t("terms.callLabel");
              return turns.map(turn => {
                const isThisTurnSelected = selectedTurn?.id === turn.id;
                const turnInput = turn.userInput.trim();
                const preview = turnInput.slice(0, 16).trimEnd() + (turnInput.length > 16 ? "…" : "");
                // Two inline spans (no flex container) so the outer NavItem
                // ellipsis still kicks in. The prefix is bold + foreground;
                // the user-input preview is lighter weight + muted grey.
                const turnLabel = (
                  <>
                    <strong style={{ fontWeight: 700, color: isThisTurnSelected ? "#4338ca" : "#111827" }}>
                      {turnPrefix} {turn.id}
                    </strong>
                    {preview && (
                      <span style={{ fontWeight: 400, color: "#9ca3af", marginLeft: 6 }}>
                        {preview}
                      </span>
                    )}
                  </>
                );
                // Status badges — same source-of-truth + same icon+count format
                // as the right-slot pills in UserTurnDetailPanel.
                const subAgentCount = turn.calls.reduce((s, c) => s + (c.subAgents?.length ?? 0), 0);
                const commandCount = turn.calls.reduce(
                  (s, c) => s + c.intervalEvents.filter(e => e.kind === "user:command").length, 0);
                const unknownCount = turn.calls.reduce(
                  (s, c) => s + c.intervalEvents.filter(e => e.kind === "unknown").length, 0);
                const noProxyCount = turn.calls.filter(c => c.proxyMatchMode === "unmatched").length;
                const navBadgeItems: StatusBadge[] = [];
                if (turn.hasCompaction)   navBadgeItems.push({ kind: "compaction", count: 1,              tooltip: t("sessionOverview.badges.compaction") });
                if (turn.errorCount > 0)  navBadgeItems.push({ kind: "error",      count: turn.errorCount,tooltip: t("sessionOverview.badges.errors") });
                if (subAgentCount > 0)    navBadgeItems.push({ kind: "subAgent",   count: subAgentCount,  tooltip: t("sessionOverview.badges.subAgents") });
                if (commandCount > 0)     navBadgeItems.push({ kind: "command",    count: commandCount,   tooltip: t("sessionOverview.badges.commands") });
                if (unknownCount > 0)     navBadgeItems.push({ kind: "unknown",    count: unknownCount,   tooltip: t("sessionOverview.badges.unknown") });
                if (noProxyCount > 0)     navBadgeItems.push({ kind: "noProxy",    count: noProxyCount,   tooltip: t("sessionOverview.badges.noProxyDetail", { count: noProxyCount })});
                const turnBadges = (
                  <StatusBadgeStrip badges={navBadgeItems} size="compact" renderIcon={renderStatusIcon} />
                );
                return (
                  <React.Fragment key={`turn-${turn.id}`}>
                    <NavItem
                      label={turnLabel}
                      sublabel={`${turn.netContextDelta > 0 ? "+" : ""}${fmtK(turn.netContextDelta)} · ${turn.llmCallCount} ${t("terms.callsSuffix")}${turn.toolCallCount > 0 ? ` · ${turn.toolCallCount} ${t("terms.toolsSuffix")}` : ""}`}
                      active={navLevel === "turn" && isThisTurnSelected && !selectedCall}
                      badges={turnBadges}
                      onClick={() => handleSelectTurn(turn)}
                    />
                    {isThisTurnSelected && allCallsForNav.length > 0 && allCallsForNav.map(call => {
                      // Call-level nav: a single global id everywhere.
                      // Label is `${callPrefix} ${call.id}` (e.g. `LLM 调用 4`)
                      // — the same numbering used in the call card header,
                      // call detail title and the breadcrumb. The sublabel no
                      // longer repeats #id since it's already in the label.
                      const callLabel = call.isCompaction
                        ? `${callPrefix} ${call.id} ◆`
                        : `${callPrefix} ${call.id}`;
                      const toolCount = call.toolCalls?.length ?? 0;
                      const deltaTxt = call.isSignificant && call.significantDelta !== 0
                        ? ` · ${call.significantDelta > 0 ? "+" : ""}${fmtK(call.significantDelta)}`
                        : "";
                      const toolsTxt = toolCount > 0
                        ? ` · ${toolCount} ${t("terms.toolsSuffix")}`
                        : "";
                      const callNavBadges: StatusBadge[] = call.isCompaction
                        ? [{ kind: "compaction", count: 1, tooltip: t("sessionOverview.badges.compaction") }]
                        : [];
                      // Proxy-link quality dot: 与右侧 chrome 的 NoProxyDot
                      // 同色同形 —— 让 sidebar 和 detail 顶部对同一条 call 的
                      // "无 proxy" 提示完全一致。
                      const hasProxyDot = call.proxyMatchMode === "unmatched";
                      const badgesNode = (hasProxyDot || callNavBadges.length > 0) ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                          {hasProxyDot && (
                            <NoProxyDot size={8} title={t("rawTab.noProxyDotTooltip")} />
                          )}
                          {callNavBadges.length > 0 && (
                            <StatusBadgeStrip badges={callNavBadges} size="compact" renderIcon={renderStatusIcon} />
                          )}
                        </div>
                      ) : undefined;
                      return (
                        <NavItem
                          key={call.id}
                          indent
                          label={callLabel}
                          sublabel={`${fmtK(call.contextSize)}${deltaTxt}${toolsTxt}`}
                          active={
                            selectedCall?.id === call.id
                            || (linkedPanel?.type === "call" && linkedPanel.call.id === call.id)
                            || (linkedPanel?.type === "turn-excerpt" && linkedPanel.focusCall?.id === call.id)
                          }
                          badges={badgesNode}
                          onClick={() => handleSelectCall(call)}
                        />
                      );
                    })}
                    {/* 在 turn N 之后插入归属于 "afterTurnId === turn.id" 的
                        compact 事件 sibling 行。同一个 turn 之后可能有多个
                        compact（罕见但允许），按 belonging 顺序渲染。 */}
                    {compactEvents
                      .filter(ev =>
                        (ev.belonging.kind === "between-turns" && ev.belonging.afterTurnId === turn.id)
                        || (ev.belonging.kind === "post-session" && ev.belonging.afterTurnId === turn.id)
                      )
                      .map(ev => (
                        <CompactEventNavItem
                          key={`compact-${ev.index}`}
                          ev={ev}
                          active={navLevel === "compact-event" && selectedCompactEventIdx === ev.index}
                          onClick={() => {
                            setSelectedCompactEventIdx(ev.index);
                            setNavLevel("compact-event");
                          }}
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
            {navLevel === "compact-event" && selectedCompactEventIdx !== null
              && compactEvents[selectedCompactEventIdx] && (
              <UserTurnDetailPanel
                turn={synthesizeCompactTurn(compactEvents[selectedCompactEventIdx])}
                onSelectCall={() => { /* 合成 call 没有真实 jsonl line，暂不接入 call detail */ }}
                isMockSession={false}
                sessionId={session.session_id}
              />
            )}
            {navLevel === "call" && selectedCall && (
              <LlmCallDetailPanel
                call={selectedCall}
                prevCall={
                  turns.flatMap(t => t.calls)
                       .find(c => c.id === selectedCall.id - 1) ?? null
                }
                onSelectEntry={handleSelectEntry}
                sessionId={session.session_id}
                onClose={() => {
                  // Closing the Call detail in main view = step back to the
                  // turn that owns it. If for some reason the turn lookup
                  // fails (call orphaned), fall back to the session level.
                  const turn = findTurnForCall(selectedCall.id);
                  if (turn) handleSelectTurn(turn);
                  else handleNavSession();
                }}
                onShowTurnContext={() => {
                  const turn = findTurnForCall(selectedCall.id);
                  if (turn) openLinkedTurnExcerpt(turn, selectedCall);
                }}
                onLinkCall={(cid) => {
                  const target = turns.flatMap(t => t.calls).find(c => c.id === cid);
                  const targetTurn = target ? turns.find(t => t.calls.some(c => c.id === cid)) : null;
                  if (target && targetTurn) openLinkedTurnExcerpt(targetTurn, target);
                }}
                onLinkSource={(srcCallId, srcTurnId) => {
                  // Reverse link from a Request leaf → the call that emitted
                  // this tool_use/tool_result. Open the *source turn's* full
                  // call event list on the right with that call scrolled into
                  // focus — reading the source call in its conversational
                  // context (sibling calls + assistant text + tool flow) is
                  // far more useful than opening just the call's attribution
                  // detail again. The user can still pin/open-as-main from
                  // the Turn excerpt to drill deeper.
                  const srcCall = turns.flatMap(t => t.calls).find(c => c.id === srcCallId);
                  // Derive turn from the call itself first — srcTurnId belongs to
                  // sourceCallId, not firstSeenInCall, so it can point to the wrong turn.
                  const srcTurn = srcCall
                    ? turns.find(t => t.calls.some(c => c.id === srcCallId)) ?? null
                    : srcTurnId != null
                      ? turns.find(t => t.id === srcTurnId) ?? null
                      : null;
                  if (!srcTurn) return;
                  openLinkedTurnExcerpt(srcTurn, srcCall ?? null);
                }}
              />
            )}
            {navLevel === "subagent" && selectedSubAgent && (
              <SubAgentSessionPanel
                drilldown={subAgentDrilldown}
                loadState={subAgentLoadState}
                parentSessionId={session.session_id}
                agentFileId={selectedSubAgent.agentFileId}
                parentLabel={selectedTurn ? `${t("sessionOverview.turn.label")} ${selectedTurn.id}` : undefined}
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
            onShowTurnContext={(turn, focusCall) => openLinkedTurnExcerpt(turn, focusCall)}
            onSelectEntry={handleSelectEntry}
          />

        </div>
      </div>
    </div>
    </AttributionGraphProvider>
  );
}

function LinkedContextPanel({
  panel,
  sessionId,
  onClose,
  onOpenAsMain,
  onSelectEntry,
}: {
  panel: LinkedPanelState | null;
  /** kept in API for forwards-compat but no longer surfaced as a UI button —
   *  call panels and turn-excerpt panels both now render their own action
   *  chips in the consolidated summary header.
   *  @deprecated Pin removed in favor of the single-row layout. */
  pinned?: boolean;
  sessionId: string;
  onClose: () => void;
  onTogglePin?: () => void;
  onOpenAsMain: () => void;
  /** kept for API compat; not used by the simplified shell. */
  onShowTurnContext?: (turn: MockUserTurn, focusCall: MockLlmCall | null) => void;
  onSelectEntry: (entry: MockDiffEntry) => void;
}) {
  const open = panel !== null;

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
        /* No outer chrome bar: both call detail and turn excerpt now render
           their own title row + Open-as-main + × buttons inline. The
           wrapper just sits behind them sliding in/out. */
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex" }}>
          {panel.type === "call" ? (
            <LlmCallDetailPanel
              call={panel.call}
              onSelectEntry={onSelectEntry}
              sessionId={sessionId}
              mode="panel"
              requestedTab={panel.requestedTab}
              jumpVersion={panel.jumpVersion}
              onClose={onClose}
              onOpenAsMain={onOpenAsMain}
              /* In panel mode `onShowTurnContext` is intentionally omitted
                 so the title row picks the `Open as main` chip instead of
                 the 查看所在轮次 chip (would loop back to the same Turn
                 the user already linked from). */
              onLinkCall={undefined}
              onLinkSource={undefined}
            />
          ) : (
            <LinkedTurnExcerptPanel
              turn={panel.turn}
              focusCall={panel.focusCall}
              /* Same anti-recursion rule for Turn excerpts: clicking a Call
                 inside should not open yet another panel. Silenced here;
                 "Open as main" promotes the excerpt into the main canvas. */
              onSelectCall={undefined}
              onClose={onClose}
              onOpenAsMain={onOpenAsMain}
            />
          )}
        </div>
      )}
    </aside>
  );
}

function linkedPanelButtonStyle(kind: "primary" | "active" | "neutral" | "ghost"): React.CSSProperties {
  const base: React.CSSProperties = {
    borderRadius: 6,
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
  onClose,
  onOpenAsMain,
}: {
  turn: MockUserTurn;
  focusCall: MockLlmCall | null;
  /** Optional: when omitted (panel-mode anti-recursion), call clicks are inert.
   *  Users can "Open as main" to drill further. */
  onSelectCall?: (call: MockLlmCall, turn: MockUserTurn) => void;
  /** Chrome callbacks plumbed through to UserTurnDetailPanel's summary
   *  header — replaces the now-removed LinkedContextPanel wrapper bar. */
  onClose?: () => void;
  onOpenAsMain?: () => void;
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
      {/* LinkedPanelScope masks the jump dispatcher + sets
          `linkedPanelMode: true` on context — Turn / Call render code
          inside drops its forward-jump buttons so a click inside the
          right panel never spawns ANOTHER right panel. */}
      <LinkedPanelScope>
        <UserTurnDetailPanel
          turn={turn}
          onSelectCall={onSelectCall ? (c) => onSelectCall(c, turn) : NOOP_SELECT_CALL}
          onClose={onClose}
          onOpenAsMain={onOpenAsMain}
        />
      </LinkedPanelScope>
    </div>
  );
}

// Shared no-op so the inert panel-mode click handler keeps a stable identity
// across renders (avoids tripping UserTurnDetailPanel's memoization).
const NOOP_SELECT_CALL = () => { /* panel-mode: clicks are inert */ };

function NavItem({
  label, sublabel, active, badge, badgeColor, badges, onClick, indent,
}: {
  /** ReactNode so callers can split the label into a bold prefix + a lighter
   *  preview (e.g. `<strong>轮次 1</strong> 考虑现在的…`). Plain strings still
   *  work for the simpler "Overview" entries. */
  label: React.ReactNode;
  sublabel?: string; active: boolean;
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
        {sublabel && (
          <div style={{
            fontSize: 10, color: "#9ca3af", marginTop: 1,
            // Nav is fixed at 200px — long stat strings would otherwise wrap to
            // a second line and break the row rhythm. Truncate instead.
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>{sublabel}</div>
        )}
      </div>
      {badges
        ? <div style={{
            display: "flex", alignItems: "center", gap: 3,
            flexShrink: 0,
            // The badge strip itself wraps internally; keep the container on
            // one line so the NavItem height stays uniform.
            maxWidth: 80, overflow: "hidden",
          }}>{badges}</div>
        : badge && <span style={{ fontSize: 10, color: badgeColor, fontWeight: 700, flexShrink: 0 }}>{badge}</span>
      }
    </div>
  );
}

// CompactEventNavItem —— 在左侧 Turn 列表中作为 sibling 行渲染。
// 视觉规则：跟 turn / call 都不同，凸显"非 turn 的系统级事件"。
//   - 橙色色板（不与 turn 蓝 / call 灰 / interTurn 紫冲突）
//   - 🗜 icon + "Compact" + 压缩比一行表达
//   - userInstructions 非空时作为副标题展示（"focus on parser" 这类语义意图必须可见）
function CompactEventNavItem({ ev, active, onClick }: { ev: CompactEvent; active: boolean; onClick: () => void }) {
  const ratioPct = ev.preTokens > 0
    ? Math.max(0, Math.round((1 - ev.postTokens / ev.preTokens) * 100))
    : 0;
  const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
  const triggerTag = ev.trigger === "manual" ? "M" : ev.trigger === "auto" ? "A" : ev.trigger === "micro" ? "μ" : "?";
  return (
    <div
      onClick={onClick}
      style={{
        padding: "5px 12px 5px 16px",
        cursor: "pointer",
        background: active ? "#fff7ed" : "transparent",
        borderLeft: active ? "2px solid #f97316" : "2px solid transparent",
        display: "flex", alignItems: "center", gap: 6,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = "#fffbeb"; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
      title={`Compact · ${ev.trigger} · ${fmtTokens(ev.preTokens)} → ${fmtTokens(ev.postTokens)} (-${ratioPct}%)`}
    >
      <span style={{ fontSize: 11, flexShrink: 0 }}>🗜</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 11, color: active ? "#c2410c" : "#9a3412",
          fontWeight: 600,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          Compact
          <span style={{ fontWeight: 400, color: "#c2410c", marginLeft: 6, fontSize: 9 }}>{triggerTag}</span>
          <span style={{ fontWeight: 400, color: "#9ca3af", marginLeft: 6, fontSize: 10 }}>
            {fmtTokens(ev.preTokens)} → {fmtTokens(ev.postTokens)}
          </span>
        </div>
        <div style={{
          fontSize: 10, color: "#9ca3af", marginTop: 1,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          fontStyle: ev.userInstructions ? "normal" : "italic",
        }}>
          {ev.userInstructions
            ? `"${ev.userInstructions}"`
            : `-${ratioPct}% · ${(ev.durationMs / 1000).toFixed(1)}s${ev.proxy ? ` · ${ev.proxy.model}` : ""}`}
        </div>
      </div>
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

// ─── synthesizeCompactTurn —— 把 CompactEvent 包装成 UserTurn-shape 数据 ──────
// 让 UserTurnDetailPanel 可以"完全复用"渲染 Compact 详情。映射要点：
//
//   UserTurn.userInput          ← `/compact [args]` 或 `/compact`
//   UserTurn.userInputLineIdx   ← ev.commandLineIdx（用户敲命令那一行）
//   UserTurn.finalOutput        ← ev.summaryText（注入到下次推理 prompt 的 summary 文本）
//   UserTurn.calls              ← 1 个合成 LlmCall，承载 summarization LLM call 的数据
//                                  来源是 proxy_requests 富化；jsonl 端无 assistant 事件
//   call.intervalEvents         ← jsonl 端 3 条相关事件（boundary / summary / 可选 command）
//                                  按行号排序，让 IntervalEventRow 顺序渲染
//
// 标志位 hasCompaction=true 保证 risk badge 显示 "compaction"。
// turn.id 用极小负数避开和真实 turn 撞 key（左 rail 不用这个 turn 渲染，但下游
// flatMap(t => t.calls) 会扫描所有 turns —— 我们没把合成 turn 加入 turns 数组，
// 只是直接喂给 UserTurnDetailPanel，所以撞 key 实际上不会发生）。
function synthesizeCompactTurn(ev: CompactEvent): UserTurn {
  const synthCallId = -(ev.index + 1) * 1000; // 极小负 id，跨真实 turn 都不会撞
  // intervalEvents：boundary / summary 必有，command 可选。按 lineIdx 升序排。
  const ies: IntervalEvent[] = [];
  if (ev.commandLineIdx !== null) {
    ies.push({
      kind: "user:command",
      lineIdx: ev.commandLineIdx,
      timestamp: ev.timestamp,
      contentPreview: ev.userInstructions
        ? `/compact ${ev.userInstructions}`
        : "/compact",
      contentSize: (ev.userInstructions?.length ?? 0) + "/compact".length + 1,
      rawJson: JSON.stringify({ type: "user", commandName: "/compact", commandArgs: ev.userInstructions ?? "" }),
    });
  }
  ies.push({
    kind: "system:compact_boundary",
    lineIdx: ev.boundaryLineIdx,
    timestamp: ev.timestamp,
    contentPreview: `compact_boundary · trigger=${ev.trigger} · ${ev.preTokens}→${ev.postTokens} tokens · ${ev.durationMs}ms`,
    contentSize: 0,
    rawJson: JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      uuid: ev.boundaryUuid,
      compactMetadata: {
        trigger: ev.trigger,
        preTokens: ev.preTokens,
        postTokens: ev.postTokens,
        durationMs: ev.durationMs,
      },
    }),
  });
  if (ev.summaryLineIdx !== null && ev.summaryText !== null) {
    ies.push({
      kind: "user:compact_summary",
      lineIdx: ev.summaryLineIdx,
      timestamp: ev.timestamp,
      contentPreview: ev.summaryText,
      contentSize: ev.summaryText.length,
      rawJson: JSON.stringify({
        type: "user",
        isCompactSummary: true,
        uuid: ev.summaryUuid,
        message: { role: "user", content: ev.summaryText },
      }),
    });
  }
  ies.sort((a, b) => a.lineIdx - b.lineIdx);

  // 合成 LlmCall：来源 = proxy 富化。proxy 缺失时降级为零值。
  const proxyData = ev.proxy ? {
    requestId: ev.proxy.proxyRequestId,
    reqMessageCount: null,
    reqHasTools: null,
    resInputTokens: ev.proxy.inputTokens,
    resOutputTokens: ev.proxy.outputTokens,
    resCacheCreation: 0,
    resCacheRead: ev.proxy.cacheReadTokens,
    resStopReason: "end_turn",
    errorClass: null,
    durationMs: ev.proxy.durationMs,
  } : null;

  const syntheticCall: LlmCall = {
    id: synthCallId,
    indexInTurn: 1,
    messageId: null,
    apiRequestId: ev.proxy?.requestId ?? null,
    jsonlLineIdx: null,
    jsonlFrameLineIdxs: [],
    contextSize: ev.preTokens,
    outputTokens: ev.proxy?.outputTokens ?? 0,
    cacheRead: ev.proxy?.cacheReadTokens ?? 0,
    cacheWrite: 0,
    timestamp: ev.proxy?.startedAt ?? ev.timestamp,
    model: ev.proxy?.model ?? "",
    stopReason: "end_turn",
    isCompaction: true,
    isUnknownHeavy: false,
    freshIn: ev.proxy?.inputTokens ?? 0,
    isSignificant: true,
    significantDelta: ev.postTokens - ev.preTokens,
    proxy: proxyData,
    proxyMatchMode: ev.proxy ? "exact" : "unmatched",
    subAgents: [],
    incomingDiff: [],
    toolNames: [],
    toolCalls: [],
    assistantText: ev.summaryText?.slice(0, 500) ?? "",
    intervalEvents: ies,
  };

  return {
    id: -(ev.index + 1),    // 负 id，避开真实 turn
    userInput: ev.userInstructions ? `/compact ${ev.userInstructions}` : "/compact",
    userInputLineIdx: ev.commandLineIdx,
    finalOutput: ev.summaryText,
    midTurnInjections: [],
    startedAt: ev.timestamp,
    endedAt: ev.timestamp,
    durationMs: ev.durationMs,
    llmCallCount: 1,
    toolCallCount: 0,
    netContextDelta: ev.postTokens - ev.preTokens,
    peakContext: ev.preTokens,
    cacheRead: ev.proxy?.cacheReadTokens ?? 0,
    cacheWrite: 0,
    unknownDelta: 0,
    hasCompaction: true,
    hasUnknownSpike: false,
    errorCount: 0,
    calls: [syntheticCall],
  };
}

// ─── CompactEventPanel —— /compact 详情面板 ───────────────────────────────────
// 风格上类 InterTurnBlockPanel：header 统计块 + body 顺序事件行。
// 数据来源严格基于 CompactEvent 的三源（boundary / summary / command / proxy），
// 不读 jsonl 原始文件 —— parser 已经把所有必需信息序列化进 CompactEvent。
//
// 内容分四个"逻辑事件"按时间顺序展示：
//   1. /compact command  ← jsonl 的 user.<command-name>/compact</command-name> 行
//                          带 userInstructions（如果用户指定了 args）
//   2. boundary marker   ← jsonl 的 system.compact_boundary 行，含 metadata
//   3. summarization LLM call  ← proxy_requests 富化（model / tokens / duration）
//                                jsonl 端无对应 assistant 事件，但调用真实发生过
//   4. summary injection ← jsonl 的 user.isCompactSummary=true 行
//                          这是 post-compact 第一次推理 prompt 里的 user message
//
// 复用 InterTurnBlockDetail 的"kindLabel + monospace row"行风格，但不直接调用
// InterTurnBlockDetail —— 后者吃的是 IntervalEvent[]，CompactEvent 不在那个数据通路里。
function CompactEventPanel({ ev }: { ev: CompactEvent }) {
  const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
  const ratioPct = ev.preTokens > 0
    ? Math.max(0, Math.round((1 - ev.postTokens / ev.preTokens) * 100))
    : 0;
  const triggerLabel = ev.trigger === "manual" ? "manual"
                      : ev.trigger === "auto"   ? "auto"
                      : ev.trigger === "micro"  ? "micro"
                      : ev.trigger;
  const belongingLabel = ev.belonging.kind === "between-turns"
    ? `T${ev.belonging.afterTurnId} → T${ev.belonging.beforeTurnId}`
    : ev.belonging.kind === "post-session"
      ? `T${ev.belonging.afterTurnId} → session end`
      : ev.belonging.kind === "pre-session"
        ? `session start → T${ev.belonging.beforeTurnId}`
        : `(other)`;
  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid #f3f4f6" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#c2410c" }}>
            🗜 Compact
          </span>
          <span style={{ fontSize: 10, color: "#9a3412", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>
            {triggerLabel}
          </span>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>· system-level maintenance event ·</span>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>{belongingLabel}</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { label: "Pre→Post", value: `${fmtTokens(ev.preTokens)} → ${fmtTokens(ev.postTokens)}` },
            { label: "Ratio", value: `-${ratioPct}%`, color: ratioPct >= 80 ? "#16a34a" : "#c2410c" },
            { label: "Duration", value: `${(ev.durationMs / 1000).toFixed(1)}s` },
            ...(ev.proxy ? [
              { label: "Model", value: ev.proxy.model || "—" },
              { label: "Out tokens", value: fmtTokens(ev.proxy.outputTokens) },
              { label: "Cache read", value: fmtTokens(ev.proxy.cacheReadTokens) },
            ] : [{ label: "Proxy", value: "unmatched", color: "#94a3b8" }]),
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              padding: "5px 10px", background: "#fff7ed", borderRadius: 6,
              border: "1px solid #fed7aa", minWidth: 64,
            }}>
              <span style={{ fontSize: 9, color: "#9ca3af", marginBottom: 2 }}>{label}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: color ?? "#c2410c" }}>{value}</span>
            </div>
          ))}
        </div>
        {ev.userInstructions && (
          <div style={{ marginTop: 12, padding: "8px 12px", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 6 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: "#92400e", letterSpacing: "0.08em", marginBottom: 4 }}>
              USER INSTRUCTIONS（/compact 附加指令）
            </div>
            <div style={{ fontSize: 12, color: "#78350f", fontFamily: "monospace", wordBreak: "break-word" }}>
              {ev.userInstructions}
            </div>
          </div>
        )}
      </div>

      {/* Event sequence —— jsonl 顺序 + LLM call 在 boundary 前 */}
      <div style={{ border: "1px solid #fed7aa", borderRadius: 8, background: "#fff7ed", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #fed7aa", background: "#ffedd5" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#c2410c" }}>Event sequence</span>
          <span style={{ fontSize: 10, color: "#fb923c" }}>·</span>
          <span style={{ fontSize: 10, color: "#fb923c", fontStyle: "italic" }}>
            jsonl events + the (jsonl-invisible) summarization LLM call
          </span>
        </div>

        <div style={{ padding: "8px 12px" }}>
          {/* 1. /compact command (可选) */}
          {ev.commandLineIdx !== null && (
            <CompactEventRow
              tag="cmd"
              lineRef={`L${ev.commandLineIdx + 1}`}
              text={ev.userInstructions
                ? `/compact ${ev.userInstructions}`
                : "/compact"}
              note="user typed slash command"
            />
          )}

          {/* 2. boundary marker */}
          <CompactEventRow
            tag="bound"
            lineRef={`L${ev.boundaryLineIdx + 1}`}
            text={`compact_boundary · trigger=${ev.trigger} · ${fmtTokens(ev.preTokens)} → ${fmtTokens(ev.postTokens)} · ${(ev.durationMs / 1000).toFixed(1)}s`}
            note={`uuid=${ev.boundaryUuid.slice(0, 8)}…`}
          />

          {/* 3. summarization LLM call —— jsonl 端没有对应 assistant 事件，
              这一行的数据全部来自 proxy_requests 富化。这是 UI 上的"幽灵 call"，
              显式标出"proxy-only"避免用户以为它该出现在 turn 的 call 列表里。 */}
          {ev.proxy ? (
            <CompactEventRow
              tag="llm"
              lineRef={`proxy#${ev.proxy.proxyRequestId}`}
              text={`${ev.proxy.model} · in=${fmtTokens(ev.proxy.inputTokens)} cache=${fmtTokens(ev.proxy.cacheReadTokens)} out=${fmtTokens(ev.proxy.outputTokens)} · ${(ev.proxy.durationMs / 1000).toFixed(1)}s`}
              note="summarization call · not in jsonl"
            />
          ) : (
            <CompactEventRow
              tag="llm"
              lineRef="—"
              text="summarization LLM call (not matched in proxy_requests)"
              note="jsonl never records this call as an assistant event"
              muted
            />
          )}

          {/* 4. injected summary —— L22, isCompactSummary=true */}
          {ev.summaryLineIdx !== null && ev.summaryText && (
            <CompactEventRow
              tag="summary"
              lineRef={`L${ev.summaryLineIdx + 1}`}
              text={ev.summaryText}
              note={`isCompactSummary · injected into next call's prompt · ${ev.summaryText.length}b`}
              monospaceBlock
            />
          )}
        </div>
      </div>
    </div>
  );
}

// 单行渲染，复用 InterTurnBlockDetail 的 "kindLabel chip + monospace text" 风格，
// 但 chip 用橙色色板与 InterTurn 紫色区分。
function CompactEventRow({
  tag, lineRef, text, note, muted, monospaceBlock,
}: {
  tag: string;
  lineRef: string;
  text: string;
  note?: string;
  muted?: boolean;
  monospaceBlock?: boolean;
}) {
  return (
    <div style={{ padding: "6px 0", borderBottom: "1px solid #ffedd5", display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{
        fontSize: 9, fontWeight: 700, color: muted ? "#94a3b8" : "#c2410c",
        background: muted ? "#f1f5f9" : "#ffedd5", borderRadius: 3, padding: "1px 5px",
        flexShrink: 0, marginTop: 2, minWidth: 42, textAlign: "center",
      }}>
        {tag}
      </span>
      <span style={{
        fontSize: 9, fontWeight: 600, color: "#9ca3af",
        flexShrink: 0, marginTop: 3, minWidth: 56, textAlign: "left", fontFamily: "monospace",
      }}>
        {lineRef}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {monospaceBlock ? (
          <pre style={{
            margin: 0, fontSize: 11, color: muted ? "#94a3b8" : "#374151",
            fontFamily: "monospace", lineHeight: 1.45, whiteSpace: "pre-wrap",
            wordBreak: "break-word", maxHeight: 360, overflowY: "auto",
            padding: "6px 8px", background: "#fff", border: "1px solid #fed7aa", borderRadius: 4,
          }}>
            {text}
          </pre>
        ) : (
          <div style={{ fontSize: 11, color: muted ? "#94a3b8" : "#374151", fontFamily: "monospace", wordBreak: "break-all", lineHeight: 1.5 }}>
            {text}
          </div>
        )}
        {note && (
          <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2, fontStyle: "italic" }}>{note}</div>
        )}
      </div>
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
