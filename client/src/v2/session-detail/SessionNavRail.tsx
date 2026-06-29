// SessionNavRail —— session drawer 左侧 200px 导航栏。
//
// 信息架构（统一 L1 手风琴 · Option A）：五个一级域用同一种"选中"语法（selection.ts
// 的 3px 左条 + indigo50 底 + indigo 文字），任意时刻恰好一个域展开：
//   主会话 / 团队 / 工作流 / 子代理 / 后台请求
// 心智模型 = session 家族：前四域都是 session 级实体（子视窗 / 子会话）——「主会话」是本
// session 自身，「子代理」「工作流」是它衍生出的子 session 转录，「团队」是与它平级的完整
// session；只有「后台请求」是非 session 旁路（标题生成 / quota 等单发请求），故垫底。
// 「主会话」域头 —— 一个 session 的 summary 天然就是其主 turn 的集合，所以点域头 = 看
// session summary（navLevel=session，不强选某个 turn），其面板就是 turn→call 列表。
// 这避免了"点域头被强制跳到 turn[0]"的跳跃感。
//
// 两个正交语义，分别上色，勿混（这正是旧版"点 Overview 高亮、点 Background 不高亮"的根因）：
//   · expanded（展开域）：activeDomain===key，由 navLevel 派生 → 面板可见 + 域头转 indigo。
//   · selected（域头即当前查看的叶子）：navLevel 恰为该域的 summary 级（session/team/
//     background）→ 域头加完整选中填充（左条+底）。工作流/子代理无 summary 级，域头永不 selected，
//     选中填充落到具体 run/agent 子行。
// 展开面板 flex 撑满中段、内部滚动；其上的域头钉顶、其下的钉底（flexbox 自然分区，非 sticky）。
//
// 点域头一律 navigate 到该域聚合入口（onClick，不靠 Radix 的 onValueChange）—— 故即便
// 域已展开，从某条 side-call 点「后台请求」头也能回到"全部后台"聚合，无需面板内再放冗余总览行。
//
// 纯展示 + 回调：选中态由 props 传入（编排器是 selection 的唯一来源），点击通过
// 回调上报（实际走 goNav 漏斗）。各面板内部行渲染（turn→call / 成员 / run→agent /
// side-call）逻辑零改动，仅从旧的 tab 分支搬进对应域的展开面板。

import React from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { CompactEvent, WorkflowRunSummary, SubAgentSummary } from "../drilldown-types";
import type { MockUserTurn, MockLlmCall } from "../lib/mock-data";
import type { SideCall, SideCallKind, TeamDomainResponse } from "../api";
import type { NavLevel } from "./session-nav";
import type { LinkedPanelState } from "./SessionDetailContext";
import { fmtK } from "../lib/format";
import { BRAND } from "../shared/brand";
import { selectionStyle, SELECTION_FG } from "../shared/selection";
import { StatusBadgeStrip, type StatusBadge } from "../shared/HeaderStats";
import { renderStatusIcon } from "../shared/SessionBadges";
import { NoProxyDot } from "../shared/NoProxyDot";
import { NavItem, CompactEventNavItem } from "./nav";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";

// side call kind → 平面文本标签（与 BackgroundCallsPanel 一致，暂不加 icon）。
const SIDE_CALL_KIND_LABEL: Record<SideCallKind, string> = {
  generate_session_title: "标题生成",
  quota: "Quota 探测",
  prompt_suggestion: "提示建议",
  agent_summary: "Agent 摘要",
  auto_dream: "Auto dream",
  extract_memories: "记忆抽取",
  away_summary: "离开摘要",
};

// 一级域 key。顺序即上→下的物理排列（主会话置顶、后台请求垫底）。
type DomainKey = "main-session" | "team" | "workflows" | "subagents" | "background";

