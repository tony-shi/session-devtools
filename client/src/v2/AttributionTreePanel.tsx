import { useEffect, useMemo, useState } from "react";
import { apiV2 } from "./api";
import type {
  AttributionTreeResult,
  SerializedNode,
  SegmentOrigin,
  OriginKind,
} from "./attribution-tree-types";

// ─── 颜色 / 文案表 ───────────────────────────────────────────────────────────

const ORIGIN_STYLE: Record<OriginKind, { bg: string; border: string; color: string; label: string }> = {
  rule:       { bg: "#eef2ff", border: "#c7d2fe", color: "#4338ca", label: "rule" },
  jsonl:      { bg: "#f0fdf4", border: "#bbf7d0", color: "#15803d", label: "jsonl" },
  structural: { bg: "#f9fafb", border: "#e5e7eb", color: "#6b7280", label: "structural" },
  unknown:    { bg: "#fef2f2", border: "#fecaca", color: "#b91c1c", label: "unknown" },
};

function originLabel(origin: SegmentOrigin): string {
  if (origin.kind === "rule") {
    // wire.* 合成 ruleId 渲染成可读形式
    if (origin.ruleId.startsWith("wire.")) return `wire · ${origin.ruleId.slice(5)}`;
    return origin.ruleId;
  }
  if (origin.kind === "jsonl") {
    return `${origin.eventKind} @L${origin.jsonlLineIdx}${origin.sourceCallId !== undefined ? ` · call #${origin.sourceCallId}` : ""}`;
  }
  if (origin.kind === "structural") return `slot · ${origin.reason}`;
  return `unknown · ${origin.reason}`;
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

// ─── Origin chip ────────────────────────────────────────────────────────────

function OriginChip({ origin }: { origin: SegmentOrigin }) {
  const style = ORIGIN_STYLE[origin.kind];
  return (
    <span
      title={originLabel(origin)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        fontSize: 9, fontWeight: 600, color: style.color,
        background: style.bg, border: `1px solid ${style.border}`,
        borderRadius: 3, padding: "1px 5px", whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontSize: 8, opacity: 0.7 }}>{style.label}</span>
      {origin.kind === "jsonl" && origin.toolUseId && (
        <span style={{ fontSize: 8, color: style.color, opacity: 0.7 }}>
          · {origin.toolUseId.slice(0, 12)}…
        </span>
      )}
    </span>
  );
}

// ─── Diff status badge ───────────────────────────────────────────────────────

function DiffBadge({ status }: { status?: "added" | "unchanged" }) {
  if (!status || status === "unchanged") return null;
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, color: "#fff",
      background: "#16a34a", borderRadius: 3, padding: "1px 5px",
      letterSpacing: "0.04em",
    }}>NEW</span>
  );
}

// ─── Tree node rendering ─────────────────────────────────────────────────────

interface NodeRowProps {
  node: SerializedNode;
  depth: number;
  expanded: Set<string>;
  toggleExpand: (id: string) => void;
  leafDiffStatus: Record<string, "added" | "unchanged">;
}

