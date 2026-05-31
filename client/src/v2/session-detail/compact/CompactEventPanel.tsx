// Compact 事件相关的视图：把 `/compact` 系统级事件 / inter-turn block 渲染成
// 跟 Turn 详情面板风格一致的样子，但用橙 / 紫色板区分语义。
//
// 包含：
//   - `synthesizeCompactTurn`：把 CompactEvent 包装成 UserTurn-shape，让
//     UserTurnDetailPanel 可以"完全复用"渲染 Compact 详情（只用于 caller 那边的
//     prop 类型对齐）。当前已不再被直接消费，但保留以防 UserTurnDetailPanel
//     重新接管 Compact 渲染。
//   - `CompactEventPanel`：主视图（jsonl + summarization LLM call 四步事件序列）
//   - `CompactEventRow`：复用的单行 chip + monospace 文本
//   - `InterTurnBlockDetail` / `InterTurnBlockPanel`：跨 turn 之间的 system block
//
// 抽取自 SessionDetailV2.tsx 文件末，未改逻辑。

import React from "react";
import { useTranslation } from "react-i18next";
import type { CompactEvent, InterTurnBlock, IntervalEvent, LlmCall, UserTurn } from "../../drilldown-types";
import { BRAND } from "../../shared/brand";
import { CommandGroupCard } from "../turn/CommandGroupCard";

