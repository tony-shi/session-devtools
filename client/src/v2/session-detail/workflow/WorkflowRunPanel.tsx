// WorkflowRunPanel —— 已完结 dynamic workflow run 的概览面板（navLevel="workflow-run"）。
//
// 数据全部来自父级传入的 drilldown（run 概览 + workflow agent 平铺条目），
// 唯一的额外请求是 Script tab 的懒加载（脚本全文不进 drilldown payload）。
//
// 口径纪律（与后端 WorkflowRunSummary 注释一致，并排展示必须分别标注）：
//   durationMs / totalTokens / taskId / startTime = 末次物理执行；
//   agentCount / agents[] = 逻辑 run（含 cached 回放）。
//
// 明确不支持（暴露而非兜底）：
//   - superseded agent 只显示计数，无下钻；
//   - launch 锚 resolve 失败显示"锚点未找到"，不按时间猜；
//   - 多次执行 run 的甘特（见 PhaseGantt 头注释）。

import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import type { SessionDrilldown, WorkflowRunSummary } from "../../drilldown-types";
import { apiV2, type WorkflowScriptResponse, type WorkflowAgentSchema, type WorkflowDataflowResponse } from "../../api";
import { fmtK, fmtDuration } from "../../lib/format";
import { BRAND } from "../../shared/brand";
import { HeaderStatRow, type HeaderStat } from "../../shared/HeaderStats";
import { SegmentedToggle } from "../../shared/SegmentedToggle";
import { CodeBlock } from "../../shared/CodeBlock";
import { joinRunAgents, resolveLaunchAnchor, resolveLaunchOrigin, type JoinedRunAgent } from "./runJoin";
import { PhaseGantt } from "./PhaseGantt";

type RunTab = "agents" | "gantt" | "script" | "result" | "dataflow";

