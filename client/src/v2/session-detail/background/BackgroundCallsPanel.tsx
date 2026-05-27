// BackgroundCallsPanel —— session 级"后台请求"视图：列出 session 在对话主线之外
// 发的 side call（标题生成 / quota 探测 / 提示建议 …），并提供打开单条详情的入口。
//
// 数据来自 /api/v2/sessions/:id/side-calls。captured=false 的行（proxy 没抓到、
// 仅 JSONL 留痕）没有 proxyRequestId / token / model，不提供 open 按钮。

import React, { useEffect, useState } from "react";
import { apiV2, type SideCall, type SideCallKind, type SideCallsResponse } from "../../api";
import { fmtK, fmtDateShort, shortModelName, modelColor } from "../../lib/format";
import { BRAND } from "../../shared/brand";

// kind → 显示标签（平面文本，暂不加 icon）。
const KIND_LABEL: Record<SideCallKind, string> = {
  generate_session_title: "标题生成",
  quota:                  "Quota 探测",
  prompt_suggestion:      "提示建议",
  agent_summary:          "Agent 摘要",
  auto_dream:             "Auto dream",
  extract_memories:       "记忆抽取",
  away_summary:           "离开摘要",
};

function kindLabel(kind: SideCallKind): string {
  return KIND_LABEL[kind] ?? kind;
}

const thStyle: React.CSSProperties = {
  textAlign: "left", padding: "6px 10px", fontSize: 10, fontWeight: 700,
  color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em",
  borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  padding: "6px 10px", fontSize: 12, color: "#374151", verticalAlign: "middle",
};

export function BackgroundCallsPanel({
  sessionId, onOpenSideCall,
}: {
  sessionId: string;
  onOpenSideCall: (proxyRequestId: number) => void;
}) {
  const [data, setData] = useState<SideCallsResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    // 数据加载 effect：标准 fetch-on-mount 模式。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadState("loading");
    apiV2.sideCalls(sessionId)
      .then(d => { if (!cancelled) { setData(d); setLoadState("ok"); } })
      .catch(() => { if (!cancelled) setLoadState("error"); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const sideCalls = data?.sideCalls ?? [];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px", minWidth: 0 }}>
      {/* ── Header + 聚合 ──────────────────────────── */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: "#111827" }}>后台请求</span>
        <span style={{ fontSize: 11, color: "#6b7280" }}>
          {sideCalls.length} 条 ·{" "}
          input <strong style={{ color: "#374151" }}>{fmtK(data?.tokenTotals.input ?? 0)}</strong> ·{" "}
          output <strong style={{ color: "#374151" }}>{fmtK(data?.tokenTotals.output ?? 0)}</strong>
        </span>
      </div>

      {/* caveat */}
      <div style={{
        fontSize: 10, color: "#92400e",
        background: "#fffbeb", border: "1px solid #fde68a",
        borderRadius: 6, padding: "6px 10px", marginBottom: 14, lineHeight: 1.5,
      }}>
        仅显示 proxy 已捕获 + JSONL 留痕的 side call；未开 proxy 时部分后台请求无法捕获、不会出现在此。
      </div>

      {loadState === "loading" && (
        <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0" }}>Loading…</div>
      )}
      {loadState === "error" && (
        <div style={{
          fontSize: 11, color: "#b91c1c",
          background: "#fef2f2", border: "1px solid #fecaca",
          borderRadius: 6, padding: "10px 12px",
        }}>
          加载后台请求失败。
        </div>
      )}
      {loadState === "ok" && sideCalls.length === 0 && (
        <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0" }}>
          没有捕获到 side call。
        </div>
      )}

      {loadState === "ok" && sideCalls.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>类型</th>
              <th style={thStyle}>模型</th>
              <th style={{ ...thStyle, textAlign: "right" }}>输入</th>
              <th style={{ ...thStyle, textAlign: "right" }}>输出</th>
              <th style={thStyle}>时间</th>
              <th style={thStyle}>状态</th>
              <th style={{ ...thStyle, textAlign: "right" }}></th>
            </tr>
          </thead>
          <tbody>
            {sideCalls.map((sc, i) => (
              <SideCallRow key={sc.proxyRequestId ?? `uncaptured-${i}`} sc={sc} onOpen={onOpenSideCall} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SideCallRow({ sc, onOpen }: { sc: SideCall; onOpen: (proxyRequestId: number) => void }) {
  return (
    <tr style={{ borderBottom: "1px solid #f3f4f6" }} className="hover:bg-neutral-50 transition-colors">
      <td style={tdStyle}>
        <span style={{ fontWeight: 600 }}>{kindLabel(sc.kind)}</span>
        {sc.title && (
          <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {sc.title}
          </div>
        )}
      </td>
      <td style={tdStyle}>
        {sc.model ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: modelColor(sc.model), flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: "#6b7280" }}>{shortModelName(sc.model)}</span>
          </span>
        ) : <span style={{ color: "#cbd5e1" }}>—</span>}
      </td>
      <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {sc.inputTokens != null ? fmtK(sc.inputTokens) : <span style={{ color: "#cbd5e1" }}>—</span>}
      </td>
      <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {sc.outputTokens != null ? fmtK(sc.outputTokens) : <span style={{ color: "#cbd5e1" }}>—</span>}
      </td>
      <td style={{ ...tdStyle, color: "#9ca3af", fontSize: 11, whiteSpace: "nowrap" }}>
        {sc.startedAt ? fmtDateShort(sc.startedAt) : "—"}
      </td>
      <td style={tdStyle}>
        {sc.anchored ? (
          <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 8, background: "#ecfdf5", color: "#047857", fontWeight: 600, whiteSpace: "nowrap" }}>
            已在对话中
          </span>
        ) : !sc.captured ? (
          <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 8, background: "#f3f4f6", color: "#6b7280", fontWeight: 600, whiteSpace: "nowrap" }}>
            请求未捕获
          </span>
        ) : (
          <span style={{ color: "#cbd5e1" }}>—</span>
        )}
      </td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        {sc.captured && sc.proxyRequestId != null ? (
          <button
            type="button"
            onClick={() => onOpen(sc.proxyRequestId as number)}
            style={{
              border: "1px solid #c7d2fe", background: BRAND.indigo50, color: BRAND.indigo700,
              borderRadius: 6, padding: "2px 9px", fontSize: 10, fontWeight: 700,
              cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            open
          </button>
        ) : (
          <button
            type="button"
            disabled
            title="proxy 未捕获，无可打开的请求体"
            style={{
              border: "1px solid #e5e7eb", background: "#f9fafb", color: "#cbd5e1",
              borderRadius: 6, padding: "2px 9px", fontSize: 10, fontWeight: 700,
              cursor: "not-allowed", whiteSpace: "nowrap",
            }}
          >
            open
          </button>
        )}
      </td>
    </tr>
  );
}