// ─── synthesizeCompactTurn —— 把 CompactEvent 包装成 UserTurn-shape 数据 ──────
// 让 UserTurnDetailPanel 可以"完全复用"渲染 Compact 详情。映射要点：
//
//   UserTurn.userInput          ← `/compact [args]` 或 `/compact`
//   UserTurn.userInputLineIdx   ← ev.commandLineIdx（用户敲命令那一行）
//   UserTurn.finalOutput        ← ev.summaryText（注入到下次推理 prompt 的 summary 文本）
//   UserTurn.calls              ← 1 个合成 LlmCall，承载 summarization LLM call 的数据
//                                  来源是 proxy_requests 富化；jsonl 端无 assistant 事件
//   call.intervalEvents         ← jsonl 端 3 条相关事件（boundary / summary / 可选 command）
//                                  按行号排序，让 IntervalEventRow 顺序渲染
//
// 标志位 hasCompaction=true 保证 risk badge 显示 "compaction"。
// turn.id 用极小负数避开和真实 turn 撞 key（左 rail 不用这个 turn 渲染，但下游
// flatMap(t => t.calls) 会扫描所有 turns —— 我们没把合成 turn 加入 turns 数组，
// 只是直接喂给 UserTurnDetailPanel，所以撞 key 实际上不会发生）。
export function synthesizeCompactTurn(ev: CompactEvent): UserTurn {
  // call id 只需"不和真实 call id 撞"——真实 call id 始终 ≥ 1，任何负数都安全。
  // 旧值 -(index+1)*1000 是过度防御，会被 call card 标题直接 print 成 "-1000"
  // 这种 sentinel 字样泄漏。改成 -(index+1)：依旧唯一，UI 侧再用
  // isCompaction && id<0 的判定把数字替换为 "压缩调用"。
  const synthCallId = -(ev.index + 1);
  // intervalEvents：boundary / summary 必有，command 可选。按 lineIdx 升序排。
  const ies: IntervalEvent[] = [];
  if (ev.commandLineIdx !== null) {
    ies.push({
      kind: "user:command",
      lineIdx: ev.commandLineIdx,
      timestamp: ev.timestamp,
      contentPreview: ev.userInstructions
        ? `/compact ${ev.userInstructions}`
        : "/compact",
      contentSize: (ev.userInstructions?.length ?? 0) + "/compact".length + 1,
      rawJson: JSON.stringify({ type: "user", commandName: "/compact", commandArgs: ev.userInstructions ?? "" }),
    });
  }
  ies.push({
    kind: "system:compact_boundary",
    lineIdx: ev.boundaryLineIdx,
    timestamp: ev.timestamp,
    contentPreview: `compact_boundary · trigger=${ev.trigger} · ${ev.preTokens}→${ev.postTokens} tokens · ${ev.durationMs}ms`,
    contentSize: 0,
    rawJson: JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      uuid: ev.boundaryUuid,
      compactMetadata: {
        trigger: ev.trigger,
        preTokens: ev.preTokens,
        postTokens: ev.postTokens,
        durationMs: ev.durationMs,
      },
    }),
  });
  if (ev.summaryLineIdx !== null && ev.summaryText !== null) {
    ies.push({
      kind: "user:compact_summary",
      lineIdx: ev.summaryLineIdx,
      timestamp: ev.timestamp,
      contentPreview: ev.summaryText,
      contentSize: ev.summaryText.length,
      rawJson: JSON.stringify({
        type: "user",
        isCompactSummary: true,
        uuid: ev.summaryUuid,
        message: { role: "user", content: ev.summaryText },
      }),
    });
  }
  ies.sort((a, b) => a.lineIdx - b.lineIdx);

  // 合成 LlmCall：来源 = proxy 富化。proxy 缺失时降级为零值。
  const proxyData = ev.proxy ? {
    requestId: ev.proxy.proxyRequestId,
    reqMessageCount: null,
    reqHasTools: null,
    resInputTokens: ev.proxy.inputTokens,
    resOutputTokens: ev.proxy.outputTokens,
    resCacheCreation: 0,
    resCacheRead: ev.proxy.cacheReadTokens,
    resStopReason: "end_turn",
    errorClass: null,
    durationMs: ev.proxy.durationMs,
  } : null;

  const syntheticCall: LlmCall = {
    id: synthCallId,
    indexInTurn: 1,
    messageId: null,
    apiRequestId: ev.proxy?.requestId ?? null,
    jsonlLineIdx: null,
    jsonlFrameLineIdxs: [],
    contextSize: ev.preTokens,
    outputTokens: ev.proxy?.outputTokens ?? 0,
    cacheRead: ev.proxy?.cacheReadTokens ?? 0,
    cacheWrite: 0,
    timestamp: ev.proxy?.startedAt ?? ev.timestamp,
    model: ev.proxy?.model ?? "",
    stopReason: "end_turn",
    isCompaction: true,
    isUnknownHeavy: false,
    freshIn: ev.proxy?.inputTokens ?? 0,
    isSignificant: true,
    significantDelta: ev.postTokens - ev.preTokens,
    proxy: proxyData,
    proxyMatchMode: ev.proxy ? "exact" : "unmatched",
    subAgents: [],
    incomingDiff: [],
    toolNames: [],
    toolCalls: [],
    assistantText: ev.summaryText?.slice(0, 500) ?? "",
    intervalEvents: ies,
  };

  return {
    id: -(ev.index + 1),    // 负 id，避开真实 turn；UI 侧翻译成 "压缩 N"
    // 只有用户真的敲过 `/compact` 命令时才填 userInput——auto-compact 没有
    // 用户输入事件，commandLineIdx 也为 null。空串触发 ChainNarrativeNode
    // 的 `!text.trim()` 早退，顶部就不会硬塞一条虚假的"用户输入: /compact"。
    // 命令 interval event 已经在上面的 `if (ev.commandLineIdx !== null)`
    // 分支同步控制——真实存在才入栈，所以这两处自然对齐。
    userInput: ev.commandLineIdx !== null
      ? (ev.userInstructions ? `/compact ${ev.userInstructions}` : "/compact")
      : "",
    userInputLineIdx: ev.commandLineIdx,
    finalOutput: ev.summaryText,
    midTurnInjections: [],
    leadingEvents: [],
    startedAt: ev.timestamp,
    endedAt: ev.timestamp,
    durationMs: ev.durationMs,
    llmCallCount: 1,
    toolCallCount: 0,
    netContextDelta: ev.postTokens - ev.preTokens,
    peakContext: ev.preTokens,
    cacheRead: ev.proxy?.cacheReadTokens ?? 0,
    cacheWrite: 0,
    unknownDelta: 0,
    hasCompaction: true,
    hasUnknownSpike: false,
    errorCount: 0,
    calls: [syntheticCall],
  };
}

