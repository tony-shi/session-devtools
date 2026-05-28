// Call-chain 的三个叶子渲染原件，供 JsonlCallChain 组合：
//   - ChainNarrativeNode：叙事节点（user input / assistant text 等）
//   - ToolCallRow：一次 tool_use 调用行
//   - IntervalEventRow：两次 call 之间的非 tool JSONL 事件行
// 互相独立、不引用 JsonlCallChain。抽自 UserTurnDetailPanel.tsx，逻辑零改动。

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import type { IntervalEvent, ToolCallSlot } from "../../drilldown-types";
import { toolUseIdsFromIntervalEvent, tryParseJson } from "../../lib/format";
import { KIND_LABEL, KIND_COLOR, RAW_ONLY_KINDS } from "../../lib/palettes";
import { BRAND } from "../../shared/brand";
import { EventUnitCard, LinkIcon } from "../../shared/EventUnitCard";
import { useAttributionGraph } from "../../attribution-graph-context";

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
        <div style={{ flex: 1, border: `1px solid ${tone.border}`, borderRadius: 8, background: tone.bg, padding: "8px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: tone.fg, letterSpacing: "0.05em", textTransform: "uppercase" }}>{label}</span>
            {meta && <span style={{ fontSize: 10, color: "#94a3b8" }}>{meta}</span>}
            {handleJump && (
              <button
                type="button"
                onClick={handleJump}
                title={`打开 call #${jumpTarget} 的 Request 视图，自动定位这条 user_input 对应的 leaf`}
                className="hover:bg-indigo-700 transition-colors"
                style={{
                  marginLeft: "auto",
                  display: "inline-flex", alignItems: "center", gap: 5,
                  border: "none", background: BRAND.indigo600, color: "#fff",
                  borderRadius: 4, padding: "3px 9px",
                  fontSize: 10, fontWeight: 700, lineHeight: 1.3,
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(79,70,229,0.25)",
                  transition: "background 0.12s",
                  letterSpacing: "0.02em",
                }}
              >
                <LinkIcon />
                {t("terms.firstInjectedAtCall", { callId: jumpTarget })}
              </button>
            )}
          </div>
          <div style={{ fontSize: 12, color: tone.fg, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {shown}
          </div>
          {needsExpand && (
            <button
              onClick={() => setExpanded(v => !v)}
              style={{ marginTop: 5, fontSize: 10, color: tone.fg, background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 700 }}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ToolCallRow: tool_use request carried by the assistant response ───────────
export function ToolCallRow({
  tc, callId, active, onHoverToolUse,
}: {
  tc: ToolCallSlot;
  /** The LLM call that emitted this tool_use — its response is where the
   *  `›` jump opens (the user's mental model: "this Tool Use came back in
   *  call #N's response"). */
  callId: number;
  active: boolean;
  onHoverToolUse: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const { onJumpToCall, highlightedToolUseId } = useAttributionGraph();
  // Amber flash outline when an Attribution-leaf back-link targets this
  // specific tool_use row. Mirrors `IntervalEventRow`'s `isFlashing` /
  // boxShadow pattern. Cleared automatically after ~2s by the context.
  const isFlashing = highlightedToolUseId !== null && highlightedToolUseId === tc.toolUseId;

  // Extract the tool_use's `description` field (the human intent label
  // Claude Code attaches to most tool calls — "List top-level entries",
  // "Read package.json", …). Shown as a subtitle on the card so users
  // can scan intent without parsing the wire JSON. Falls back to other
  // common scalar fields (command / file_path / …) so e.g. Read calls
  // without an explicit description still surface their file_path.
  const description = (() => {
    const raw = tc.inputPreview ?? "";
    if (!raw) return undefined;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (typeof obj.description === "string" && obj.description.trim()) {
        return obj.description.trim();
      }
      for (const key of ["command", "file_path", "pattern", "query", "prompt", "url"]) {
        const v = obj[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    } catch { /* inputPreview may be truncated/non-JSON — no subtitle */ }
    return undefined;
  })();

  // Skill 工具结构化参数：input schema 已被 cli.js 定为 { skill: string, args?: string }
  // （SkillTool.ts:291 zod schema 固定）—— LLM 不能传其他字段，所以解析永远安全。
  // 解析失败时 fallback 到通用 INPUT 渲染（保险，不破坏其他工具）。
  const skillRequest: { preview: string; segments: { label: string; content: string; monospace: boolean }[] } | undefined = (() => {
    if (tc.name !== "Skill") return undefined;
    try {
      const obj = JSON.parse(tc.inputPreview) as { skill?: string; args?: string };
      if (typeof obj.skill !== "string") return undefined;
      const segments: { label: string; content: string; monospace: boolean }[] = [
        {
          label: "",
          content: t("skillInvocation.requestLoad", { skill: obj.skill }),
          monospace: false,
        },
      ];
      if (typeof obj.args === "string" && obj.args.length > 0) {
        segments.push({
          label: "",
          content: t("skillInvocation.argsLabel", { args: obj.args }),
          monospace: false,
        });
      }
      return {
        preview: t("skillInvocation.requestLoad", { skill: obj.skill }),
        segments,
      };
    } catch {
      return undefined;
    }
  })();

  return (
    <div
      data-tool-use-id={tc.toolUseId}
      style={{
        marginBottom: 3,
        borderRadius: 6,
        boxShadow: isFlashing ? "0 0 0 3px rgba(245,158,11,0.45)" : "none",
        transition: "box-shadow 350ms ease",
      }}
    >
      <EventUnitCard
        // dot color is the *event type* (Tool Use = orange), not the tool's
        // individual chip color — tool identity is conveyed by the `title`
        // chip + tool name text. This keeps the type-color visual anchor
        // ("orange = tool_use anywhere in the app") intact across calls.
        color="#f59e0b"
        kindLabel="Tool Use"
        title={tc.name}
        // tool_use 是 LLM 输出的 wire 字段 —— direction 应为 "out"。
        // 不再展示 `toolu_xxx` shortId：那是 Anthropic API 服务端生成的
        // 配对 token，不属于 LLM 语义产出。要看 wire 原物，通过 jump chip
        // 跳到右侧 ResponseTreePanel（那里是 HTTP response 权威 view）。
        size={{ bytes: tc.inputSize, direction: "out" }}
        preview={skillRequest?.preview ?? description}
        description={skillRequest?.preview ?? description}
        segments={
          skillRequest
            // Skill 工具：把 INPUT raw JSON 替换为结构化两行展示
            //   请求加载 SKILL: {skill}
            //   args: {args}    （没有 args 时不显示）
            // 用户的关注点是"请求做什么"，不是 wire JSON 长什么样。
            ? skillRequest.segments
            : tc.inputPreview
              ? [
                  {
                    label: "INPUT", content: tc.inputPreview,
                    monospace: true, truncateAt: 600,
                    // 不在这里提供"原始 JSON" tab —— 左侧是事件流派生 view（来自 parser
                    // 加工后的 ToolCallSlot.inputPreview，已被截到 300 字符）。要看真正
                    // 的原始 wire response，请用 jump chip 跳到右侧 ResponseTreePanel。
                  },
                ]
              : []
        }
        active={active}
        onMouseEnter={() => onHoverToolUse(tc.toolUseId)}
        onMouseLeave={() => onHoverToolUse(null)}
        onJump={onJumpToCall ? () => onJumpToCall(callId, "response", { toolUseId: tc.toolUseId }) : undefined}
        jumpLabel={t("terms.returnedByCall", { callId })}
        jumpTooltip={t("terms.openCallResponseTooltip", { callId })}
      />
      {/* SkillInvocationChip（之前版本）已撤销 —— 改由 IntervalEventRow 在两条
          后续 jsonl 行（user:tool_result 的 "Launching skill: ..." + user:skill_injection
          的 SKILL.md body）上特化渲染，避免把"请求"和"结果"塞到同一张卡片。 */}
    </div>
  );
}

// Kinds where `contentPreview` is just `JSON.stringify(...)` of the same
// payload the JSON tree shows. Rendering a "渲染|原始 JSON" toggle on those
// is misleading — both views would carry the same info, the text one just
// less readable. For `unknown` the preview is the truncated raw JSON itself,
// so the toggle is even more confusing. These rows default to the JSON tree
// view and hide the toggle entirely.

// Parse cli.js command envelopes (固定模板，确定性 schema) into a structured,
// human-readable rendering. Returns null when the kind doesn't match or no
// known tags found — caller falls back to raw preview.
//
// Output shape:
//   - segmentLabel:  body 段标题 ("命令输入" / "命令输出" / "BASH 输入" ...)
//   - segmentContent: 已结构化的可读文本 (XML 标签已剥离)
//   - direction:     "in" = 用户输入；"out" = 命令执行结果
//   - kindLabelOverride: 可选，覆盖头部 kindLabel 让输入/输出在折叠态也能区分
function parseCommandEnvelope(ev: IntervalEvent): {
  segmentLabel: string;
  segmentContent: string;
  direction: "in" | "out";
  kindLabelOverride?: string;
  preview: string;
} | null {
  const raw = ev.contentPreview || "";
  const match = (re: RegExp): string | undefined => {
    const m = raw.match(re);
    return m ? m[1] : undefined;
  };
  if (ev.kind === "user:command") {
    const name = match(/<command-name>([\s\S]*?)<\/command-name>/)?.trim();
    if (name) {
      const msg  = match(/<command-message>([\s\S]*?)<\/command-message>/)?.trim();
      const args = match(/<command-args>([\s\S]*?)<\/command-args>/)?.trim();
      const lines = [`$ ${name}`];
      if (msg && msg !== name)     lines.push(`  description: ${msg}`);
      if (args && args.length > 0) lines.push(`  args: ${args}`);
      return {
        segmentLabel: "命令输入", segmentContent: lines.join("\n"), direction: "in",
        kindLabelOverride: "命令", preview: `$ ${name}${msg && msg !== name ? `  (${msg})` : ""}`,
      };
    }
    const bash = match(/<bash-input>([\s\S]*?)<\/bash-input>/)?.trim();
    if (bash != null) {
      return {
        segmentLabel: "BASH 输入", segmentContent: `$ ${bash}`, direction: "in",
        kindLabelOverride: "bash", preview: `$ ${bash}`,
      };
    }
    return null;
  }
  if (ev.kind === "system:local_command") {
    const stdout = match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
    const stderr = match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
    const bashOut = match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
    const bashErr = match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
    const parts: string[] = [];
    if (stdout != null && stdout.trim().length > 0) parts.push(stdout);
    if (stderr != null && stderr.trim().length > 0) parts.push(`stderr:\n${stderr}`);
    if (bashOut != null && bashOut.trim().length > 0) parts.push(bashOut);
    if (bashErr != null && bashErr.trim().length > 0) parts.push(`stderr:\n${bashErr}`);
    if (parts.length > 0) {
      const joined = parts.join("\n\n");
      const first = joined.split("\n")[0] ?? "";
      return {
        segmentLabel: "命令输出", segmentContent: joined, direction: "out",
        kindLabelOverride: "命令输出", preview: first.slice(0, 120),
      };
    }
    return null;
  }
  return null;
}
// ── IntervalEventRow: non-tool JSONL events between calls ─────────────────────
export function IntervalEventRow({
  ev, activeToolUseId, onHoverToolUse, suppressPendingState = false,
}: {
  ev: IntervalEvent;
  /**
   * The call this event belongs to in the JSONL stream (i.e. the call whose
   * `intervalEvents` array contains it). For `user:tool_result` rows this
   * is the call that *emitted* the tool_use → its response holds the block
   * we want to back-link to. Undefined for events without a parent call
   * scope (e.g. inter-turn renders).
   */
  producingCallId?: number;
  activeToolUseId: string | null;
  onHoverToolUse: (id: string | null) => void;
  /** 抑制"暂未消费"逐条徽章 —— 调用方（trailing InterTurnBlock）已用块级文案
   *  说明 session 结束所以无人消费，行内重复反而误导。 */
  suppressPendingState?: boolean;
}) {
  const { t } = useTranslation();
  const col = KIND_COLOR[ev.kind];
  const linkedToolUseIds = toolUseIdsFromIntervalEvent(ev);
  const linked = activeToolUseId != null && linkedToolUseIds.includes(activeToolUseId);
  const hoverLinkedId = linkedToolUseIds[0] ?? null;
  // tool_result events get the i18n-aware Agent-execution-result label;
  // other kinds keep their static KIND_LABEL string.
  const kindLabel = ev.kind === "user:tool_result"
    ? t("terms.toolResultLabel")
    : t(`eventKinds.${ev.kind.replace(/[:-]/g, "_")}`, { defaultValue: KIND_LABEL[ev.kind] });
  // 详尽解读 hover：非 context 元数据事件（ai-title / permission-mode / …）在 locale
  // 的 eventKindDesc.<kind> 里有详细描述（是什么/何时出现/为何不进上下文）。其它 kind
  // 无描述则 defaultValue "" → 不显示 tooltip。
  const kindTooltip = t(`eventKindDesc.${ev.kind.replace(/[:-]/g, "_")}`, { defaultValue: "" }) || undefined;
  // tool_result is the *output* fed back to the LLM; other kinds don't fit
  // input/output framing — leave bare bytes (direction undefined).
  // user:command/system:local_command 由后段 commandFormat 覆盖出明确方向。
  const baseDirection: "in" | "out" | undefined = ev.kind === "user:tool_result" ? "out" : undefined;

  // ── Skill-related 特化渲染 ───────────────────────────────────────────────
  // 三种 case 的识别依据全部是 cli.js 写入的确定性字段：
  //   (a) user:tool_result + contentPreview 命中 "Launching skill: ..." → inline 加载中
  //   (b) user:tool_result + contentPreview 命中 `Skill "..." completed (forked execution)` → forked
  //   (c) user:skill_injection（parser 在 isMeta && sourceToolUseID 时打的 kind）→ SKILL.md 注入
  //
  // 这里只覆盖 preview / segments 这两层 UI 字段，**不改** kindLabel — 用户要求
  // "Tool Result 保持不变，更清晰"。skill_injection 的 kindLabel 走默认 i18n
  // (eventKinds.user_skill_injection = "激活 SKILL")。
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
  // user:command / system:local_command 在 jsonl 里是 cli.js 写死的 XML 信封：
  //   user:command            → <command-name>/<command-message>/<command-args>
  //                           或 <bash-input>!ls</bash-input>
  //   system:local_command    → <local-command-stdout>...</local-command-stdout>
  //                           或 <local-command-stderr>... 等
  // 直接展示原始 XML 既丑又掩盖结构。这里 parse 出来后用对话式排版渲染（输入/输出
  // 区分明显，空 args 自动省略）。解析失败时回退到原 preview，绝不丢内容。
  const commandFormat = parseCommandEnvelope(ev);
  const direction: "in" | "out" | undefined = commandFormat?.direction ?? baseDirection;
  // commandFormat 命中时让头部 kindLabel 直接说明角色（命令 vs 命令输出），与
  // segment 标签保持一致；解析失败仍走 i18n 默认。
  const effectiveKindLabel = commandFormat?.kindLabelOverride ?? kindLabel;

  // ── Reverse-attribution lookup ────────────────────────────────────────
  // Each jsonl event may already have been audited by the session graph:
  //   - indexed → render normal + jump to firstSeenInCall
  //   - pending → yellow tint + "暂未消费"
  //   - skipped → dim + "仅元数据"
  // When the graph hasn't loaded yet annotation === null and the card
  // renders without any impact treatment.
  const { getEventAnnotation, onJumpToCall, onOpenSideCall, highlightedLineIdx } = useAttributionGraph();
  const annotation = getEventAnnotation(ev.lineIdx);
  const isFlashing = highlightedLineIdx === ev.lineIdx;
  // 抑制 pending：调用方说明"集体未消费"已由块级文案覆盖，行内重复反而干扰。
  // 把 pending 状态降级为 undefined（视觉上完全中性，不黄不灰），其它 state 不变。
  const impact = annotation && !(suppressPendingState && annotation.contextImpact === "pending") ? {
    state: annotation.contextImpact,
    firstSeenInCall: annotation.firstSeenInCall,
    consumedByCallIds: annotation.consumedByCallIds,
    // Audit-gap caveat from server: firstSeen value here is unreliable
    // because unaudited calls (no proxy) exist before the earliest audited
    // call.
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
  // 指纹归因（ghost-attribution）把有 JSONL 锚点的 side call 连回对应行：
  //   ai-title           → generate_session_title 请求
  //   system:away_summary → away_summary 请求
  // controller 回填 generatedByProxyRequestId，这里据此渲染「→ proxy#<id>」chip
  // （provenanceJump，不受 EventUnitCard 的 skipped 门控影响）。
  const linkedProxyId = ev.generatedByProxyRequestId;

  return (
    <div
      data-jsonl-line={ev.lineIdx}
      style={{
        marginBottom: 2,
        borderRadius: 6,
        // Flash outline driven by AttributionGraphContext.flashEvent —
        // lights up for ~2s when a reverse-jump (Call leaf → Turn view)
        // targets this row's jsonl line.
        boxShadow: isFlashing ? "0 0 0 3px rgba(245,158,11,0.45)" : "none",
        transition: "box-shadow 350ms ease",
      }}
    >
      <EventUnitCard
        color={col.fg}
        bg={col.bg}
        border={col.border}
        kindLabel={effectiveKindLabel}
        kindTooltip={kindTooltip}
        size={ev.contentSize > 0 ? { bytes: ev.contentSize, direction } : undefined}
        timestamp={ev.timestamp}
        preview={skillFormat?.preview ?? commandFormat?.preview ?? ev.contentPreview.slice(0, 120)}
        defaultExpanded={skillFormat ? skillFormat.defaultExpanded : undefined}
        segments={[
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
            // skill_injection 的 SKILL.md 通常 5-10KB —— 给一个足够大的阈值，
            // 让用户展开后能看到完整内容（SegmentView 仍提供 "展开全部" 按钮兜底）。
            monospace: true,
            truncateAt: skillFormat ? 20000 : 1000,
            // Whole-jsonl-line raw view — collapsible tree of the parsed
            // line object (parentUuid / message / toolUseResult / …). Lets
            // users drill into structural fields without parsing the
            // truncated text mentally.
            rawJson: tryParseJson(ev.rawJson),
            // unknown / api_error / stop_hook_summary: preview is a
            // truncated stringify of the same payload → skip the misleading
            // "渲染" tab, go straight to the JSON tree.
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
        // 非 context 事件 → 生成它的后台 proxy 请求：走 provenanceJump（header chip，
        // 与其它 jump chip 同款 LinkIcon + 靛色样式），不受 isSkipped 门控影响。
        provenanceJump={linkedProxyId != null && onOpenSideCall ? {
          label: `proxy#${linkedProxyId}`,
          tooltip: t("terms.sideCallGeneratedBy", { defaultValue: `打开生成它的后台请求 proxy#${linkedProxyId}` }),
          onClick: () => onOpenSideCall(linkedProxyId),
        } : undefined}
      />
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

// ── JsonlCallChain: main component ────────────────────────────────────────────
