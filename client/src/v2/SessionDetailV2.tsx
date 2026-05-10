import { useState } from "react";
import type { SessionV2 } from "./types";

// ─── Mock Data Types ────────────────────────────────────────────────────────

interface MockDiffEntry {
  id: string;
  category: string;
  label: string;
  delta: number;
  changeType: "added" | "removed" | "changed" | "retained";
  cause: string;
  confidence: "High" | "Medium" | "Low" | "Unknown";
  evidence?: string;
}

interface MockLlmCall {
  id: number;
  contextSize: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp: string;
  isCompaction?: boolean;
  isUnknownHeavy?: boolean;
  isSignificant?: boolean;
  significantDelta?: number;
  incomingDiff: MockDiffEntry[];
}

interface MockUserTurn {
  id: number;
  userInput: string;
  llmCallCount: number;
  toolCallCount: number;
  netContextDelta: number;
  peakContext: number;
  cacheRead: number;
  cacheWrite: number;
  unknownDelta: number;
  hasCompaction?: boolean;
  hasUnknownSpike?: boolean;
  calls: MockLlmCall[];
}

// ─── Mock Data ───────────────────────────────────────────────────────────────

function buildMockTurns(): MockUserTurn[] {
  return [
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
  turns, onSelectTurn,
}: { turns: MockUserTurn[]; onSelectTurn: (t: MockUserTurn) => void }) {
  const totalCalls = turns.reduce((s, t) => s + t.llmCallCount, 0);
  const totalToolCalls = turns.reduce((s, t) => s + t.toolCallCount, 0);
  const peakContext = Math.max(...turns.map(t => t.peakContext));
  const totalCacheRead = turns.reduce((s, t) => s + t.cacheRead, 0);

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* Metric Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 20 }}>
        {[
          { label: "User Turns", value: String(turns.length), mock: false },
          { label: "LLM Calls", value: String(totalCalls), mock: false },
          { label: "Tool Calls", value: String(totalToolCalls), mock: false },
          { label: "Peak Context", value: fmtK(peakContext), mock: false },
          { label: "Cache Read", value: fmtK(totalCacheRead), mock: false },
          { label: "Cache Write", value: fmtK(turns.reduce((s, t) => s + t.cacheWrite, 0)), mock: false },
          { label: "Unknown %", value: "5.2%", mock: true },
          { label: "Net Context", value: `+${fmtK(turns.reduce((s, t) => s + t.netContextDelta, 0))}`, mock: false },
        ].map(({ label, value, mock }) => (
          <div key={label} style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 12px", border: "1px solid #e5e7eb" }}>
            <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 4 }}>{label}{mock && <MockBadge />}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Context Overview Timeline (mock) */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
          Context Overview Timeline <MockBadge />
        </div>
        <div style={{
          border: "1px dashed #d1d5db", borderRadius: 8, padding: "16px",
          background: "#fafafa", height: 120, position: "relative", overflow: "hidden",
        }}>
          <MockContextTimeline turns={turns} />
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

function MockContextTimeline({ turns }: { turns: MockUserTurn[] }) {
  const maxContext = Math.max(...turns.map(t => t.peakContext));
  const barColors = ["#6366f1", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7"];

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: "100%", paddingBottom: 20, position: "relative" }}>
      {turns.map((turn, i) => {
        const heightPct = (turn.peakContext / maxContext) * 100;
        return (
          <div key={turn.id} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, height: "100%", justifyContent: "flex-end" }}>
            <div style={{
              width: "100%", background: barColors[i % barColors.length],
              height: `${heightPct}%`, borderRadius: "3px 3px 0 0", opacity: 0.7,
              minHeight: 4, position: "relative",
            }}>
              {(turn.hasCompaction || turn.calls.some(c => c.isCompaction)) && (
                <div style={{ position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)", fontSize: 10, color: "#ef4444" }}>◆</div>
              )}
              {turn.hasUnknownSpike && (
                <div style={{ position: "absolute", top: -8, right: 0, fontSize: 10, color: "#94a3b8" }}>?</div>
              )}
            </div>
            <div style={{ fontSize: 9, color: "#9ca3af", marginTop: 2 }}>T{turn.id}</div>
          </div>
        );
      })}
      <div style={{ position: "absolute", bottom: 18, left: 0, right: 0, borderBottom: "1px dashed #e5e7eb" }} />
    </div>
  );
}