// ─── CompactEventPanel —— /compact 详情面板 ───────────────────────────────────
// 风格上类 InterTurnBlockPanel：header 统计块 + body 顺序事件行。
// 数据来源严格基于 CompactEvent 的三源（boundary / summary / command / proxy），
// 不读 jsonl 原始文件 —— parser 已经把所有必需信息序列化进 CompactEvent。
//
// 内容分四个"逻辑事件"按时间顺序展示：
//   1. /compact command  ← jsonl 的 user.<command-name>/compact</command-name> 行
//                          带 userInstructions（如果用户指定了 args）
//   2. boundary marker   ← jsonl 的 system.compact_boundary 行，含 metadata
//   3. summarization LLM call  ← proxy_requests 富化（model / tokens / duration）
//                                jsonl 端无对应 assistant 事件，但调用真实发生过
//   4. summary injection ← jsonl 的 user.isCompactSummary=true 行
//                          这是 post-compact 第一次推理 prompt 里的 user message
//
// 复用 InterTurnBlockDetail 的"kindLabel + monospace row"行风格，但不直接调用
// InterTurnBlockDetail —— 后者吃的是 IntervalEvent[]，CompactEvent 不在那个数据通路里。
export function CompactEventPanel({ ev }: { ev: CompactEvent }) {
  const { t } = useTranslation();
  const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
  const ratioPct = ev.preTokens > 0
    ? Math.max(0, Math.round((1 - ev.postTokens / ev.preTokens) * 100))
    : 0;
  const triggerLabel = ev.trigger === "manual" ? "manual"
                      : ev.trigger === "auto"   ? "auto"
                      : ev.trigger === "micro"  ? "micro"
                      : ev.trigger;
  const belongingLabel = ev.belonging.kind === "between-turns"
    ? `T${ev.belonging.afterTurnId} → T${ev.belonging.beforeTurnId}`
    : ev.belonging.kind === "post-session"
      ? `T${ev.belonging.afterTurnId} → session end`
      : ev.belonging.kind === "pre-session"
        ? `session start → T${ev.belonging.beforeTurnId}`
        : `(other)`;
  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid #f3f4f6" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#c2410c" }}>
            🗜 Compact
          </span>
          <span style={{ fontSize: 10, color: "#9a3412", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>
            {triggerLabel}
          </span>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>· system-level maintenance event ·</span>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>{belongingLabel}</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { label: "Pre→Post", value: `${fmtTokens(ev.preTokens)} → ${fmtTokens(ev.postTokens)}` },
            { label: "Ratio", value: `-${ratioPct}%`, color: ratioPct >= 80 ? "#16a34a" : "#c2410c" },
            { label: "Duration", value: `${(ev.durationMs / 1000).toFixed(1)}s` },
            ...(ev.proxy ? [
              { label: "Model", value: ev.proxy.model || "—" },
              { label: "Out tokens", value: fmtTokens(ev.proxy.outputTokens) },
              { label: "Cache read", value: fmtTokens(ev.proxy.cacheReadTokens) },
            ] : [{ label: "Proxy", value: "unmatched", color: "#94a3b8" }]),
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              padding: "5px 10px", background: "#fff7ed", borderRadius: 6,
              border: "1px solid #fed7aa", minWidth: 64,
            }}>
              <span style={{ fontSize: 9, color: "#9ca3af", marginBottom: 2 }}>{label}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: color ?? "#c2410c" }}>{value}</span>
            </div>
          ))}
        </div>
        {ev.userInstructions && (
          <div style={{ marginTop: 12, padding: "8px 12px", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 6 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: "#92400e", letterSpacing: "0.08em", marginBottom: 4 }}>
              {t("compactEvent.userInstructions")}
            </div>
            <div style={{ fontSize: 12, color: "#78350f", fontFamily: "monospace", wordBreak: "break-word" }}>
              {ev.userInstructions}
            </div>
          </div>
        )}
      </div>

      {/* Event sequence —— jsonl 顺序 + LLM call 在 boundary 前 */}
      <div style={{ border: "1px solid #fed7aa", borderRadius: 8, background: "#fff7ed", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #fed7aa", background: "#ffedd5" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#c2410c" }}>Event sequence</span>
          <span style={{ fontSize: 10, color: "#fb923c" }}>·</span>
          <span style={{ fontSize: 10, color: "#fb923c", fontStyle: "italic" }}>
            jsonl events + the (jsonl-invisible) summarization LLM call
          </span>
        </div>

        <div style={{ padding: "8px 12px" }}>
          {/* 1. /compact command (可选) */}
          {ev.commandLineIdx !== null && (
            <CompactEventRow
              tag="cmd"
              lineRef={`L${ev.commandLineIdx + 1}`}
              text={ev.userInstructions
                ? `/compact ${ev.userInstructions}`
                : "/compact"}
              note="user typed slash command"
            />
          )}

          {/* 2. boundary marker */}
          <CompactEventRow
            tag="bound"
            lineRef={`L${ev.boundaryLineIdx + 1}`}
            text={`compact_boundary · trigger=${ev.trigger} · ${fmtTokens(ev.preTokens)} → ${fmtTokens(ev.postTokens)} · ${(ev.durationMs / 1000).toFixed(1)}s`}
            note={`uuid=${ev.boundaryUuid.slice(0, 8)}…`}
          />

          {/* 3. summarization LLM call —— jsonl 端没有对应 assistant 事件，
              这一行的数据全部来自 proxy_requests 富化。这是 UI 上的"幽灵 call"，
              显式标出"proxy-only"避免用户以为它该出现在 turn 的 call 列表里。 */}
          {ev.proxy ? (
            <CompactEventRow
              tag="llm"
              lineRef={`proxy#${ev.proxy.proxyRequestId}`}
              text={`${ev.proxy.model} · in=${fmtTokens(ev.proxy.inputTokens)} cache=${fmtTokens(ev.proxy.cacheReadTokens)} out=${fmtTokens(ev.proxy.outputTokens)} · ${(ev.proxy.durationMs / 1000).toFixed(1)}s`}
              note="summarization call · not in jsonl"
            />
          ) : (
            <CompactEventRow
              tag="llm"
              lineRef="—"
              text="summarization LLM call (not matched in proxy_requests)"
              note="jsonl never records this call as an assistant event"
              muted
            />
          )}

          {/* 4. injected summary —— L22, isCompactSummary=true */}
          {ev.summaryLineIdx !== null && ev.summaryText && (
            <CompactEventRow
              tag="summary"
              lineRef={`L${ev.summaryLineIdx + 1}`}
              text={ev.summaryText}
              note={`isCompactSummary · injected into next call's prompt · ${ev.summaryText.length}b`}
              monospaceBlock
            />
          )}
        </div>
      </div>
    </div>
  );
}

