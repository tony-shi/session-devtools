// ResponseTreePanel — LLM Call 详情页 "Response" tab 的视图组件。
//
// 风格与 AttributionTreePanel 一致：顶部 stacked bar（按 charCount 比例）+ 行列表 + 叶子详情。
//
// 数据：响应 wire body（assistant message content[]）→ 三类 slotType：
//   - response.thinking
//   - response.text
//   - response.tool_use（叶子上可挂 linkedToolResult — 指向下游 call 的 tool_result）
//
// 双向 link：点击 tool_use 叶子的 linkedToolResult 区块 → 触发 onLinkCall(nextCallId)
// 调用方负责打开右侧 LinkedContextPanel。

import { useEffect, useState } from "react";
import { apiV2 } from "./api";
import type {
  ResponseTreeResult,
  ResponseNode,
  ResponseSlotType,
  LinkedToolResult,
} from "./response-tree-types";

// ─── 类型/配色 ────────────────────────────────────────────────────────────────

interface SlotMeta {
  label: string;
  barBg: string;
  barText: string;
  rowBg: string;
  rowBorder: string;
  marker: string;
  textColor: string;
}

const SLOT_META: Record<Exclude<ResponseSlotType, "response">, SlotMeta> = {
  "response.thinking":  { label: "Thinking",  barBg: "#c4b5fd", barText: "#fff", rowBg: "#f5f3ff", rowBorder: "#ddd6fe", marker: "#a78bfa", textColor: "#5b21b6" },
  "response.text":      { label: "Text",      barBg: "#86efac", barText: "#fff", rowBg: "#f0fdf4", rowBorder: "#bbf7d0", marker: "#22c55e", textColor: "#15803d" },
  "response.tool_use":  { label: "Tool Use",  barBg: "#fcd34d", barText: "#78350f", rowBg: "#fffbeb", rowBorder: "#fde68a", marker: "#f59e0b", textColor: "#92400e" },
};

function slotMeta(slot: ResponseSlotType): SlotMeta {
  if (slot === "response") {
    return { label: "Response", barBg: "#e5e7eb", barText: "#374151", rowBg: "#fafafa", rowBorder: "#e5e7eb", marker: "#9ca3af", textColor: "#374151" };
  }
  return SLOT_META[slot];
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

// ─── Bar：顶部比例条 ──────────────────────────────────────────────────────────

function StackedBar({
  children, total, selectedId, onSelect,
}: {
  children: ResponseNode[];
  total: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (children.length === 0 || total === 0) return null;
  return (
    <div style={{
      display: "flex", height: 28, borderRadius: 6, overflow: "hidden",
      border: "1px solid #e5e7eb", marginBottom: 10,
    }}>
      {children.map((n) => {
        const meta = slotMeta(n.slotType);
        const pct = (n.charCount / total) * 100;
        const isSel = selectedId === n.id;
        return (
          <button
            key={n.id}
            title={`${meta.label} · ${fmtK(n.charCount)} chars`}
            onClick={() => onSelect(isSel ? null : n.id)}
            style={{
              flex: Math.max(pct, 0.5), minWidth: 24,
              border: "none", padding: 0, cursor: "pointer",
              background: meta.barBg,
              opacity: selectedId && !isSel ? 0.55 : 1,
              outline: isSel ? "2px solid #4f46e5" : "none",
              outlineOffset: -2,
              transition: "opacity 0.1s",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 600, color: meta.barText,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}
          >
            {pct > 7 ? meta.label : ""}
          </button>
        );
      })}
    </div>
  );
}

// ─── 行视图（未选中状态：所有 block 列表） ────────────────────────────────────

function NodeRow({
  node, totalChars, onSelect, isSelected,
}: {
  node: ResponseNode;
  totalChars: number;
  onSelect: () => void;
  isSelected: boolean;
}) {
  const meta = slotMeta(node.slotType);
  const pct = totalChars > 0 ? (node.charCount / totalChars * 100).toFixed(1) : "0";

  return (
    <button
      onClick={onSelect}
      style={{
        width: "100%", textAlign: "left",
        background: isSelected ? meta.rowBg : "#fff",
        border: `1px solid ${isSelected ? meta.marker : meta.rowBorder}`,
        borderRadius: 6, padding: "8px 12px",
        marginBottom: 6, cursor: "pointer",
        display: "flex", flexDirection: "column", gap: 4,
        transition: "border-color 0.1s",
      }}
      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.borderColor = meta.marker; }}
      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.borderColor = meta.rowBorder; }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.marker, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: meta.textColor, letterSpacing: "0.04em" }}>
          {meta.label}
        </span>
        {node.wireMeta?.toolName && (
          <span style={{ fontSize: 11, color: "#374151", fontWeight: 600 }}>
            {node.wireMeta.toolName}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 9, color: "#9ca3af" }}>
          {fmtK(node.charCount)} chars · {pct}%
        </span>
      </div>
      {node.preview && (
        <div style={{
          fontSize: 11, color: "#6b7280", lineHeight: 1.5,
          maxHeight: 36, overflow: "hidden", paddingLeft: 16,
          fontFamily: node.slotType === "response.tool_use" ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "inherit",
        }}>
          {node.preview}
        </div>
      )}
      {node.linkedToolResult && (
        <div style={{ paddingLeft: 16, display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 9, color: "#9ca3af" }}>↩ result:</span>
          <span style={{ fontSize: 9, fontWeight: 600, color: node.linkedToolResult.isError ? "#dc2626" : "#16a34a" }}>
            {fmtK(node.linkedToolResult.charCount)} chars
          </span>
          {node.linkedToolResult.nextCallId != null && (
            <span style={{ fontSize: 9, color: "#6366f1" }}>→ Call #{node.linkedToolResult.nextCallId}</span>
          )}
        </div>
      )}
    </button>
  );
}

