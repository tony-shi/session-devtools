// TurnCard —— Session 总览里一格 turn 卡片：header（turn 标签 / 统计 / badges）
// + user/agent 对话气泡。点击 header 钻入该 turn。
//
// 仍是 prop-driven：`onClick` 由父级（SessionOverviewPanel）决定做什么
// （当前 = navigate 到该 turn）。卡片本身不关心导航，保持纯展示。
//
// 抽取自 SessionDetailV2.tsx，逻辑零改动。

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MockUserTurn } from "../../lib/mock-data";
import { fmtK, fmtDuration } from "../../lib/format";
import { StatusBadgeStrip, type StatusBadge } from "../../shared/HeaderStats";
import { renderStatusIcon } from "../../shared/SessionBadges";
import { BRAND } from "../../shared/brand";

const INPUT_PREVIEW_CHARS = 500;
const OUTPUT_PREVIEW_CHARS = 1000;

export function TurnCard({ turn, onClick }: { turn: MockUserTurn; onClick: () => void }) {
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

  // One borderless card — header + dialog body — mirroring the LLM Call card
  // structure inside the Turn detail. The header strip is the click target
  // (drill into the turn); the body keeps the user/agent dialog feel via
  // left/right color bars so it still reads as a conversation.
  return (
    <div
      style={{ display: "flex", flexDirection: "column" }}
    >
      {/* ── Header — same layout as Call card header ── */}
      <div
        onClick={onClick}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "5px 4px", borderBottom: "1px solid #f3f4f6",
          cursor: "pointer",
          marginBottom: 10,
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
          <StatusBadgeStrip badges={turnCardBadges} renderIcon={renderStatusIcon} size="compact" />
          <span style={{ fontSize: 11, color: "#6366f1", fontWeight: 600, cursor: "pointer" }}>
            {t("terms.viewDetails")} ›
          </span>
        </div>
      </div>

      {/* ── Dialog body — bubbles replaced by clean, borderless Left-Blue/Right-Green indicator stripes ── */}
      <div style={{ padding: "0 4px" }}>
        {/* User bubble — left aligned, blue left indicator stripe */}
        <div style={{ display: "flex", marginBottom: 8 }}>
          <div style={{ width: "100%", maxWidth: "85%" }}>
            <div style={{
              fontSize: 12, color: "#1e3a5f", lineHeight: 1.55,
              background: "#f8fafc",
              borderLeft: "3px solid #3b82f6",
              padding: "6px 12px",
              whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}>
              {inputShown}
            </div>
            {inputNeedsExpand && (
              <button
                onClick={e => { e.stopPropagation(); setInputExpanded(v => !v); }}
                style={{ marginTop: 4, fontSize: 10, color: BRAND.blue500, background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 600 }}
              >
                {inputExpanded ? "Show less ↑" : "Show more ↓"}
              </button>
            )}
          </div>
        </div>

        {/* Mid-turn injections — yellow dashed left indicator stripe */}
        {turn.midTurnInjections?.map((inj, idx) => (
          <div key={idx} style={{ display: "flex", marginBottom: 8 }}>
            <div style={{ width: "100%", maxWidth: "85%" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "#d97706", marginBottom: 3, letterSpacing: "0.05em" }}>
                ↩ INTERRUPT · after call {inj.afterCallIndex}
              </div>
              <div style={{
                fontSize: 12, color: "#78350f", lineHeight: 1.5,
                background: "#fffbeb",
                borderLeft: "3px dashed #d97706",
                padding: "6px 12px",
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

        {/* AI bubble — right aligned, green right indicator stripe */}
        {outputFull && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            <div style={{ width: "100%", maxWidth: "85%", display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
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
                background: "#f0fdf4",
                borderRight: "3px solid #10b981",
                padding: "6px 12px",
                width: "100%",
                textAlign: "left",
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
                    style={{ marginTop: 4, fontSize: 10, color: "#16a34a", background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 600 }}
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
