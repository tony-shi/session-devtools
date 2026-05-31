// EventUnitCard — 跨 Turn / Call detail 两个视图的统一"事件单元"卡片。
//
// 同一类事件（tool_use / tool_result / user_input / assistant_text / thinking
// / attachment / system_local_command / stop_hook / unknown）无论出现在哪个
// 视图，都用这一个组件渲染，只是 META 行的"坐标系" 不同：
//   - Turn card 视角：jsonl 坐标（line + uuid + parent）
//   - Call detail 视角：structured 坐标（path + callIndex + source）
//
// 视觉壳固定为 3 段：
//   header — 色 dot · 类型 · 标题 · 短 ID · size · time · jump › · 折叠 ▼
//   content — 一或多段 segment（label + raw + truncate + show more）
//   footer — META 行（坐标 + 置信度）
//
// 形态：默认 list row（collapsed），点击 header 整体展开成 detail；也可以通过
// `expandable={false} + defaultExpanded` 让卡片永远展开（NodeDetail 用法）。

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import JsonView from "@uiw/react-json-view";
import { TriangleAlert, Link2, ArrowUpRight } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { BRAND } from "./brand";

export type EventDirection = "in" | "out";

export type EventCoordinate =
  | { kind: "jsonl"; line: number; uuid?: string; parentUuid?: string; jsonPath?: string }
  | { kind: "structured"; path: string; callIndex?: number; source?: string; jsonPath?: string };

export interface EventSegment {
  /** Optional uppercase tag above the raw content (e.g. "INPUT" / "OUTPUT"). */
  label?: string;
  /** Raw text content. Truncated client-side at `truncateAt` chars. */
  content: string;
  /** Default true. Set false for prose-like content. */
  monospace?: boolean;
  /** Default 1000. Pass Infinity to disable truncation. */
  truncateAt?: number;
  /**
   * When present, the segment shows a "渲染 | 原始 JSON" toggle next to the
   * label. The user can flip between the rendered `content` (truncated text)
   * and the underlying structured object rendered via a collapsible JSON
   * tree viewer. Useful for jsonl events / wire blocks where the rendered
   * form is a lossy preview and the user occasionally wants the full
   * structured payload.
   */
  rawJson?: unknown;
  /**
   * When true (requires `rawJson` to be set), the segment defaults to the
   * JSON tree view and hides the "渲染|原始 JSON" toggle entirely. Use this
   * for events where the rendered text is just `JSON.stringify(...)` of the
   * same object (unknown / system:api_error / system:stop_hook_summary) —
   * showing a "渲染" tab there is misleading because both tabs would
   * essentially show the same content.
   */
  rawOnly?: boolean;
  /**
   * When true (requires `rawJson` to be set), the segment starts in JSON
   * tree mode but the user can still toggle to the rendered text view.
   * Use for surfaces where the structured form is the primary one (e.g.
   * Attribution leaf detail for tool definitions / wire blocks).
   */
  defaultRaw?: boolean;
}

export interface EventUnitCardProps {
  // === Header (always visible) ===
  color: string;                   // dot + accent color
  kindLabel: string;               // "Tool Use" / "Tool Result" / "User Input" / ...
  /** 详尽描述,作为 kindLabel 的 hover tooltip。用于非 context 元数据事件
   *  （ai-title / permission-mode / …）解释「这是什么、何时出现、为何不进上下文」。 */
  kindTooltip?: string;
  title?: string;                  // e.g. tool name "Edit"
  shortId?: string;                // e.g. "toolu_013n…3MjCD"
  size?: { bytes: number; direction?: EventDirection };
  timestamp?: string;              // ISO; rendered as HH:MM:SS

  // === Collapsed preview ===
  /** Shown only when card is collapsed (single-line summary). */
  preview?: string;
  /**
   * Always-visible subtitle below the header strip. Used for short,
   * human-readable intent labels — e.g. tool_use cards surface the
   * `description` field that Claude Code attaches to most tool calls
   * ("List top-level entries", "Read package.json"). Visible in both
   * collapsed and expanded state so it's there when the user is scanning
   * AND when they've drilled in.
   */
  description?: string;