export function WorkflowRunPanel({
  run, drilldown, sessionId, onSelectAgent, onJumpToCall,
}: {
  run: WorkflowRunSummary;
  drilldown: SessionDrilldown;
  sessionId: string;
  onSelectAgent: (agentFileId: string) => void;
  onJumpToCall: (turnId: number, callId: number) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RunTab>("agents");
  const agents = useMemo(() => joinRunAgents(run, drilldown.subAgents), [run, drilldown.subAgents]);
  const multiLaunch = run.launches.length > 1;

  // superseded（历史执行残留）不进指标行 —— 它是 resume 的副产品（成本的一部分，
  // 体现脚本可重入），收纳进 resume 徽章详情；终态归宿是 attempt 槽位模型（05 文档 §5）。
  const stats: HeaderStat[] = [
    { label: t("workflow.statDuration", { defaultValue: "时长（末次执行）" }), value: fmtDuration(run.durationMs) },
    { label: t("workflow.statTokens", { defaultValue: "tokens（末次执行）" }), value: fmtK(run.totalTokens) },
    { label: t("workflow.statToolCalls", { defaultValue: "工具调用" }), value: String(run.totalToolCalls) },
    { label: t("workflow.statAgents", { defaultValue: "agents（逻辑 run）" }), value: String(run.agentCount) },
  ];
  const supersededNote = run.supersededAgentCount > 0
    ? t("workflow.supersededNote", {
        defaultValue: "历史执行残留 {{count}} 个转录（上一轮失败/被 resume 前缀规则作废）。本期不支持下钻。",
        count: run.supersededAgentCount,
      })
    : "";

  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
      {/* ── 标题行：名称 + 状态/resume/模型 chips ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>{run.workflowName || run.runId}</span>
        <RunStatusChip status={run.status} error={run.error} />
        {multiLaunch && (
          <Chip
            bg="#fff7ed" fg="#c2410c"
            title={`${t("workflow.resumeTooltip", { defaultValue: "该 run 被 resume 过：同 runId 多次物理执行，概览数字是末次执行口径。" })}${supersededNote ? ` ${supersededNote}` : ""}`}
          >
            {t("workflow.resumeBadge", { defaultValue: "执行 ×{{count}}", count: run.launches.length })}
            {run.supersededAgentCount > 0 && ` · ${t("workflow.residualShort", { defaultValue: "残留 {{count}}", count: run.supersededAgentCount })}`}
          </Chip>
        )}
        {/* 防御：单 launch 但有残留（in-flight resume 的 launch 被 completedAt
            过滤等边缘）—— 残留信息不丢。 */}
        {!multiLaunch && run.supersededAgentCount > 0 && (
          <Chip bg="#f8fafc" fg="#9ca3af" title={supersededNote}>
            {t("workflow.residualShort", { defaultValue: "残留 {{count}}", count: run.supersededAgentCount })}
          </Chip>
        )}
        {run.defaultModel && <Chip bg="#f1f5f9" fg="#475569">{run.defaultModel}</Chip>}
        <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: "auto" }}>{run.runId} · task {run.taskId}</span>
      </div>

      {run.summary && (
        <div style={{ fontSize: 12, color: "#6b7280" }}>{run.summary}</div>
      )}
      {run.error && (
        <div style={{ fontSize: 11, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 4, padding: "6px 10px" }}>
          {run.error}
        </div>
      )}

      <HeaderStatRow stats={stats} />

      {/* ── launches：回指主时间线的锚点（resume → 多个，按物理序） ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", letterSpacing: "0.04em" }}>
          {t("workflow.launches", { defaultValue: "LAUNCHES" })}
        </span>
        {run.launches.map((l, i) => {
          const anchor = resolveLaunchAnchor(l.toolUseId, drilldown.turns);
          const label = `#${i + 1} ${l.toolUseId.slice(0, 14)}…${l.taskId ? ` · ${l.taskId}` : ""}`;
          return anchor ? (
            <button
              key={l.toolUseId}
              onClick={() => onJumpToCall(anchor.turnId, anchor.callId)}
              className="hover:bg-indigo-100 transition-colors"
              style={{
                fontSize: 10, color: BRAND.indigo600, background: "#eef2ff",
                border: `1px solid ${BRAND.indigo200}`, borderRadius: 4,
                padding: "2px 8px", cursor: "pointer",
              }}
            >
              {label} → {t("sessionOverview.turn.label")} {anchor.turnId} · {t("terms.callLabel")} {anchor.callId}
            </button>
          ) : (
            <span key={l.toolUseId} style={{ fontSize: 10, color: "#9ca3af", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 4, padding: "2px 8px" }}>
              {label} · {t("workflow.anchorNotFound", { defaultValue: "锚点未找到" })}
            </span>
          );
        })}
      </div>

      {/* ── tabs ── */}
      <SegmentedToggle<RunTab>
        align="start"
        options={[
          { id: "agents", label: t("workflow.tabAgents", { defaultValue: "Agents" }) },
          { id: "gantt", label: t("workflow.tabGantt", { defaultValue: "甘特" }) },
          { id: "script", label: t("workflow.tabScript", { defaultValue: "脚本" }) },
          { id: "result", label: t("workflow.tabResult", { defaultValue: "结果" }) },
          { id: "dataflow", label: t("workflow.tabDataflow", { defaultValue: "数据流" }) },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "agents" && <AgentsTab agents={agents} onSelectAgent={onSelectAgent} />}
      {tab === "gantt" && <PhaseGantt agents={agents} onSelectAgent={onSelectAgent} />}
      {tab === "script" && <ScriptTab sessionId={sessionId} run={run} drilldown={drilldown} onJumpToCall={onJumpToCall} />}
      {tab === "result" && <ResultTab agents={agents} sessionId={sessionId} runId={run.runId} />}
      {tab === "dataflow" && <DataflowTab sessionId={sessionId} runId={run.runId} drilldown={drilldown} onJumpToCall={onJumpToCall} />}
    </div>
  );
}

