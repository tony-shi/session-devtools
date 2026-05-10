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
        {/* Row 0: Model chip (when single model — multi-model uses ModelBreakdownBlock below) */}
        {modelBreakdown && Object.keys(modelBreakdown).length === 1 && (() => {
          const [[m]] = Object.entries(modelBreakdown);
          const color = modelColor(m);
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>{shortModelName(m)}</span>
              <span style={{ fontSize: 10, color: "#9ca3af" }}>·</span>
              <span style={{ fontSize: 10, color: "#9ca3af" }}>{contextWindowSize.toLocaleString()} ctx window</span>
            </div>
          );
        })()}

        {/* Row 1: Call & turn counts — 4-col, same structure as Turn Row 1 */}
        <div style={{ marginBottom: 8 }}>
          <SummaryMetricStrip columns={4} cards={[
            { label: "User Turns",  value: String(turns.length),      mock: isMock },
            { label: "LLM Calls",   value: String(totalCalls),        mock: isMock },
            { label: "Tool Calls",  value: String(totalToolCalls),    mock: isMock },
            { label: "Duration",    value: durationStr,               mock: isMock },
          ]} />
        </div>

        {/* Row 2: Token breakdown — same 5-col layout as Turn */}
        <div style={{ marginBottom: 8 }}>
          <SummaryMetricStrip columns={5} cards={[
            { label: "Cache Read",  value: fmtK(totalCacheRead),  mock: isMock },
            { label: "Cache Write", value: fmtK(totalCacheWrite), mock: isMock },
            { label: "Fresh In",    value: totalFreshIn !== null ? fmtK(totalFreshIn) : "—", mock: isMock },
            { label: "Fresh Out",   value: totalFreshOut !== null ? fmtK(totalFreshOut) : "—", mock: isMock },
            { label: "Cache Ratio", value: cacheRatio !== null ? `${cacheRatio}%` : "—",
              tooltip: "cache_read / (cache_read + fresh_in)", mock: isMock },
          ]} />
        </div>

        {/* Row 3: Context stats — same 3-col layout as Turn */}
        <SummaryMetricStrip columns={3} cards={[
          { label: "Peak Context", value: fmtK(peakContext), mock: isMock },
          { label: "Net Context",  value: netContextStr,
            color: netContext !== null && netContext < 0 ? "#16a34a" : undefined,
            mock: netContext === null,
            tooltip: "从 session 第一个 LLM call 到最后一个 call，context size 的净变化。compaction 会压低这个数字。" },
          { label: "Errors",       value: String(systemErrors ?? 0),
            alert: systemErrors !== null && systemErrors > 0, mock: isMock },
        ]} />
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
              model window = {fmtK(contextWindowSize)}
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

  // ── Y axis ──────────────────────────────────────────────────────
  // Peak context can exceed the nominal context window when the
  // context-management beta is active (extended cache). In that case,
  // scale Y up to fit the actual peak, and annotate the model ceiling
  // as a reference line rather than the hard top of the chart.
  const peakCtxRaw = Math.max(...allPoints.map(p => p.contextSize), contextWindowSize);
  // Round up to next 50k for a clean axis
  const yMax = Math.ceil(peakCtxRaw / 50_000) * 50_000;
  const exceedsWindow = peakCtxRaw > contextWindowSize;

  const toY = (v: number) => PAD.t + chartH - (v / yMax) * chartH;
  const ceilingY = toY(contextWindowSize);         // model limit line (may not be at top)
  const warningY = toY(contextWindowSize * 0.9);   // 90% of model limit

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
  const peakCtx = peakCtxRaw;
  const peakPct = peakCtx / contextWindowSize;
  const lineColor = peakPct > 0.9 ? "#ea580c" : "#6366f1";

  // Y-axis ticks: cover full yMax range at 50k steps
  const tickStep = 50_000;
  const yTicks = Array.from({ length: Math.floor(yMax / tickStep) + 1 }, (_, i) => i * tickStep)
    .filter(v => v <= yMax);

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

        {/* Model context window ceiling line (always drawn, may be below chart top if exceeded) */}
        <line x1={PAD.l} y1={ceilingY} x2={PAD.l + chartW} y2={ceilingY}
          stroke="#ef4444" strokeWidth={1} strokeDasharray="4,3" opacity={0.7}
        />
        <text x={W - PAD.r + 2} y={ceilingY + 3} fontSize={8} fill="#ef4444" opacity={0.85}>
          {fmtK(contextWindowSize)}
        </text>

        {/* Danger zone: 90-100% of the model context window */}
        {warningY > ceilingY && (
          <rect x={PAD.l} y={ceilingY} width={chartW} height={warningY - ceilingY}
            fill="#fef3c7" opacity={0.6}
          />
        )}

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
        <div style={{ padding: "2px 10px 6px", fontSize: 10, color: "#9ca3af", display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>
            Peak: <strong style={{ color: peakPct > 0.9 ? "#ea580c" : "#374151" }}>{fmtK(peakCtx)}</strong>
            {" "}({Math.round(peakPct * 100)}% of {fmtK(contextWindowSize)} window)
          </span>
          {exceedsWindow && (
            <span style={{ color: "#ea580c" }}>
              ⚠ exceeds nominal window — context-management beta active
            </span>
          )}
          {xMode === "time" && <span style={{ color: "#c4b5d5" }}>X axis = wall-clock time</span>}
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

// ─── Agent Loop mock data types ──────────────────────────────────────────────

interface MockToolCall {
  id: string;
  tool: string;          // "Read" | "Bash" | "Write" | "Edit" | "WebFetch" | ...
  input: string;         // short description of the input
  outputSize: number;    // tokens
  durationMs: number;
  status: "ok" | "error" | "timeout";
  isParallel?: boolean;  // part of a parallel group
}

interface MockToolGroup {
  id: string;
  afterCallId: number;   // which LLM call issued these tools
  tools: MockToolCall[];
  totalOutputSize: number;
  isParallel: boolean;
}

interface MockTransition {
  fromCallId: number;
  toCallId: number;
  contextDelta: number;
  dominantCause: string; // "Tool Output: Read x6" | "Compaction" | etc.
}

interface MockAgentLoopData {
  toolGroups: MockToolGroup[];
  transitions: MockTransition[];
  toolSummary: Array<{ tool: string; calls: number; totalOutput: number; failed: number }>;
  status: "completed" | "interrupted" | "continued";
}

// Build mock agent loop data from existing call list
function buildMockAgentLoop(turn: MockUserTurn): MockAgentLoopData {
  // Generate realistic-looking tool groups for each call that has tool_use
  const toolGroups: MockToolGroup[] = [];
  const toolCounts: Record<string, { calls: number; totalOutput: number; failed: number }> = {};

  const toolPatterns: Record<number, MockToolCall[]> = {
    // Per call index → what tools it issues (0-indexed within turn)
    0: [
      { id: "t1a", tool: "Read", input: "src/index.ts", outputSize: 2800, durationMs: 45, status: "ok" },
      { id: "t1b", tool: "Read", input: "tsconfig.json", outputSize: 1200, durationMs: 38, status: "ok" },
      { id: "t1c", tool: "Bash", input: "ls -la src/", outputSize: 340, durationMs: 120, status: "ok" },
    ],
    1: [
      { id: "t2a", tool: "Read", input: "package.json", outputSize: 980, durationMs: 40, status: "ok", isParallel: true },
      { id: "t2b", tool: "Read", input: "src/routes/index.ts", outputSize: 3400, durationMs: 42, status: "ok", isParallel: true },
      { id: "t2c", tool: "Read", input: "src/middleware/auth.ts", outputSize: 2100, durationMs: 41, status: "ok", isParallel: true },
      { id: "t2d", tool: "Read", input: "src/db/connection.ts", outputSize: 1800, durationMs: 39, status: "ok", isParallel: true },
    ],
    2: [
      { id: "t3a", tool: "Edit", input: "src/routes/index.ts", outputSize: 180, durationMs: 55, status: "ok" },
      { id: "t3b", tool: "Edit", input: "src/middleware/auth.ts", outputSize: 220, durationMs: 52, status: "ok" },
    ],
    3: [
      { id: "t4a", tool: "Bash", input: "npm run build", outputSize: 4200, durationMs: 8400, status: "ok" },
    ],
    4: [
      { id: "t5a", tool: "Bash", input: "npm test", outputSize: 6800, durationMs: 12300, status: "error" },
    ],
    5: [
      { id: "t6a", tool: "Read", input: "src/routes/__tests__/index.test.ts", outputSize: 5200, durationMs: 44, status: "ok" },
      { id: "t6b", tool: "Bash", input: "npx jest --testPathPattern=routes", outputSize: 3100, durationMs: 9800, status: "ok" },
    ],
  };

  turn.calls.forEach((call, i) => {
    const pattern = toolPatterns[i % Object.keys(toolPatterns).length];
    if (!pattern || call.isCompaction) return;
    const tools: MockToolCall[] = pattern.map(t => ({ ...t, id: `${call.id}-${t.id}` }));
    const totalOutput = tools.reduce((s, t) => s + t.outputSize, 0);
    const isParallel = tools.some(t => t.isParallel);

    toolGroups.push({
      id: `tg-${call.id}`,
      afterCallId: call.id,
      tools,
      totalOutputSize: totalOutput,
      isParallel,
    });

    tools.forEach(t => {
      if (!toolCounts[t.tool]) toolCounts[t.tool] = { calls: 0, totalOutput: 0, failed: 0 };
      toolCounts[t.tool].calls++;
      toolCounts[t.tool].totalOutput += t.outputSize;
      if (t.status !== "ok") toolCounts[t.tool].failed++;
    });
  });

  // Transitions between consecutive calls
  const transitions: MockTransition[] = [];
  for (let i = 0; i < turn.calls.length - 1; i++) {
    const c = turn.calls[i];
    const next = turn.calls[i + 1];
    const delta = next.contextSize - c.contextSize;
    if (Math.abs(delta) < 500) continue; // skip tiny changes

    const tg = toolGroups.find(g => g.afterCallId === c.id);
    let cause = "incremental";
    if (c.isCompaction) cause = "Compaction";
    else if (tg) {
      const topTool = [...tg.tools].sort((a, b) => b.outputSize - a.outputSize)[0];
      const toolName = topTool?.tool ?? "tool";
      const toolCount = tg.tools.filter(t => t.tool === topTool?.tool).length;
      cause = toolCount > 1 ? `${toolName} ×${toolCount}` : `${toolName}: ${topTool?.input ?? ""}`;
    }
    transitions.push({ fromCallId: c.id, toCallId: next.id, contextDelta: delta, dominantCause: cause });
  }

  const toolSummary = Object.entries(toolCounts)
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([tool, s]) => ({ tool, ...s }));

  return { toolGroups, transitions, toolSummary, status: "completed" };
}

// ─── Agent Loop Timeline component ───────────────────────────────────────────

function AgentLoopTimeline({
  turn, agentLoop, onSelectCall,
}: { turn: MockUserTurn; agentLoop: MockAgentLoopData; onSelectCall: (c: MockLlmCall) => void }) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const maxCtx = Math.max(...turn.calls.map(c => c.contextSize), 1);

  return (
    <div style={{ position: "relative" }}>
      {/* Vertical spine */}
      <div style={{
        position: "absolute", left: 16, top: 0, bottom: 0,
        width: 2, background: "#e5e7eb", zIndex: 0,
      }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {/* User Input node */}
        <AgentLoopNode icon="👤" color="#6366f1" label="User Input" secondary={fmtDuration(turn.durationMs) || undefined}>
          <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.5, background: "#f5f3ff", borderRadius: 6, padding: "8px 10px" }}>
            {turn.userInput.length > 150 ? turn.userInput.slice(0, 150) + "…" : turn.userInput}
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
            </div>
          );
        })}

        {/* Terminal node */}
        <AgentLoopNode
          icon={agentLoop.status === "completed" ? "✓" : agentLoop.status === "interrupted" ? "⚠" : "→"}
          color={agentLoop.status === "completed" ? "#16a34a" : agentLoop.status === "interrupted" ? "#d97706" : "#6366f1"}
          label={agentLoop.status === "completed" ? "Completed" : agentLoop.status === "interrupted" ? "Interrupted" : "Continued"}
          isTerminal
        />
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
          borderRadius: 8, padding: "8px 12px",
        }}>
          <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 3 }}>
            {label}{mock && <MockBadge />}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: alert ? "#dc2626" : (color ?? "#111827"), lineHeight: 1.2 }}>
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

