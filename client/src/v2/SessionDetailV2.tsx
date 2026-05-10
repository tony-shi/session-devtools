import { useEffect, useState } from "react";
import type { SessionV2 } from "./types";
import type { DiffEntry, LlmCall, ModelStats, SessionDrilldown, UserTurn } from "./drilldown-types";
import { apiV2 } from "./api";

// Local aliases for brevity (same as drilldown-types, no local re-declaration needed)
type MockDiffEntry = DiffEntry;
// LlmCall fields added in drilldown-types are optional in the raw fallback
// data below; normalizeTurns() fills them in.
type RawMockCall = Omit<LlmCall,
  "indexInTurn" | "model" | "contextWindowSize" | "stopReason" | "proxy" |
  "isCompaction" | "isUnknownHeavy" | "isSignificant" | "significantDelta"
> & {
  isCompaction?: boolean; isUnknownHeavy?: boolean; isSignificant?: boolean; significantDelta?: number;
};
type RawMockTurn = Omit<UserTurn, "startedAt" | "endedAt" | "hasCompaction" | "hasUnknownSpike" | "finalOutput" | "durationMs" | "calls"> & {
  hasCompaction?: boolean; hasUnknownSpike?: boolean; calls: RawMockCall[];
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
    ...t,
    calls: t.calls.map((c, ci) => ({
      ...c,
      indexInTurn: ci + 1,
      model: "claude-opus-4-7",
      contextWindowSize: 200_000,
      stopReason: "end_turn" as const,
      proxy: null,
      isCompaction: c.isCompaction ?? false,
      isUnknownHeavy: c.isUnknownHeavy ?? false,
      isSignificant: c.isSignificant ?? false,
      significantDelta: c.significantDelta ?? 0,
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

function CallNodeIcon({ call }: { call: MockLlmCall }) {
  if (call.isCompaction) return <span style={{ color: "#ef4444", fontSize: 13 }}>◆</span>;
  if (call.isUnknownHeavy) return <span style={{ color: "#94a3b8", fontSize: 13 }}>◎</span>;
  if (call.isSignificant) return <span style={{ color: "#3b82f6", fontSize: 13 }}>●</span>;
  return <span style={{ color: "#d1d5db", fontSize: 13 }}>○</span>;
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
          { label: "Net Context", value: `${turn.netContextDelta > 0 ? "+" : ""}${fmtK(turn.netContextDelta)}` },
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
  // Prefer real drilldown data for metrics; fallback to turn-computed values
  const totalCalls = drilldown?.totalLlmCalls ?? turns.reduce((s, t) => s + t.llmCallCount, 0);
  const totalToolCalls = drilldown?.totalToolCalls ?? turns.reduce((s, t) => s + t.toolCallCount, 0);
  const peakContext = drilldown?.peakContext ?? (turns.length ? Math.max(...turns.map(t => t.peakContext)) : 0);
  const totalCacheRead = drilldown?.totalCacheRead ?? turns.reduce((s, t) => s + t.cacheRead, 0);
  const totalCacheWrite = drilldown?.totalCacheWrite ?? turns.reduce((s, t) => s + t.cacheWrite, 0);
  const totalFreshIn = drilldown?.totalFreshIn ?? null;
  const totalFreshOut = drilldown?.totalFreshOut ?? null;
  const systemErrors = drilldown?.systemErrorCount ?? null;
  const isMock = drilldown === null;

  // Duration from session metadata
  let durationStr = "—";
  if (drilldown?.firstEventAt && drilldown?.lastEventAt) {
    const ms = new Date(drilldown.lastEventAt).getTime() - new Date(drilldown.firstEventAt).getTime();
    if (ms > 0) durationStr = ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`;
  }

  // Cache ratio
  const totalInput = (totalFreshIn ?? 0) + totalCacheRead;
  const cacheRatio = totalInput > 0 ? Math.round((totalCacheRead / totalInput) * 100) : null;

  const modelBreakdown = drilldown?.modelBreakdown ?? null;
  const contextWindowSize = drilldown?.contextWindowSize ?? 200_000;

  // Net Context = last call's context size minus first call's context size across the whole session
  // Semantics: how much did the total context window usage grow from session start to end?
  // This reflects the net accumulation after all tool results, compactions, and assistant history.
  const allCallsFlat = turns.flatMap(t => t.calls);
  const netContext = allCallsFlat.length >= 2
    ? allCallsFlat[allCallsFlat.length - 1].contextSize - allCallsFlat[0].contextSize
    : null;
  const netContextStr = netContext !== null
    ? `${netContext >= 0 ? "+" : ""}${fmtK(netContext)}`
    : "—";

  const compactionTurns = turns.filter(t => t.hasCompaction || t.calls.some(c => c.isCompaction));

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* ── Token / call metrics ───────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        {/* Row 1: Model + LLM Calls combined */}
        {modelBreakdown && (() => {
          const entries = Object.entries(modelBreakdown).sort((a, b) => b[1].calls - a[1].calls);
          const singleModel = entries.length === 1;
          return (
            <div style={{ display: "grid", gridTemplateColumns: singleModel ? "auto 1fr" : "1fr 1fr", gap: 10, marginBottom: 10 }}>
              {/* Model identity */}
              <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                {entries.map(([m, s]) => {
                  const color = modelColor(m);
                  return (
                    <div key={m} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>{shortModelName(m)}</span>
                      {!singleModel && <span style={{ fontSize: 10, color: "#9ca3af" }}>{s.calls} calls</span>}
                    </div>
                  );
                })}
                <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 4 }}>
                  {contextWindowSize.toLocaleString()} ctx window
                </span>
              </div>
              {/* LLM / Tool Calls + Duration */}
              <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px", display: "flex", gap: 20, alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 2 }}>LLM Calls</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{totalCalls}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 2 }}>Tool Calls</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{totalToolCalls}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 2 }}>Turns</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{turns.length}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 2 }}>Duration</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{durationStr}</div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Row 2: Token breakdown — Cache Read/Write, Fresh In/Out, Ratio */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 10 }}>
          {[
            { label: "Cache Read", value: fmtK(totalCacheRead) },
            { label: "Cache Write", value: fmtK(totalCacheWrite) },
            { label: "Fresh In", value: totalFreshIn !== null ? fmtK(totalFreshIn) : "—" },
            { label: "Fresh Out", value: totalFreshOut !== null ? fmtK(totalFreshOut) : "—" },
            { label: "Cache Ratio", value: cacheRatio !== null ? `${cacheRatio}%` : "—", tooltip: "cache_read / (cache_read + fresh_in)" },
          ].map(({ label, value, tooltip }) => (
            <div key={label} title={tooltip} style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 12px" }}>
              <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 3 }}>{label}{isMock && <MockBadge />}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Row 3: Context stats — Peak, Net Context, Errors */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 12px" }}>
            <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 3 }}>Peak Context{isMock && <MockBadge />}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{fmtK(peakContext)}</div>
          </div>
          <div
            title="从 session 第一个 LLM call 到最后一个 call，context size 的净变化。正值表示整体增长；compaction 会压低这个数字。"
            style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 12px", cursor: "help" }}
          >
            <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 3 }}>
              Net Context
              {netContext === null && <MockBadge />}
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: netContext !== null && netContext < 0 ? "#16a34a" : "#111827" }}>
              {netContextStr}
            </div>
          </div>
          <div style={{
            background: systemErrors !== null && systemErrors > 0 ? "#fef2f2" : "#f9fafb",
            border: `1px solid ${systemErrors !== null && systemErrors > 0 ? "#fecaca" : "#e5e7eb"}`,
            borderRadius: 8, padding: "8px 12px",
          }}>
            <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 3 }}>Errors{isMock && <MockBadge />}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: systemErrors !== null && systemErrors > 0 ? "#dc2626" : "#111827" }}>
              {systemErrors ?? 0}
            </div>
          </div>
        </div>
      </div>

      {/* Compaction / Near-limit hotspot chips — only meaningful info */}
      {!isMock && (compactionTurns.length > 0 || peakContext > 150000) && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {compactionTurns.length > 0 && (
            <HotspotChip icon="◆" label="Compaction" value={compactionTurns.map(t => `Turn ${t.id}`).join(", ")} color="#ef4444" />
          )}
          {peakContext > 150000 && (
            <HotspotChip icon="⚠" label="Peak context" value={`${fmtK(peakContext)} (${Math.round(peakContext / contextWindowSize * 100)}%)`} color="#ea580c" />
          )}
        </div>
      )}

      {/* Model Breakdown — only show when there are multiple models */}
      {modelBreakdown && Object.keys(modelBreakdown).length > 1 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Models</div>
          <ModelBreakdownBlock breakdown={modelBreakdown} contextWindowSize={contextWindowSize} />
        </div>
      )}

      {/* Context Overview Timeline */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
          Context Timeline {isMock && <MockBadge />}
          {!isMock && (
            <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 400, marginLeft: 6 }}>
              ceiling = {fmtK(contextWindowSize)} ({contextWindowSize.toLocaleString()} tokens)
            </span>
          )}
        </div>
        <ContextTimelineChart turns={turns} isMock={isMock} contextWindowSize={contextWindowSize} />
      </div>

      {/* Top context contributors (mock) */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
          Top Context Contributors <MockBadge />
        </div>
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
      </div>

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
  breakdown, contextWindowSize,
}: { breakdown: Record<string, ModelStats>; contextWindowSize: number }) {
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
      {/* Footer: context window */}
      <div style={{ padding: "6px 12px", background: "#f9fafb", borderTop: "1px solid #e5e7eb" }}>
        <span style={{ fontSize: 10, color: "#9ca3af" }}>
          Context window ceiling: <strong style={{ color: "#374151" }}>{contextWindowSize.toLocaleString()} tokens</strong>
        </span>
      </div>
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
  turns, isMock, contextWindowSize = 200_000,
}: { turns: MockUserTurn[]; isMock: boolean; contextWindowSize?: number }) {
  const [xMode, setXMode] = useState<TimelineXMode>("linear");

  if (!turns.length) return null;

  // Collect all LLM calls with timestamps
  const allPoints: Array<{
    turnId: number; callId: number; contextSize: number;
    isCompaction: boolean; timestamp: string;
  }> = [];
  for (const turn of turns) {
    for (const call of turn.calls) {
      allPoints.push({
        turnId: turn.id, callId: call.id,
        contextSize: call.contextSize, isCompaction: call.isCompaction,
        timestamp: call.timestamp,
      });
    }
  }

  if (allPoints.length === 0) {
    const maxCtx = Math.max(...turns.map(t => t.peakContext), 1);
    const barColors = ["#6366f1", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7"];
    return (
      <div style={{ border: isMock ? "1px dashed #d1d5db" : "1px solid #e5e7eb", borderRadius: 8, padding: "16px", background: "#fafafa", height: 120, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: "80%", paddingBottom: 4 }}>
          {turns.map((t, i) => {
            const h = Math.round((t.peakContext / maxCtx) * 100);
            return (
              <div key={t.id} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                <div style={{ width: "100%", height: `${Math.max(h, 4)}%`, background: barColors[i % barColors.length], borderRadius: "3px 3px 0 0", opacity: 0.7 }} />
                <div style={{ fontSize: 9, color: "#9ca3af", marginTop: 2 }}>T{t.id}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── SVG dimensions ──────────────────────────────────────────────
  const W = 600, H = 110, PAD = { t: 10, b: 22, l: 6, r: 36 };
  const chartW = W - PAD.l - PAD.r;
  const chartH = H - PAD.t - PAD.b;

  // ── Y axis: 0 → context window ceiling ─────────────────────────
  const toY = (v: number) => PAD.t + chartH - (v / contextWindowSize) * chartH;
  const ceilingY = toY(contextWindowSize);
  const warningY = toY(contextWindowSize * 0.9); // top-10% danger zone starts here

  // ── X axis: two modes ───────────────────────────────────────────
  // Mode A (linear): equal spacing per call index
  // Mode B (time): spacing proportional to wall-clock time between calls
  let xs: number[];
  const n = allPoints.length;

  if (xMode === "linear" || n <= 1) {
    xs = allPoints.map((_, i) => PAD.l + (i / Math.max(n - 1, 1)) * chartW);
  } else {
    // Parse timestamps to ms; fall back to linear if timestamps are missing/identical
    const tms = allPoints.map(p => {
      const t = p.timestamp ? new Date(p.timestamp).getTime() : NaN;
      return isNaN(t) ? null : t;
    });
    const hasAllTimestamps = tms.every(t => t !== null);
    if (!hasAllTimestamps) {
      xs = allPoints.map((_, i) => PAD.l + (i / Math.max(n - 1, 1)) * chartW);
    } else {
      const tFirst = tms[0]!;
      const tLast = tms[n - 1]!;
      const tRange = tLast - tFirst || 1;
      xs = tms.map(t => PAD.l + ((t! - tFirst) / tRange) * chartW);
    }
  }

  const ys = allPoints.map(p => toY(p.contextSize));
  const pathD = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");

  // Turn boundary x positions (first call of each turn except T1)
  const turnBoundaries: number[] = [];
  let cumIdx = 0;
  for (const turn of turns) {
    if (cumIdx > 0) turnBoundaries.push(xs[cumIdx]);
    cumIdx += turn.calls.length;
  }

  // Peak
  const peakCtx = Math.max(...allPoints.map(p => p.contextSize));
  const peakPct = peakCtx / contextWindowSize;
  const lineColor = peakPct > 0.9 ? "#ea580c" : "#6366f1";

  // Y-axis ticks: 200k ceiling + 50k increments
  const tickStep = contextWindowSize <= 200_000 ? 50_000 : 100_000;
  const yTicks = Array.from({ length: Math.floor(contextWindowSize / tickStep) + 1 }, (_, i) => i * tickStep)
    .filter(v => v <= contextWindowSize);

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
          const isCeiling = v === contextWindowSize;
          return (
            <g key={v}>
              <line x1={PAD.l} y1={y} x2={PAD.l + chartW} y2={y}
                stroke={isCeiling ? "#ef4444" : "#f3f4f6"}
                strokeWidth={isCeiling ? 1 : 0.75}
                strokeDasharray={isCeiling ? "4,3" : undefined}
                opacity={isCeiling ? 0.7 : 1}
              />
              <text x={W - PAD.r + 2} y={y + 3} fontSize={8}
                fill={isCeiling ? "#ef4444" : "#d1d5db"} opacity={isCeiling ? 0.85 : 1}>
                {fmtK(v)}
              </text>
            </g>
          );
        })}

        {/* Danger zone fill: top 10% of context window
            toY(ceiling) is the TOP of the chart (smaller Y value),
            toY(90%) is BELOW the ceiling (larger Y value).
            Height = toY(90%) - toY(ceiling) = positive number. */}
        <rect
          x={PAD.l} y={ceilingY}
          width={chartW} height={warningY - ceilingY}
          fill="#fef3c7" opacity={0.6}
        />

        {/* Turn boundary vertical lines */}
        {turnBoundaries.map((x, i) => (
          <line key={i} x1={x} y1={PAD.t} x2={x} y2={PAD.t + chartH}
            stroke="#e5e7eb" strokeWidth={1} strokeDasharray="3,3" />
        ))}

        {/* Turn labels at bottom */}
        {turns.map((turn, ti) => {
          const startIdx = turns.slice(0, ti).reduce((s, t) => s + t.calls.length, 0);
          const midIdx = startIdx + Math.floor(turn.calls.length / 2);
          const x = xs[Math.min(midIdx, xs.length - 1)] ?? 0;
          return (
            <text key={turn.id} x={x} y={H - 4} textAnchor="middle" fontSize={9} fill="#9ca3af">T{turn.id}</text>
          );
        })}

        {/* Time labels on X axis (Time mode only) */}
        {xMode === "time" && allPoints.map((p, i) => {
          if (!p.timestamp) return null;
          // Only label first + last + turn starts
          const isTurnStart = turnBoundaries.includes(xs[i]) || i === 0;
          if (!isTurnStart && i !== n - 1) return null;
          const label = p.timestamp.length >= 19
            ? p.timestamp.slice(11, 16)
            : p.timestamp.slice(0, 5);
          return (
            <text key={i} x={xs[i]} y={H - 4} textAnchor="middle" fontSize={8} fill="#c4b5d5">{label}</text>
          );
        })}

        {/* Area fill */}
        <path
          d={`${pathD} L${xs[n - 1].toFixed(1)},${(PAD.t + chartH).toFixed(1)} L${PAD.l.toFixed(1)},${(PAD.t + chartH).toFixed(1)} Z`}
          fill={lineColor} opacity={0.06}
        />

        {/* Main line */}
        <path d={pathD} fill="none" stroke={lineColor} strokeWidth={1.5} />

        {/* Compaction markers */}
        {allPoints.map((p, i) => p.isCompaction ? (
          <text key={i} x={xs[i]} y={ys[i] - 5} textAnchor="middle" fontSize={9} fill="#ef4444">◆</text>
        ) : null)}

        {/* Call dots */}
        {n <= 40 && allPoints.map((p, i) => (
          <circle key={i} cx={xs[i]} cy={ys[i]} r={2.5}
            fill={p.isCompaction ? "#ef4444" : lineColor} opacity={0.85} />
        ))}
      </svg>

      {/* Footer annotation */}
      {!isMock && (
        <div style={{ padding: "2px 10px 6px", fontSize: 10, color: "#9ca3af", display: "flex", gap: 16 }}>
          <span>
            Peak: <strong style={{ color: peakPct > 0.9 ? "#ea580c" : "#374151" }}>{fmtK(peakCtx)}</strong>
            {" "}({Math.round(peakPct * 100)}% of window)
          </span>
          {xMode === "time" && <span style={{ color: "#c4b5d5" }}>X axis = wall-clock time</span>}
          <span style={{ color: "#fde68a" }}>
            ░ danger zone = top 10% ({fmtK(contextWindowSize * 0.9)}+)
          </span>
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
  const [expanded, setExpanded] = useState(false);

  const inputFull = turn.userInput;
  const inputPreview = inputFull.length > INPUT_PREVIEW_CHARS
    ? inputFull.slice(0, INPUT_PREVIEW_CHARS) + "…"
    : inputFull;

  const outputFull = turn.finalOutput ?? null;
  const outputPreview = outputFull
    ? outputFull.length > OUTPUT_PREVIEW_CHARS
      ? outputFull.slice(0, OUTPUT_PREVIEW_CHARS) + "…"
      : outputFull
    : null;

  const needsExpand = inputFull.length > INPUT_PREVIEW_CHARS
    || (outputFull !== null && outputFull.length > OUTPUT_PREVIEW_CHARS);

  const dur = fmtDuration(turn.durationMs);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff", overflow: "hidden" }}>
      {/* Header row — always visible, click to drilldown */}
      <div
        onClick={onClick}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", cursor: "pointer", borderBottom: expanded ? "1px solid #f3f4f6" : "none" }}
        onMouseEnter={e => (e.currentTarget.style.background = "#fafafa")}
        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", flexShrink: 0 }}>Turn {turn.id}</span>
        {dur && <span style={{ fontSize: 10, color: "#9ca3af", flexShrink: 0 }}>{dur}</span>}
        <span style={{ fontSize: 11, color: "#9ca3af", flexShrink: 0 }}>
          {turn.llmCallCount} calls · {turn.toolCallCount} tools
        </span>
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {turn.hasCompaction && <RiskBadge type="compaction" />}
          {turn.peakContext > 150000 && <RiskBadge type="near-limit" />}
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
            {expanded ? inputFull : inputPreview}
          </div>
        </div>

        {/* Model output */}
        {outputFull && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", letterSpacing: "0.05em", marginBottom: 4 }}>ASSISTANT</div>
            <div style={{
              fontSize: 12, color: "#374151", lineHeight: 1.55,
              background: "#eff6ff", borderRadius: 6, padding: "8px 10px",
              whiteSpace: "pre-wrap", wordBreak: "break-word",
              borderLeft: "3px solid #6366f1",
            }}>
              {expanded ? outputFull : outputPreview}
            </div>
          </div>
        )}

        {/* Expand / collapse toggle */}
        {needsExpand && (
          <button
            onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
            style={{
              marginTop: 8, fontSize: 11, color: "#6366f1", background: "none",
              border: "none", cursor: "pointer", padding: 0,
            }}
          >
            {expanded ? "Show less ↑" : "Show more ↓"}
          </button>
        )}
      </div>
    </div>
  );
}

function UserTurnDetailPanel({
  turn, onSelectCall,
}: { turn: MockUserTurn; onSelectCall: (c: MockLlmCall) => void }) {
  const significantChanges = turn.calls.flatMap(c =>
    c.isSignificant || c.isCompaction
      ? c.incomingDiff
          .filter(d => Math.abs(d.delta) > 1000 || d.category === "Unknown" || d.changeType === "removed")
          .map(d => ({ call: c, entry: d }))
      : []
  );
  const maxContext = Math.max(...turn.calls.map(c => c.contextSize));

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* Turn Header */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 4 }}>Turn {turn.id}</div>
        <div style={{ fontSize: 12, color: "#4b5563", lineHeight: 1.5, background: "#f9fafb", padding: "8px 12px", borderRadius: 6, marginBottom: 8 }}>
          "{turn.userInput}"
        </div>
        <div style={{ fontSize: 11, color: "#6b7280" }}>
          {turn.llmCallCount} LLM calls · {turn.toolCallCount} tool calls ·{" "}
          <span style={{ fontWeight: 600, color: turn.netContextDelta > 0 ? "#16a34a" : "#dc2626" }}>
            {turn.netContextDelta > 0 ? "+" : ""}{fmtK(turn.netContextDelta)} context
          </span>
          {" "}· Peak {fmtK(turn.peakContext)}
        </div>
      </div>

      {/* Call Trend */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
          Call Trend <MockBadge />
        </div>
        <div style={{ border: "1px dashed #d1d5db", borderRadius: 8, padding: "12px 16px", background: "#fafafa" }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 64, marginBottom: 8 }}>
            {turn.calls.map(c => {
              const h = Math.round((c.contextSize / maxContext) * 100);
              const isComp = c.isCompaction;
              const isSig = c.isSignificant;
              return (
                <div
                  key={c.id}
                  onClick={() => onSelectCall(c)}
                  title={`Call #${c.id}: ${fmtK(c.contextSize)}`}
                  style={{
                    flex: 1, height: `${Math.max(h, 5)}%`, minHeight: 4,
                    background: isComp ? "#ef4444" : isSig ? "#3b82f6" : "#cbd5e1",
                    borderRadius: "2px 2px 0 0", cursor: "pointer", opacity: 0.85,
                    transition: "opacity 0.1s",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
                  onMouseLeave={e => (e.currentTarget.style.opacity = "0.85")}
                />
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 3 }}>
            {turn.calls.map(c => (
              <div key={c.id} style={{ flex: 1, textAlign: "center" }}>
                <span style={{ fontSize: 9, color: "#9ca3af" }}>#{c.id}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Significant Changes */}
      {significantChanges.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Significant Changes</div>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
            {significantChanges.map(({ call: c, entry: e }, i) => (
              <div
                key={`${c.id}-${e.id}`}
                onClick={() => onSelectCall(c)}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                  borderBottom: i < significantChanges.length - 1 ? "1px solid #f3f4f6" : "none",
                  cursor: "pointer", background: "#fff",
                }}
                onMouseEnter={e2 => (e2.currentTarget.style.background = "#f9fafb")}
                onMouseLeave={e2 => (e2.currentTarget.style.background = "#fff")}
              >
                <span style={{ fontSize: 11, color: "#9ca3af", width: 52, flexShrink: 0 }}>#{c.id}→</span>
                <ChangeTypeIcon type={e.changeType} />
                <span style={{ fontSize: 11, color: CATEGORY_COLORS[e.category] ?? "#6b7280", width: 80, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.category}
                </span>
                <span style={{ fontSize: 11, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.label}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: e.delta >= 0 ? "#16a34a" : "#dc2626", flexShrink: 0 }}>
                  {e.delta >= 0 ? "+" : ""}{fmtK(e.delta)}
                </span>
                <span style={{ fontSize: 10, color: "#9ca3af", flexShrink: 0 }}>
                  {e.confidence === "High" ? "✓" : e.confidence === "Unknown" ? "?" : "~"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Compact Call Strip */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>All Calls</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {turn.calls.map(c => (
            <div
              key={c.id}
              onClick={() => onSelectCall(c)}
              title={`Call #${c.id} · ${fmtK(c.contextSize)}${c.isCompaction ? " · compaction" : c.isSignificant ? ` · +${fmtK(c.significantDelta ?? 0)}` : ""}`}
              style={{
                display: "flex", alignItems: "center", gap: 4, padding: "4px 8px",
                borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer",
                background: c.isCompaction ? "#fef2f2" : c.isSignificant ? "#eff6ff" : "#f9fafb",
                fontSize: 11,
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = "#6366f1")}
              onMouseLeave={e => (e.currentTarget.style.borderColor = "#e5e7eb")}
            >
              <CallNodeIcon call={c} />
              <span style={{ color: "#374151" }}>#{c.id}</span>
              {c.isSignificant && <span style={{ color: "#3b82f6" }}>+{fmtK(c.significantDelta ?? 0)}</span>}
              {c.isCompaction && <span style={{ color: "#ef4444" }}>C</span>}
              {c.isUnknownHeavy && <span style={{ color: "#94a3b8" }}>?</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type DiffTab = "incoming" | "next" | "snapshot" | "evidence";

function LlmCallDetailPanel({
  call, onSelectEntry,
}: { call: MockLlmCall; onSelectEntry: (e: MockDiffEntry) => void }) {
  const [tab, setTab] = useState<DiffTab>("incoming");
  const netDelta = call.incomingDiff.reduce((s, e) => s + e.delta, 0);
  const added = call.incomingDiff.filter(e => e.changeType === "added");
  const removed = call.incomingDiff.filter(e => e.changeType === "removed");
  const changed = call.incomingDiff.filter(e => e.changeType === "changed");
  const retained = call.incomingDiff.filter(e => e.changeType === "retained");

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* Call Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>Call #{call.id}</div>
          {call.isCompaction && <RiskBadge type="compaction" />}
          {call.isSignificant && <RiskBadge type="large-growth" />}
        </div>
        <div style={{ fontSize: 11, color: "#6b7280" }}>{call.timestamp}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 10 }}>
          {[
            { label: "Context", value: fmtK(call.contextSize) },
            { label: "Output", value: fmtK(call.outputTokens) },
            { label: "Cache R", value: fmtK(call.cacheRead) },
            { label: "Cache W", value: fmtK(call.cacheWrite) },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: "#f9fafb", borderRadius: 6, padding: "8px 10px", border: "1px solid #e5e7eb" }}>
              <div style={{ fontSize: 10, color: "#9ca3af" }}>{label}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Snapshot Overview */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
          Snapshot Overview <MockBadge />
        </div>
        <div style={{ border: "1px dashed #d1d5db", borderRadius: 8, padding: "10px 12px", background: "#fafafa" }}>
          <div style={{ display: "flex", gap: 4, height: 12, borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
            {[
              { cat: "System", w: 22 },
              { cat: "Tool Schemas", w: 18 },
              { cat: "User Messages", w: 8 },
              { cat: "Assistant History", w: 15 },
              { cat: "Tool Output", w: 28 },
              { cat: "Unknown", w: 9 },
            ].map(({ cat, w }) => (
              <div key={cat} style={{ width: `${w}%`, height: "100%", background: CATEGORY_COLORS[cat] ?? "#e5e7eb" }} title={`${cat} ~${w}%`} />
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
            {[
              { cat: "System", w: 22 }, { cat: "Tool Output", w: 28 },
              { cat: "Tool Schemas", w: 18 }, { cat: "Assistant History", w: 15 },
              { cat: "User Messages", w: 8 }, { cat: "Unknown", w: 9 },
            ].map(({ cat, w }) => (
              <div key={cat} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: 1, background: CATEGORY_COLORS[cat] ?? "#e5e7eb" }} />
                <span style={{ fontSize: 10, color: "#6b7280" }}>{cat} {w}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Diff Tabs */}
      <div>
        <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb", marginBottom: 12 }}>
          {(["incoming", "next", "snapshot", "evidence"] as DiffTab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "7px 14px", fontSize: 12, fontWeight: tab === t ? 600 : 400,
                color: tab === t ? "#6366f1" : "#6b7280",
                background: "transparent", border: "none", borderBottom: tab === t ? "2px solid #6366f1" : "2px solid transparent",
                cursor: "pointer", marginBottom: -1,
              }}
            >
              {t === "incoming" ? "Incoming Diff" : t === "next" ? "Next Diff" : t === "snapshot" ? "Snapshot" : "Evidence"}
            </button>
          ))}
        </div>

        {tab === "incoming" && (
          <div>
            {/* Summary line */}
            <div style={{ background: "#f9fafb", borderRadius: 6, padding: "8px 12px", fontSize: 11, color: "#374151", marginBottom: 10, display: "flex", gap: 16 }}>
              <span><span style={{ fontWeight: 600, color: netDelta >= 0 ? "#16a34a" : "#dc2626" }}>{netDelta >= 0 ? "+" : ""}{fmtK(netDelta)}</span> net</span>
              <span>{added.length} added · {removed.length} removed · {changed.length} changed · {retained.length} retained</span>
            </div>
            {[
              { label: "Added", entries: added, color: "#16a34a" },
              { label: "Changed", entries: changed, color: "#d97706" },
              { label: "Removed", entries: removed, color: "#dc2626" },
              { label: "Retained", entries: retained, color: "#9ca3af" },
            ].filter(g => g.entries.length > 0).map(group => (
              <div key={group.label} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: group.color, marginBottom: 4 }}>{group.label}</div>
                {group.entries.map(entry => (
                  <DiffRow key={entry.id} entry={entry} onSelect={onSelectEntry} />
                ))}
              </div>
            ))}
          </div>
        )}

        {tab === "next" && (
          <div style={{ padding: "20px", textAlign: "center", color: "#9ca3af", fontSize: 12, border: "1px dashed #e5e7eb", borderRadius: 8 }}>
            Next Diff shows how the following call's context changed.<br /><MockBadge /><span style={{ marginLeft: 4 }}>Not yet implemented</span>
          </div>
        )}

        {tab === "snapshot" && (
          <div style={{ padding: "20px", textAlign: "center", color: "#9ca3af", fontSize: 12, border: "1px dashed #e5e7eb", borderRadius: 8 }}>
            Full snapshot of context at Call #{call.id}.<br /><MockBadge /><span style={{ marginLeft: 4 }}>Not yet implemented</span>
          </div>
        )}

        {tab === "evidence" && (
          <div style={{ padding: "20px", textAlign: "center", color: "#9ca3af", fontSize: 12, border: "1px dashed #e5e7eb", borderRadius: 8 }}>
            Click a diff row to view its evidence.<br /><MockBadge /><span style={{ marginLeft: 4 }}>Select a diff row above</span>
          </div>
        )}
      </div>
    </div>
  );
}

function DiffRow({ entry, onSelect }: { entry: MockDiffEntry; onSelect: (e: MockDiffEntry) => void }) {
  const confidenceColors = { High: "#16a34a", Medium: "#d97706", Low: "#dc2626", Unknown: "#6b7280" };
  return (
    <div
      onClick={() => onSelect(entry)}
      style={{
        display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
        borderRadius: 6, cursor: "pointer", marginBottom: 2,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = "#f3f4f6")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      <ChangeTypeIcon type={entry.changeType} />
      <div style={{ width: 6, height: 6, borderRadius: 1, background: CATEGORY_COLORS[entry.category] ?? "#e5e7eb", flexShrink: 0 }} />
      <span style={{ fontSize: 11, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.label}</span>
      <span style={{ fontSize: 10, color: confidenceColors[entry.confidence], flexShrink: 0 }} title={`${entry.confidence} confidence`}>
        {entry.confidence === "High" ? "✓" : entry.confidence === "Unknown" ? "?" : "~"}
      </span>
      <span style={{ fontSize: 11, fontWeight: 600, color: entry.delta >= 0 ? "#16a34a" : "#dc2626", flexShrink: 0, width: 48, textAlign: "right" }}>
        {entry.delta >= 0 ? "+" : ""}{fmtK(entry.delta)}
      </span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type NavLevel = "session" | "turn" | "call";

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
  const isMockData = drilldown === null;

  const [navLevel, setNavLevel] = useState<NavLevel>("session");
  const [selectedTurn, setSelectedTurn] = useState<MockUserTurn | null>(null);
  const [selectedCall, setSelectedCall] = useState<MockLlmCall | null>(null);
  const [inspector, setInspector] = useState<InspectorState>({ type: "hotspots" });

  const title = (drilldown?.title ?? session.custom_title ?? session.ai_title ?? session.session_id.slice(0, 16)) as string;

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
    setSelectedCall(null);
    setInspector({ type: "hotspots" });
  }

  function handleNavTurn(turn: MockUserTurn) {
    setSelectedTurn(turn);
    setSelectedCall(null);
    setNavLevel("turn");
    setInspector({ type: "turn-rollup", turn });
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
            {turns.map(turn => (
              <NavItem
                key={turn.id}
                label={`Turn ${turn.id}`}
                sublabel={`${turn.netContextDelta > 0 ? "+" : ""}${fmtK(turn.netContextDelta)} · ${turn.llmCallCount} calls`}
                active={navLevel === "turn" && selectedTurn?.id === turn.id && !selectedCall}
                badge={turn.hasCompaction ? "C" : turn.hasUnknownSpike ? "!" : undefined}
                badgeColor={turn.hasCompaction ? "#ef4444" : "#94a3b8"}
                onClick={() => handleSelectTurn(turn)}
              />
            ))}

            {allCallsForNav.length > 0 && (
              <>
                <div style={{ padding: "10px 12px 4px", fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>
                  LLM CALLS <span style={{ fontWeight: 400, fontSize: 9 }}>(Turn {selectedTurn?.id})</span>
                </div>
                {allCallsForNav.map(call => (
                  <NavItem
                    key={call.id}
                    label={`#${call.id}`}
                    sublabel={call.isCompaction ? "compaction" : call.isSignificant ? `+${fmtK(call.significantDelta ?? 0)}` : fmtK(call.contextSize)}
                    active={selectedCall?.id === call.id}
                    badge={call.isCompaction ? "◆" : call.isSignificant ? "●" : undefined}
                    badgeColor={call.isCompaction ? "#ef4444" : "#3b82f6"}
                    onClick={() => handleSelectCall(call)}
                  />
                ))}
              </>
            )}
          </div>

          {/* Main Canvas */}
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
            {navLevel === "session" && (
              <SessionOverviewPanel turns={turns} drilldown={drilldown} onSelectTurn={handleSelectTurn} />
            )}
            {navLevel === "turn" && selectedTurn && !selectedCall && (
              <UserTurnDetailPanel turn={selectedTurn} onSelectCall={handleSelectCall} />
            )}
            {navLevel === "call" && selectedCall && (
              <LlmCallDetailPanel call={selectedCall} onSelectEntry={handleSelectEntry} />
            )}
          </div>

          {/* Inspector — only shown for Turn/Call detail, not Session Overview */}
          {navLevel !== "session" && (
            <div style={{ width: 240, borderLeft: "1px solid #e5e7eb", overflowY: "auto", flexShrink: 0, background: "#fafafa" }}>
              {inspector.type === "hotspots" && <SessionHotspotsPanel turns={turns} />}
              {inspector.type === "turn-rollup" && <TurnRollupPanel turn={inspector.turn} />}
              {inspector.type === "call-diff" && <CallDiffSummaryPanel call={inspector.call} />}
              {inspector.type === "evidence" && <DiffEvidencePanel entry={inspector.entry} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NavItem({
  label, sublabel, active, badge, badgeColor, onClick,
}: {
  label: string; sublabel?: string; active: boolean;
  badge?: string; badgeColor?: string; onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "7px 12px 7px 16px", cursor: "pointer",
        background: active ? "#eff6ff" : "transparent",
        borderLeft: active ? "2px solid #6366f1" : "2px solid transparent",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = "#f3f4f6"; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      <div>
        <div style={{ fontSize: 12, color: active ? "#6366f1" : "#374151", fontWeight: active ? 600 : 400 }}>{label}</div>
        {sublabel && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1 }}>{sublabel}</div>}
      </div>
      {badge && <span style={{ fontSize: 11, color: badgeColor, fontWeight: 700 }}>{badge}</span>}
    </div>
  );
}
