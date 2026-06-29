// ChainNarrativeNode —— call-chain 的叙事节点（user input / interrupt / final
// assistant text）。抽自 call-chain-rows.tsx，逻辑零改动。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BRAND } from "../../../shared/brand";
import { LinkIcon } from "../../../shared/EventUnitCard";
import { useAttributionGraph } from "../../../attribution-graph-context";

export function ChainNarrativeNode({
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
    ? { bg: "#eff6ff", border: "#bfdbfe", fg: "#1e3a5f", dot: BRAND.blue500 }
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
        <div style={{
          flex: 1,
          border: "none",
          borderLeft: kind === "interrupt" ? `3px dashed ${tone.dot}` : `3px solid ${tone.dot}`,
          padding: "4px 0 4px 12px",
          background: "transparent",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: tone.fg, fontFamily: "'Outfit', sans-serif", letterSpacing: "0.05em", textTransform: "uppercase" }}>{label}</span>
            {meta && <span style={{ fontSize: 10, color: "#94a3b8" }}>{meta}</span>}
            {handleJump && (
              <button
                type="button"
                onClick={handleJump}
                title={t("callChain.jumpToRequestTooltip", { callId: jumpTarget })}
                className="hover:opacity-80 transition-opacity"
                style={{
                  marginLeft: "auto",
                  display: "inline-flex", alignItems: "center", gap: 5,
                  border: "none", background: "transparent", color: BRAND.indigo600,
                  padding: "2px 4px",
                  fontSize: 10, fontWeight: 700, lineHeight: 1.3,
                  cursor: "pointer",
                  transition: "color 0.12s, opacity 0.12s",
                  letterSpacing: "0.02em",
                }}
              >
                <LinkIcon />
                {t("terms.firstInjectedAtCall", { callId: jumpTarget })}
              </button>
            )}
          </div>
          <div style={{
            fontSize: 12,
            color: tone.fg,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: tone.bg,
            border: `1px solid ${tone.border}`,
            borderRadius: 6,
            padding: "8px 12px",
            marginTop: 4,
          }}>
            {shown}
          </div>
          {needsExpand && (
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              style={{
                marginTop: 6,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 10,
                color: BRAND.indigo600,
                background: "#f1f5f9",
                border: "none",
                borderRadius: 4,
                padding: "3px 8px",
                cursor: "pointer",
                fontWeight: 700,
                transition: "background 0.1s",
              }}
              className="hover:bg-slate-200 transition-colors"
            >
              {expanded ? t("terms.showLessShort") : t("terms.showMoreShort")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
