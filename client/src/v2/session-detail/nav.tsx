// Session drawer 左侧导航的三种行：
//   - NavItem：普通 turn / overview 行（最常用）
//   - CompactEventNavItem：Compact 事件行（橙色调，跟 turn / call 分开）
//   - InterTurnNavItem：跨 turn 之间的 system block 行（紫调，斜体）
//
// 抽出自原 SessionDetailV2.tsx 下半，未改逻辑。

import React from "react";
import { useTranslation } from "react-i18next";
import type { CompactEvent, InterTurnBlock } from "../drilldown-types";
import { BRAND } from "../shared/brand";
import { selectionStyle, SELECTION_FG } from "../shared/selection";

export function NavItem({
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
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 4,
        ...selectionStyle(active, "indigo"),
      }}
      className={!active ? "hover:bg-gray-100 transition-colors" : ""}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: indent ? 11 : 12,
          color: active ? SELECTION_FG : "#374151",
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
// 结构和 NavItem 完全对齐（同 padding / fontSize / 双行布局），让 compact
// 行和 turn 行在视觉密度上一致。只有 active 高亮保留橙色调（#f97316/#fff7ed），
// 这样扫读时仍能一眼分出 compact 节点，但平常 idle 态不打断 turn 列表的节奏。
//
// label  ←  "压缩 N"（N = ev.index + 1，1-based）+ userInstructions 预览
// sublabel ← preTokens → postTokens (-ratio%)
export function CompactEventNavItem({ ev, active, onClick }: { ev: CompactEvent; active: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const ratioPct = ev.preTokens > 0
    ? Math.max(0, Math.round((1 - ev.postTokens / ev.preTokens) * 100))
    : 0;
  const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
  const compactLabel = t("sessionOverview.compact.label");
  const ordinal = ev.index + 1;
  // 预览文本：优先展示用户在 /compact 后附加的语义意图（"focus on parser"
  // 这类）；没有时退化到 trigger 提示，让 auto/micro compact 至少能被区分。
  const previewText = ev.userInstructions
    ? ev.userInstructions
    : ev.trigger === "auto" ? "auto"
    : ev.trigger === "micro" ? "micro"
    : "";
  return (
    <div
      onClick={onClick}
      style={{
        padding: "7px 12px 7px 16px",
        cursor: "pointer",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 4,
        ...selectionStyle(active, "compact"),
      }}
      className={!active ? "hover:bg-amber-50 transition-colors" : ""}
      title={`${compactLabel} ${ordinal} · ${ev.trigger} · ${fmtTokens(ev.preTokens)} → ${fmtTokens(ev.postTokens)} (-${ratioPct}%)`}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 12,
          color: active ? SELECTION_FG : "#374151",
          fontWeight: active ? 600 : 400,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          <strong style={{ fontWeight: 700, color: active ? SELECTION_FG : "#111827" }}>
            {compactLabel} {ordinal}
          </strong>
          {previewText && (
            <span style={{ fontWeight: 400, color: "#9ca3af", marginLeft: 6 }}>
              {previewText}
            </span>
          )}
        </div>
        <div style={{
          fontSize: 10, color: "#9ca3af", marginTop: 1,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {fmtTokens(ev.preTokens)} → {fmtTokens(ev.postTokens)} · -{ratioPct}%
        </div>
      </div>
    </div>
  );
}

export function InterTurnNavItem({ block, active, onClick }: { block: InterTurnBlock; active: boolean; onClick: () => void }) {
  const exitLabel = block.label.includes("/exit") || !block.enteredContext;
  return (
    <div
      onClick={onClick}
      style={{
        padding: "3px 12px 3px 22px",
        cursor: "pointer",
        display: "flex", alignItems: "center", gap: 5,
        ...selectionStyle(active, "interturn"),
      }}
      className={!active ? "hover:bg-gray-50 transition-colors" : ""}
    >
      <span style={{ fontSize: 9, color: exitLabel ? "#94a3b8" : BRAND.violet400, flexShrink: 0 }}>
        {exitLabel ? "⏎" : "⌘"}
      </span>
      <span style={{
        fontSize: 10,
        color: active ? SELECTION_FG : "#9ca3af",
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