  // === Expanded content ===
  segments?: EventSegment[];
  coordinate?: EventCoordinate;
  /** Confidence level (definitive / high / partial / none / etc.) — appended
   *  to the META footer when present. */
  confidence?: string;
  /**
   * Reverse-attribution facts (server-side `JsonlEventAnnotation` projected
   * onto this event). Drives:
   *   - META row chips ("first seen → call #N · used in K calls")
   *   - Three-state visual:
   *       · indexed → normal card
   *       · pending → yellow tint, "暂未消费" chip
   *       · skipped → opacity 0.6, "仅元数据" chip, no `›` jump
   * Pass null/undefined to render the card without any impact treatment.
   */
  impact?: {
    state: "indexed" | "skipped" | "pending";
    firstSeenInCall?: number | null;
    consumedByCallIds?: number[];
    /**
     * Audit-gap caveat: server detected that firstSeenInCall is the
     * earliest audited call but there are unaudited calls (no proxy data)
     * before it. The true first-seen may be one of those unaudited calls.
     * UI restyles the jump chip with a warning so the user can tell that
     * the target may not be the real source.
     */
    firstSeenIsAfterAuditGap?: boolean;
  };

  // === Behavior ===
  /** Default true; if false, expanded state is fixed and no ▼ toggle shown. */
  expandable?: boolean;
  /** Initial state when expandable=true; ignored otherwise. */
  defaultExpanded?: boolean;

  // === Interaction ===
  active?: boolean;                // hover-linked highlight (amber outline)
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onClick?: () => void;            // fires alongside expand toggle
  onJump?: () => void;             // header jump button (chip)
  /** Short label shown inside the jump chip — e.g. "call #140". Without it
   *  the chip falls back to "跳转". A label is strongly recommended so users
   *  see the target before clicking. */
  jumpLabel?: string;
  jumpTooltip?: string;
  /** Provenance jump — a header chip with the SAME styling as `onJump`, but
   *  NOT suppressed when the event is reverse-attribution "skipped". Used for
   *  ai-title → 生成它的 proxy 请求：纯元数据行常被标 skipped（→ onJump 会被吞），
   *  但它确实有一个可跳的来源，所以走这条不受门控的通道，保证 chip 恒显且与其它
   *  jump chip 视觉一致。 */
  provenanceJump?: { label: string; tooltip?: string; onClick: () => void };

  // === Style overrides ===
  bg?: string;                     // default "#fafafa"
  border?: string;                 // default "#f0f0f0"

  /** Tighter padding for nested contexts. */
  compact?: boolean;
  /** Flat and borderless mode, with a colored left stripe. */
  borderless?: boolean;
}

function fmtBytes(b: number): string {
  if (b >= 1_000_000) return (b / 1_000_000).toFixed(1) + "M";
  if (b >= 1_000)     return (b / 1_000).toFixed(1) + "k";
  return b > 0 ? String(b) + "b" : "0";
}

