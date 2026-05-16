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
import { FisheyeStrip } from "./fisheye-strip";
import { EventUnitCard } from "./shared/EventUnitCard";
import type {
  ResponseTreeResult,
  ResponseNode,
  ResponseSlotType,
  LinkedToolResult,
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
  node, onClose, onLinkCall,
}: {
  node: ResponseNode;
  onClose: () => void;
  onLinkCall?: (callId: number) => void;
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
        segments={[
          {
            label: isToolUse ? "INPUT" : "CONTENT",
            content: node.rawText ?? node.preview,
            monospace: isToolUse,
          },
        ]}
        coordinate={{ kind: "structured", path, source: "jsonl" }}
        expandable={false}
        defaultExpanded={true}
      />

      {/* Linked tool_result forwarding — rendered as a sibling EventUnitCard
          so the "tool_use → tool_result" pair reads as two same-shell units. */}
      {node.linkedToolResult && (
        <LinkedResultBlock
          linked={node.linkedToolResult}
          onLinkCall={onLinkCall}
        />
      )}
    </div>
  );
}

function LinkedResultBlock({
  linked, onLinkCall,
}: {
  linked: LinkedToolResult;
  onLinkCall?: (callId: number) => void;
}) {
  const color = linked.isError ? "#dc2626" : "#16a34a";
  const bg    = linked.isError ? "#fef2f2" : "#f0fdf4";
  const border = linked.isError ? "#fecaca" : "#bbf7d0";

  return (
    <EventUnitCard
      color={color}
      bg={bg}
      border={border}
      kindLabel={linked.isError ? "Tool Result · error" : "Tool Result"}
      shortId={linked.toolUseId}
      size={{ bytes: linked.charCount, direction: "in" }}
      segments={linked.preview ? [
        { content: linked.preview, monospace: true, truncateAt: 1000 },
      ] : []}
      coordinate={linked.nextCallId != null ? {
        kind: "structured",
        path: "request.messages[…].tool_result",
        callIndex: linked.nextCallId,
        source: "jsonl",
      } : undefined}
      expandable={false}
      defaultExpanded={true}
      onJump={linked.nextCallId != null && onLinkCall
        ? () => onLinkCall(linked.nextCallId!)
        : undefined}
      jumpLabel={linked.nextCallId != null ? `call #${linked.nextCallId}` : undefined}
      jumpTooltip={linked.nextCallId != null
        ? `打开 call #${linked.nextCallId}（消费这条 tool_result 的下一次 LLM 调用）`
        : undefined}
    />
  );
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  callId: number;
  onLinkCall?: (callId: number) => void;
}

export function ResponseTreePanel({ sessionId, callId, onLinkCall }: Props) {
  const [data, setData] = useState<ResponseTreeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setSelectedId(null);
    apiV2.responseTree(sessionId, callId)
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => { setData(null); setLoading(false); });
  }, [sessionId, callId]);

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
          onLinkCall={onLinkCall}
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
