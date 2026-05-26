import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionV2 } from "./types";
import type { SessionDrilldown, UserTurn, InterTurnBlock, CompactEvent } from "./drilldown-types";
import { apiV2 } from "./api";
import type { SubAgentSummary } from "./drilldown-types";
import { getSessionDisplayName } from "./session-display";
import { AttributionGraphProvider } from "./attribution-graph-context";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";

import type { MockDiffEntry, MockLlmCall, MockUserTurn } from "./lib/mock-data";
import { buildFallbackTurns } from "./lib/mock-data";
import {
  synthesizeCompactTurn, InterTurnBlockPanel,
} from "./session-detail/compact/CompactEventPanel";
import {
  type SessionNav, type NavLevel, type CallTab, buildSessionPath, parseSessionNav,
} from "./session-detail/session-nav";
import {
  SessionDetailProvider,
  type SessionDetailContextValue,
  type InspectorState,
  type LinkedPanelState,
} from "./session-detail/SessionDetailContext";
import { SessionOverviewPanel } from "./session-detail/overview/SessionOverviewPanel";
import { UserTurnDetailPanel } from "./session-detail/turn/UserTurnDetailPanel";
import { LlmCallDetailPanel } from "./session-detail/call/LlmCallDetailPanel";
import { BackgroundCallsPanel } from "./session-detail/background/BackgroundCallsPanel";
import { SideCallDetailPanel } from "./session-detail/sidecall/SideCallDetailPanel";
import { SubAgentSessionPanel } from "./session-detail/subagent/SubAgentSessionPanel";
import { LinkedContextPanel } from "./session-detail/linked/LinkedContextPanel";
import { SessionNavRail } from "./session-detail/SessionNavRail";
import { SessionDetailHeader } from "./session-detail/SessionDetailHeader";

interface Props {
  session: SessionV2;
  onClose: () => void;
}

