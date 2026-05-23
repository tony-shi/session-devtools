// SessionBadges —— 跨 session-detail 多面板复用的原子级 UI（小徽章 / 图标 /
// 容器型小组件）。每个 export 都是无副作用、props-driven 的小积木：StatusBadge、
// TrustBadge、ProxyStatusPill、HotspotChip 等等。
//
// 抽取自原 SessionDetailV2.tsx 中部，未改任何逻辑。集中放在 shared/ 是因为这些
// 组件在 turn / call / sub-agent / session overview 多处都用到。

import React from "react";
import type { StatusBadgeKind } from "./HeaderStats";
import type { MockDiffEntry, MockLlmCall } from "../lib/mock-data";
import type { SubAgentSummary } from "../drilldown-types";
import type { TrustMode } from "../drilldown-mock-fill";
import { fmtK, fmtDuration } from "../lib/format";
import { BRAND } from "./brand";

// ─── ForkIcon (sub-agent fork 标记) ───────────────────────────────────────────

export function ForkIcon({ size = 12, color = BRAND.violet600 }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}>
      <line x1="4" y1="1" x2="4" y2="11" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 5 Q4 3 9 3" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <circle cx="9" cy="3" r="1.5" fill={color} />
      <circle cx="4" cy="1" r="1.5" fill={color} />
    </svg>
  );
}

// ─── BADGE_ICONS：StatusBadgeStrip 用的图标 registry ─────────────────────────
// To swap any icon: edit the corresponding entry here.
export const BADGE_ICONS = {
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

// Bridge between StatusBadgeStrip (which takes a renderIcon callback so the
// shared module doesn't depend on SessionDetailV2) and BADGE_ICONS above.
export function renderStatusIcon(kind: StatusBadgeKind, px: number, color: string): React.ReactNode {
  switch (kind) {
    case "compaction": return BADGE_ICONS.compaction(px, color);
    case "error":      return BADGE_ICONS.error(px, color);
    case "subAgent":   return BADGE_ICONS.subAgent(px, color);
    case "command":    return BADGE_ICONS.command(px, color);
    case "unknown":    return BADGE_ICONS.unknown(px, color);
    case "noProxy":    return BADGE_ICONS.noProxy(px, color);
  }
}

// ─── MockBadge：标记某项数据来自 mock fill ────────────────────────────────────

export function MockBadge() {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, color: "#9ca3af", border: "1px dashed #d1d5db",
      borderRadius: 3, padding: "1px 4px", letterSpacing: "0.05em", marginLeft: 4,
    }}>MOCK</span>
  );
}

// ─── RiskBadge：context 风险标签 ──────────────────────────────────────────────

export function RiskBadge({ type }: { type: "compaction" | "unknown-spike" | "large-growth" | "tool-heavy" | "near-limit" }) {
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

// ─── ChangeTypeIcon：diff entry 的 +/-/~ 单字符标记 ───────────────────────────

export function ChangeTypeIcon({ type }: { type: MockDiffEntry["changeType"] }) {
  const configs = {
    added: { symbol: "+", color: "#16a34a" },
    removed: { symbol: "−", color: "#dc2626" },
    changed: { symbol: "~", color: "#d97706" },
    retained: { symbol: "·", color: "#9ca3af" },
  };
  const c = configs[type];
  return <span style={{ color: c.color, fontWeight: 700, fontSize: 13, width: 14, display: "inline-block" }}>{c.symbol}</span>;
}

// ─── HotspotCard / HotspotChip：summary 视图里的小卡片 ────────────────────────

export function HotspotCard({ icon, label, value, color }: { icon: string; label: string; value: string; color: string }) {
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

export function HotspotChip({ icon, label, value, color }: { icon: string; label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6 }}>
      <span style={{ color, fontSize: 12 }}>{icon}</span>
      <span style={{ fontSize: 11, color: "#6b7280" }}>{label}:</span>
      <span style={{ fontSize: 11, fontWeight: 600, color }}>{value}</span>
    </div>
  );
}

// ─── CompressionCapsule：sub-agent 节省比例胶囊 ───────────────────────────────

export interface SubAgentCompression {
  consumed: number;       // total tokens the sub agent dealt with internally (proxy)
  returned: number;       // tokens written back into the parent context
  savedRatio: number;     // 1 - returned/consumed, clamped 0..1
}

export function deriveSubAgentCompression(sa: SubAgentSummary): SubAgentCompression | null {
  // cacheRead is the dominant component of internal processing volume; it's the
  // same number we surface as "Cache R" elsewhere, so the math stays explainable.
  const consumed = sa.totalCacheRead;
  const returned = sa.totalOutputTokens;
  if (consumed <= 0 || returned <= 0 || returned >= consumed) return null;
  const savedRatio = Math.max(0, Math.min(1, 1 - returned / consumed));
  return { consumed, returned, savedRatio };
}

export function CompressionCapsule({ sa, compact = false }: { sa: SubAgentSummary; compact?: boolean }) {
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

// ─── SummaryMetricStrip：Session/Turn 顶部的 4 列指标卡 ──────────────────────

export interface MetricCard {
  label: string;
  value: string;
  sub?: string;          // small secondary value below main number
  color?: string;        // override value text color
  alert?: boolean;       // red background
  mock?: boolean;
  tooltip?: string;
}

export function SummaryMetricStrip({ cards, columns = 4 }: { cards: MetricCard[]; columns?: number }) {
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

// ─── StatusBadge：turn / session 状态徽标 ───────────────────────────────────

export function StatusBadge({ status }: { status: "completed" | "interrupted" | "continued" }) {
  const cfg = {
    completed:   { color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", label: "Completed" },
    interrupted: { color: "#d97706", bg: "#fffbeb", border: "#fde68a", label: "Interrupted" },
    continued:   { color: BRAND.indigo500, bg: "#eff6ff", border: BRAND.indigo200, label: "Continued" },
  }[status];
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, color: cfg.color,
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      borderRadius: 4, padding: "2px 7px",
    }}>{cfg.label}</span>
  );
}

// ─── SectionLabel：小写的灰色区段标题 ─────────────────────────────────────────

export function SectionLabel({ children, mock }: { children: React.ReactNode; mock?: boolean }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 6 }}>
      {children}{mock && <MockBadge />}
    </div>
  );
}

// ─── TrustBadge：attribution 的来源 / 置信度顶部 banner ──────────────────────

export function TrustBadge({ mode, proxy }: { mode: TrustMode; proxy?: MockLlmCall["proxy"] }) {
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

// ─── ProxyStatusPill：代理"运行中 / 未启动" 状态条 ───────────────────────────
// 比之前那个橙色 warning box 更克制，"运行中" 和 "未启动" 用同一种 pill 容器，
// 只换颜色。

export function ProxyStatusPill({ running, label }: { running: boolean; label: string }) {
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

// ─── InlineLink：用于「打开代理设置 →」「去启动」等跳转 ─────────────────────

export function InlineLink({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:underline"
      style={{
        border: "none", background: "transparent", padding: 0,
        color: BRAND.indigo500, fontWeight: 600, fontSize: "inherit",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