function AgentLoopFlow({
  turn, agentLoop, onSelectCall,
}: { turn: MockUserTurn; agentLoop: MockAgentLoopData; onSelectCall: (c: MockLlmCall) => void }) {
  const [hoveredCallId, setHoveredCallId] = useState<number | null>(null);
  const maxCtx = Math.max(...turn.calls.map(c => c.contextSize), 1);
  const maxToolOutput = Math.max(...agentLoop.toolGroups.map(g => g.totalOutputSize), 1);

  // Build the sequence: [UserInput, Call, ToolGroup?, Call, ToolGroup?, ..., Terminal]
  type FlowItem =
    | { kind: "user" }
    | { kind: "call"; call: MockLlmCall; delta: number }
    | { kind: "tools"; group: MockToolGroup; toCallId: number }
    | { kind: "terminal"; status: MockAgentLoopData["status"] };

  const items: FlowItem[] = [{ kind: "user" }];
  turn.calls.forEach(call => {
    const prevCtx = items.findLast(i => i.kind === "call")
      ? (items.findLast(i => i.kind === "call") as { kind: "call"; call: MockLlmCall; delta: number }).call.contextSize
      : 0;
    const delta = call.contextSize - prevCtx;
    items.push({ kind: "call", call, delta });

    const tg = agentLoop.toolGroups.find(g => g.afterCallId === call.id);
    if (tg) {
      const nextCallIdx = turn.calls.findIndex(c => c.id === call.id) + 1;
      const nextCall = turn.calls[nextCallIdx];
      items.push({ kind: "tools", group: tg, toCallId: nextCall?.id ?? -1 });
    }
  });
  items.push({ kind: "terminal", status: agentLoop.status });

  const CALL_W = 88;    // LLM call node base width
  const TOOL_W = 110;   // tool group node base width
  const USER_W = 70;
  const TERM_W = 70;
  const ARROW_W = 28;
  const NODE_H = 120;
  const LABEL_H = 28;

  return (
    <div style={{ overflowX: "auto", paddingBottom: 8 }}>
      <div style={{
        display: "flex", alignItems: "stretch", gap: 0,
        minHeight: NODE_H + LABEL_H + 24,
        padding: "4px 2px 8px",
      }}>
        {items.map((item, idx) => {
          const isLast = idx === items.length - 1;

          // ── Arrow connector ────────────────────────────────
          const Arrow = idx > 0 ? (
            <div style={{
              width: ARROW_W, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              paddingTop: 0, alignSelf: "center",
              marginTop: -LABEL_H / 2,
            }}>
              <div style={{ width: "100%", height: 2, background: "#e5e7eb", position: "relative" }}>
                <div style={{
                  position: "absolute", right: -1, top: -4,
                  borderTop: "5px solid transparent",
                  borderBottom: "5px solid transparent",
                  borderLeft: "7px solid #d1d5db",
                }} />
              </div>
            </div>
          ) : null;

          if (item.kind === "user") {
            return (
              <div key="user" style={{ display: "flex", alignItems: "center" }}>
                <div style={{
                  width: USER_W, display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                }}>
                  <div style={{
                    width: USER_W - 8, padding: "8px 6px", borderRadius: 8,
                    background: "#f5f3ff", border: "2px solid #6366f1",
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                    minHeight: 60,
                  }}>
                    <span style={{ fontSize: 16 }}>👤</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#6366f1" }}>User</span>
                  </div>
                  <span style={{ fontSize: 9, color: "#9ca3af", textAlign: "center", maxWidth: USER_W }}>
                    {turn.userInput.slice(0, 20)}{turn.userInput.length > 20 ? "…" : ""}
                  </span>
                </div>
              </div>
            );
          }

          if (item.kind === "terminal") {
            const cfg = {
              completed: { color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", icon: "✓" },
              interrupted: { color: "#d97706", bg: "#fffbeb", border: "#fde68a", icon: "⚠" },
              continued: { color: "#6366f1", bg: "#eff6ff", border: "#c7d2fe", icon: "→" },
            }[item.status];
            return (
              <div key="terminal" style={{ display: "flex", alignItems: "center", gap: 0 }}>
                {Arrow}
                <div style={{
                  width: TERM_W - 8, padding: "8px 6px", borderRadius: 8,
                  background: cfg.bg, border: `2px solid ${cfg.border}`,
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                  minHeight: 60, alignSelf: "center", marginTop: -LABEL_H / 2,
                }}>
                  <span style={{ fontSize: 18 }}>{cfg.icon}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: cfg.color }}>{item.status}</span>
                </div>
              </div>
            );
          }

          if (item.kind === "call") {
            const { call, delta } = item;
            // Height encodes context size relative to max
            const ctxPct = Math.max(call.contextSize / maxCtx, 0.15);
            const nodeH = Math.round(40 + ctxPct * 60); // 40–100px
            const isHovered = hoveredCallId === call.id;
            const isComp = call.isCompaction;
            const nearLimit = call.contextSize > call.contextWindowSize * 0.85;

            const border = isComp ? "#ef4444"
              : nearLimit ? "#ea580c"
              : call.isSignificant ? "#3b82f6"
              : "#e5e7eb";
            const bg = isComp ? "#fef2f2"
              : nearLimit ? "#fff7ed"
              : isHovered ? "#eff6ff"
              : "#f9fafb";

            return (
              <div key={call.id} style={{ display: "flex", alignItems: "center", gap: 0 }}>
                {Arrow}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  {/* Context delta annotation above */}
                  <div style={{ height: LABEL_H, display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 2 }}>
                    {Math.abs(delta) > 500 && (
                      <span style={{
                        fontSize: 10, fontWeight: 700,
                        color: delta > 2000 ? "#d97706" : delta < -2000 ? "#16a34a" : "#9ca3af",
                      }}>
                        {delta > 0 ? "+" : ""}{fmtK(delta)}
                      </span>
                    )}
                  </div>

                  {/* Main call node */}
                  <div
                    onClick={() => onSelectCall(call)}
                    onMouseEnter={() => setHoveredCallId(call.id)}
                    onMouseLeave={() => setHoveredCallId(null)}
                    style={{
                      width: CALL_W, height: nodeH, borderRadius: 8,
                      background: bg, border: `2px solid ${border}`,
                      cursor: "pointer", display: "flex", flexDirection: "column",
                      alignItems: "center", justifyContent: "space-between",
                      padding: "6px 4px 5px", gap: 3,
                      boxShadow: isHovered ? "0 2px 8px rgba(99,102,241,0.18)" : undefined,
                      transition: "box-shadow 0.12s",
                    }}
                  >
                    <span style={{ fontSize: 10, fontWeight: 700, color: isComp ? "#ef4444" : "#374151" }}>
                      #{call.id}
                    </span>

                    {/* Context bar inside node */}
                    <div style={{ width: "80%", display: "flex", flexDirection: "column", gap: 2, flex: 1, justifyContent: "center" }}>
                      {/* Cache read fill */}
                      <div style={{ width: "100%", height: 6, background: "#f3f4f6", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{
                          width: `${Math.min(call.cacheRead / call.contextSize * 100, 100)}%`,
                          height: "100%", background: "#a5b4fc", borderRadius: 3,
                        }} title="cache read" />
                      </div>
                      {/* Cache write fill */}
                      <div style={{ width: "100%", height: 6, background: "#f3f4f6", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{
                          width: `${Math.min(call.cacheWrite / call.contextSize * 100, 100)}%`,
                          height: "100%", background: "#6366f1", borderRadius: 3, opacity: 0.5,
                        }} title="cache write" />
                      </div>
                    </div>

                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: "#374151" }}>{fmtK(call.contextSize)}</div>
                      <div style={{ fontSize: 9, color: "#9ca3af" }}>ctx</div>
                    </div>

                    {/* Stop reason pill */}
                    {call.stopReason && call.stopReason !== "tool_use" && (
                      <div style={{
                        fontSize: 8, fontWeight: 700, color: "#16a34a",
                        background: "#f0fdf4", borderRadius: 3, padding: "1px 4px",
                      }}>
                        end_turn
                      </div>
                    )}
                    {isComp && (
                      <div style={{ fontSize: 9, color: "#ef4444", fontWeight: 700 }}>◆</div>
                    )}
                  </div>

                  {/* Call id label below */}
                  <span style={{ fontSize: 9, color: "#9ca3af" }}>Call #{call.indexInTurn}</span>
                </div>
              </div>
            );
          }

          if (item.kind === "tools") {
            const { group } = item;
            const outputPct = group.totalOutputSize / maxToolOutput;
            // Tool group height encodes output tokens (thickness = output size)
            const toolNodeH = Math.round(28 + outputPct * 60); // 28–88px
            const hasError = group.tools.some(t => t.status !== "ok");
            const border = hasError ? "#fca5a5" : group.isParallel ? "#c4b5fd" : "#e5e7eb";
            const bg = hasError ? "#fef2f2" : group.isParallel ? "#f5f3ff" : "#fffbeb";
            const durationTotal = group.tools.reduce((s, t) => s + t.durationMs, 0);

            return (
              <div key={group.id} style={{ display: "flex", alignItems: "center", gap: 0 }}>
                {Arrow}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  {/* Duration label above */}
                  <div style={{ height: LABEL_H, display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 2 }}>
                    <span style={{ fontSize: 10, color: "#9ca3af" }}>{fmtDuration(durationTotal)}</span>
                  </div>

                  {/* Tool group node */}
                  <div style={{
                    width: TOOL_W, height: toolNodeH, borderRadius: 8,
                    background: bg, border: `2px solid ${border}`,
                    padding: "5px 6px", display: "flex", flexDirection: "column", gap: 3,
                  }}>
                    {/* Header */}
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                      {group.isParallel && (
                        <span style={{ fontSize: 9, fontWeight: 800, color: "#7c3aed" }}>∥</span>
                      )}
                      <span style={{ fontSize: 10, fontWeight: 700, color: hasError ? "#dc2626" : "#374151" }}>
                        {group.tools.length} tool{group.tools.length > 1 ? "s" : ""}
                      </span>
                      {hasError && <span style={{ fontSize: 10, color: "#dc2626" }}>✗</span>}
                    </div>

                    {/* Tool pills */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 2, flex: 1, alignContent: "flex-start" }}>
                      {/* Group by tool type */}
                      {Object.entries(
                        group.tools.reduce((acc, t) => {
                          acc[t.tool] = (acc[t.tool] ?? 0) + 1;
                          return acc;
                        }, {} as Record<string, number>)
                      ).map(([toolName, count]) => (
                        <span key={toolName} style={{
                          fontSize: 9, fontWeight: 600,
                          color: toolName === "Bash" ? "#d97706"
                            : toolName === "Read" ? "#3b82f6"
                            : toolName === "Write" || toolName === "Edit" ? "#16a34a"
                            : "#6b7280",
                          background: toolName === "Bash" ? "#fffbeb"
                            : toolName === "Read" ? "#eff6ff"
                            : toolName === "Write" || toolName === "Edit" ? "#f0fdf4"
                            : "#f9fafb",
                          borderRadius: 3, padding: "1px 4px",
                          border: "1px solid currentColor",
                          opacity: 0.9,
                        }}>
                          {toolName}{count > 1 ? ` ×${count}` : ""}
                        </span>
                      ))}
                    </div>

                    {/* Output size annotation */}
                    <div style={{ fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>
                      +{fmtK(group.totalOutputSize)} out
                    </div>
                  </div>

                  {/* Group label below */}
                  <span style={{ fontSize: 9, color: "#9ca3af" }}>
                    {group.isParallel ? "parallel" : "sequential"}
                  </span>
                </div>
              </div>
            );
          }

          return null;
        })}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "4px 2px", borderTop: "1px solid #f3f4f6", marginTop: 4 }}>
        {[
          { color: "#a5b4fc", label: "Cache read (in ctx)" },
          { color: "#6366f1", label: "Cache write" },
          { color: "#7c3aed", label: "∥ parallel tools" },
          { color: "#d97706", label: "Bash" },
          { color: "#3b82f6", label: "Read" },
          { color: "#16a34a", label: "Write/Edit" },
          { color: "#ef4444", label: "◆ compaction" },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
            <span style={{ fontSize: 9, color: "#9ca3af" }}>{label}</span>
          </div>
        ))}
        <span style={{ fontSize: 9, color: "#d1d5db", marginLeft: "auto" }}>
          Node height ∝ context size · Node thickness ∝ tool output <MockBadge />
        </span>
      </div>
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
        const label = v === "classic" ? "Classic" : "Flow";
        const desc  = v === "classic" ? "Context strip + vertical timeline" : "Horizontal trace · LLM ↔ Tool causality";
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
        {view === "classic" ? "Context strip + vertical timeline" : "Horizontal trace · LLM ↔ Tool causality"}
      </span>
    </div>
  );
}