export function SessionDetailV2({ session, onClose }: Props) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [drilldown, setDrilldown] = useState<SessionDrilldown | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    // 数据加载 effect：标准 fetch-on-mount 模式。
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
  // side-call 详情用 proxyRequestId 寻址（proxy-only，不依赖 turns 加载）。
  const [selectedProxyRequestId, setSelectedProxyRequestId] = useState<number | null>(null);
  const [, setInspector] = useState<InspectorState>({ type: "hotspots" });
  const [selectedSubAgent, setSelectedSubAgent] = useState<SubAgentSummary | null>(null);
  const [subAgentDrilldown, setSubAgentDrilldown] = useState<SessionDrilldown | null>(null);
  const [subAgentLoadState, setSubAgentLoadState] = useState<"loading" | "ok" | "error">("loading");
  // sub-agent 内部 turn/call 现在由 URL 驱动（Phase 4 lift up），不再藏在
  // SubAgentSessionPanel 的 local state 里。null/null = bare（待 redirect 到首 turn）。
  const [subAgentTurnId, setSubAgentTurnId] = useState<number | null>(null);
  const [subAgentCallId, setSubAgentCallId] = useState<number | null>(null);
  const [linkedPanel, setLinkedPanel] = useState<LinkedPanelState | null>(null);
  const [linkedPanelPinned, setLinkedPanelPinned] = useState(false);

  const title = getSessionDisplayName(session, drilldown?.title);

  // agentFileId → SubAgentSummary 查找表。sub-agent 分散在各 turn 的 call 上，
  // URL 只带 agentFileId，靠这张表还原出 SubAgentSummary（agentType 等显示信息）。
  const subAgentByFileId = useMemo(() => {
    const m = new Map<string, SubAgentSummary>();
    for (const turn of turns) {
      for (const call of turn.calls) {
        for (const sa of call.subAgents ?? []) {
          if (!m.has(sa.agentFileId)) m.set(sa.agentFileId, sa);
        }
      }
    }
    return m;
  }, [turns]);

  // sub-agent 的真实父 turn —— 由 sa.parentCallId 反查（哪个主 turn 的 calls 含
  // 这个 call），而不是用 selectedTurn（浏览历史里停留的 turn）。后者会在深链 /
  // 先逛别的 turn 再进 sub-agent 时给出错误的父级（曾把 turn 19 的 sub-agent 错
  // 显成 "Turn 4"）。父级是 sub-agent 自身数据的属性，与导航路径无关。
  const subAgentParentTurn = useMemo(() => {
    if (!selectedSubAgent) return null;
    return turns.find(t => t.calls.some(c => c.id === selectedSubAgent.parentCallId)) ?? null;
  }, [selectedSubAgent, turns]);

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

  // ── 导航主干：handler 只 navigate，state 由 reconciliation 写回 ────────────
  // applyNav 是唯一写 navLevel/selected* 的地方（除 sub-agent，见 Phase 4 注释），
  // 由下方 useEffect 在 URL 变化时调用。点击 handler 一律走 navigate(buildSessionPath)，
  // 不直接 setState —— 保证 URL 是唯一真相、避免双写竞争。
  const goNav = useCallback((nav: SessionNav) => {
    navigate(buildSessionPath(session.session_id, nav));
  }, [navigate, session.session_id]);

  function openLinkedPanelAsMain() {
    if (!linkedPanel) return;
    // 提升 linked panel 到主视图 = 导航到对应 turn/call。先关 panel 再 navigate。
    setLinkedPanel(null);
    goNav(linkedPanel.type === "call"
      ? { level: "call", turnId: linkedPanel.turn.id, callId: linkedPanel.call.id }
      : { level: "turn", turnId: linkedPanel.turn.id });
  }

  function handleSelectTurn(turn: MockUserTurn) {
    goNav({ level: "turn", turnId: turn.id });
  }

  function handleSelectCall(call: MockLlmCall) {
    // call 归属当前 selectedTurn；兜底用 findTurnForCall 反查（如从别处直达）。
    const owningTurn = selectedTurn?.calls.some(c => c.id === call.id)
      ? selectedTurn
      : findTurnForCall(call.id);
    if (!owningTurn) return;
    goNav({ level: "call", turnId: owningTurn.id, callId: call.id });
  }

  function handleLinkCallFromTurn(call: MockLlmCall) {
    openLinkedCall(call, selectedTurn);
    setInspector({ type: "call-diff", call });
  }

  function handleSelectEntry(entry: MockDiffEntry) {
    setInspector({ type: "evidence", entry });
  }

  function handleNavSession() {
    goNav({ level: "session" });
  }

  // applyNav：把解析出的 SessionNav 写回 state。找不到目标（坏链 / 不属于本
  // session）退到 session 总览。inspector 在此同步设置，保持右栏与主视图一致。
  // 注意：不处理 subagent —— 它仍由 handleSelectSubAgent setState 驱动（Phase 4
  // 才接 URL）；本 effect 只在 pathname/loadState 变化时跑，进 subagent 不改
  // pathname，因此不会被 applyNav 误覆盖。
  function applyNav(nav: SessionNav) {
    switch (nav.level) {
      case "turn": {
        const turn = turns.find(t => t.id === nav.turnId);
        if (!turn) { applySessionLevel(); return; }
        setNavLevel("turn"); setSelectedTurn(turn); setSelectedCall(null);
        setSelectedInterTurnBlock(null); setSelectedCompactEventIdx(null);
        if (!linkedPanelPinned) setLinkedPanel(null);
        setInspector({ type: "turn-rollup", turn });
        return;
      }
      case "call": {
        const turn = turns.find(t => t.id === nav.turnId);
        const call = turn?.calls.find(c => c.id === nav.callId);
        if (!turn || !call) { applySessionLevel(); return; }
        setNavLevel("call"); setSelectedTurn(turn); setSelectedCall(call);
        setSelectedInterTurnBlock(null); setSelectedCompactEventIdx(null);
        if (!linkedPanelPinned) setLinkedPanel(null);
        setInspector({ type: "call-diff", call });
        return;
      }
      case "inter-turn": {
        const block = interTurnBlocks.find(b => b.index === nav.blockIdx);
        if (!block) { applySessionLevel(); return; }
        setNavLevel("inter-turn"); setSelectedInterTurnBlock(block);
        setSelectedTurn(null); setSelectedCall(null); setSelectedCompactEventIdx(null);
        if (!linkedPanelPinned) setLinkedPanel(null);
        return;
      }
      case "compact-event": {
        if (!compactEvents[nav.compactIdx]) { applySessionLevel(); return; }
        setNavLevel("compact-event"); setSelectedCompactEventIdx(nav.compactIdx);
        setSelectedTurn(null); setSelectedCall(null); setSelectedInterTurnBlock(null);
        if (!linkedPanelPinned) setLinkedPanel(null);
        return;
      }
      case "compact-call": {
        if (!compactEvents[nav.compactIdx]) { applySessionLevel(); return; }
        setNavLevel("compact-call"); setSelectedCompactEventIdx(nav.compactIdx);
        setSelectedTurn(null); setSelectedCall(null); setSelectedInterTurnBlock(null);
        if (!linkedPanelPinned) setLinkedPanel(null);
        return;
      }
      case "subagent":
      case "subagent-turn":
      case "subagent-call": {
        const sa = subAgentByFileId.get(nav.agentFileId);
        if (!sa) { applySessionLevel(); return; }
        // 父 turn 由 subAgentParentTurn（sa.parentCallId 反查）决定，与 selectedTurn
        // 无关 —— 这里设 selectedTurn=null，避免 stale 值在别处泄漏。返回父 turn
        // 走 handleReturnFromSubAgent → subAgentParentTurn。
        setSelectedSubAgent(sa);
        setSelectedTurn(null);
        setNavLevel("subagent");
        setSelectedCall(null); setSelectedInterTurnBlock(null); setSelectedCompactEventIdx(null);
        if (!linkedPanelPinned) setLinkedPanel(null);
        setSubAgentTurnId(nav.level === "subagent" ? null : nav.turnId);
        setSubAgentCallId(nav.level === "subagent-call" ? nav.callId : null);
        return;
      }
      case "background": {
        // session 级旁路视图：不依赖 turns 加载，没有"找不到 → 退 session"的守卫。
        setNavLevel("background");
        setSelectedTurn(null); setSelectedCall(null);
        setSelectedInterTurnBlock(null); setSelectedCompactEventIdx(null);
        setSelectedProxyRequestId(null);
        if (!linkedPanelPinned) setLinkedPanel(null);
        setInspector({ type: "hotspots" });
        return;
      }
      case "side-call": {
        setNavLevel("side-call");
        setSelectedProxyRequestId(nav.proxyRequestId);
        setSelectedTurn(null); setSelectedCall(null);
        setSelectedInterTurnBlock(null); setSelectedCompactEventIdx(null);
        if (!linkedPanelPinned) setLinkedPanel(null);
        setInspector({ type: "hotspots" });
        return;
      }
      case "session":
      default:
        applySessionLevel();
        return;
    }
  }

  function applySessionLevel() {
    setNavLevel("session");
    setSelectedTurn(null);
    setSelectedInterTurnBlock(null);
    setSelectedCall(null);
    setSelectedCompactEventIdx(null);
    setSelectedProxyRequestId(null);
    if (!linkedPanelPinned) setLinkedPanel(null);
    setInspector({ type: "hotspots" });
  }

  // Reconciliation：URL → state 的唯一通道。等 drilldown 到位（loadState==="ok"，
  // turns/compactEvents 才有内容）再解析 pathname 并 applyNav。依赖只取
  // [pathname, loadState] —— applyNav 内部的 setState 不改这两者，所以不会自触发，
  // 单向流不成环。subagent 内部点击不改 pathname，因此不会被这里覆盖。
  useEffect(() => {
    if (loadState !== "ok") return;
    // 受保护的 URL→state reconciliation：这是单向数据流的唯一回写通道（见文件头
    // 注释）。setState-in-effect 是此架构的核心，非性能问题，刻意保留。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    applyNav(parseSessionNav(location.pathname, session.session_id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, loadState, session.session_id]);

  // 进 sub-agent：navigate 到 bare /subagent/:aid，reconciliation + redirect effect
  // 会接管（解析 sa、拉 drilldown、跳首 turn）。fetch 不在这里，挪到下方专用 effect
  // （按 agentFileId 去重，避免 bare→turn redirect 触发二次 fetch）。
  function handleSelectSubAgent(sa: SubAgentSummary) {
    goNav({ level: "subagent", agentFileId: sa.agentFileId });
  }

  // Return from a sub-agent side branch to its真实父 turn（由 parentCallId 反查），
  // 不再依赖 selectedTurn。父 turn 不存在（理论上不应发生）时退到 session。
  function handleReturnFromSubAgent() {
    if (subAgentParentTurn) goNav({ level: "turn", turnId: subAgentParentTurn.id });
    else goNav({ level: "session" });
  }

  // sub-agent drilldown 拉取：按 selectedSubAgent.agentFileId 去重。只有真正
  // 处于 subagent 视图时才拉。effect deps 是 agentFileId —— bare→turn→call 的
  // URL 变化不改 agentFileId，因此只拉一次。
  const activeSubAgentFileId = navLevel === "subagent" ? (selectedSubAgent?.agentFileId ?? null) : null;
  useEffect(() => {
    if (!activeSubAgentFileId) return;
    let cancelled = false;
    // sub-agent 数据加载 effect：标准 fetch 模式。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSubAgentDrilldown(null);
    setSubAgentLoadState("loading");
    apiV2.subAgentDrilldown(session.session_id, activeSubAgentFileId)
      .then(data => { if (!cancelled) { setSubAgentDrilldown(data); setSubAgentLoadState("ok"); } })
      .catch(() => { if (!cancelled) setSubAgentLoadState("error"); });
    return () => { cancelled = true; };
  }, [activeSubAgentFileId, session.session_id]);

  // bare /subagent/:aid 的 resolve-then-redirect：drilldown 到位后跳首 turn，
  // 用 replace 不污染历史。没有"默认 turn 0"魔法 —— canonical URL 永远带 turn。
  useEffect(() => {
    if (navLevel !== "subagent") return;
    if (subAgentTurnId !== null) return;          // 已在某个 turn
    if (subAgentLoadState !== "ok" || !subAgentDrilldown) return;
    const firstTurnId = subAgentDrilldown.turns[0]?.id;
    if (firstTurnId == null || !selectedSubAgent) return;
    navigate(
      buildSessionPath(session.session_id, { level: "subagent-turn", agentFileId: selectedSubAgent.agentFileId, turnId: firstTurnId }),
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navLevel, subAgentTurnId, subAgentLoadState, subAgentDrilldown, selectedSubAgent, session.session_id]);

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

  // Phase 2：把编排器已经算好的值 + 唯一导航漏斗 + linkedPanel/inspector 动作
  // 原样 re-expose 给 context。纯加法 —— 目前没有消费者，旧 prop 路径照常工作；
  // Phase 3 起各域面板再逐步改成 useSessionDetail()。
  const sessionDetailCtx: SessionDetailContextValue = {
    sessionId: session.session_id,
    drilldown,
    turns,
    isMockSession: isMockData,
    navigate: goNav,
    linkTo: {
      call: openLinkedCall,
      turnExcerpt: openLinkedTurnExcerpt,
      close: closeLinkedPanel,
    },
    selectEntry: handleSelectEntry,
  };

  return (
    <SessionDetailProvider value={sessionDetailCtx}>
    <AttributionGraphProvider
      sessionId={session.session_id}
      onJumpToCall={onJumpToCall}
      onOpenSideCall={(proxyRequestId) => goNav({ level: "side-call", proxyRequestId })}
    >
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="!max-w-none p-0 gap-0 sm:max-w-none"
        style={{
          // Drawer width is responsive to "how much canvas does this state
          // need":
          //   · linkedPanel open → widest (1560px) since right panel eats
          //     a big chunk
          //   · subagent open → 1480px because the sub-agent view has its
          //     own 200px left nav + breadcrumb + amber notice
          //   · default (session / turn / call) → 1480px so unified lens
          //     view has room to breathe (旧版 1200 太挤；用户反馈调宽)
          width: linkedPanel
            ? "calc(100vw - 64px)"
            : navLevel === "subagent"
              ? "calc(100vw - 96px)"
              : "calc(100vw - 120px)",
          maxWidth: linkedPanel ? 1560 : 1480,
          transition: "width 180ms ease, max-width 180ms ease",
        }}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">Session detail drawer for {session.session_id}</SheetDescription>
        <SessionDetailHeader
          title={title}
          sessionId={session.session_id}
          navLevel={navLevel}
          selectedTurn={selectedTurn}
          selectedCall={selectedCall}
          selectedCompactEventIdx={selectedCompactEventIdx}
          selectedSubAgent={selectedSubAgent}
          subAgentParentTurn={subAgentParentTurn}
          loadState={loadState}
          onNavSession={handleNavSession}
          onNavigate={goNav}
          onClose={onClose}
        />

        {/* Body: Left Nav + Main + Inspector */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <SessionNavRail
            turns={turns}
            compactEvents={compactEvents}
            navLevel={navLevel}
            selectedTurn={selectedTurn}
            selectedCall={selectedCall}
            selectedCompactEventIdx={selectedCompactEventIdx}
            linkedPanel={linkedPanel}
            allCallsForNav={allCallsForNav}
            onNavSession={handleNavSession}
            onSelectTurn={handleSelectTurn}
            onSelectCall={handleSelectCall}
            onSelectCompact={(idx) => goNav({ level: "compact-event", compactIdx: idx })}
            onNavBackground={() => goNav({ level: "background" })}
          />

          {/* Main Canvas */}
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
            {navLevel === "session" && (
              <SessionOverviewPanel />
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
                onSelectCall={() => {
                  // 合成 call 没有真实 jsonl line，但 compact 端点能用 idx 反查；
                  // navigate 到 compact-call 子级，reconciliation 会切 navLevel。
                  goNav({ level: "compact-call", compactIdx: selectedCompactEventIdx });
                }}
                isMockSession={false}
                sessionId={session.session_id}
              />
            )}
            {navLevel === "compact-call" && selectedCompactEventIdx !== null
              && compactEvents[selectedCompactEventIdx] && (() => {
              // 这里现合成一次 turn 是为了拿到合成 call —— synthesizeCompactTurn
              // 是纯函数，开销可忽略。
              const synthTurn = synthesizeCompactTurn(compactEvents[selectedCompactEventIdx]);
              const synthCall = synthTurn.calls[0];
              return (
                <LlmCallDetailPanel
                  call={synthCall}
                  prevCall={null}
                  onSelectEntry={handleSelectEntry}
                  sessionId={session.session_id}
                  compactIdx={selectedCompactEventIdx}
                  onClose={() => goNav({ level: "compact-event", compactIdx: selectedCompactEventIdx })}
                />
              );
            })()}
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
                parentLabel={subAgentParentTurn ? `${t("sessionOverview.turn.label")} ${subAgentParentTurn.id}` : undefined}
                onReturnToParent={subAgentParentTurn ? handleReturnFromSubAgent : undefined}
                selectedTurnId={subAgentTurnId}
                selectedCallId={subAgentCallId}
                onSelectTurn={(turnId) => goNav({ level: "subagent-turn", agentFileId: selectedSubAgent.agentFileId, turnId })}
                onSelectCall={(callId) => goNav({ level: "subagent-call", agentFileId: selectedSubAgent.agentFileId, turnId: subAgentTurnId ?? 0, callId })}
                onClearCall={() => goNav({ level: "subagent-turn", agentFileId: selectedSubAgent.agentFileId, turnId: subAgentTurnId ?? 0 })}
              />
            )}
            {navLevel === "background" && (
              <BackgroundCallsPanel
                sessionId={session.session_id}
                onOpenSideCall={(pid) => goNav({ level: "side-call", proxyRequestId: pid })}
              />
            )}
            {navLevel === "side-call" && selectedProxyRequestId != null && (
              <SideCallDetailPanel
                sessionId={session.session_id}
                proxyRequestId={selectedProxyRequestId}
                onClose={() => goNav({ level: "background" })}
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
      </SheetContent>
    </Sheet>
    </AttributionGraphProvider>
    </SessionDetailProvider>
  );
}
