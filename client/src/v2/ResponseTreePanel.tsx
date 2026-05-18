// ResponseTreePanel — LLM Call 详情页 Attribution → Response 子 tab 的视图。
//
// 视觉模型（与 AttributionTreePanel 一致 — 无边框 / gap 间隔 / 钻取式导航）：
//   Layer 1  顶部 stacked bar — thinking / text / tool_use 三类 block，按 charCount 比例
//   Layer 2  极简 table — 每个 block 一行
//   选中后  block detail：完整 rawText + linkedToolResult forwarding
//
// 点击 == 选中 == 钻取，无下拉。

import { useEffect, useState } from "react";
import { apiV2 } from "./api";
import { useAttributionGraph } from "./attribution-graph-context";
import { FisheyeStrip } from "./fisheye-strip";
import { EventUnitCard } from "./shared/EventUnitCard";
import type {
  ResponseTreeResult,
  ResponseNode,
  ResponseSlotType,
} from "./response-tree-types";

// ─── 配色 ─────────────────────────────────────────────────────────────────────

interface SlotMeta {
  label: string;
  barBg: string;
  barText: string;
  rowBg: string;
  marker: string;
  textColor: string;
}

const SLOT_META: Record<Exclude<ResponseSlotType, "response">, SlotMeta> = {
  "response.thinking":  { label: "Thinking",  barBg: "#a78bfa", barText: "#fff", rowBg: "#f5f3ff", marker: "#a78bfa", textColor: "#5b21b6" },
  "response.text":      { label: "Text",      barBg: "#22c55e", barText: "#fff", rowBg: "#f0fdf4", marker: "#22c55e", textColor: "#15803d" },
  "response.tool_use":  { label: "Tool Use",  barBg: "#f59e0b", barText: "#fff", rowBg: "#fffbeb", marker: "#f59e0b", textColor: "#92400e" },
};

