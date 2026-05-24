// LinkedContextPanel —— 右栏滑入的"对比上下文"面板：要么是一个 call detail
// （LlmCallDetailPanel panel 模式），要么是一个 turn 摘录（LinkedTurnExcerptPanel
// 包 UserTurnDetailPanel）。不进 URL，是次要 / 对比状态。
//
// 本批为纯抽取，逻辑零改动。

import React, { useEffect } from "react";
import type { MockUserTurn, MockLlmCall, MockDiffEntry } from "../../lib/mock-data";
import type { LinkedPanelState } from "../SessionDetailContext";
import { LinkedPanelScope } from "../../attribution-graph-context";
import { UserTurnDetailPanel } from "../turn/UserTurnDetailPanel";
import { LlmCallDetailPanel } from "../call/LlmCallDetailPanel";

export function LinkedContextPanel({
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

