// IntervalEventRow —— 两次 call 之间的 JSONL 事件行（tool_result + command /
// system / attachment / skill_injection / ai-title 等非 tool_use 事件）。
//
// 层级感：tool_result 的 per-tool 特化（目前只有 Workflow 的 launch-ack）由
// tool-adapters 的 renderToolResult 产出（覆盖 preview + 一个附加渲染）；其余
// 事件类型（command / skill_injection / …）的特化仍在本组件内（它们不是
// tool_use/tool_result 家族）。

import { useTranslation } from "react-i18next";
import type { IntervalEvent, ToolCallSlot } from "../../../drilldown-types";
import { toolUseIdsFromIntervalEvent, tryParseJson } from "../../../lib/format";
import { KIND_LABEL, KIND_COLOR, RAW_ONLY_KINDS } from "../../../lib/palettes";
import { EventUnitCard } from "../../../shared/EventUnitCard";
import { useAttributionGraph } from "../../../attribution-graph-context";
import { useSessionDetail } from "../../SessionDetailContext";
import { parseCommandEnvelope } from "../command-envelope";
import { renderToolResult } from "../tool-adapters";

export function IntervalEventRow({
  ev, activeToolUseId, onHoverToolUse, suppressPendingState = false, producingCallId, toolCall,
}: {
  ev: IntervalEvent;
  producingCallId?: number;
  activeToolUseId: string | null;
  onHoverToolUse: (id: string | null) => void;
  suppressPendingState?: boolean;
  toolCall?: ToolCallSlot;
}) {
  const { t } = useTranslation();
  const { navigate, turns: mainTurns } = useSessionDetail();
  const col = KIND_COLOR[ev.kind] || { bg: "#f8fafc", border: "#e2e8f0", fg: "#64748b" };
  const linkedToolUseIds = toolUseIdsFromIntervalEvent(ev);
  const linked = activeToolUseId != null && linkedToolUseIds.includes(activeToolUseId);
  const hoverLinkedId = linkedToolUseIds[0] ?? null;
  // tool_result events get the i18n-aware Agent-execution-result label;
  // other kinds keep their static KIND_LABEL string.
  const kindLabel = ev.kind === "user:tool_result"
    ? t("terms.toolResultLabel")
    : t(`eventKinds.${ev.kind.replace(/[:-]/g, "_")}`, { defaultValue: KIND_LABEL[ev.kind] || ev.kind });
  // 详尽解读 hover：非 context 元数据事件（ai-title / permission-mode / …）在 locale
  // 的 eventKindDesc.<kind> 里有详细描述（是什么/何时出现/为何不进上下文）。其它 kind
  // 无描述则 defaultValue "" → 不显示 tooltip。
  const kindTooltip = t(`eventKindDesc.${ev.kind.replace(/[:-]/g, "_")}`, { defaultValue: "" }) || undefined;
  // tool_result is the *output* fed back to the LLM; other kinds don't fit
  // input/output framing — leave bare bytes (direction undefined).
  // user:command/system:local_command 由后段 commandFormat 覆盖出明确方向。
  const baseDirection: "in" | "out" | undefined = ev.kind === "user:tool_result" ? "out" : undefined;

  // ── Workflow launch-ack 特化（tool-adapter，只读 ev.rawJson.toolUseResult） ──
  // 命中时覆盖 preview，并在卡片下方挂跳转 chips（run 面板 / 回执 → Turn N）。
  const wfResult = renderToolResult(ev, { t, navigate, mainTurns });

  // ── Skill-related 特化渲染 ───────────────────────────────────────────────
  // 三种 case 的识别依据全部是 cli.js 写入的确定性字段：
  //   (a) user:tool_result + contentPreview 命中 "Launching skill: ..." → inline 加载中
  //   (b) user:tool_result + contentPreview 命中 `Skill "..." completed (forked execution)` → forked
  //   (c) user:skill_injection（parser 在 isMeta && sourceToolUseID 时打的 kind）→ SKILL.md 注入
  const skillFormat: { preview: string; segmentContent: string; segmentLabel: string; defaultExpanded: boolean; footnote?: string } | null = (() => {
    if (ev.kind === "user:tool_result") {
      // (a) Launching skill: {name}
      const launchMatch = /^Launching skill:\s*(.+?)\s*$/m.exec(ev.contentPreview);
      if (launchMatch) {
        const skill = ev.skillName ?? launchMatch[1];
        return {
          preview: t("skillInvocation.launching", { skill }),
          segmentContent: ev.contentPreview,
          segmentLabel: "",
          defaultExpanded: true, // 单行短文本，默认就显示
        };
      }
      // (b) Skill "name" completed (forked execution).\n\nResult:\n...
      const forkedMatch = /^Skill "([^"]+)" completed \(forked execution\)\./.exec(ev.contentPreview);
      if (forkedMatch) {
        const skill = ev.skillName ?? forkedMatch[1];
        const size = ev.contentSize >= 1000 ? `${(ev.contentSize / 1000).toFixed(1)}k` : `${ev.contentSize}b`;
        return {
          preview: t("skillInvocation.forkedExecuted", { skill, size }),
          segmentContent: ev.contentPreview,
          segmentLabel: "Result",
          defaultExpanded: false,
          footnote: t("skillInvocation.forkedTodoLink"),
        };
      }
    }
    if (ev.kind === "user:skill_injection") {
      const skill = ev.skillName ?? "(unknown)";
      // contentPreview 被 parser 强制截到 300 字符，但 SKILL.md 通常 5KB 量级 ——
      // 从 rawJson（携带完整 jsonl 行 JSON）里提取 message.content 的 text 块拼出
      // 全量正文。零后端改动，rawJson 本来就传到前端了。
      let fullText = ev.contentPreview;
      try {
        const obj = JSON.parse(ev.rawJson) as { message?: { content?: unknown } };
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          const parts: string[] = [];
          for (const blk of content as Array<{ type?: string; text?: string }>) {
            if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
          }
          if (parts.length > 0) fullText = parts.join("\n\n");
        } else if (typeof content === "string") {
          fullText = content;
        }
      } catch { /* fall back to truncated preview */ }
      return {
        preview: t("skillInvocation.activatedSkill", { skill }),
        segmentContent: fullText,
        segmentLabel: t("skillInvocation.viewSkillMd"),
        defaultExpanded: false, // 默认折叠
      };
    }
    return null;
  })();

  // ── Command envelope parsing ──────────────────────────────────────────
  // user:command / system:local_command 在 jsonl 里是 cli.js 写死的 XML 信封。
  // 直接展示原始 XML 既丑又掩盖结构 —— parse 后用对话式排版渲染。失败回退原 preview。
  const commandFormat = parseCommandEnvelope(ev, t);
  const direction: "in" | "out" | undefined = commandFormat?.direction ?? baseDirection;
  // commandFormat 命中时让头部 kindLabel 直接说明角色（命令 vs 命令输出）。
  const effectiveKindLabel = commandFormat?.kindLabelOverride ?? kindLabel;

  // ── Reverse-attribution lookup ────────────────────────────────────────
  const { getEventAnnotation, onJumpToCall, onOpenSideCall, highlightedLineIdx } = useAttributionGraph();
  const annotation = getEventAnnotation(ev.lineIdx);
  const isFlashing = highlightedLineIdx === ev.lineIdx;
  // 抑制 pending：调用方说明"集体未消费"已由块级文案覆盖，行内重复反而干扰。
  const impact = annotation && !(suppressPendingState && annotation.contextImpact === "pending") ? {
    state: annotation.contextImpact,
    firstSeenInCall: annotation.firstSeenInCall,
    consumedByCallIds: annotation.consumedByCallIds,
    firstSeenIsAfterAuditGap: annotation.firstSeenIsAfterAuditGap,
  } : undefined;
  // All event kinds (including tool_result) forward-jump to the first call
  // that consumed this jsonl line — opens the Attribution tab and auto-selects
  // the matching leaf so the user can see exactly where in the request it landed.
  const consumerJumpTarget = annotation?.firstSeenInCall ?? null;
  const handleJump = onJumpToCall && consumerJumpTarget != null
    ? () => onJumpToCall(consumerJumpTarget, "request", { lineIdx: ev.lineIdx })
    : undefined;
  const jumpLabel = consumerJumpTarget != null
    ? t("terms.firstInjectedAtCall", { callId: consumerJumpTarget })
    : undefined;
  const jumpTooltip = consumerJumpTarget != null
    ? t("terms.openAttributionAtLine", { callId: consumerJumpTarget })
    : undefined;

  // ── 非 context 事件 → 生成它的后台 proxy 请求 ────────────────────────────
  const linkedProxyId = ev.generatedByProxyRequestId;

  const inputSegment = (() => {
    if (!toolCall || !toolCall.inputPreview) return null;
    const parsedInput = (() => {
      try { return JSON.parse(toolCall.inputPreview); } catch { return undefined; }
    })();
    if (parsedInput && typeof parsedInput === "object") {
      if (toolCall.name === "Bash" && typeof parsedInput.command === "string") {
        return {
          label: "INPUT",
          content: parsedInput.command,
          monospace: true,
          rawJson: parsedInput,
        };
      }
      const strippedInput = { ...parsedInput } as Record<string, unknown>;
      delete strippedInput.description;
      return {
        label: "INPUT",
        content: Object.keys(strippedInput).length > 0
          ? JSON.stringify(strippedInput, null, 2)
          : "",
        monospace: true,
        rawJson: parsedInput,
      };
    }
    return {
      label: "INPUT",
      content: toolCall.inputPreview,
      monospace: true,
      truncateAt: 600,
    };
  })();

  return (
    <div
      data-jsonl-line={ev.lineIdx}
      style={{
        marginBottom: 2,
        // Flash outline driven by AttributionGraphContext.flashEvent —
        // lights up for ~2s when a reverse-jump (Call leaf → Turn view)
        // targets this row's jsonl line.
        boxShadow: isFlashing ? "0 0 0 3px rgba(245,158,11,0.45)" : "none",
        transition: "box-shadow 350ms ease",
      }}
    >
      <EventUnitCard
        borderless={true}
        color={col.fg}
        bg={col.bg}
        border={col.border}
        kindLabel={effectiveKindLabel}
        kindTooltip={kindTooltip}
        size={ev.contentSize > 0 ? { bytes: ev.contentSize, direction } : undefined}
        timestamp={ev.timestamp}
        preview={wfResult?.preview ?? skillFormat?.preview ?? commandFormat?.preview ?? (ev.contentPreview ? ev.contentPreview.replace(/[\r\n\t]+/g, " ").slice(0, 120) : "")}
        defaultExpanded={skillFormat ? skillFormat.defaultExpanded : undefined}
        segments={[
          ...(inputSegment ? [inputSegment] : []),
          {
            label: skillFormat
              ? skillFormat.segmentLabel
              : commandFormat
                ? commandFormat.segmentLabel
                : (direction === "out" ? "OUTPUT" : "CONTENT"),
            content: skillFormat
              ? skillFormat.segmentContent
              : commandFormat
                ? commandFormat.segmentContent
                : (ev.contentPreview && ev.contentPreview.length > 0 ? ev.contentPreview : ev.rawJson),
            // skill_injection 的 SKILL.md 通常 5-10KB —— 给一个足够大的阈值。
            monospace: true,
            truncateAt: skillFormat ? 20000 : 1000,
            // Whole-jsonl-line raw view — collapsible tree of the parsed line object.
            rawJson: tryParseJson(ev.rawJson),
            rawOnly: RAW_ONLY_KINDS.has(ev.kind),
          },
        ]}
        coordinate={{ kind: "jsonl", line: ev.lineIdx + 1 }}
        impact={impact}
        active={linked}
        onMouseEnter={() => { if (hoverLinkedId) onHoverToolUse(hoverLinkedId); }}
        onMouseLeave={() => { if (hoverLinkedId) onHoverToolUse(null); }}
        onJump={handleJump}
        jumpLabel={jumpLabel}
        jumpTooltip={jumpTooltip}
        // 非 context 事件 → 生成它的后台 proxy 请求：走 provenanceJump（header chip）。
        provenanceJump={linkedProxyId != null && onOpenSideCall ? {
          label: t("terms.viewSideCallDetail", { defaultValue: "查看详情" }),
          tooltip: t("terms.sideCallGeneratedBy", { proxyId: linkedProxyId, defaultValue: `打开生成它的后台请求（proxy#${linkedProxyId}）` }),
          onClick: () => onOpenSideCall(linkedProxyId),
        } : undefined}
      />
      {/* Workflow launch-ack 的跳转 chips（run 面板 / 回执 → Turn N），仅 workflow
          tool_result 命中时出现。 */}
      {wfResult?.attachment}
      {/* forked 模式 footnote: "跳转 sub-agent：TODO" 占位文字（最简实现，无跳转） */}
      {skillFormat?.footnote && (
        <div style={{
          marginTop: 2,
          marginLeft: 18,
          fontSize: 10,
          fontStyle: "italic",
          color: "#92400e",
        }}>
          {skillFormat.footnote}
        </div>
      )}
    </div>
  );
}