// 单行渲染，复用 InterTurnBlockDetail 的 "kindLabel chip + monospace text" 风格，
// 但 chip 用橙色色板与 InterTurn 紫色区分。
function CompactEventRow({
  tag, lineRef, text, note, muted, monospaceBlock,
}: {
  tag: string;
  lineRef: string;
  text: string;
  note?: string;
  muted?: boolean;
  monospaceBlock?: boolean;
}) {
  return (
    <div style={{ padding: "6px 0", borderBottom: "1px solid #ffedd5", display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{
        fontSize: 9, fontWeight: 700, color: muted ? "#94a3b8" : "#c2410c",
        background: muted ? "#f1f5f9" : "#ffedd5", borderRadius: 3, padding: "1px 5px",
        flexShrink: 0, marginTop: 2, minWidth: 42, textAlign: "center",
      }}>
        {tag}
      </span>
      <span style={{
        fontSize: 9, fontWeight: 600, color: "#9ca3af",
        flexShrink: 0, marginTop: 3, minWidth: 56, textAlign: "left", fontFamily: "monospace",
      }}>
        {lineRef}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {monospaceBlock ? (
          <pre style={{
            margin: 0, fontSize: 11, color: muted ? "#94a3b8" : "#374151",
            fontFamily: "monospace", lineHeight: 1.45, whiteSpace: "pre-wrap",
            wordBreak: "break-word", maxHeight: 360, overflowY: "auto",
            padding: "6px 8px", background: "#fff", border: "1px solid #fed7aa", borderRadius: 4,
          }}>
            {text}
          </pre>
        ) : (
          <div style={{ fontSize: 11, color: muted ? "#94a3b8" : "#374151", fontFamily: "monospace", wordBreak: "break-all", lineHeight: 1.5 }}>
            {text}
          </div>
        )}
        {note && (
          <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2, fontStyle: "italic" }}>{note}</div>
        )}
      </div>
    </div>
  );
}

// ─── InterTurnBlock detail (shared between inline Turn view and full panel) ───