function NodeRow({ node, depth, expanded, toggleExpand, leafDiffStatus }: NodeRowProps) {
  const isLeaf = node.children.length === 0;
  const isExpanded = expanded.has(node.id);

  // 容器 / 叶子按不同密度渲染
  const indent = depth * 14;
  const ownDiff = isLeaf ? leafDiffStatus[node.id] : undefined;
  const hasNewChild = !isLeaf && containsNewLeaf(node, leafDiffStatus);

  return (
    <>
      <div
        onClick={() => !isLeaf && toggleExpand(node.id)}
        style={{
          display: "flex", alignItems: "flex-start", gap: 6,
          padding: "3px 8px 3px 0", paddingLeft: indent + 8,
          fontSize: 11, lineHeight: 1.4,
          cursor: isLeaf ? "default" : "pointer",
          background: ownDiff === "added" ? "#f0fdf4" : hasNewChild ? "#fafafa" : "transparent",
          borderBottom: "1px solid #f9fafb",
        }}
        onMouseEnter={(e) => { if (!isLeaf) (e.currentTarget as HTMLDivElement).style.background = "#f3f4f6"; }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.background =
            ownDiff === "added" ? "#f0fdf4" : hasNewChild ? "#fafafa" : "transparent";
        }}
      >
        {/* 折叠箭头 / 叶子小点 */}
        <span style={{ width: 12, color: "#9ca3af", flexShrink: 0, fontSize: 10 }}>
          {isLeaf ? "·" : isExpanded ? "▾" : "▸"}
        </span>

        {/* slot 标签 */}
        <span style={{
          fontFamily: "ui-monospace, monospace", fontSize: 10,
          color: isLeaf ? "#374151" : "#6b7280",
          fontWeight: isLeaf ? 600 : 500,
          flexShrink: 0,
        }}>
          {shortSlotType(node.slotType)}
        </span>

        {/* origin chip — 仅叶子展示（container 永远是 structural/container_node） */}
        {isLeaf && <OriginChip origin={node.origin} />}

        {/* diff badge */}
        {ownDiff && <DiffBadge status={ownDiff} />}
        {!isLeaf && hasNewChild && !ownDiff && (
          <span style={{
            fontSize: 9, fontWeight: 600, color: "#16a34a",
            background: "#f0fdf4", border: "1px solid #bbf7d0",
            borderRadius: 3, padding: "1px 4px",
          }}>has new</span>
        )}

        {/* 字符数 */}
        <span style={{ fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>
          {fmtK(node.charCount)}
        </span>

        {/* 内容预览（仅叶子） */}
        {isLeaf && (
          <span style={{
            fontSize: 10, color: "#6b7280",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            flex: 1, minWidth: 0,
          }}>
            {node.preview}
          </span>
        )}
      </div>

      {/* 子节点 */}
      {!isLeaf && isExpanded && node.children.map((child) => (
        <NodeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          toggleExpand={toggleExpand}
          leafDiffStatus={leafDiffStatus}
        />
      ))}
    </>
  );
}

function containsNewLeaf(node: SerializedNode, leafDiff: Record<string, "added" | "unchanged">): boolean {
  for (const child of node.children) {
    if (child.children.length === 0) {
      if (leafDiff[child.id] === "added") return true;
    } else if (containsNewLeaf(child, leafDiff)) {
      return true;
    }
  }
  return false;
}

function shortSlotType(slotType: string): string {
  // 去掉 "system.main-prompt.section." 前缀让 UI 紧凑
  return slotType
    .replace("system.main-prompt.section.", "sys.")
    .replace("system.main-prompt-block", "sys.main")
    .replace("messages.", "msg.")
    .replace("tools.builtin.", "tool.");
}

// ─── 顶层 Panel ─────────────────────────────────────────────────────────────

export function AttributionTreePanel({
  sessionId,
  callId,
}: {
  sessionId: string;
  callId: number;
}) {
  const [result, setResult] = useState<AttributionTreeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiV2
      .attributionTree(sessionId, callId)
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        // 默认展开所有顶层 root 节点
        if (r.snapshot) {
          setExpanded(new Set(r.snapshot.roots.map((n) => n.id)));
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId, callId]);

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Summary metrics
  const summary = useMemo(() => {
    if (!result?.snapshot) return null;
    const link = result.linkReport;
    const diff = result.diff?.summary;
    return { link, diff };
  }, [result]);

  if (loading) {
    return <div style={{ padding: "32px 0", textAlign: "center", fontSize: 11, color: "#9ca3af" }}>Loading attribution tree…</div>;
  }

  if (error) {
    return <div style={{ padding: 16, fontSize: 11, color: "#b91c1c", background: "#fef2f2", borderRadius: 6, border: "1px solid #fecaca" }}>
      Failed to load attribution tree: {error}
    </div>;
  }

  if (!result?.snapshot) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "#9ca3af", background: "#fafafa", borderRadius: 6, border: "1px dashed #e5e7eb" }}>
        {result?.error ?? "Attribution tree unavailable — proxy data may be missing for this call."}
      </div>
    );
  }

  const snapshot = result.snapshot;
  const leafDiffStatus = result.diff?.leafStatus ?? {};

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* —— 顶部 summary —— */}
      <div style={{
        display: "flex", gap: 8, padding: "8px 12px",
        background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6,
        fontSize: 10, color: "#374151", flexWrap: "wrap",
      }}>
        <span><b>queryKind:</b> {snapshot.queryKind}</span>
        <span style={{ color: "#d1d5db" }}>·</span>
        <span><b>leaves:</b> {summary?.diff?.currentLeaves ?? "?"}</span>
        {summary?.link && (
          <>
            <span style={{ color: "#d1d5db" }}>·</span>
            <span style={{ color: "#15803d" }}>
              <b>jsonl matched:</b>{" "}
              tool_use {summary.link.matched.toolUse} ·
              tool_result {summary.link.matched.toolResult} ·
              user_input {summary.link.matched.userInput} ·
              assistant_text {summary.link.matched.assistantText}
            </span>
          </>
        )}
        {summary?.diff && result.previousCallId !== null && (
          <>
            <span style={{ color: "#d1d5db" }}>·</span>
            <span>
              <b>vs call #{result.previousCallId}:</b>{" "}
              <span style={{ color: "#16a34a" }}>+{summary.diff.addedLeaves} (+{fmtK(summary.diff.addedChars)}c)</span>{" "}
              <span style={{ color: "#dc2626" }}>−{summary.diff.removedLeaves} (−{fmtK(summary.diff.removedChars)}c)</span>{" "}
              <span style={{ color: "#6b7280" }}>·</span>{" "}
              <span style={{ color: summary.diff.netCharDelta > 0 ? "#dc2626" : summary.diff.netCharDelta < 0 ? "#16a34a" : "#6b7280" }}>
                net {summary.diff.netCharDelta > 0 ? "+" : ""}{fmtK(summary.diff.netCharDelta)}c
              </span>
            </span>
          </>
        )}
      </div>

      {/* —— 控件：展开/折叠全部 —— */}
      <div style={{ display: "flex", gap: 6, fontSize: 10 }}>
        <button
          onClick={() => setExpanded(new Set(Object.keys(snapshot.nodeSummaries)))}
          style={{ fontSize: 10, padding: "3px 8px", background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 4, cursor: "pointer", color: "#374151" }}
        >Expand all</button>
        <button
          onClick={() => setExpanded(new Set(snapshot.roots.map((n) => n.id)))}
          style={{ fontSize: 10, padding: "3px 8px", background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 4, cursor: "pointer", color: "#374151" }}
        >Collapse to roots</button>
      </div>

      {/* —— Tree —— */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 6, overflow: "hidden", background: "#fff" }}>
        {snapshot.roots.map((root) => (
          <NodeRow
            key={root.id}
            node={root}
            depth={0}
            expanded={expanded}
            toggleExpand={toggleExpand}
            leafDiffStatus={leafDiffStatus}
          />
        ))}
      </div>

      {/* —— Removed leaves —— */}
      {result.diff && result.diff.removedFromPrevious.length > 0 && (
        <details style={{ fontSize: 11 }}>
          <summary style={{ cursor: "pointer", color: "#dc2626", padding: "6px 10px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6 }}>
            Removed from previous call: {result.diff.removedFromPrevious.length} leaves
            ({fmtK(result.diff.summary.removedChars)} chars)
          </summary>
          <div style={{ marginTop: 6, border: "1px solid #fecaca", borderRadius: 6, overflow: "hidden" }}>
            {result.diff.removedFromPrevious.map((leaf) => (
              <div key={leaf.nodeId} style={{
                display: "flex", alignItems: "flex-start", gap: 6,
                padding: "4px 10px", fontSize: 10,
                borderBottom: "1px solid #fef2f2", background: "#fff",
              }}>
                <span style={{ fontFamily: "ui-monospace, monospace", color: "#b91c1c", fontWeight: 600, flexShrink: 0 }}>
                  {shortSlotType(leaf.slotType)}
                </span>
                <span style={{ fontSize: 9, color: "#9ca3af", flexShrink: 0 }}>
                  {fmtK(leaf.charCount)}c
                </span>
                <span style={{ color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                  {leaf.preview}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