// 深链的 runId 不在已完结 run 列表里 —— 显式错误面板（产品决策：不静默退
// session 总览）。两种已知成因直接写给用户：run 未完结（无 wf json，不可见）
// 或 id 错误。
export function WorkflowRunNotFoundPanel({ runId, knownRunIds, onBackToOverview }: {
  runId: string;
  knownRunIds: string[];
  onBackToOverview: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ padding: "40px 32px", display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: "#dc2626" }}>
        {t("workflow.notFoundTitle", { defaultValue: "Workflow run 不存在" })}
      </div>
      <CodeBlock mono>{runId}</CodeBlock>
      <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.7 }}>
        {t("workflow.notFoundDetail", {
          defaultValue: "该 runId 不在本 session 的已完结 run 列表中。可能原因：run 尚未完结（进行中的 run 没有汇总文件，本系统只渲染已完结场景）；或 runId 拼写错误。",
        })}
        {knownRunIds.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {t("workflow.notFoundKnown", { defaultValue: "本 session 已完结的 run：" })} {knownRunIds.join(", ")}
          </div>
        )}
      </div>
      <button
        onClick={onBackToOverview}
        className="hover:bg-gray-100 transition-colors"
        style={{ fontSize: 11, color: "#374151", border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 12px", background: "#fff", cursor: "pointer" }}
      >
        {t("workflow.backToOverview", { defaultValue: "返回 session 总览" })}
      </button>
    </div>
  );
}

// ── tabs ─────────────────────────────────────────────────────────────────────