export function InterTurnBlockDetail({ block }: { block: InterTurnBlock }) {
  const { t } = useTranslation();
  const kindLabel: Record<string, string> = {
    "user:command": "cmd",
    "system:local_command": "sys",
    "user:human": "inject",
    "file-history-snapshot": "snapshot",
  };
  // 命令计数：commandGroup wrapper 即一次完整的命令交互（caveat + 输入 + 输出）。
  // 没被分组的 cmd/sys-cmd 各自单独算一条命令；其余事件归入 "事件"（meta 类）。
  const commandCount = block.events.filter(
    (ev) => ev.commandGroup || ev.kind === "user:command" || ev.kind === "system:local_command",
  ).length;
  const otherCount = block.events.length - commandCount;
  // Trailing block 的"未消费"是集体命运（session 结束所以没有 LLM call 消费），
  // 不是事件本身的反常 —— 抑制行内徽章，由 block-level 文案集中说明。详见 D 任务。
  const suppressPendingPill = !block.enteredContext;
  return (
    <div style={{ border: "1px solid #e9d5ff", borderRadius: 8, background: BRAND.violetGradient50, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #e9d5ff", background: "#f3e8ff" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.violet600 }}>{block.label}</span>
        <span style={{ fontSize: 10, color: BRAND.violet400 }}>·</span>
        <span style={{ fontSize: 10, color: BRAND.violet400 }}>
          {commandCount > 0 && t("compactEvent.commandsCount", { count: commandCount })}
          {commandCount > 0 && otherCount > 0 && " · "}
          {otherCount > 0 && t("compactEvent.eventsCount", { count: otherCount })}
          {commandCount === 0 && otherCount === 0 && t("compactEvent.noEvents")}
        </span>
        {!block.enteredContext && (
          <span
            title={t("compactEvent.compactionPostTooltip")}
            style={{ fontSize: 10, color: "#94a3b8", marginLeft: "auto", fontStyle: "italic", cursor: "help" }}
          >
            {t("compactEvent.compactionPostWarning")}
          </span>
        )}
        {block.enteredContext && (
          <span style={{ fontSize: 10, color: BRAND.violet400, marginLeft: "auto", fontStyle: "italic" }}>entered context in next turn</span>
        )}
      </div>
      <div style={{ padding: "8px 12px" }}>
        {block.events.map((ev, i) => (
          // 命令分组（caveat + command-name + stdout）折叠成单张卡片；逐段反向归因
          // 由 CommandGroupCard 内部按 member.lineIdx 各自查询。InterTurnBlockDetail
          // 渲染在 session detail 里，已处于 AttributionGraph context 内（context 缺
          // 失时 getEventAnnotation 优雅返回 null，per-row chip 不显示，不会报错）。
          ev.commandGroup ? (
            <div key={i} style={{ padding: "4px 0" }}>
              <CommandGroupCard
                ev={ev}
                activeToolUseId={null}
                onHoverToolUse={() => {}}
                suppressPendingState={suppressPendingPill}
              />
            </div>
          ) : (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0", borderBottom: i < block.events.length - 1 ? "1px solid #f3e8ff" : "none" }}>
              <span style={{
                fontSize: 9, fontWeight: 700, color: BRAND.violet400,
                background: BRAND.violet100, borderRadius: 3, padding: "1px 4px",
                flexShrink: 0, marginTop: 2,
              }}>
                {kindLabel[ev.kind] ?? ev.kind.split(":")[1] ?? ev.kind}
              </span>
              <span style={{ fontSize: 11, color: "#374151", wordBreak: "break-all", fontFamily: "monospace", lineHeight: 1.5 }}>
                {ev.contentPreview || <span style={{ color: "#d1d5db" }}>—</span>}
              </span>
            </div>
          )
        ))}
      </div>
    </div>
  );
}

// ─── Full-page inter-turn block panel (shown in main canvas) ─────────────────

export function InterTurnBlockPanel({ block }: { block: InterTurnBlock }) {
  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid #f3f4f6" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.violet600 }}>
            {block.label}
          </span>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>inter-turn commands</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { label: "Events", value: String(block.events.length) },
            { label: "After Turn", value: block.prevTurnId !== null ? `T${block.prevTurnId}` : "session start",
              color: block.prevTurnId === null ? "#9ca3af" : undefined },
            { label: "Before Turn", value: block.nextTurnId !== null ? `T${block.nextTurnId}` : "session end",
              color: block.nextTurnId === null ? "#9ca3af" : undefined },
            { label: "Entered Context", value: block.enteredContext ? "yes" : "no",
              color: block.enteredContext ? "#16a34a" : "#94a3b8" },
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              padding: "5px 10px", background: BRAND.violetGradient50, borderRadius: 6,
              border: "1px solid #e9d5ff", minWidth: 64,
            }}>
              <span style={{ fontSize: 9, color: "#9ca3af", marginBottom: 2 }}>{label}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: color ?? BRAND.violet600 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
      <InterTurnBlockDetail block={block} />
    </div>
  );
}