function TurnCard({ turn, onClick }: { turn: MockUserTurn; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 14px",
        cursor: "pointer", background: "#fff", transition: "border-color 0.15s",
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = "#6366f1")}
      onMouseLeave={e => (e.currentTarget.style.borderColor = "#e5e7eb")}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280" }}>Turn {turn.id}</div>
        <div style={{ display: "flex", gap: 4 }}>
          {turn.hasCompaction && <RiskBadge type="compaction" />}
          {turn.hasUnknownSpike && <RiskBadge type="unknown-spike" />}
          {turn.peakContext > 130000 && <RiskBadge type="near-limit" />}
        </div>
      </div>
      <div style={{ fontSize: 12, color: "#374151", marginBottom: 8, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        "{turn.userInput}"
      </div>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>
        {turn.llmCallCount} LLM calls · {turn.toolCallCount} tool calls ·{" "}
        <span style={{ color: turn.netContextDelta > 0 ? "#16a34a" : "#dc2626", fontWeight: 600 }}>
          {turn.netContextDelta > 0 ? "+" : ""}{fmtK(turn.netContextDelta)}
        </span>
        {" "}context
      </div>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>
        Peak {fmtK(turn.peakContext)} · Cache read {fmtK(turn.cacheRead)} · Unknown +{fmtK(turn.unknownDelta)}
      </div>
      <div style={{ fontSize: 11, color: "#9ca3af" }}>
        {turn.calls
          .filter(c => c.isSignificant || c.isCompaction)
          .slice(0, 3)
          .map((c, i) => (
            <span key={c.id}>
              {i > 0 && " · "}
              {c.isCompaction
                ? <span style={{ color: "#ef4444" }}>Compaction −{fmtK(Math.abs(c.incomingDiff.filter(d => d.changeType === "removed").reduce((s, d) => s + d.delta, 0)))}</span>
                : <span style={{ color: "#d97706" }}>+{fmtK(c.significantDelta ?? 0)} at #{c.id}</span>
              }
            </span>
          ))
        }
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
  const turns = buildMockTurns();
  const [navLevel, setNavLevel] = useState<NavLevel>("session");
  const [selectedTurn, setSelectedTurn] = useState<MockUserTurn | null>(null);
  const [selectedCall, setSelectedCall] = useState<MockLlmCall | null>(null);
  const [inspector, setInspector] = useState<InspectorState>({ type: "hotspots" });

  const title = session.custom_title ?? session.ai_title ?? session.session_id.slice(0, 16);

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
            <span style={{ fontSize: 10, color: "#9ca3af", background: "#f9fafb", border: "1px dashed #d1d5db", borderRadius: 4, padding: "2px 6px" }}>All mock data</span>
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
              <SessionOverviewPanel turns={turns} onSelectTurn={handleSelectTurn} />
            )}
            {navLevel === "turn" && selectedTurn && !selectedCall && (
              <UserTurnDetailPanel turn={selectedTurn} onSelectCall={handleSelectCall} />
            )}
            {navLevel === "call" && selectedCall && (
              <LlmCallDetailPanel call={selectedCall} onSelectEntry={handleSelectEntry} />
            )}
          </div>

          {/* Inspector */}
          <div style={{ width: 240, borderLeft: "1px solid #e5e7eb", overflowY: "auto", flexShrink: 0, background: "#fafafa" }}>
            {inspector.type === "hotspots" && <SessionHotspotsPanel turns={turns} />}
            {inspector.type === "turn-rollup" && <TurnRollupPanel turn={inspector.turn} />}
            {inspector.type === "call-diff" && <CallDiffSummaryPanel call={inspector.call} />}
            {inspector.type === "evidence" && <DiffEvidencePanel entry={inspector.entry} />}
          </div>
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