function UserTurnDetailPanel({
  turn, onSelectCall,
}: { turn: MockUserTurn; onSelectCall: (c: MockLlmCall) => void }) {
  const [turnView, setTurnView] = useState<TurnView>("classic");
  const agentLoop = buildMockAgentLoop(turn);
  const maxCtx = Math.max(...turn.calls.map(c => c.contextSize), 1);
  const dur = fmtDuration(turn.durationMs);

  // Net context for this turn: last call ctx − first call ctx
  const firstCtx = turn.calls[0]?.contextSize ?? 0;
  const lastCtx  = turn.calls[turn.calls.length - 1]?.contextSize ?? 0;
  const netCtx   = lastCtx - firstCtx;
  const netCtxStr = `${netCtx >= 0 ? "+" : ""}${fmtK(netCtx)}`;

  // Cache ratio for this turn
  const cacheRatio = turn.cacheRead + turn.cacheWrite > 0
    ? Math.round(turn.cacheRead / (turn.cacheRead + turn.cacheWrite) * 100)
    : null;

  // Top transitions
  const topTransitions = agentLoop.transitions
    .filter(t => Math.abs(t.contextDelta) > 2000)
    .sort((a, b) => Math.abs(b.contextDelta) - Math.abs(a.contextDelta))
    .slice(0, 4);

  // Risk badges for this turn
  const risks: Array<{ type: "compaction" | "unknown-spike" | "large-growth" | "near-limit" | "tool-heavy" }> = [];
  if (turn.hasCompaction) risks.push({ type: "compaction" });
  if (turn.hasUnknownSpike) risks.push({ type: "unknown-spike" });
  if (turn.peakContext > 150_000) risks.push({ type: "near-limit" });
  const toolHeavy = agentLoop.toolSummary.reduce((s, t) => s + t.totalOutput, 0) > 20_000;
  if (toolHeavy) risks.push({ type: "tool-heavy" });

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>

      {/* ── Turn Header ───────────────────────────────────────────── */}
      <div style={{ marginBottom: 20, paddingBottom: 18, borderBottom: "1px solid #f3f4f6" }}>
        {/* Title row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>Turn {turn.id}</span>
          <StatusBadge status={agentLoop.status} />
          {dur && <span style={{ fontSize: 11, color: "#9ca3af" }}>{dur}</span>}
          {risks.length > 0 && (
            <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
              {risks.map(r => <RiskBadge key={r.type} type={r.type} />)}
            </div>
          )}
        </div>

        {/* User input */}
        <div style={{
          fontSize: 12, color: "#374151", lineHeight: 1.55,
          background: "#f5f3ff", borderRadius: 6, padding: "8px 12px",
          borderLeft: "3px solid #6366f1", marginBottom: 14,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {turn.userInput}
        </div>

        {/* ── Metric Strip — same visual language as Session ─────── */}
        {/* Row 1: Call & loop counts */}
        <div style={{ marginBottom: 8 }}>
          <SummaryMetricStrip columns={4} cards={[
            { label: "LLM Calls",   value: String(turn.llmCallCount) },
            { label: "Tool Calls",  value: String(turn.toolCallCount), sub: `${agentLoop.toolGroups.length} groups`, mock: true },
            { label: "Duration",    value: dur || "—" },
            { label: "Tool Errors", value: String(agentLoop.toolSummary.reduce((s, t) => s + t.failed, 0)),
              alert: agentLoop.toolSummary.some(t => t.failed > 0), mock: true },
          ]} />
        </div>
        {/* Row 2: Token accounting */}
        <div style={{ marginBottom: 8 }}>
          <SummaryMetricStrip columns={5} cards={[
            { label: "Cache Read",  value: fmtK(turn.cacheRead) },
            { label: "Cache Write", value: fmtK(turn.cacheWrite) },
            { label: "Fresh In",    value: fmtK(turn.calls.reduce((s, c) => s + c.contextSize - c.cacheRead - c.cacheWrite, 0)) },
            { label: "Fresh Out",   value: fmtK(turn.calls.reduce((s, c) => s + c.outputTokens, 0)) },
            { label: "Cache Ratio", value: cacheRatio !== null ? `${cacheRatio}%` : "—",
              tooltip: "cache_read / (cache_read + cache_write)" },
          ]} />
        </div>
        {/* Row 3: Context accounting */}
        <div style={{ marginBottom: 0 }}>
          <SummaryMetricStrip columns={3} cards={[
            { label: "Peak Context", value: fmtK(turn.peakContext) },
            { label: "Net Context",  value: netCtxStr,
              color: netCtx < 0 ? "#16a34a" : undefined,
              tooltip: "Last call context minus first call context in this turn" },
            { label: "Unknown Δ",    value: turn.unknownDelta > 0 ? `+${fmtK(turn.unknownDelta)}` : "0",
              color: turn.unknownDelta > 1000 ? "#dc2626" : undefined },
          ]} />
        </div>
      </div>

      {/* ── Top Transitions (summary before deep-dive) ────────────── */}
      {topTransitions.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <SectionLabel mock>Top Transitions</SectionLabel>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
            {topTransitions.map((tr, i) => (
              <div key={`${tr.fromCallId}-${tr.toCallId}`} style={{
                display: "grid", gridTemplateColumns: "80px 52px 1fr",
                alignItems: "center", gap: 10, padding: "8px 12px",
                borderBottom: i < topTransitions.length - 1 ? "1px solid #f3f4f6" : "none",
                background: "#fff",
              }}>
                <span style={{ fontSize: 11, color: "#9ca3af" }}>
                  #{tr.fromCallId} → #{tr.toCallId}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: tr.contextDelta > 0 ? "#d97706" : "#16a34a" }}>
                  {tr.contextDelta > 0 ? "+" : ""}{fmtK(tr.contextDelta)}
                </span>
                <span style={{ fontSize: 11, color: "#4b5563" }}>{tr.dominantCause}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── View toggle ───────────────────────────────────────────── */}
      <TurnViewToggle view={turnView} onChange={setTurnView} />

      {/* ── View A: Classic (context strip + vertical timeline) ───── */}
      {turnView === "classic" && (
        <>
          {/* Compact context strip */}
          <div style={{ marginBottom: 20 }}>
            <SectionLabel>Context Strip</SectionLabel>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 44, background: "#f9fafb", borderRadius: 6, padding: "6px 8px 0", border: "1px solid #f3f4f6" }}>
              {turn.calls.map(c => {
                const h = Math.round((c.contextSize / maxCtx) * 100);
                return (
                  <div key={c.id} title={`#${c.id}: ${fmtK(c.contextSize)}`}
                    style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%", cursor: "pointer" }}
                    onClick={() => onSelectCall(c)}>
                    <div style={{
                      width: "100%", height: `${Math.max(h, 5)}%`,
                      background: c.isCompaction ? "#ef4444" : c.isSignificant ? "#3b82f6" : "#6366f140",
                      borderRadius: "2px 2px 0 0",
                    }} />
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 2, marginTop: 2 }}>
              {turn.calls.map(c => (
                <div key={c.id} style={{ flex: 1, textAlign: "center", fontSize: 8, color: "#d1d5db" }}>#{c.id}</div>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 20 }}>
            <SectionLabel mock>Agent Loop</SectionLabel>
            <AgentLoopTimeline turn={turn} agentLoop={agentLoop} onSelectCall={onSelectCall} />
          </div>
        </>
      )}

      {/* ── View B: Flow (horizontal trace-like agent loop flow) ──── */}
      {turnView === "flow" && (
        <div style={{ marginBottom: 20 }}>
          <SectionLabel mock>Agent Loop Flow</SectionLabel>
          <AgentLoopFlow turn={turn} agentLoop={agentLoop} onSelectCall={onSelectCall} />
        </div>
      )}

      {/* ── Tool Summary ──────────────────────────────────────────── */}
      {agentLoop.toolSummary.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <SectionLabel mock>Tool Summary</SectionLabel>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
            {/* Header */}
            <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 72px 72px 52px", gap: 0, padding: "5px 12px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
              {["Tool", "Top input", "Calls", "Output", "Failed"].map(h => (
                <span key={h} style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600 }}>{h}</span>
              ))}
            </div>
            {agentLoop.toolSummary.map((ts, i) => {
              // Find the largest single tool call for this tool type
              const allCallsForTool = agentLoop.toolGroups
                .flatMap(tg => tg.tools)
                .filter(t => t.tool === ts.tool)
                .sort((a, b) => b.outputSize - a.outputSize);
              const topInput = allCallsForTool[0]?.input ?? "—";

              return (
                <div key={ts.tool} style={{
                  display: "grid", gridTemplateColumns: "60px 1fr 72px 72px 52px",
                  alignItems: "center", gap: 0, padding: "7px 12px",
                  borderBottom: i < agentLoop.toolSummary.length - 1 ? "1px solid #f3f4f6" : "none",
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>{ts.tool}</span>
                  <span style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 }}>{topInput}</span>
                  <span style={{ fontSize: 11, color: "#374151" }}>{ts.calls}</span>
                  <span style={{ fontSize: 11, color: "#374151" }}>+{fmtK(ts.totalOutput)}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: ts.failed > 0 ? "#dc2626" : "#9ca3af" }}>
                    {ts.failed > 0 ? ts.failed : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Mock payload / response data for Call Detail ────────────────────────────

interface MockPayloadSegment {
  id: string;
  category: string;
  label: string;
  tokens: number;
  source: string;     // "system" | "user_message" | "tool_result" | "assistant_history" | "tool_schema" | "unknown"
  content?: string;   // preview text
}

interface MockCallResponse {
  textOutput: string;
  toolUseBlocks: Array<{ id: string; name: string; input: string }>;
  stopReason: string;
  outputTokens: number;
  hasThinking: boolean;
  thinkingPreview?: string;
}

function buildMockPayload(call: MockLlmCall): MockPayloadSegment[] {
  const ctx = call.contextSize;
  const cacheR = call.cacheRead;
  const cacheW = call.cacheWrite;
  const fresh = ctx - cacheR - cacheW;
  // Simulate a realistic payload breakdown
  const systemTokens = Math.round(ctx * 0.22);
  const schemaTokens = Math.round(ctx * 0.18);
  const historyTokens = Math.round(ctx * 0.15);
  const toolOutTokens = Math.round(ctx * 0.28);
  const userTokens = Math.round(ctx * 0.08);
  const unknownTokens = ctx - systemTokens - schemaTokens - historyTokens - toolOutTokens - userTokens;

  return [
    { id: "seg-sys",    category: "System",                 label: "system prompt",            tokens: systemTokens,  source: "system",           content: "You are Claude Code, Anthropic's official CLI…" },
    { id: "seg-schema", category: "Tool Schemas",           label: "tool definitions (12)",    tokens: schemaTokens,  source: "tool_schema",      content: "Read, Write, Edit, Bash, Glob, Grep, WebFetch…" },
    { id: "seg-hist",   category: "Assistant History",      label: "prior assistant turns",    tokens: historyTokens, source: "assistant_history", content: "Previous assistant responses in this session…" },
    { id: "seg-tool",   category: "Tool Output",            label: "tool results (recent)",    tokens: toolOutTokens, source: "tool_result",       content: "Read(server/src/parser.ts): export function parse…" },
    { id: "seg-user",   category: "User Messages",          label: "current user input",       tokens: userTokens,    source: "user_message",      content: "请帮我分析这个 session 的数据结构…" },
    { id: "seg-unk",    category: "Unknown",                label: "unattributed",             tokens: Math.max(unknownTokens, 0), source: "unknown" },
  ].filter(s => s.tokens > 0);
}

function buildMockResponse(call: MockLlmCall): MockCallResponse {
  const hasTools = call.stopReason === "tool_use" || (call.stopReason !== "end_turn");
  return {
    textOutput: call.stopReason === "end_turn"
      ? "根据分析，当前 session 的 context 结构主要由 Tool Output 主导（约 28%），系统提示占 22%，工具定义占 18%。建议关注 Tool Output 的累积增长，考虑在必要时触发 compaction 以控制 context 规模。"
      : "",
    toolUseBlocks: hasTools ? [
      { id: "toolu_mock_01", name: "Read", input: JSON.stringify({ file_path: "server/src/session-drilldown-parser.ts" }, null, 2) },
    ] : [],
    stopReason: call.stopReason ?? "end_turn",
    outputTokens: call.outputTokens,
    hasThinking: call.id % 4 === 0,
    thinkingPreview: call.id % 4 === 0 ? "Let me think through this carefully. The session has multiple turns…" : undefined,
  };
}

// ─── Sankey mini overview ─────────────────────────────────────────────────────

function IncomingDiffSankey({
  segments, diff,
}: { segments: MockPayloadSegment[]; diff: MockDiffEntry[] }) {
  const total = segments.reduce((s, seg) => s + seg.tokens, 0) || 1;
  const netDelta = diff.reduce((s, e) => s + e.delta, 0);
  const added   = diff.filter(e => e.changeType === "added");
  const removed = diff.filter(e => e.changeType === "removed");
  const retained = diff.filter(e => e.changeType === "retained" || (e.changeType !== "added" && e.changeType !== "removed" && e.changeType !== "changed"));

  const addedTotal   = added.reduce((s, e) => s + e.delta, 0);
  const removedTotal = Math.abs(removed.reduce((s, e) => s + e.delta, 0));
  const retainedTotal = Math.max(total - addedTotal, 0);

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Header metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 12 }}>
        {[
          { label: "Net Δ", value: `${netDelta >= 0 ? "+" : ""}${fmtK(netDelta)}`, color: netDelta > 0 ? "#d97706" : "#16a34a" },
          { label: "Added",   value: `+${fmtK(addedTotal)}`,   color: "#16a34a" },
          { label: "Removed", value: removedTotal > 0 ? `−${fmtK(removedTotal)}` : "—", color: "#dc2626" },
          { label: "Retained", value: fmtK(retainedTotal),     color: "#9ca3af" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "6px 10px" }}>
            <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Sankey-like flow bars */}
      <div style={{ background: "#f9fafb", borderRadius: 8, padding: "12px", border: "1px solid #f3f4f6" }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", marginBottom: 8, letterSpacing: "0.05em" }}>
          PREVIOUS → CURRENT PAYLOAD <MockBadge />
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
          {/* Left: previous payload bar */}
          <div style={{ width: 80, flexShrink: 0 }}>
            <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 4, textAlign: "center" }}>Previous</div>
            <div style={{ height: 80, display: "flex", flexDirection: "column", borderRadius: 4, overflow: "hidden", gap: 1 }}>
              {segments.map(seg => {
                const h = Math.round((seg.tokens / total) * 100);
                return h > 0 ? (
                  <div key={seg.id} title={`${seg.category}: ${fmtK(seg.tokens)}`} style={{
                    height: `${h}%`, minHeight: 2,
                    background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb",
                    opacity: 0.6,
                  }} />
                ) : null;
              })}
            </div>
            <div style={{ fontSize: 9, color: "#9ca3af", textAlign: "center", marginTop: 4 }}>{fmtK(total - netDelta)}</div>
          </div>

          {/* Middle: flow arrows */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, paddingTop: 16 }}>
            {/* Retained band */}
            {retainedTotal > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ flex: 1, height: 10, background: "#e5e7eb", borderRadius: 2, opacity: 0.7 }} title={`Retained: ${fmtK(retainedTotal)}`} />
                <span style={{ fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>retained</span>
              </div>
            )}
            {/* Added band */}
            {addedTotal > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ flex: 1, height: Math.max(6, Math.round(addedTotal / total * 40)), background: "#16a34a", borderRadius: 2, opacity: 0.5 }} title={`Added: ${fmtK(addedTotal)}`} />
                <span style={{ fontSize: 9, color: "#16a34a", flexShrink: 0 }}>+{fmtK(addedTotal)}</span>
              </div>
            )}
            {/* Removed band */}
            {removedTotal > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ flex: 1, height: Math.max(4, Math.round(removedTotal / total * 30)), background: "#ef4444", borderRadius: 2, opacity: 0.4 }} title={`Removed: ${fmtK(removedTotal)}`} />
                <span style={{ fontSize: 9, color: "#ef4444", flexShrink: 0 }}>−{fmtK(removedTotal)}</span>
              </div>
            )}
          </div>

          {/* Right: current payload bar */}
          <div style={{ width: 80, flexShrink: 0 }}>
            <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 4, textAlign: "center" }}>Current</div>
            <div style={{ height: 80, display: "flex", flexDirection: "column", borderRadius: 4, overflow: "hidden", gap: 1 }}>
              {segments.map(seg => {
                const h = Math.round((seg.tokens / total) * 100);
                return h > 0 ? (
                  <div key={seg.id} title={`${seg.category}: ${fmtK(seg.tokens)}`} style={{
                    height: `${h}%`, minHeight: 2,
                    background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb",
                  }} />
                ) : null;
              })}
            </div>
            <div style={{ fontSize: 9, color: "#9ca3af", textAlign: "center", marginTop: 4 }}>{fmtK(total)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── LLM Call Detail Panel (v2) ───────────────────────────────────────────────

type CallTab = "incoming" | "response" | "payload" | "next" | "raw";

function LlmCallDetailPanel({
  call, onSelectEntry,
}: { call: MockLlmCall; onSelectEntry: (e: MockDiffEntry) => void }) {
  const [tab, setTab] = useState<CallTab>("incoming");
  const [selectedEvidenceEntry, setSelectedEvidenceEntry] = useState<MockDiffEntry | null>(null);

  const diff = call.incomingDiff;
  const netDelta = diff.reduce((s, e) => s + e.delta, 0);
  const added   = diff.filter(e => e.changeType === "added");
  const removed = diff.filter(e => e.changeType === "removed");
  const changed = diff.filter(e => e.changeType === "changed");
  const retained = diff.filter(e => e.changeType === "retained");

  const segments = buildMockPayload(call);
  const response = buildMockResponse(call);

  const freshIn  = call.contextSize - call.cacheRead - call.cacheWrite;
  const cacheRatio = call.contextSize > 0
    ? Math.round(call.cacheRead / call.contextSize * 100)
    : 0;
  const nearLimit = call.contextSize > call.contextWindowSize * 0.85;

  function handleSelectEntry(entry: MockDiffEntry) {
    setSelectedEvidenceEntry(entry);
    onSelectEntry(entry);
    setTab("incoming"); // stay on incoming diff tab, evidence shows in inspector
  }

  const TAB_DEFS: Array<{ id: CallTab; label: string; badge?: string }> = [
    { id: "incoming", label: "Incoming Diff" },
    { id: "response", label: "Response" },
    { id: "payload",  label: "Payload Map" },
    { id: "next",     label: "Next Diff" },
    { id: "raw",      label: "Raw" },
  ];

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* ── Main area ─────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px 20px 24px", minWidth: 0 }}>

        {/* ── Call Header ──────────────────────────────────── */}
        <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid #f3f4f6" }}>
          {/* Title + badges */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>Call #{call.id}</span>
            <span style={{ fontSize: 10, color: "#9ca3af" }}>#{call.indexInTurn} in turn</span>
            {call.isCompaction && <RiskBadge type="compaction" />}
            {nearLimit && <RiskBadge type="near-limit" />}
            {call.isSignificant && !nearLimit && <RiskBadge type="large-growth" />}
            <span style={{ marginLeft: "auto", fontSize: 10, color: "#9ca3af" }}>
              {call.model && <span style={{ fontWeight: 600, color: "#374151" }}>{shortModelName(call.model)} · </span>}
              {call.timestamp ? new Date(call.timestamp).toLocaleTimeString() : call.timestamp}
            </span>
          </div>

          {/* Data source banner */}
          <div style={{
            fontSize: 10, color: "#6b7280", background: "#fffbeb",
            border: "1px solid #fde68a", borderRadius: 5, padding: "5px 10px",
            marginBottom: 10, display: "flex", alignItems: "center", gap: 6,
          }}>
            <span style={{ fontWeight: 600, color: "#d97706" }}>⚠ Observed from JSONL</span>
            <span>· Estimated attribution · No exact request payload available · </span>
            <span style={{ color: "#9ca3af" }}>Proxy data: {call.proxy ? "available" : "not linked"}</span>
          </div>

          {/* Metric strip: 3 rows same language as session/turn */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {/* Row 1: identity */}
            <SummaryMetricStrip columns={4} cards={[
              { label: "Context Size",  value: fmtK(call.contextSize), color: nearLimit ? "#ea580c" : undefined },
              { label: "Context Δ",     value: `${call.significantDelta >= 0 ? "+" : ""}${fmtK(call.significantDelta)}`,
                color: call.significantDelta > 2000 ? "#d97706" : call.significantDelta < -2000 ? "#16a34a" : undefined },
              { label: "Stop Reason",   value: call.stopReason ?? "—" },
              { label: "Window Used",   value: `${Math.round(call.contextSize / call.contextWindowSize * 100)}%`,
                color: nearLimit ? "#ea580c" : undefined },
            ]} />
            {/* Row 2: tokens */}
            <SummaryMetricStrip columns={5} cards={[
              { label: "Cache Read",    value: fmtK(call.cacheRead) },
              { label: "Cache Write",   value: fmtK(call.cacheWrite) },
              { label: "Fresh In",      value: fmtK(freshIn) },
              { label: "Fresh Out",     value: fmtK(call.outputTokens) },
              { label: "Cache %",       value: `${cacheRatio}%`, tooltip: "cache_read / context_size" },
            ]} />
          </div>
        </div>

        {/* ── Tabs ───────────────────────────────────────────── */}
        <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb", marginBottom: 16, gap: 0 }}>
          {TAB_DEFS.map(({ id, label, badge }) => (
            <button key={id} onClick={() => setTab(id)} style={{
              padding: "7px 13px", fontSize: 11, fontWeight: tab === id ? 700 : 400,
              color: tab === id ? "#6366f1" : "#6b7280",
              background: "transparent", border: "none",
              borderBottom: tab === id ? "2px solid #6366f1" : "2px solid transparent",
              cursor: "pointer", marginBottom: -1, display: "flex", alignItems: "center", gap: 4,
            }}>
              {label}
              {badge && <span style={{ fontSize: 9, background: "#fef2f2", color: "#dc2626", borderRadius: 3, padding: "1px 4px", fontWeight: 700 }}>{badge}</span>}
            </button>
          ))}
        </div>

        {/* ── Tab: Incoming Diff ─────────────────────────────── */}
        {tab === "incoming" && (
          <div>
            {/* Sankey mini overview */}
            <IncomingDiffSankey segments={segments} diff={diff} />

            {/* Diff table */}
            {diff.length > 0 ? (
              <>
                {[
                  { label: "Added",    entries: added,    color: "#16a34a" },
                  { label: "Changed",  entries: changed,  color: "#d97706" },
                  { label: "Removed",  entries: removed,  color: "#dc2626" },
                  { label: "Retained", entries: retained, color: "#9ca3af" },
                ].filter(g => g.entries.length > 0).map(group => (
                  <div key={group.label} style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: group.color }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: group.color }}>{group.label}</span>
                      <span style={{ fontSize: 10, color: "#9ca3af" }}>{group.entries.length} entries</span>
                    </div>
                    <div style={{ border: "1px solid #f3f4f6", borderRadius: 6, overflow: "hidden" }}>
                      {group.entries.map((entry, i) => (
                        <EnrichedDiffRow
                          key={entry.id} entry={entry}
                          selected={selectedEvidenceEntry?.id === entry.id}
                          onSelect={handleSelectEntry}
                          isLast={i === group.entries.length - 1}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <div style={{ padding: "24px", textAlign: "center", color: "#9ca3af", border: "1px dashed #e5e7eb", borderRadius: 8 }}>
                <div style={{ fontSize: 13, marginBottom: 4 }}>No diff data available</div>
                <div style={{ fontSize: 11 }}>Incoming diff is not yet computed for this call.</div>
                <div style={{ marginTop: 8 }}><MockBadge /></div>
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Response ──────────────────────────────────── */}
        {tab === "response" && (
          <div>
            {/* Thinking block */}
            {response.hasThinking && (
              <div style={{ marginBottom: 12 }}>
                <SectionLabel>Extended Thinking</SectionLabel>
                <div style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 8, padding: "10px 14px", fontSize: 11, color: "#7c3aed", lineHeight: 1.6, fontStyle: "italic" }}>
                  {response.thinkingPreview}
                  <span style={{ color: "#c4b5fd" }}> … [redacted]</span>
                  <div style={{ marginTop: 4 }}><MockBadge /></div>
                </div>
              </div>
            )}

            {/* Text output */}
            {response.textOutput && (
              <div style={{ marginBottom: 12 }}>
                <SectionLabel>Text Output</SectionLabel>
                <div style={{
                  background: "#f0fdf4", border: "1px solid #bbf7d0",
                  borderLeft: "3px solid #16a34a",
                  borderRadius: 8, padding: "10px 14px",
                  fontSize: 12, color: "#14532d", lineHeight: 1.65, whiteSpace: "pre-wrap",
                }}>
                  {response.textOutput}
                </div>
              </div>
            )}

            {/* Tool use blocks */}
            {response.toolUseBlocks.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <SectionLabel>Tool Use Requests</SectionLabel>
                {response.toolUseBlocks.map(tu => (
                  <div key={tu.id} style={{
                    border: "1px solid #fde68a", borderLeft: "3px solid #d97706",
                    background: "#fffbeb", borderRadius: 8, padding: "10px 14px", marginBottom: 8,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#d97706" }}>{tu.name}</span>
                      <code style={{ fontSize: 10, color: "#9ca3af" }}>{tu.id}</code>
                    </div>
                    <pre style={{ fontSize: 11, color: "#374151", margin: 0, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {tu.input}
                    </pre>
                  </div>
                ))}
              </div>
            )}

            {/* No output case */}
            {!response.textOutput && response.toolUseBlocks.length === 0 && (
              <div style={{ padding: "20px", textAlign: "center", color: "#9ca3af", border: "1px dashed #e5e7eb", borderRadius: 8 }}>
                No response content captured. <MockBadge />
              </div>
            )}

            {/* Output stats */}
            <div style={{ marginTop: 8 }}>
              <SummaryMetricStrip columns={3} cards={[
                { label: "Output Tokens", value: fmtK(response.outputTokens) },
                { label: "Stop Reason",   value: response.stopReason },
                { label: "Thinking",      value: response.hasThinking ? "enabled" : "off", mock: true },
              ]} />
            </div>
          </div>
        )}

        {/* ── Tab: Payload Map ───────────────────────────────── */}
        {tab === "payload" && (
          <div>
            <SectionLabel mock>Estimated Payload Breakdown</SectionLabel>
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "8px 12px", fontSize: 11, color: "#92400e", marginBottom: 12 }}>
              Estimated from JSONL usage tokens. No exact request payload available without proxy dump.
            </div>

            {/* Stacked bar */}
            <div style={{ display: "flex", height: 20, borderRadius: 6, overflow: "hidden", gap: 1, marginBottom: 8 }}>
              {segments.map(seg => {
                const total = segments.reduce((s, g) => s + g.tokens, 0) || 1;
                const w = Math.max(seg.tokens / total * 100, 0.5);
                return (
                  <div key={seg.id} title={`${seg.category}: ${fmtK(seg.tokens)} (${Math.round(w)}%)`}
                    style={{ width: `${w}%`, background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb" }} />
                );
              })}
            </div>

            {/* Segment rows */}
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
              {/* Header */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 60px 100px", gap: 0, padding: "5px 12px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                {["Segment", "Tokens", "%", "Source"].map(h => (
                  <span key={h} style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600 }}>{h}</span>
                ))}
              </div>
              {segments.map((seg, i) => {
                const total = segments.reduce((s, g) => s + g.tokens, 0) || 1;
                const pct = Math.round(seg.tokens / total * 100);
                return (
                  <div key={seg.id} style={{
                    display: "grid", gridTemplateColumns: "1fr 60px 60px 100px",
                    gap: 0, padding: "8px 12px",
                    borderBottom: i < segments.length - 1 ? "1px solid #f3f4f6" : "none",
                    alignItems: "center",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb" }} />
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>{seg.label}</div>
                        {seg.content && (
                          <div style={{ fontSize: 10, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {seg.content.slice(0, 60)}…
                          </div>
                        )}
                      </div>
                    </div>
                    <span style={{ fontSize: 11, color: "#374151" }}>{fmtK(seg.tokens)}</span>
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>{pct}%</span>
                    <span style={{ fontSize: 10, color: "#6b7280", fontFamily: "monospace" }}>{seg.source}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Tab: Next Diff ─────────────────────────────────── */}
        {tab === "next" && (
          <div style={{ padding: "32px 16px", textAlign: "center", border: "1px dashed #e5e7eb", borderRadius: 8 }}>
            <div style={{ fontSize: 14, color: "#374151", marginBottom: 8 }}>Next Diff</div>
            <div style={{ fontSize: 12, color: "#9ca3af", lineHeight: 1.6 }}>
              Shows how <strong>this call's response + tool results</strong> changed the following call's payload.
              <br />Requires both JSONL events for this call and the next call.
            </div>
            <div style={{ marginTop: 12 }}><MockBadge /></div>
          </div>
        )}

        {/* ── Tab: Raw ───────────────────────────────────────── */}
        {tab === "raw" && (
          <div>
            <SectionLabel>Raw JSONL Events</SectionLabel>
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "8px 12px", fontSize: 11, color: "#92400e", marginBottom: 12 }}>
              Request payload not available — proxy data not linked. Showing estimated token usage from JSONL.
            </div>
            <pre style={{
              fontSize: 11, fontFamily: "monospace", color: "#374151",
              background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8,
              padding: "12px 14px", overflowX: "auto", whiteSpace: "pre-wrap",
              wordBreak: "break-all", lineHeight: 1.5,
            }}>
              {JSON.stringify({
                _note: "Observed from JSONL — no proxy dump available",
                call_id: call.id,
                model: call.model,
                timestamp: call.timestamp,
                usage: {
                  input_tokens: call.contextSize - call.cacheRead - call.cacheWrite,
                  cache_read_input_tokens: call.cacheRead,
                  cache_creation_input_tokens: call.cacheWrite,
                  output_tokens: call.outputTokens,
                },
                stop_reason: call.stopReason,
                context_size_estimated: call.contextSize,
              }, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* ── Right evidence panel ──────────────────────────────── */}
      <div style={{ width: 220, borderLeft: "1px solid #f3f4f6", overflowY: "auto", flexShrink: 0, background: "#fafafa", padding: "16px 14px" }}>
        {selectedEvidenceEntry ? (
          <EvidenceSidePanel entry={selectedEvidenceEntry} onClear={() => setSelectedEvidenceEntry(null)} />
        ) : (
          <CallContextSummaryPanel call={call} segments={segments} />
        )}
      </div>
    </div>
  );
}

// ─── Enriched Diff Row ────────────────────────────────────────────────────────

function EnrichedDiffRow({
  entry, selected, onSelect, isLast,
}: { entry: MockDiffEntry; selected: boolean; onSelect: (e: MockDiffEntry) => void; isLast: boolean }) {
  const confidenceColors = { High: "#16a34a", Medium: "#d97706", Low: "#dc2626", Unknown: "#6b7280" };
  const confidenceLabels = { High: "✓", Medium: "~", Low: "!", Unknown: "?" };

  return (
    <div
      onClick={() => onSelect(entry)}
      style={{
        display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px",
        cursor: "pointer", background: selected ? "#eff6ff" : "transparent",
        borderBottom: isLast ? "none" : "1px solid #f9fafb",
        borderLeft: selected ? "2px solid #6366f1" : "2px solid transparent",
        transition: "background 0.1s",
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = "#f9fafb"; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      {/* Change type icon */}
      <ChangeTypeIcon type={entry.changeType} />

      {/* Category dot */}
      <div style={{ width: 6, height: 6, borderRadius: 1, flexShrink: 0, marginTop: 3,
        background: CATEGORY_COLORS[entry.category] ?? "#e5e7eb" }} />

      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {entry.label}
          </span>
          <span style={{ fontSize: 10, color: confidenceColors[entry.confidence], flexShrink: 0 }}
            title={`${entry.confidence} confidence`}>
            {confidenceLabels[entry.confidence]}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
          <span style={{ fontSize: 10, color: CATEGORY_COLORS[entry.category] ?? "#9ca3af" }}>{entry.category}</span>
          <span style={{ fontSize: 10, color: "#9ca3af" }}>·</span>
          <span style={{ fontSize: 10, color: "#9ca3af" }}>{entry.cause}</span>
        </div>
      </div>

      {/* Delta */}
      <span style={{
        fontSize: 12, fontWeight: 700, flexShrink: 0,
        color: entry.delta >= 0 ? "#16a34a" : "#dc2626",
        minWidth: 44, textAlign: "right",
      }}>
        {entry.delta >= 0 ? "+" : ""}{fmtK(entry.delta)}
      </span>
    </div>
  );
}

// ─── Evidence Side Panel ──────────────────────────────────────────────────────

function EvidenceSidePanel({ entry, onClear }: { entry: MockDiffEntry; onClear: () => void }) {
  const confidenceColors = { High: "#16a34a", Medium: "#d97706", Low: "#dc2626", Unknown: "#6b7280" };
  const confidenceNotes = {
    High: "Exact content matched from event record.",
    Medium: "Structural match; segment boundary is inferred.",
    Low: "Inferred from token gap only. Weak heuristic.",
    Unknown: "Cannot attribute. Only token gap observed.",
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>Evidence</span>
        <button onClick={onClear} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 14, color: "#9ca3af", padding: 0 }}>×</button>
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, color: "#111827", marginBottom: 10, lineHeight: 1.4, wordBreak: "break-word" }}>
        {entry.label}
      </div>

      {[
        { label: "Category", value: <span style={{ color: CATEGORY_COLORS[entry.category] ?? "#374151" }}>{entry.category}</span> },
        { label: "Change",   value: entry.changeType },
        { label: "Delta",    value: <span style={{ color: entry.delta >= 0 ? "#16a34a" : "#dc2626", fontWeight: 700 }}>{entry.delta >= 0 ? "+" : ""}{fmtK(entry.delta)}</span> },
        { label: "Cause",    value: entry.cause },
        { label: "Confidence", value: <span style={{ color: confidenceColors[entry.confidence], fontWeight: 700 }}>{entry.confidence}</span> },
      ].map(({ label, value }) => (
        <div key={label} style={{ display: "flex", gap: 8, padding: "5px 0", borderBottom: "1px solid #f3f4f6" }}>
          <span style={{ width: 72, flexShrink: 0, fontSize: 10, color: "#9ca3af" }}>{label}</span>
          <span style={{ fontSize: 11, color: "#374151" }}>{value}</span>
        </div>
      ))}

      {entry.evidence && (
        <div style={{ marginTop: 10, padding: "8px 10px", background: "#f9fafb", borderRadius: 6, fontSize: 10, fontFamily: "monospace", color: "#374151", lineHeight: 1.6, wordBreak: "break-all" }}>
          {entry.evidence}
        </div>
      )}
      {!entry.evidence && (
        <div style={{ marginTop: 10, padding: "8px 10px", background: "#f9fafb", borderRadius: 6, fontSize: 11, color: "#9ca3af", fontStyle: "italic" }}>
          No source reference. <MockBadge />
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 10, color: "#9ca3af", fontStyle: "italic", lineHeight: 1.5 }}>
        {confidenceNotes[entry.confidence]}
      </div>
    </div>
  );
}

// ─── Call Context Summary (right panel default) ───────────────────────────────

function CallContextSummaryPanel({ call, segments }: { call: MockLlmCall; segments: MockPayloadSegment[] }) {
  const total = segments.reduce((s, seg) => s + seg.tokens, 0) || 1;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
        Context Composition <MockBadge />
      </div>
      {/* Mini stacked bar */}
      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", gap: 0.5, marginBottom: 10 }}>
        {segments.map(seg => (
          <div key={seg.id} title={seg.category}
            style={{ width: `${seg.tokens / total * 100}%`, background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb" }} />
        ))}
      </div>
      {segments.map(seg => {
        const pct = Math.round(seg.tokens / total * 100);
        return (
          <div key={seg.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <div style={{ width: 7, height: 7, borderRadius: 1, background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb", flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seg.category}</span>
            <div style={{ width: 36, height: 3, background: "#f3f4f6", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: CATEGORY_COLORS[seg.category] ?? "#e5e7eb" }} />
            </div>
            <span style={{ fontSize: 10, color: "#9ca3af", width: 24, textAlign: "right" }}>{pct}%</span>
          </div>
        );
      })}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #f3f4f6", fontSize: 10, color: "#9ca3af", lineHeight: 1.5 }}>
        Click a diff row to see its evidence and source reference.
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