// 一级域头：五个域共用的统一"选中"语法。两个正交语义分别上色（见文件头）：
//   · expanded：该域展开（面板可见）→ 域头转 indigo + chevron 旋转。
//   · selected：域头本身即当前查看的叶子 → 加完整选中填充（左条+底）。
// onClick 一律导航到该域聚合入口（即便已展开也触发，故能从子项回聚合）。
function DomainTrigger({
  label, count, expanded, selected, onClick,
}: {
  label: React.ReactNode;
  count?: number;
  expanded: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const indigo = expanded || selected;
  return (
    <AccordionTrigger
      onClick={onClick}
      className={!selected ? "hover:bg-gray-100 transition-colors" : ""}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "9px 12px", cursor: "pointer",
        fontSize: 12, fontWeight: 700,
        color: indigo ? SELECTION_FG : "#374151",
        borderTop: "1px solid #f3f4f6",
        ...selectionStyle(selected, "indigo"),
      }}
    >
      <ChevronRight
        size={13}
        style={{
          flexShrink: 0,
          color: indigo ? SELECTION_FG : "#9ca3af",
          transition: "transform 120ms ease",
          transform: expanded ? "rotate(90deg)" : "none",
        }}
      />
      <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      {count != null && count > 0 && (
        <span style={{
          fontSize: 9, fontWeight: 700, flexShrink: 0,
          color: indigo ? BRAND.indigo700 : "#9ca3af",
          background: indigo ? BRAND.indigo100 : "#f1f5f9",
          borderRadius: 8, padding: "1px 6px", lineHeight: 1.4,
        }}>{count}</span>
      )}
    </AccordionTrigger>
  );
}