function fmtTime(ts: string): string {
  // ISO "2026-05-15T09:33:46.863Z" → "09:33:46"
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

function shortenId(id: string): string {
  if (id.length <= 18) return id;
  return id.slice(0, 10) + "…" + id.slice(-5);
}

export function EventUnitCard(props: EventUnitCardProps) {
  const { t } = useTranslation();
  const {
    color, kindLabel, kindTooltip, title, shortId, size, timestamp,
    preview, description, segments = [], coordinate, confidence, impact,
    expandable = true, defaultExpanded = false,
    active = false,
    onMouseEnter, onMouseLeave, onClick, onJump, jumpLabel, jumpTooltip, provenanceJump,
    bg, border, compact = false, borderless = false,
  } = props;

  const [expanded, setExpanded] = useState(defaultExpanded);
  const showExpanded = expandable ? expanded : true;

  // Impact state cascades into background / opacity / jump button visibility.
  // Skipped events are "metadata only" → dim and non-navigable. Pending
  // events are highlighted yellow so the eye catches them as "weirdly
  // unconsumed". Indexed events render normally.
  const isSkipped = impact?.state === "skipped";
  const isPending = impact?.state === "pending";

  const headerPadding = compact ? "3px 8px" : "5px 10px";
  const impactBg = isPending ? "#fffbeb" : undefined;
  const effectiveBg     = active ? "#fff7ed" : (impactBg ?? bg ?? "#fafafa");
  const effectiveBorder = active ? "#f59e0b" : (isPending ? "#fde68a" : (border ?? "#f0f0f0"));
  const cardOpacity = isSkipped ? 0.6 : 1;

  // Skipped events never offer a jump — there's no call to point at.
  // Audit-gap events DO keep their jump chip (so users see a consistent
  // affordance everywhere), but the chip is restyled in amber + ⚠ icon and
  // its tooltip spells out "early calls not audited, target may be wrong".
  // The hide-it-entirely approach left users wondering "why does this one
  // have a chip and that one doesn't"; surfacing the unreliability is more
  // honest than hiding.
  const auditGapped = !!impact?.firstSeenIsAfterAuditGap;
  const effectiveOnJump = isSkipped ? undefined : onJump;

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        background: borderless ? (active ? "#fff7ed" : "transparent") : effectiveBg,
        border: borderless ? "none" : `1px solid ${effectiveBorder}`,
        borderRadius: borderless ? 0 : 6,
        borderLeft: borderless ? (active ? "3px solid #f59e0b" : `3px solid ${color}`) : undefined,
        paddingLeft: borderless ? 8 : 0,
        overflow: "hidden",
        opacity: cardOpacity,
        boxShadow: active ? (borderless ? "0 0 0 2px rgba(245,158,11,0.1)" : "0 0 0 2px rgba(245,158,11,0.14)") : "none",
        transition: "background 0.1s, border-color 0.1s, opacity 0.1s",
      }}
    >
      {/* === Header ===
          Click target is intentionally just the chevron toggle, NOT the
          whole header strip. Clicking the body anywhere else used to expand
          the card and shift surrounding rows — visually identical to a
          "scroll" the user didn't request. Now the body is inert; only the
          jump chip (right side) and the chevron (far right) take clicks.
          When the caller wants whole-body click behavior they can still
          pass `onClick` — that fires without touching expansion state. */}
      <div
        onClick={onClick ? () => onClick() : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: headerPadding,
          cursor: onClick ? "pointer" : "default",
        }}
      >
        {/* color dot */}
        {!borderless && (
          <span style={{
            width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0,
          }} />
        )}

        {/* kind label —— kindTooltip 存在时用 Radix Tooltip（复用 App 根的
            TooltipProvider，同 DiffPanel/UserTurnDetailPanel）弹出详尽解读；
            加 help 光标 + 虚线下划线提示可 hover。原生 title 不可靠，已弃用。 */}
        {kindTooltip ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span style={{
                fontSize: 10, fontWeight: 700, color: "#4b5563",
                fontFamily: "'Outfit', sans-serif",
                textTransform: "uppercase", letterSpacing: "0.05em",
                flexShrink: 0, whiteSpace: "nowrap",
                cursor: "help", textDecoration: "underline dotted", textUnderlineOffset: 2,
              }}>
                {kindLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal leading-relaxed">
              {kindTooltip}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span style={{
            fontSize: 10, fontWeight: 700, color: "#4b5563",
            fontFamily: "'Outfit', sans-serif",
            textTransform: "uppercase", letterSpacing: "0.05em",
            flexShrink: 0, whiteSpace: "nowrap",
          }}>
            {kindLabel}
          </span>
        )}

        {/* title (e.g. tool name) */}
        {title && (
          <span style={{
            fontSize: 11, fontWeight: 700, color: "#111827",
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            flexShrink: 0, whiteSpace: "nowrap",
          }}>
            {title}
          </span>
        )}

        {/* short ID */}
        {shortId && (
          <code style={{ fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>
            {shortenId(shortId)}
          </code>
        )}

        {/* Collapsed preview occupies the stretch slot */}
        {!showExpanded && preview ? (
          <span style={{
            fontSize: 11, color: "#6b7280",
            flex: 1, minWidth: 0,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {preview}
          </span>
        ) : (
          <div style={{ flex: 1 }} />
        )}

        {/* size badge */}
        {size && size.bytes > 0 && (
          <span style={{ fontSize: 9, color: "#94a3b8", flexShrink: 0 }}>
            {size.direction ? `${size.direction} ` : ""}{fmtBytes(size.bytes)}
          </span>
        )}

        {/* timestamp */}
        {timestamp && (
          <span style={{ fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>
            {fmtTime(timestamp)}
          </span>
        )}

        {/* jump button — solid indigo (normal) or amber (audit-gap warning).
            Two visual states share the same shape so the affordance is
            consistent across every event; only color + icon + tooltip
            differ. */}
        {effectiveOnJump && (
          <button
            type="button"
            title={auditGapped
              ? `${jumpTooltip ?? ""}\n\n${t("eventCard.unreliableAuditWarning")}`.trim()
              : jumpTooltip}
            onClick={(e) => { e.stopPropagation(); effectiveOnJump(); }}
            className={borderless ? "hover:opacity-80 transition-opacity" : (auditGapped ? "hover:!bg-amber-700 transition-colors" : "hover:!bg-indigo-700 transition-colors")}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              border: "none",
              background: borderless ? "transparent" : (auditGapped ? "#d97706" : BRAND.indigo600),
              color: borderless ? (auditGapped ? "#d97706" : BRAND.indigo600) : "#fff",
              borderRadius: borderless ? 0 : 4,
              fontSize: 10, fontWeight: 700,
              padding: borderless ? "2px 4px" : "3px 9px",
              cursor: "pointer", lineHeight: 1.3,
              flexShrink: 0, whiteSpace: "nowrap",
              transition: "background 0.12s, color 0.12s",
              boxShadow: borderless ? "none" : (auditGapped
                ? "0 1px 2px rgba(217,119,6,0.30)"
                : "0 1px 2px rgba(79,70,229,0.25)"),
              letterSpacing: "0.02em",
            }}
          >
            {auditGapped ? <WarningIcon /> : <LinkIcon />}
            {auditGapped && jumpLabel ? `?${jumpLabel}` : (jumpLabel ?? t("eventCard.jump"))}
          </button>
        )}

        {/* provenance jump — 与上面 jump chip 同款样式（LinkIcon + 靛色），但不受
            isSkipped 门控。ai-title → 生成它的 proxy 请求走这条。 */}
        {provenanceJump && (
          <button
            type="button"
            title={provenanceJump.tooltip}
            onClick={(e) => { e.stopPropagation(); provenanceJump.onClick(); }}
            className={borderless ? "hover:opacity-80 transition-opacity" : "hover:!bg-indigo-700 transition-colors"}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              border: "none",
              background: borderless ? "transparent" : BRAND.indigo600,
              color: borderless ? BRAND.indigo600 : "#fff",
              borderRadius: borderless ? 0 : 4,
              fontSize: 10, fontWeight: 700,
              padding: borderless ? "2px 4px" : "3px 9px",
              cursor: "pointer", lineHeight: 1.3,
              flexShrink: 0, whiteSpace: "nowrap",
              transition: "background 0.12s, color 0.12s",
              boxShadow: borderless ? "none" : "0 1px 2px rgba(79,70,229,0.25)",
              letterSpacing: "0.02em",
              marginLeft: 6,
            }}
          >
            <LinkIcon />
            {provenanceJump.label}
          </button>
        )}

        {/* expand toggle — the only element in the header that toggles
            expansion. stopPropagation so it doesn't double-fire onClick. */}
        {expandable && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
            title={expanded ? t("eventCard.collapse") : t("eventCard.expand")}
            style={{
              background: "transparent", border: "none",
              cursor: "pointer", padding: "0 2px",
              fontSize: 11, color: "#9ca3af", lineHeight: 1,
              flexShrink: 0,
            }}
          >
            {expanded ? "▲" : "▼"}
          </button>
        )}
      </div>

      {/* === Description subtitle ===
          Always-visible (collapsed and expanded). For tool_use cards this
          carries the human intent string ("List top-level entries") which
          is much more scannable than the raw input JSON. Indented to align
          with the kind label. */}
      {showExpanded && description && (
        <div style={{
          padding: compact ? "0 8px 4px 8px" : "0 10px 5px 10px",
          fontSize: 11, color: "#6b7280",
          fontStyle: "italic", lineHeight: 1.4,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {description}
        </div>
      )}

      {/* === Content === */}
      {showExpanded && segments.length > 0 && (
        <div style={{ padding: "0 10px 8px" }}>
          {segments.map((seg, i) => (
            <SegmentView key={i} seg={seg} />
          ))}
        </div>
      )}

      {/* === META footer === */}
      {showExpanded && (coordinate || confidence || impact) && (
        <div style={{
          padding: borderless ? "4px 0" : "5px 10px",
          borderTop: borderless ? "none" : "1px solid #f3f4f6",
          fontSize: 9, color: borderless ? "#9ca3af" : "#6b7280",
          display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center",
          background: borderless ? "transparent" : (isPending ? "#fffdf2" : "#fcfcfc"),
        }}>
          <span style={{ fontFamily: "'Outfit', sans-serif", fontWeight: 700, color: "#9ca3af", letterSpacing: "0.05em" }}>META</span>
          {coordinate && <CoordinateChips coordinate={coordinate} />}
          {impact && <ImpactChips impact={impact} />}
          {confidence && (
            <span style={{ marginLeft: "auto", color: "#9ca3af" }}>
              confidence · {confidence}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ImpactChips({ impact }: { impact: NonNullable<EventUnitCardProps["impact"]> }) {
  const { t } = useTranslation();
  if (impact.state === "skipped") {
    return <span style={{ color: "#9ca3af" }}>{t("eventCard.metadataOnly")}</span>;
  }
  if (impact.state === "pending") {
    return <span style={{ color: "#b45309" }}>{t("eventCard.notConsumedYet")}</span>;
  }
  // indexed
  const fst = impact.firstSeenInCall;
  const usedIn = impact.consumedByCallIds?.length ?? 0;
  const gapQualifier = impact.firstSeenIsAfterAuditGap;
  return (
    <>
      {fst != null && (
        <span>
          first seen → call #{fst}
          {gapQualifier && (
            <span style={{ color: "#b45309", marginLeft: 4 }}>
              {t("eventCard.gappedAuditWarn")}
            </span>
          )}
        </span>
      )}
      {usedIn > 1 && <span>used in {usedIn} calls</span>}
    </>
  );
}

function CoordinateChips({ coordinate }: { coordinate: EventCoordinate }) {
  // Request-body JSON pointer (e.g. `system[0]`, `messages[0].content[1]`).
  // Server stores it as `reqBody.<path>` — strip that prefix so the chip reads
  // like the path you'd type into the raw-request JSON.
  const reqPath = coordinate.jsonPath
    ? coordinate.jsonPath.replace(/^reqBody\./, "")
    : undefined;
  if (coordinate.kind === "jsonl") {
    return (
      <>
        <span>jsonl: L{coordinate.line}</span>
        {coordinate.uuid && <span>uuid: {coordinate.uuid.slice(0, 8)}…</span>}
        {coordinate.parentUuid && <span>parent: {coordinate.parentUuid.slice(0, 8)}…</span>}
        {reqPath && <span>request: <code style={{ fontSize: 9 }}>{reqPath}</code></span>}
      </>
    );
  }
  return (
    <>
      <span>path: <code style={{ fontSize: 9 }}>{coordinate.path}</code></span>
      {coordinate.callIndex != null && <span>call #{coordinate.callIndex}</span>}
      {coordinate.source && <span>source: {coordinate.source}</span>}
      {reqPath && <span>request: <code style={{ fontSize: 9 }}>{reqPath}</code></span>}
    </>
  );
}

function WarningIcon() {
  return <TriangleAlert size={11} className="shrink-0" />;
}

export function LinkIcon() {
  // "navigate (cross-reference inside the same scope)" semantics.
  return <Link2 size={11} className="shrink-0" />;
}

export function ForwardArrowIcon() {
  // "navigate INTO another scope" (e.g. open a sub-agent's own detail view) —
  // distinct from LinkIcon which means "cross-reference inside the same scope".
  return <ArrowUpRight size={11} className="shrink-0" />;
}

export function SegmentView({ seg }: { seg: EventSegment }) {
  const { t } = useTranslation();
  const truncateAt = seg.truncateAt ?? 1000;
  const tooLong = seg.content.length > truncateAt;
  const [showFull, setShowFull] = useState(false);
  const hasRaw = seg.rawJson !== undefined && seg.rawJson !== null;
  // `rawOnly` collapses the toggle and forces the JSON tree view. Only
  // honored when raw JSON is actually present — otherwise we silently fall
  // through to the standard preview path so we never end up with both
  // views disabled.
  const rawOnly = !!seg.rawOnly && hasRaw;
  // "preview" = rendered/truncated content (default); "raw" = JSON tree
  // viewer over `seg.rawJson`. Toggle only available when rawJson is
  // present — segments without structured backing stay text-only.
  // `defaultRaw` flips the initial mode to JSON tree while keeping the
  // toggle visible, so users can still drop back to the raw string.
  const initialMode: "preview" | "raw" = rawOnly || (seg.defaultRaw && hasRaw) ? "raw" : "preview";
  const [viewMode, setViewMode] = useState<"preview" | "raw">(initialMode);
  const effectiveMode = rawOnly ? "raw" : viewMode;
  const showToggle = hasRaw && !rawOnly;
  const shown = !tooLong || showFull ? seg.content : seg.content.slice(0, truncateAt);
  const monospace = seg.monospace ?? true;

  return (
    <div style={{ marginTop: 6 }}>
      {(seg.label || showToggle) && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          marginBottom: 3,
        }}>
          {seg.label && (
            <span style={{
              fontSize: 9, color: "#64748b", fontWeight: 700, letterSpacing: "0.05em",
            }}>
              {seg.label}
            </span>
          )}
          {showToggle && (
            <div style={{
              marginLeft: "auto",
              display: "inline-flex",
              border: "1px solid #e5e7eb", borderRadius: 4,
              overflow: "hidden",
            }}>
              <SegmentModeButton
                active={viewMode === "preview"}
                onClick={(e) => { e.stopPropagation(); setViewMode("preview"); }}
              >
                {t("eventCard.render")}
              </SegmentModeButton>
              <SegmentModeButton
                active={viewMode === "raw"}
                onClick={(e) => { e.stopPropagation(); setViewMode("raw"); }}
              >
                {t("eventCard.rawJson")}
              </SegmentModeButton>
            </div>
          )}
        </div>
      )}

      {effectiveMode === "raw" && hasRaw ? (
        <div style={{
          padding: "6px 8px",
          background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 4,
          maxHeight: 480, overflow: "auto",
          fontSize: 11,
        }}>
          <JsonView
            value={seg.rawJson as object}
            collapsed={false}
            displayDataTypes={false}
            displayObjectSize={false}
            enableClipboard
            style={{
              backgroundColor: "transparent",
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              fontSize: 11,
              lineHeight: 1.55,
            }}
          />
        </div>
      ) : (
        <>
          <pre style={{
            margin: 0, padding: "6px 8px",
            fontSize: 11, lineHeight: 1.5,
            background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 4,
            color: "#334155",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            maxHeight: showFull ? 480 : 200, overflow: "auto",
            fontFamily: monospace ? "ui-monospace, SFMono-Regular, monospace" : "inherit",
          }}>
            {shown}
          </pre>
          {tooLong && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowFull(v => !v); }}
              style={{
                marginTop: 3, fontSize: 10, color: BRAND.indigo500,
                background: "none", border: "none", cursor: "pointer", padding: 0,
                fontWeight: 600,
              }}
            >
              {showFull
                ? t("terms.showLess")
                : t("terms.showMore", { n: seg.content.length - truncateAt })}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SegmentModeButton({
  active, onClick, children,
}: {
  active: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? BRAND.indigo50 : "transparent",
        color: active ? BRAND.indigo700 : "#9ca3af",
        border: "none",
        padding: "2px 8px",
        fontSize: 9, fontWeight: 700, letterSpacing: "0.04em",
        cursor: "pointer", lineHeight: 1.3,
      }}
    >
      {children}
    </button>
  );
}