// ─── 叶子详情视图（选中后） ───────────────────────────────────────────────────

function NodeDetail({
  node, onClose, onLinkCall,
}: {
  node: ResponseNode;
  onClose: () => void;
  onLinkCall?: (callId: number) => void;
}) {
  const meta = slotMeta(node.slotType);
  const isToolUse = node.slotType === "response.tool_use";

  return (
    <div style={{
      background: "#fff", border: `1px solid ${meta.marker}`,
      borderRadius: 8, marginBottom: 8, overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 14px", background: meta.rowBg,
        borderBottom: `1px solid ${meta.rowBorder}`,
      }}>
        <button
          onClick={onClose}
          style={{
            fontSize: 11, padding: "2px 8px", borderRadius: 4,
            background: "#fff", border: "1px solid #e5e7eb",
            cursor: "pointer", color: "#6b7280",
          }}
        >← back</button>
        <span style={{ fontSize: 11, fontWeight: 700, color: meta.textColor }}>
          {meta.label}
        </span>
        {node.wireMeta?.toolName && (
          <span style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>
            {node.wireMeta.toolName}
          </span>
        )}
        {node.wireMeta?.toolUseId && (
          <code style={{ fontSize: 9, color: "#9ca3af" }}>{node.wireMeta.toolUseId}</code>
        )}
        <span style={{ marginLeft: "auto", fontSize: 9, color: "#9ca3af" }}>
          {fmtK(node.charCount)} chars
        </span>
      </div>

      {/* Content */}
      <div style={{ padding: "10px 14px" }}>
        <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 600, letterSpacing: "0.05em", marginBottom: 4 }}>
          {isToolUse ? "INPUT" : "CONTENT"}
        </div>
        <pre style={{
          margin: 0, fontSize: 11, color: "#374151", lineHeight: 1.55,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 280, overflowY: "auto",
          fontFamily: isToolUse ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "inherit",
        }}>
          {node.rawText ?? node.preview}
        </pre>
      </div>

      {/* Linked tool result forwarding */}
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
  const bg = linked.isError ? "#fef2f2" : "#f0fdf4";
  const border = linked.isError ? "#fecaca" : "#bbf7d0";

  return (
    <div style={{
      borderTop: "1px solid #f3f4f6",
      background: bg, padding: "10px 14px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 9, fontWeight: 700, color, letterSpacing: "0.05em" }}>
          ↩ TOOL RESULT
        </span>
        <span style={{ fontSize: 10, color: "#6b7280" }}>
          {fmtK(linked.charCount)} chars{linked.isError ? " · error" : ""}
        </span>
        {linked.nextCallId != null && onLinkCall && (
          <button
            onClick={() => onLinkCall(linked.nextCallId!)}
            title="Locate this tool_result in the Turn timeline"
            style={{
              marginLeft: "auto",
              fontSize: 10, fontWeight: 600,
              padding: "3px 10px", borderRadius: 4,
              background: "#fff", border: `1px solid ${border}`,
              color: "#4338ca", cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#eef2ff"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
          >
            Show in Turn (Call #{linked.nextCallId}) →
          </button>
        )}
      </div>
      {linked.preview && (
        <pre style={{
          margin: 0, fontSize: 10, color: "#374151", lineHeight: 1.5,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 160, overflowY: "auto",
          background: "#fff", border: `1px solid ${border}`, borderRadius: 4,
          padding: "6px 8px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}>
          {linked.preview}
        </pre>
      )}
    </div>
  );
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  callId: number;
  /** 点击 linkedToolResult 时调用：跳转到下游 call 在右侧 drawer 中 */
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
      <div style={{ fontSize: 11, color: "#9ca3af", padding: "24px 0", textAlign: "center" }}>
        {data?.error ?? "No response data available."}
      </div>
    );
  }

  const root = data.snapshot.roots[0];
  const blocks = root?.children ?? [];
  const selected = selectedId
    ? blocks.find((n) => n.id === selectedId) ?? null
    : null;

  return (
    <div>
      {/* Header strip */}
      <div style={{
        display: "flex", alignItems: "baseline", gap: 16,
        marginBottom: 10, padding: "0 2px", flexWrap: "wrap",
      }}>
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

      {/* Top stacked bar */}
      <StackedBar
        children={blocks}
        total={root?.charCount ?? 0}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />

      {/* Selected detail or full list */}
      {selected ? (
        <NodeDetail
          node={selected}
          onClose={() => setSelectedId(null)}
          onLinkCall={onLinkCall}
        />
      ) : (
        <div>
          {blocks.length === 0 && (
            <div style={{ fontSize: 11, color: "#9ca3af", padding: "16px 0", textAlign: "center" }}>
              No content blocks in this response.
            </div>
          )}
          {blocks.map((n) => (
            <NodeRow
              key={n.id}
              node={n}
              totalChars={root?.charCount ?? 0}
              isSelected={false}
              onSelect={() => setSelectedId(n.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