function AgentsTab({ agents, onSelectAgent }: { agents: JoinedRunAgent[]; onSelectAgent: (agentFileId: string) => void }) {
  const { t } = useTranslation();
  // attempt 历史展开态（按胜出 agentFileId 键控）
  const [openAttempts, setOpenAttempts] = useState<Set<string>>(new Set());
  const toggleAttempts = (id: string) => setOpenAttempts((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <div>
      {agents.map(({ progress: pa, transcript }, idx) => {
        // phase 标题在该 phase 的第一行上方出现一次（按前一行对比推导，免渲染期可变量）
        const phaseHeader = idx === 0 || agents[idx - 1].progress.phaseTitle !== pa.phaseTitle ? pa.phaseTitle : null;
        const clickable = pa.hasTranscript && transcript != null;
        const attemptsOpen = openAttempts.has(pa.agentFileId);
        return (
          <React.Fragment key={pa.agentFileId}>
            {phaseHeader && (
              <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", letterSpacing: "0.05em", padding: "10px 2px 3px" }}>
                {pa.phaseIndex != null ? `${pa.phaseIndex}. ` : ""}{phaseHeader}
              </div>
            )}
            <div
              onClick={clickable ? () => onSelectAgent(pa.agentFileId) : undefined}
              className={clickable ? "hover:bg-gray-50 transition-colors" : ""}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 8px", borderLeft: `3px solid ${pa.cached ? "#cbd5e1" : BRAND.indigo400}`,
                cursor: clickable ? "pointer" : "default",
                opacity: clickable ? 1 : 0.55,
                marginBottom: 2,
              }}
            >
              <span title={pa.cached
                ? t("workflow.cachedTooltip", { defaultValue: "resume 回放：结果来自上一轮 journal，转录来自上一轮执行" })
                : t("workflow.liveTooltip", { defaultValue: "本次执行实跑" })}
                style={{
                  width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                  background: pa.cached ? "#94a3b8" : "#10b981",
                }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: "#111827", whiteSpace: "nowrap" }}>{pa.label}</span>
              {pa.state !== "done" && (
                <Chip bg="#fffbeb" fg="#b45309">{pa.state}</Chip>
              )}
              <span style={{ fontSize: 10, color: "#6b7280", whiteSpace: "nowrap" }}>
                {transcript
                  ? `${transcript.llmCallCount}c · ${transcript.toolCallCount}t · ${fmtDuration(transcript.durationMs)} · ${t("workflow.peakCtx", { defaultValue: "峰值" })} ${fmtK(transcript.peakContext)}`
                  : t("workflow.noTranscript", { defaultValue: "无转录" })}
              </span>
              <span style={{
                fontSize: 10, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap", flex: 1, minWidth: 0,
              }}>{(transcript?.resultPreview ?? pa.resultPreview).slice(0, 160)}</span>
              {pa.attempts && (
                <button
                  onClick={(e) => { e.stopPropagation(); toggleAttempts(pa.agentFileId); }}
                  title={t("workflow.attemptsTooltip", { defaultValue: "该调用槽位被执行过多次（resume 重跑），展开尝试历史" })}
                  style={{
                    fontSize: 10, fontWeight: 700, color: "#c2410c", background: "#fff7ed",
                    border: "1px solid #fed7aa", borderRadius: 4, padding: "1px 7px",
                    cursor: "pointer", flexShrink: 0,
                  }}
                >
                  {attemptsOpen ? "▴" : "▾"} {t("workflow.attemptsBadge", { defaultValue: "尝试 ×{{count}}", count: pa.attempts.length })}
                </button>
              )}
              {clickable && (
                <span style={{ fontSize: 10, color: BRAND.indigo500, flexShrink: 0 }}>
                  {t("workflow.drillIn", { defaultValue: "查看完整" })} ›
                </span>
              )}
            </div>
            {/* attempt 槽位历史：journal 物理行序 = 尝试时间序。非胜出尝试的转录
                真实存在（视觉降级但可下钻）；hasResult=false 即失败/中断的尝试。 */}
            {pa.attempts && attemptsOpen && (
              <div style={{ margin: "0 0 6px 18px", borderLeft: "2px solid #fed7aa", paddingLeft: 10 }}>
                {pa.attempts.map((at, ai) => (
                  <div key={at.agentFileId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 10 }}>
                    <span style={{ color: "#9ca3af", width: 44, flexShrink: 0 }}>
                      {t("workflow.attemptN", { defaultValue: "尝试 {{n}}", n: ai + 1 })}
                    </span>
                    <span style={{ fontFamily: "monospace", color: "#6b7280" }}>{at.agentId.slice(0, 8)}</span>
                    {at.final ? (
                      <Chip bg="#f0fdf4" fg="#16a34a">{t("workflow.attemptFinal", { defaultValue: "胜出" })}</Chip>
                    ) : at.hasResult ? (
                      <Chip bg="#f8fafc" fg="#9ca3af" title={t("workflow.attemptVoidedTooltip", { defaultValue: "曾成功，但被 resume 的最长不变前缀规则作废重跑" })}>
                        {t("workflow.attemptVoided", { defaultValue: "成功但被作废" })}
                      </Chip>
                    ) : (
                      <Chip bg="#fef2f2" fg="#dc2626">{t("workflow.attemptFailed", { defaultValue: "失败/中断" })}</Chip>
                    )}
                    {at.hasTranscript ? (
                      <button
                        onClick={() => onSelectAgent(at.agentFileId)}
                        className="hover:bg-gray-100 transition-colors"
                        style={{ fontSize: 10, color: BRAND.indigo500, background: "none", border: "1px solid #e5e7eb", borderRadius: 4, padding: "1px 7px", cursor: "pointer" }}
                      >
                        {t("workflow.attemptTranscript", { defaultValue: "转录" })} ›
                      </button>
                    ) : (
                      <span style={{ color: "#cbd5e1" }}>{t("workflow.noTranscript", { defaultValue: "无转录" })}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ScriptTab({ sessionId, run, drilldown, onJumpToCall }: {
  sessionId: string;
  run: WorkflowRunSummary;
  drilldown: SessionDrilldown;
  onJumpToCall: (turnId: number, callId: number) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ok"; data: WorkflowScriptResponse }
    | { phase: "error"; message: string }
  >({ phase: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    apiV2.workflowScript(sessionId, run.runId)
      .then((data) => { if (!cancelled) setState({ phase: "ok", data }); })
      .catch((e: Error) => { if (!cancelled) setState({ phase: "error", message: e.message }); });
    return () => { cancelled = true; };
  }, [sessionId, run.runId]);

  // 脚本诞生处：launches[0]（首次 launch，resume 复用同一脚本）。
  // inline（首 key = script）→ 脚本逐 token 是该 call 的 LLM 输出；
  // scriptPath → 来自文件，诞生在别处（仍给 launch 跳链但措辞区分）。
  const origin = resolveLaunchOrigin(run.launches[0]?.toolUseId ?? "", drilldown.turns);
  const originRow = (() => {
    if (!origin) {
      return (
        <span style={{ color: "#9ca3af" }}>
          {t("workflow.originNotFound", { defaultValue: "launch 锚点未找到，无法定位脚本诞生处" })}
        </span>
      );
    }
    const jumpBtn = (label: string) => (
      <button
        onClick={() => onJumpToCall(origin.turnId, origin.callId)}
        className="hover:bg-indigo-100 transition-colors"
        style={{
          fontSize: 10, color: BRAND.indigo600, background: "#eef2ff",
          border: `1px solid ${BRAND.indigo200}`, borderRadius: 4, padding: "2px 8px", cursor: "pointer",
        }}
      >
        {label} → {t("sessionOverview.turn.label")} {origin.turnId} · {t("terms.callLabel")} {origin.callId}
      </button>
    );
    if (origin.firstInputKey === "script") {
      return jumpBtn(run.launches.length > 1
        ? t("workflow.originBornFirstLaunch", { defaultValue: "诞生于首次 launch（该 call 的 LLM 输出）" })
        : t("workflow.originBorn", { defaultValue: "诞生于此（该 call 的 LLM 输出）" }));
    }
    if (origin.firstInputKey === "scriptPath") {
      return (
        <>
          <span style={{ color: "#6b7280" }}>
            {t("workflow.originFromFile", { defaultValue: "脚本来自文件（scriptPath 调用），非本 call 的 LLM 输出" })}
          </span>
          {jumpBtn(t("workflow.originLaunchSite", { defaultValue: "launch 处" }))}
        </>
      );
    }
    return jumpBtn(t("workflow.originLaunchSite", { defaultValue: "launch 处" }));
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 10, color: "#6b7280" }}>
        {originRow}
        {run.launches.length > 1 && (
          <Chip bg="#fff7ed" fg="#c2410c">{t("workflow.scriptResume", { defaultValue: "resume ×{{count}}", count: run.launches.length })}</Chip>
        )}
        <span>{run.scriptLength.toLocaleString()} chars</span>
        <span style={{ fontFamily: "monospace" }}>{run.scriptPath}</span>
      </div>
      {run.args !== undefined && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", letterSpacing: "0.04em", marginBottom: 3 }}>ARGS</div>
          <CodeBlock mono maxHeight={180}>{tryPrettyJson(run.args)}</CodeBlock>
        </div>
      )}
      {state.phase === "loading" && (
        <div style={{ fontSize: 12, color: "#9ca3af" }}>{t("workflow.scriptLoading", { defaultValue: "加载脚本…" })}</div>
      )}
      {state.phase === "error" && (
        <div style={{ fontSize: 12, color: "#dc2626" }}>
          {t("workflow.scriptError", { defaultValue: "脚本加载失败：" })}{state.message}
        </div>
      )}
      {state.phase === "ok" && (
        <CodeBlock mono>{state.data.script}</CodeBlock>
      )}
    </div>
  );
}

// 结果 tab：每 agent 的 journal result（结构化返回值权威来源）。
// run 级 result（wf json result 字段）后端未暴露，本期不展示 —— 不在前端拼装伪造。
//
// 渲染分流（按值类型，不猜语义）：
//   1. JSON 对象且含超长 string 顶层字段（如 {findings: "万字 markdown", keyFacts: […]}
//      这类常见形态）→ 长字段逐个渲染 markdown 小节，其余字段收进 JSON 块；
//   2. 其他合法 JSON → 美化 JSON；
//   3. 非 JSON（schema-less agent 的纯文本返回值）→ 整体 markdown。
// schema 本体不在 payload 里（脚本源码/proxy tools[] 才有）—— schema-aware
// 渲染挂远期（05 文档 §6/待办 L），这里只按值分流。
const LONG_STRING_THRESHOLD = 500;

function splitLongStringFields(raw: string): { long: Array<[string, string]>; rest: Record<string, unknown> } | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  const long = entries.filter((e): e is [string, string] =>
    typeof e[1] === "string" && e[1].length > LONG_STRING_THRESHOLD);
  if (long.length === 0) return null;
  const longKeys = new Set(long.map(([k]) => k));
  return { long, rest: Object.fromEntries(entries.filter(([k]) => !longKeys.has(k))) };
}

// schema.properties[key].description 抽取（L：proxy tools[] 真值的最小集成 ——
// 字段标注，不做校验/类型徽章）。schema 缺失/形状不符 → undefined，零影响。
function fieldDescription(schema: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const props = (schema as { properties?: Record<string, { description?: unknown }> } | null | undefined)?.properties;
  const d = props?.[key]?.description;
  return typeof d === "string" ? d : undefined;
}

function AgentResultBody({ raw, schema }: { raw: string; schema?: Record<string, unknown> | null }) {
  const { t } = useTranslation();
  const split = splitLongStringFields(raw);
  if (split) {
    return (
      <div style={{
        maxHeight: 420, overflowY: "auto",
        border: "1px solid #e5e7eb", borderRadius: 4, padding: "8px 12px",
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        {split.long.map(([key, text]) => {
          const desc = fieldDescription(schema, key);
          return (
          <div key={key}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", letterSpacing: "0.04em", marginBottom: 3 }}>
              {key} <span style={{ fontWeight: 400 }}>· {text.length.toLocaleString()} chars</span>
              {desc && <span style={{ fontWeight: 400, color: "#9ca3af", marginLeft: 8, letterSpacing: 0 }}>{desc}</span>}
            </div>
            <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.7 }} className="markdown-body">
              <ReactMarkdown>{text}</ReactMarkdown>
            </div>
          </div>
          );
        })}
        {Object.keys(split.rest).length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", letterSpacing: "0.04em", marginBottom: 3 }}>
              {t("workflow.resultRestFields", { defaultValue: "其余字段" })}
            </div>
            <CodeBlock mono maxHeight={260}>{JSON.stringify(split.rest, null, 2)}</CodeBlock>
          </div>
        )}
      </div>
    );
  }
  const pretty = tryParseJson(raw);
  if (pretty !== null) return <CodeBlock mono maxHeight={420}>{pretty}</CodeBlock>;
  return (
    <div style={{
      maxHeight: 420, overflowY: "auto", fontSize: 12, color: "#374151",
      border: "1px solid #e5e7eb", borderRadius: 4, padding: "8px 12px", lineHeight: 1.7,
    }} className="markdown-body">
      <ReactMarkdown>{raw}</ReactMarkdown>
    </div>
  );
}

function ResultTab({ agents, sessionId, runId }: { agents: JoinedRunAgent[]; sessionId: string; runId: string }) {
  const { t } = useTranslation();
  // schema 懒加载（proxy 真值）：纯增强 —— 加载中/失败不阻塞结果渲染，
  // 失败显示一行小灰字而不是报错（schema 只提供字段 description 标注）。
  const [schemas, setSchemas] = useState<Record<string, WorkflowAgentSchema> | null>(null);
  const [schemaError, setSchemaError] = useState(false);
  React.useEffect(() => {
    let cancelled = false;
    apiV2.workflowSchemas(sessionId, runId)
      .then((r) => { if (!cancelled) setSchemas(r.schemas); })
      .catch(() => { if (!cancelled) setSchemaError(true); });
    return () => { cancelled = true; };
  }, [sessionId, runId]);

  const withResult = agents.filter((a) => a.transcript?.result);
  if (withResult.length === 0) {
    return (
      <div style={{ padding: "14px 4px", fontSize: 12, color: "#9ca3af" }}>
        {t("workflow.resultEmpty", { defaultValue: "journal 中没有任何 agent 的 result 记录。" })}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {schemaError && (
        <div style={{ fontSize: 10, color: "#9ca3af" }}>
          {t("workflow.schemaLoadFailed", { defaultValue: "schema 加载失败（字段标注不可用，结果内容不受影响）" })}
        </div>
      )}
      {withResult.map(({ progress: pa, transcript }) => (
        <div key={pa.agentFileId}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "#111827", marginBottom: 4 }}>
            {pa.label} <span style={{ fontWeight: 400, color: "#9ca3af" }}>· {pa.phaseTitle}</span>
          </div>
          <AgentResultBody raw={transcript!.result!} schema={schemas?.[pa.agentId]?.schema} />
        </div>
      ))}
      {agents.some((a) => !a.transcript?.result) && (
        <div style={{ fontSize: 10, color: "#9ca3af" }}>
          {t("workflow.resultMissing", { defaultValue: "无 result 记录的 agent：" })}
          {agents.filter((a) => !a.transcript?.result).map((a) => a.progress.label).join(", ")}
        </div>
      )}
    </div>
  );
}

// 数据流 tab：F（agent→agent，逐字节包含的确定性验证）+ G（结果回流主线，
// exact/field 两级置信）。空态文案明确"未确认 ≠ 无数据流"——脚本加工过 result
// （slice/摘要）就无法用包含法确认，不猜。
function DataflowTab({ sessionId, runId, drilldown, onJumpToCall }: {
  sessionId: string;
  runId: string;
  drilldown: SessionDrilldown;
  onJumpToCall: (turnId: number, callId: number) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ok"; data: WorkflowDataflowResponse }
    | { phase: "error"; message: string }
  >({ phase: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    apiV2.workflowDataflow(sessionId, runId)
      .then((data) => { if (!cancelled) setState({ phase: "ok", data }); })
      .catch((e: Error) => { if (!cancelled) setState({ phase: "error", message: e.message }); });
    return () => { cancelled = true; };
  }, [sessionId, runId]);

  // 主线行号 → (turn, call) 反查：intervalEvents 的 lineIdx 与端点同口径
  // （0-based 文件行号）。找不到（leadingEvents 等盲区）→ 显示行号无跳链。
  const resolveMainLine = (lineIdx: number): { turnId: number; callId: number } | null => {
    for (const turn of drilldown.turns) {
      for (const call of turn.calls) {
        if (call.intervalEvents.some((ev) => ev.lineIdx === lineIdx)) {
          return { turnId: turn.id, callId: call.id };
        }
      }
    }
    return null;
  };

  if (state.phase === "loading") {
    return <div style={{ padding: "14px 4px", fontSize: 12, color: "#9ca3af" }}>{t("workflow.dataflowLoading", { defaultValue: "计算数据流…" })}</div>;
  }
  if (state.phase === "error") {
    return <div style={{ padding: "14px 4px", fontSize: 12, color: "#dc2626" }}>{t("workflow.dataflowError", { defaultValue: "数据流计算失败：" })}{state.message}</div>;
  }
  const { edges, mainline } = state.data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", letterSpacing: "0.05em", marginBottom: 4 }}>
          {t("workflow.dataflowEdges", { defaultValue: "AGENT 间数据流（逐字节确认）" })}
        </div>
        {edges.length === 0 ? (
          <div style={{ fontSize: 11, color: "#9ca3af" }}>
            {t("workflow.dataflowNoEdges", { defaultValue: "无逐字节确认的数据流。注意：脚本若对上游 result 做过加工（截取/摘要/重组），包含检查不命中——未确认不等于无数据流。" })}
          </div>
        ) : edges.map((e) => (
          <div key={`${e.fromAgentId}-${e.toAgentId}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", fontSize: 11 }}>
            <span style={{ fontWeight: 700, color: "#111827" }}>{e.fromLabel}</span>
            <span style={{ color: "#9ca3af" }}>──({fmtK(e.matchedChars)} chars)──→</span>
            <span style={{ fontWeight: 700, color: "#111827" }}>{e.toLabel}</span>
            <span style={{ fontSize: 9, color: "#9ca3af" }}>
              {t("workflow.dataflowVerbatim", { defaultValue: "result 全文逐字节出现在下游 prompt" })}
            </span>
          </div>
        ))}
      </div>
      <div>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", letterSpacing: "0.05em", marginBottom: 4 }}>
          {t("workflow.dataflowMainline", { defaultValue: "结果回流主线" })}
        </div>
        {mainline.length === 0 ? (
          <div style={{ fontSize: 11, color: "#9ca3af" }}>
            {t("workflow.dataflowNoMainline", { defaultValue: "未确认任何 result 回流主线（主 agent 可能未读取，或读取时经 jq/head 加工后无法全文/字段级匹配）。" })}
          </div>
        ) : mainline.map((m) => {
          const anchor = resolveMainLine(m.lineIdx);
          return (
            <div key={m.agentId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", fontSize: 11 }}>
              <span style={{ fontWeight: 700, color: "#111827" }}>{m.label}</span>
              <Chip bg={m.confidence === "exact" ? "#f0fdf4" : "#fffbeb"} fg={m.confidence === "exact" ? "#16a34a" : "#b45309"}
                title={m.confidence === "exact"
                  ? t("workflow.mainlineExactTooltip", { defaultValue: "result 全文出现在主线 tool_result" })
                  : t("workflow.mainlineFieldTooltip", { defaultValue: "对象 result 的某顶层字段全文出现（jq 提取等场景）" })}>
                {m.confidence === "exact"
                  ? t("workflow.mainlineExact", { defaultValue: "全文" })
                  : `${t("workflow.mainlineField", { defaultValue: "字段" })} ${m.matchedField}`}
              </Chip>
              {anchor ? (
                <button
                  onClick={() => onJumpToCall(anchor.turnId, anchor.callId)}
                  className="hover:bg-indigo-100 transition-colors"
                  style={{ fontSize: 10, color: BRAND.indigo600, background: "#eef2ff", border: `1px solid ${BRAND.indigo200}`, borderRadius: 4, padding: "1px 7px", cursor: "pointer" }}
                >
                  → {t("sessionOverview.turn.label")} {anchor.turnId} · {t("terms.callLabel")} {anchor.callId}
                </button>
              ) : (
                <span style={{ fontSize: 10, color: "#9ca3af" }}>jsonl #{m.lineIdx}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 小件 ─────────────────────────────────────────────────────────────────────

function RunStatusChip({ status, error }: { status: string; error?: string }) {
  const ok = status === "completed";
  return (
    <Chip bg={ok ? "#f0fdf4" : "#fef2f2"} fg={ok ? "#16a34a" : "#dc2626"} title={error}>
      {status}
    </Chip>
  );
}

function Chip({ bg, fg, title, children }: { bg: string; fg: string; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} style={{
      fontSize: 10, fontWeight: 700, color: fg, background: bg,
      borderRadius: 4, padding: "2px 7px", whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

/** JSON 字符串 → 美化文本；不是合法 JSON 返回 null（调用方走 markdown/原文路径）。 */
function tryParseJson(raw: string): string | null {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return null;
  }
}

function tryPrettyJson(raw: string): string {
  return tryParseJson(raw) ?? raw;
}