function slotMeta(slot: ResponseSlotType): SlotMeta {
  if (slot === "response") {
    return { label: "Response", barBg: "#e5e7eb", barText: "#374151", rowBg: "#fafafa", marker: "#9ca3af", textColor: "#374151" };
  }
  return SLOT_META[slot];
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function tryParseJson(s: string): unknown {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

// Same description-extraction logic as Turn ToolCallRow — keeps the
// description subtitle aligned across the four tool_use views.
function extractToolDescription(raw: string | undefined): string | undefined {
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
  } catch { /* not JSON */ }
  return undefined;
}

// ─── 顶部 stacked bar — 消费 fisheye-strip 模块 ──────────────────────────────
//
// Response 通常只有 3-5 个 block（thinking / text / 几个 tool_use），元素数远少于
// fisheye auto 阈值 → 实际上 fisheye 默认就是关闭的，行为退化为普通 stacked bar。
// 但万一某个 response 有大量 tool_use（罕见但可能），fisheye 仍能兜底。

const BAR_HEIGHT = 44;

interface ResponseBlockItem {
  id: string;
  size: number;
  node: ResponseNode;
}

function ResponseBar({
  blocks, selectedId, onSelect,
}: {
  blocks: ResponseNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (blocks.length === 0) return null;
  const items: ResponseBlockItem[] = blocks.map((n) => ({
    id: n.id,
    size: Math.max(n.charCount, 1),  // 避免极小段被算出 size=0
    node: n,
  }));
  return (
    <FisheyeStrip<ResponseBlockItem>
      items={items}
      getColor={(it) => slotMeta(it.node.slotType).barBg}
      getLabel={(it) => it.node.wireMeta?.toolName ?? slotMeta(it.node.slotType).label}
      getTitle={(it) => {
        const meta = slotMeta(it.node.slotType);
        return `${meta.label} · ${fmtK(it.node.charCount)} chars`;
      }}
      height={BAR_HEIGHT}
      background="transparent"
      selectedId={selectedId}
      onSelect={(it) => onSelect(selectedId === it.id ? null : it.id)}
    />
  );
}

// ─── 极简 table ───────────────────────────────────────────────────────────────

function BlockTable({
  blocks, totalChars, selectedId, onSelect,
}: {
  blocks: ResponseNode[];
  totalChars: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {blocks.map((n) => {
        const meta = slotMeta(n.slotType);
        const pct = totalChars > 0 ? (n.charCount / totalChars) * 100 : 0;
        const isSel = selectedId === n.id;
        const isToolUse = n.slotType === "response.tool_use";
        return (
          <button
            key={n.id}
            onClick={() => onSelect(n.id)}
            style={{
              display: "flex", alignItems: "center", gap: 14,
              padding: "8px 8px",
              background: isSel ? meta.rowBg : "transparent",
              border: "none", borderRadius: 4,
              cursor: "pointer", textAlign: "left",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = "#f9fafb"; }}
            onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.marker, flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: meta.textColor, minWidth: 80 }}>
              {meta.label}
            </span>
            {n.wireMeta?.toolName && (
              <span style={{ fontSize: 11, color: "#374151", fontWeight: 600, fontFamily: "ui-monospace, monospace", minWidth: 110 }}>
                {n.wireMeta.toolName}
              </span>
            )}
            <span style={{ fontSize: 11, color: "#374151", minWidth: 50 }}>{fmtK(n.charCount)}</span>
            <span style={{ fontSize: 10, color: "#9ca3af", minWidth: 40 }}>{pct.toFixed(1)}%</span>
            <span style={{
              fontSize: 10, color: "#6b7280", flex: 1,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              fontFamily: isToolUse ? "ui-monospace, SFMono-Regular, monospace" : "inherit",
            }}>
              {n.preview}
            </span>
            {n.linkedToolResult?.nextCallId != null && (
              <span style={{ fontSize: 9, color: "#6366f1", flexShrink: 0 }}>
                → #{n.linkedToolResult.nextCallId}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── 叶子详情视图 ─────────────────────────────────────────────────────────────

function NodeDetail({
  node, onClose,
}: {
  node: ResponseNode;
  onClose: () => void;
}) {
  const meta = slotMeta(node.slotType);
  const isToolUse = node.slotType === "response.tool_use";
  // structured path: response.tool_use / response.text / response.thinking
  const path = node.slotType;

  return (
    <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Back button — kept outside the EventUnitCard since it's a navigation
          action specific to the detail view, not an attribute of the event. */}
      <div>
        <button
          onClick={onClose}
          style={{
            fontSize: 11, padding: "3px 10px", borderRadius: 4,
            background: "#fff", border: "1px solid #e5e7eb",
            cursor: "pointer", color: "#374151",
          }}
        >← back</button>
      </div>

      {/* Main event unit — shared shell with Turn-card events */}
      <EventUnitCard
        color={meta.marker}
        bg={meta.rowBg}
        border="#e5e7eb"
        kindLabel={meta.label}
        title={node.wireMeta?.toolName}
        shortId={node.wireMeta?.toolUseId}
        size={{ bytes: node.charCount, direction: "out" }}
        description={isToolUse ? extractToolDescription(node.rawText ?? node.preview) : undefined}
        segments={[
          {
            label: isToolUse ? "INPUT" : "CONTENT",
            content: node.rawText ?? node.preview,
            monospace: isToolUse,
            // For tool_use, the rendered content is a JSON string of the
            // wire input — make it tree-toggleable. For text/thinking the
            // content is prose; raw mode adds no value, leave undefined.
            rawJson: isToolUse ? tryParseJson(node.rawText ?? node.preview) : undefined,
          },
        ]}
        coordinate={{ kind: "structured", path, source: "jsonl" }}
        expandable={false}
        defaultExpanded={true}
      />

      {/* tool_result intentionally NOT rendered here. The Response tab
          shows what THIS call returned — only text / thinking / tool_use
          blocks. The matching tool_result was emitted by the harness in a
          later jsonl event and entered the NEXT call's request — that's
          where it lives. Showing it inside Response misleads users into
          thinking the LLM "returned" a result. To follow the chain, the
          tool_use card's jump chip + the Request tab of the consumer call
          provide the navigation. */}
    </div>
  );
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  /** Present iff rendering a sub-agent call — routes to sub-agent endpoint. */
  agentFileId?: string;
  callId: number;
  onLinkCall?: (callId: number) => void;
}

export function ResponseTreePanel({ sessionId, agentFileId, callId, onLinkCall }: Props) {
  const [data, setData] = useState<ResponseTreeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setSelectedId(null);
    const fetcher = agentFileId
      ? apiV2.subAgentResponseTree(sessionId, agentFileId, callId)
      : apiV2.responseTree(sessionId, callId);
    fetcher
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => { setData(null); setLoading(false); });
  }, [sessionId, agentFileId, callId]);

  // Pending-focus consumption: when a Turn-view tool_use jump lands here
  // with `{ toolUseId }`, find the matching response block and select it.
  const { pendingFocus, clearPendingFocus } = useAttributionGraph();
  useEffect(() => {
    if (!pendingFocus || !("toolUseId" in pendingFocus) || !data?.snapshot) return;
    const target = pendingFocus.toolUseId;
    const blocks = data.snapshot.roots[0]?.children ?? [];
    const match = blocks.find((b) => b.wireMeta?.toolUseId === target);
    if (match) setSelectedId(match.id);
    clearPendingFocus();
  }, [pendingFocus, data, clearPendingFocus]);

  if (loading) {
    return <div style={{ fontSize: 11, color: "#9ca3af", padding: "32px 0", textAlign: "center" }}>Loading response…</div>;
  }

  if (!data?.snapshot) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "#9ca3af", background: "#fafafa", borderRadius: 6, border: "1px dashed #e5e7eb" }}>
        {data?.error ?? "No response data available."}
      </div>
    );
  }

  const root = data.snapshot.roots[0];
  const blocks = root?.children ?? [];
  const totalChars = root?.charCount ?? 0;
  const selected = selectedId ? blocks.find((n) => n.id === selectedId) ?? null : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Header strip */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, padding: "0 2px", flexWrap: "wrap" }}>
        <span style={{ fontSize: 9, color: "#9ca3af", fontWeight: 600, letterSpacing: "0.05em" }}>RESPONSE</span>
        <span style={{ fontSize: 11, color: "#6b7280" }}>
          stop: <strong style={{ color: "#374151" }}>{data.stopReason ?? "—"}</strong>
        </span>
        <span style={{ fontSize: 11, color: "#6b7280" }}>
          out: <strong style={{ color: "#374151" }}>{fmtK(data.outputTokens)}</strong>
        </span>
        <span style={{ fontSize: 11, color: "#6b7280" }}>
          blocks: <strong style={{ color: "#374151" }}>{blocks.length}</strong>
        </span>
        <span style={{ marginLeft: "auto", fontSize: 9, color: "#d1d5db" }}>
          source: {data.dataSource}
        </span>
      </div>

      {/* Layer 1: 顶部 stacked bar */}
      <ResponseBar
        blocks={blocks}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />

      {/* Layer 2 / detail */}
      {blocks.length === 0 ? (
        <div style={{ fontSize: 11, color: "#9ca3af", padding: "16px 0", textAlign: "center" }}>
          No content blocks in this response.
        </div>
      ) : selected ? (
        <NodeDetail
          node={selected}
          onClose={() => setSelectedId(null)}
        />
      ) : (
        <BlockTable
          blocks={blocks}
          totalChars={totalChars}
          selectedId={null}
          onSelect={setSelectedId}
        />
      )}
    </div>
  );
}