export function SessionNavRail({
  turns, compactEvents, navLevel, selectedTurn, selectedCall,
  selectedCompactEventIdx, linkedPanel, allCallsForNav,
  onNavSession, onSelectTurn, onSelectCall, onSelectCompact, onNavBackground,
  sideCalls, selectedProxyRequestId, onSelectSideCall,
  workflowRuns, selectedRunId, onSelectWorkflowRun,
  taskSubAgents, selectedAgentFileId, onSelectSubAgent,
  teamDomain, currentSessionId, onNavTeam, onOpenSession,
}: {
  turns: MockUserTurn[];
  compactEvents: CompactEvent[];
  navLevel: NavLevel;
  selectedTurn: MockUserTurn | null;
  selectedCall: MockLlmCall | null;
  selectedCompactEventIdx: number | null;
  linkedPanel: LinkedPanelState | null;
  allCallsForNav: MockLlmCall[];
  onNavSession: () => void;
  onSelectTurn: (turn: MockUserTurn) => void;
  onSelectCall: (call: MockLlmCall) => void;
  onSelectCompact: (idx: number) => void;
  // 后台 side call（标题生成 / quota / suggestion 等）入口。作为一级域垫底，
  // 展开成编号子项（#1/#2…，按 started_at），与 turn→call 对齐。
  onNavBackground: () => void;
  sideCalls: SideCall[];
  selectedProxyRequestId: number | null;
  onSelectSideCall: (proxyRequestId: number) => void;
  // 已完结 workflow run —— 独立一级域。
  workflowRuns: WorkflowRunSummary[];
  selectedRunId: string | null;
  onSelectWorkflowRun: (runId: string) => void;
  // Task 型 sub agent（含 background Agent）—— 独立一级域的 session 级直接入口
  // （之前必须 turn→call→sub-agent 块三跳）。
  taskSubAgents: SubAgentSummary[];
  // 当前下钻中的 agent（workflow 或 task）—— 用于 run 子行 / 子代理行高亮，
  // 以及"在某 run 的 agent 里时该域/该 run 保持展开"。
  selectedAgentFileId: string | null;
  onSelectSubAgent: (agentFileId: string) => void;
  // agent teams：本会话所属 team（null = 非 team 会话，该域不渲染）。
  // 成员行点击 = 跨 session 跳转（成员是平级完整 session）。
  teamDomain: TeamDomainResponse | null;
  currentSessionId: string;
  onNavTeam: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation();

  // 哪些域当前在场（总览 / 后台请求 恒在；团队 / 工作流 / 子代理 按数据存在性）。
  const hasTeam = teamDomain != null;
  const hasWorkflows = workflowRuns.length > 0;
  const hasSubagents = taskSubAgents.length > 0;

  // 展开域 = 由 navLevel 派生。turn/call/inter-turn/compact 归「主会话」域（主会话即
  // 本 session 的 turns 集合）。subagent 有歧义：工作流内的 agent 归 workflows 域，否则
  // 归 subagents 域（与下方 run 行的 inThisRun 判定同源）。
  const rawDomain: DomainKey = (() => {
    switch (navLevel) {
      case "background":
      case "side-call":
        return "background";
      case "team":
        return "team";
      case "workflow-run":
        return "workflows";
      case "subagent": {
        const inWorkflow = selectedAgentFileId != null && workflowRuns.some(r =>
          r.agents.some(a => a.agentFileId === selectedAgentFileId
            || a.attempts?.some(at => at.agentFileId === selectedAgentFileId)));
        return inWorkflow ? "workflows" : "subagents";
      }
      case "session":
      case "turn":
      case "call":
      case "inter-turn":
      case "compact-event":
      case "compact-call":
      default:
        return "main-session";
    }
  })();
  // 防御：派生域恰好不在场时退回主会话（不变量下不应发生，纯保险）。
  const present = new Set<DomainKey>(["main-session", "background"]);
  if (hasTeam) present.add("team");
  if (hasWorkflows) present.add("workflows");
  if (hasSubagents) present.add("subagents");
  const activeDomain: DomainKey = present.has(rawDomain) ? rawDomain : "main-session";

  // 点域头 → 导航到该域聚合入口。总览/团队/后台有真正的聚合视图（session summary /
  // 团队总览 / 全部后台），点头一律回聚合（含从子项返回）。工作流/子代理无聚合视图 →
  // 仅在从别处进入时落到首项；已在域内时点头会重导到首项，属可接受的小副作用。
  const navigateToDomain = (key: DomainKey) => {
    switch (key) {
      case "main-session": onNavSession(); break;
      case "team":       onNavTeam(); break;
      case "background": onNavBackground(); break;
      case "workflows":  if (workflowRuns[0]) onSelectWorkflowRun(workflowRuns[0].runId); break;
      case "subagents":  if (taskSubAgents[0]) onSelectSubAgent(taskSubAgents[0].agentFileId); break;
    }
  };

  // 展开域 = flex-1 撑满中段并内部滚动；其余域头折叠成 flex-none（自然钉顶 / 钉底）。
  const itemClass = (key: DomainKey) =>
    activeDomain === key ? "flex-1 min-h-0" : "flex-none";

  const turnPrefix = t("sessionOverview.turn.label");
  const callPrefix = t("terms.callLabel");

  return (
    <div style={{ width: 200, borderRight: "1px solid #e5e7eb", flexShrink: 0, background: "#fafafa", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Accordion
        type="single"
        value={activeDomain}
        className="flex-1 min-h-0"
      >
        {/* 主会话（本 session 自身）：点域头 = 看 session summary（不强选 turn），其面板
            就是 turn → call 子行 + 夹在 turn 之间的 compact 事件行。
            域头 selected 仅当 navLevel=session；进某个 turn 后高亮移到 turn 子行。 */}
        <AccordionItem value="main-session" className={itemClass("main-session")}>
          <DomainTrigger
            label={t("sessionOverview.nav.mainSession", { defaultValue: "主会话" })}
            count={turns.length}
            expanded={activeDomain === "main-session"}
            selected={navLevel === "session"}
            onClick={() => navigateToDomain("main-session")}
          />
          <AccordionContent className="flex-1 min-h-0 overflow-y-auto">
            {turns.map(turn => {
              const isThisTurnSelected = selectedTurn?.id === turn.id;
              const turnInput = turn.userInput.trim();
              const preview = turnInput.slice(0, 16).trimEnd() + (turnInput.length > 16 ? "…" : "");
              // Two inline spans (no flex container) so the outer NavItem
              // ellipsis still kicks in. The prefix is bold + foreground;
              // the user-input preview is lighter weight + muted grey.
              const turnLabel = (
                <>
                  <strong style={{ fontWeight: 700, color: isThisTurnSelected ? BRAND.indigo700 : "#111827" }}>
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
              // subAgent 计数只数 Task 型 —— workflow agent 归 Workflows 域，单独用
              // ⚙ workflow 徽章表达"该 turn 发起了 workflow"（不再混进 subAgent 数）。
              const subAgentCount = turn.calls.reduce((s, c) => s + (c.subAgents?.filter(sa => sa.agentSource !== "workflow").length ?? 0), 0);
              const workflowLaunchCount = turn.calls.reduce((s, c) => s + (c.toolCalls?.filter(tc => tc.name === "Workflow").length ?? 0), 0);
              const commandCount = turn.calls.reduce(
                (s, c) => s + c.intervalEvents.filter(e => e.kind === "user:command").length, 0);
              const unknownCount = turn.calls.reduce(
                (s, c) => s + c.intervalEvents.filter(e => e.kind === "unknown").length, 0);
              const noProxyCount = turn.calls.filter(c => c.proxyMatchMode === "unmatched").length;
              const navBadgeItems: StatusBadge[] = [];
              if (turn.hasCompaction)   navBadgeItems.push({ kind: "compaction", count: 1,              tooltip: t("sessionOverview.badges.compaction") });
              if (turn.errorCount > 0)  navBadgeItems.push({ kind: "error",      count: turn.errorCount,tooltip: t("sessionOverview.badges.errors") });
              if (subAgentCount > 0)    navBadgeItems.push({ kind: "subAgent",   count: subAgentCount,  tooltip: t("sessionOverview.badges.subAgents") });
              if (workflowLaunchCount > 0) navBadgeItems.push({ kind: "workflow", count: workflowLaunchCount, tooltip: t("sessionOverview.badges.workflows", { defaultValue: "工作流" }) });
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
                    onClick={() => onSelectTurn(turn)}
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
                      <React.Fragment key={call.id}>
                      <NavItem
                        indent
                        label={callLabel}
                        sublabel={`${fmtK(call.contextSize)}${deltaTxt}${toolsTxt}`}
                        active={
                          selectedCall?.id === call.id
                          || (linkedPanel?.type === "call" && linkedPanel.call.id === call.id)
                          || (linkedPanel?.type === "turn-excerpt" && linkedPanel.focusCall?.id === call.id)
                        }
                        badges={badgesNode}
                        onClick={() => onSelectCall(call)}
                      />
                      </React.Fragment>
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
                      <React.Fragment key={`compact-${ev.index}`}>
                      <CompactEventNavItem
                        ev={ev}
                        active={navLevel === "compact-event" && selectedCompactEventIdx === ev.index}
                        onClick={() => onSelectCompact(ev.index)}
                      />
                      </React.Fragment>
                    ))}
                </React.Fragment>
              );
            })}
          </AccordionContent>
        </AccordionItem>

        {/* 团队：本会话所属 agent team（成员是平级完整 session，点击成员 = 跨 session
            跳转；team 是 session 间关系，置于工作流之上）。 */}
        {teamDomain && (
          <AccordionItem value="team" className={itemClass("team")}>
            <DomainTrigger
              label={teamDomain.teamName}
              count={teamDomain.members.length}
              expanded={activeDomain === "team"}
              selected={navLevel === "team"}
              onClick={() => navigateToDomain("team")}
            />
            <AccordionContent className="flex-1 min-h-0 overflow-y-auto">
              {teamDomain.members.map((m) => {
                const isSelf = m.sessionId === currentSessionId;
                return (
                  <NavItem
                    key={m.sessionId}
                    indent
                    label={
                      <>
                        <strong style={{ fontWeight: 700, color: m.role === "lead" ? "#0e7490" : undefined }}>
                          {m.agentName ?? "team-lead"}
                        </strong>
                        {isSelf && <span style={{ fontWeight: 400, color: "#9ca3af", marginLeft: 5 }}>{t("team.thisSession", { defaultValue: "(本会话)" })}</span>}
                      </>
                    }
                    sublabel={`${m.role} · ${fmtK(m.llmCallCount)} calls`}
                    active={false}
                    onClick={isSelf ? onNavTeam : () => onOpenSession(m.sessionId)}
                  />
                );
              })}
            </AccordionContent>
          </AccordionItem>
        )}

        {/* 工作流：已完结 dynamic workflow run。run 由某 turn 内的 launch 发起、在后续
            turn 回执 —— 不属于任何单个 turn，故做独立一级域而非 turn 子行。选中（run
            面板打开 / 正在其某 agent 内）时展开 agent 子行，与 turn 展开 call 同构。 */}
        {hasWorkflows && (
          <AccordionItem value="workflows" className={itemClass("workflows")}>
            <DomainTrigger
              label={t("sessionOverview.nav.workflows", { defaultValue: "工作流" })}
              count={workflowRuns.length}
              expanded={activeDomain === "workflows"}
              selected={false}
              onClick={() => navigateToDomain("workflows")}
            />
            <AccordionContent className="flex-1 min-h-0 overflow-y-auto">
              {workflowRuns.map((run) => {
                const failed = run.status !== "completed";
                const inThisRun = selectedAgentFileId != null
                  && run.agents.some((a) => a.agentFileId === selectedAgentFileId
                    || a.attempts?.some((at) => at.agentFileId === selectedAgentFileId));
                const expanded = (navLevel === "workflow-run" && selectedRunId === run.runId) || inThisRun;
                return (
                  <React.Fragment key={run.runId}>
                    <NavItem
                      label={
                        <>
                          <strong style={{ fontWeight: 700 }}>{run.workflowName || run.runId}</strong>
                          {failed && <span style={{ color: "#dc2626", marginLeft: 5, fontWeight: 700 }}>{run.status}</span>}
                        </>
                      }
                      sublabel={`${run.agents.length} ${t("terms.agentsSuffix")} · ${fmtK(run.totalTokens)} ${t("terms.tokensSuffix")} · ${run.launches.length > 1 ? `×${run.launches.length} · ` : ""}${run.runId.slice(0, 14)}`}
                      active={navLevel === "workflow-run" && selectedRunId === run.runId}
                      onClick={() => onSelectWorkflowRun(run.runId)}
                    />
                    {expanded && run.agents.map((agent) => (
                      <NavItem
                        key={agent.agentFileId}
                        indent
                        label={agent.label}
                        sublabel={`${agent.phaseTitle}${agent.cached ? ` · ${t("terms.cachedSuffix")}` : ""}`}
                        active={selectedAgentFileId === agent.agentFileId}
                        onClick={() => onSelectSubAgent(agent.agentFileId)}
                      />
                    ))}
                  </React.Fragment>
                );
              })}
            </AccordionContent>
          </AccordionItem>
        )}

        {/* 子代理：Task 型（含 background Agent）的 session 级直接入口。 */}
        {hasSubagents && (
          <AccordionItem value="subagents" className={itemClass("subagents")}>
            <DomainTrigger
              label={t("sessionOverview.nav.subAgents", { defaultValue: "子代理" })}
              count={taskSubAgents.length}
              expanded={activeDomain === "subagents"}
              selected={false}
              onClick={() => navigateToDomain("subagents")}
            />
            <AccordionContent className="flex-1 min-h-0 overflow-y-auto">
              {taskSubAgents.map((sa) => (
                <NavItem
                  key={sa.agentFileId}
                  label={
                    <>
                      <strong style={{ fontWeight: 700 }}>{sa.agentType}</strong>
                      {sa.description && (
                        <span style={{ fontWeight: 400, color: "#9ca3af", marginLeft: 6 }}>{sa.description}</span>
                      )}
                    </>
                  }
                  sublabel={`${sa.llmCallCount} ${t("terms.callsSuffix")} · ${fmtK(sa.totalOutputTokens)} ${t("terms.outSuffix")}`}
                  active={selectedAgentFileId === sa.agentFileId}
                  onClick={() => onSelectSubAgent(sa.agentFileId)}
                />
              ))}
            </AccordionContent>
          </AccordionItem>
        )}

        {/* 后台请求：session 级旁路视图（标题生成 / quota / suggestion …），垫底。
            域头即"全部后台"入口（点头 navLevel=background）；面板展开成编号子项。 */}
        <AccordionItem value="background" className={itemClass("background")}>
          <DomainTrigger
            label={t("sessionOverview.nav.background", { defaultValue: "后台请求" })}
            count={sideCalls.length}
            expanded={activeDomain === "background"}
            selected={navLevel === "background"}
            onClick={() => navigateToDomain("background")}
          />
          <AccordionContent className="flex-1 min-h-0 overflow-y-auto">
            {sideCalls.length === 0 && (
              <div style={{ padding: "8px 16px", fontSize: 11, color: "#9ca3af" }}>
                {t("sessionOverview.nav.backgroundEmpty", { defaultValue: "（无后台请求 / 扫描中…）" })}
              </div>
            )}
            {sideCalls.map((sc, i) => {
              const label = `#${i + 1} ${SIDE_CALL_KIND_LABEL[sc.kind] ?? sc.kind}`;
              if (sc.proxyRequestId == null) {
                // 未捕获（proxy 未抓到，仅 JSONL 留痕）：无详情页可跳，置灰、不可点。
                return (
                  <div key={`sc-uncap-${i}`} style={{ padding: "5px 10px 5px 28px", fontSize: 11, color: "#cbd5e1" }}>
                    {label} <span style={{ fontSize: 9 }}>· 未捕获</span>
                  </div>
                );
              }
              const pid = sc.proxyRequestId;
              return (
                <NavItem
                  key={`sc-${pid}`}
                  indent
                  label={label}
                  sublabel={sc.title ?? undefined}
                  active={navLevel === "side-call" && selectedProxyRequestId === pid}
                  onClick={() => onSelectSideCall(pid)}
                />
              );
            })}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
