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

// ─── 顶部 stacked bar（无边框 / gap 间隔 / 可点击） ───────────────────────────

const BAR_HEIGHT = 44;

function ResponseBar({
  blocks, total, selectedId, onSelect,
}: {
  blocks: ResponseNode[];
  total: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (blocks.length === 0 || total === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, height: BAR_HEIGHT }}>
      {blocks.map((n) => {
        const meta = slotMeta(n.slotType);
        const pct = n.charCount / total;
        const isSel = selectedId === n.id;
        const dimmed = selectedId !== null && !isSel;
        return (
          <button
            key={n.id}
            onClick={() => onSelect(isSel ? null : n.id)}
            title={`${meta.label} · ${fmtK(n.charCount)} chars`}
            style={{
              flex: Math.max(pct, 0.04), minWidth: 64,
              background: meta.barBg,
              opacity: dimmed ? 0.32 : 1,
              border: "none", borderRadius: 6,
              padding: "8px 14px",
              cursor: "pointer", textAlign: "left",
              color: meta.barText,
              display: "flex", flexDirection: "column", justifyContent: "center",
              overflow: "hidden",
              transition: "opacity 0.15s",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {n.wireMeta?.toolName ?? meta.label}
            </div>
            <div style={{ fontSize: 11, fontWeight: 500, opacity: 0.95, lineHeight: 1.25 }}>
              ~{fmtK(n.charCount)}
            </div>
          </button>
        );
      })}
    </div>
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

  return (
    <div style={{
      marginTop: 4,
      background: "#fff", border: "1px solid #e5e7eb",
      borderRadius: 6, overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 12px", background: meta.rowBg,
      }}>
        <button
          onClick={onClose}
          style={{
            fontSize: 11, padding: "3px 10px", borderRadius: 4,
            background: "#fff", border: "1px solid #e5e7eb",
            cursor: "pointer", color: "#374151",
          }}
        >← back</button>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.marker }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: meta.textColor }}>
          {meta.label}
        </span>
        {node.wireMeta?.toolName && (
          <span style={{ fontSize: 11, fontWeight: 600, color: "#374151", fontFamily: "ui-monospace, monospace" }}>
            {node.wireMeta.toolName}
          </span>
        )}
        {node.wireMeta?.toolUseId && (
          <code style={{ fontSize: 9, color: "#9ca3af" }}>{node.wireMeta.toolUseId}</code>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#9ca3af" }}>
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
          background: "#f9fafb", padding: "6px 10px", borderRadius: 4,
          fontFamily: isToolUse ? "ui-monospace, SFMono-Regular, monospace" : "inherit",
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
    <div style={{ borderTop: "1px solid #f3f4f6", background: bg, padding: "10px 14px" }}>
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
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
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
        total={totalChars}
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
