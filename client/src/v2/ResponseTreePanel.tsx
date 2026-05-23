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
import { BRAND } from "./shared/brand";
import { Badge } from "@/components/ui/badge";
import type {
  ResponseTreeResult,
  ResponseTreeDataSource,
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
  "response.thinking":  { label: "Thinking",  barBg: BRAND.violet400, barText: "#fff", rowBg: BRAND.violet50, marker: BRAND.violet400, textColor: BRAND.violet800 },
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
            className={!isSel ? "hover:bg-gray-50" : ""}
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
              <span style={{ fontSize: 9, color: BRAND.indigo500, flexShrink: 0 }}>
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

// 把 ResponseTreeDataSource 转成 META 行展示用的可读 source 标签。
// "none" 路径不会走到 NodeDetail，所以这里只处理 proxy-* 两种。
function dataSourceLabel(ds: ResponseTreeDataSource): string {
  if (ds === "proxy-sse") return "proxy SSE";
  if (ds === "proxy-json") return "proxy (non-stream)";
  return ds; // 兜底 — 不应到达
}

function NodeDetail({
  node, dataSource,
}: {
  node: ResponseNode;
  dataSource: ResponseTreeDataSource;
}) {
  const meta = slotMeta(node.slotType);
  const isToolUse = node.slotType === "response.tool_use";
  // structured path: response.tool_use / response.text / response.thinking
  const path = node.slotType;

  // 对 tool_use，rawText 是完整 content block 序列化 `{type, id, name, input}`。
  // 拆出 input 给"渲染"tab；rawJson tab 显示整个对象（含 type/id/name）—— 这就是
  // 用户切到"原始"时应该看到的 wire 真相。
  let renderContent: string;
  let rawJsonObject: unknown;
  if (isToolUse) {
    const parsed = tryParseJson(node.rawText ?? "") as
      | { type?: string; id?: string; name?: string; input?: unknown }
      | undefined;
    if (parsed && typeof parsed === "object") {
      renderContent = parsed.input != null ? JSON.stringify(parsed.input, null, 2) : "";
      rawJsonObject = parsed;
    } else {
      renderContent = node.rawText ?? node.preview;
      rawJsonObject = tryParseJson(node.rawText ?? node.preview);
    }
  } else {
    // text / thinking：rawText 直接是文本，没有 wire envelope
    renderContent = node.rawText ?? node.preview;
    rawJsonObject = undefined;
  }

  return (
    <div style={{ marginTop: 4 }}>
      {/* 不再有 ← back 按钮。关闭交互对齐 lens framework：再点上方
          BlockTable 同一行即收起；没有独立的退出按钮。 */}
      <EventUnitCard
        color={meta.marker}
        bg={meta.rowBg}
        border="#e5e7eb"
        kindLabel={meta.label}
        title={node.wireMeta?.toolName}
        // 不再传 shortId={node.wireMeta?.toolUseId} —— toolu_xxx 是协议层配对
        // token，不属于"语义产出"。要看 id 切到下方"原始 JSON" tab，它在 wire
        // 对象里看得到。
        size={{ bytes: node.charCount, direction: "out" }}
        description={isToolUse ? extractToolDescription(node.rawText ?? node.preview) : undefined}
        segments={[
          {
            label: isToolUse ? "INPUT" : "CONTENT",
            content: renderContent,
            monospace: isToolUse,
            rawJson: rawJsonObject,
          },
        ]}
        coordinate={{ kind: "structured", path, source: dataSourceLabel(dataSource) }}
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

  // dataSource="none" 专门占位：proxy 没存这个 call 的 response，不做 jsonl
  // 反向渲染，明确告诉用户"没有数据"而非展示伪原物。
  if (!data?.snapshot) {
    const isMissing = data?.dataSource === "none";
    return (
      <div style={{ padding: 16, fontSize: 11, color: "#6b7280", background: "#fafafa", borderRadius: 6, border: "1px dashed #e5e7eb", lineHeight: 1.6 }}>
        {isMissing ? (
          <>
            <div style={{ fontWeight: 600, color: "#374151", marginBottom: 4 }}>
              未存储该 call 的 HTTP response 原始数据
            </div>
            <div>
              Response 视图只展示 proxy 抓取的 wire 原物。该 call 未匹配到 proxy 记录
              （旧 session / 无 request-id / proxy 未启用）。如需查看 LLM 决策的事件视角，
              请回到左侧 Turn card 的 Tool Use 行。
            </div>
            {data?.error && (
              <div style={{ marginTop: 6, fontSize: 10, color: "#9ca3af" }}>
                {data.error}
              </div>
            )}
          </>
        ) : (
          <>{data?.error ?? "No response data available."}</>
        )}
      </div>
    );
  }

  const root = data.snapshot.roots[0];
  const blocks = root?.children ?? [];
  const totalChars = root?.charCount ?? 0;
  const selected = selectedId ? blocks.find((n) => n.id === selectedId) ?? null : null;

  // 对齐 lens framework：再点同一行收起 / 点另一行切换 / 上层 bar 也可取消。
  const toggleSelect = (id: string | null) =>
    setSelectedId((cur) => (id !== null && cur === id ? null : id));

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
        {data.truncated && (
          <Badge variant="amber" className="text-[10px] px-1.5 py-0 rounded-sm">SSE 流中断</Badge>
        )}
        <span style={{ marginLeft: "auto", fontSize: 9, color: "#d1d5db" }}>
          source: {dataSourceLabel(data.dataSource)}
        </span>
      </div>

      {/* Layer 1: 顶部 stacked bar */}
      <ResponseBar
        blocks={blocks}
        selectedId={selectedId}
        onSelect={toggleSelect}
      />

      {/* Layer 2: BlockTable 常驻，选中行下方直接挂 NodeDetail（lens 框架范式：
          列表 + inline 详情，没有 ← back 按钮，再点同行收起）。 */}
      {blocks.length === 0 ? (
        <div style={{ fontSize: 11, color: "#9ca3af", padding: "16px 0", textAlign: "center" }}>
          No content blocks in this response.
        </div>
      ) : (
        <>
          <BlockTable
            blocks={blocks}
            totalChars={totalChars}
            selectedId={selectedId}
            onSelect={(id) => toggleSelect(id)}
          />
          {selected && (
            <NodeDetail node={selected} dataSource={data.dataSource} />
          )}
        </>
      )}
    </div>
  );
}
