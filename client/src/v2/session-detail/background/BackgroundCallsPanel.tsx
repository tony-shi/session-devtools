// BackgroundCallsPanel —— session 级"后台请求"视图：列出 session 在对话主线之外
// 发的 side call（标题生成 / quota 探测 / 提示建议 …），并提供打开单条详情的入口。
//
// 数据来自 /api/v2/sessions/:id/side-calls。captured=false 的行（proxy 没抓到、
// 仅 JSONL 留痕）没有 proxyRequestId / token / model，不提供 open 按钮。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiV2, type SideCall, type SideCallKind, type SideCallsResponse } from "../../api";
import { fmtK, fmtDateShort, shortModelName, modelColor } from "../../lib/format";
import { BRAND } from "../../shared/brand";

function kindLabel(t: (k: string) => string, kind: SideCallKind): string {
  const localized = t(`backgroundCalls.kinds.${kind}`);
  return localized !== `backgroundCalls.kinds.${kind}` ? localized : kind;
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
  anchorTurnByProxyId, anchorTurnByAiTitle, onJumpToAnchor,
}: {
  sessionId: string;
  onOpenSideCall: (proxyRequestId: number) => void;
  /** proxyRequestId → 锚定 turn.id；缺席时该 side call 不显示反向跳转。
   *  由 SessionDetailV2 从 drilldown.turns 的事件 generatedByProxyRequestId 反向聚合。 */
  anchorTurnByProxyId: Map<number, number>;
  /** aiTitle 文本 → 锚定 turn.id；用于 proxy 未捕获、仅 JSONL 留痕的 ai-title 行。 */
  anchorTurnByAiTitle: Map<string, number>;
  /** 点击"已在对话中"按钮时回调；负责把 nav 切到目标 turn。 */
  onJumpToAnchor: (turnId: number) => void;
}) {
  const { t } = useTranslation();
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
        <span style={{ fontSize: 14, fontWeight: 800, color: "#111827" }}>{t("backgroundCalls.title")}</span>
        <span style={{ fontSize: 11, color: "#6b7280" }}>
          {sideCalls.length} {t("backgroundCalls.countSuffix")} ·{" "}
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
        {t("backgroundCalls.proxyHint")}
      </div>

      {loadState === "loading" && (
        <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0" }}>{t("proxyTraffic.loading")}</div>
      )}
      {loadState === "error" && (
        <div style={{
          fontSize: 11, color: "#b91c1c",
          background: "#fef2f2", border: "1px solid #fecaca",
          borderRadius: 6, padding: "10px 12px",
        }}>
          {t("backgroundCalls.loadFailed")}
        </div>
      )}
      {loadState === "ok" && sideCalls.length === 0 && (
        <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0" }}>
          {t("backgroundCalls.empty")}
        </div>
      )}

      {loadState === "ok" && sideCalls.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>{t("backgroundCalls.colType")}</th>
              <th style={thStyle}>{t("backgroundCalls.colModel")}</th>
              <th style={{ ...thStyle, textAlign: "right" }}>{t("backgroundCalls.colInput")}</th>
              <th style={{ ...thStyle, textAlign: "right" }}>{t("backgroundCalls.colOutput")}</th>
              <th style={thStyle}>{t("backgroundCalls.colTime")}</th>
              <th style={thStyle}>{t("backgroundCalls.colStatus")}</th>
              <th style={{ ...thStyle, textAlign: "right" }}></th>
            </tr>
          </thead>
          <tbody>
            {sideCalls.map((sc, i) => {
              // 反向锚点解析：先按 proxyRequestId 查，未捕获的 ai-title 兜底按
              // title（=aiTitle）查。两者都找不到 → 该行没有反向跳转链接。
              const anchorTurnId =
                (sc.proxyRequestId != null ? anchorTurnByProxyId.get(sc.proxyRequestId) : undefined)
                ?? (sc.kind === "generate_session_title" && sc.title ? anchorTurnByAiTitle.get(sc.title) : undefined)
                ?? null;
              return (
                <SideCallRow
                  key={sc.proxyRequestId ?? `uncaptured-${i}`}
                  sc={sc}
                  anchorTurnId={anchorTurnId}
                  onOpen={onOpenSideCall}
                  onJumpToAnchor={onJumpToAnchor}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SideCallRow({
  sc, anchorTurnId, onOpen, onJumpToAnchor,
}: {
  sc: SideCall;
  /** 反向锚点：当 side call 在 transcript 中有对应行时，这里是承载它的 turn.id。null = 不可跳转。 */
  anchorTurnId: number | null;
  onOpen: (proxyRequestId: number) => void;
  onJumpToAnchor: (turnId: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <tr style={{ borderBottom: "1px solid #f3f4f6" }} className="hover:bg-neutral-50 transition-colors">
      <td style={tdStyle}>
        <span style={{ fontWeight: 600 }}>{kindLabel(t, sc.kind)}</span>
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
        {anchorTurnId != null ? (
          // 反向跳转按钮：点击切到承载这条 side call JSONL 锚点行的 turn。
          // 视觉沿用旧版"已在对话中" 绿底色，附加 hover 加深 + 下划线提示可点。
          <button
            type="button"
            onClick={() => onJumpToAnchor(anchorTurnId)}
            title={t("backgroundCalls.jumpTooltip", { turnId: anchorTurnId })}
            style={{
              fontSize: 10, padding: "2px 7px", borderRadius: 8,
              background: "#ecfdf5", color: "#047857", fontWeight: 600,
              whiteSpace: "nowrap", border: "1px solid #a7f3d0",
              cursor: "pointer", textDecoration: "underline",
            }}
          >
            → Turn {anchorTurnId}
          </button>
        ) : sc.anchored ? (
          // 兜底：服务端标 anchored=true 但 drilldown 还没载入 / 反向索引未命中
          // （理论上不应发生）。保留旧静态徽章，至少状态语义不丢。
          <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 8, background: "#ecfdf5", color: "#047857", fontWeight: 600, whiteSpace: "nowrap" }}>
            {t("backgroundCalls.inConversation")}
          </span>
        ) : !sc.captured ? (
          <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 8, background: "#f3f4f6", color: "#6b7280", fontWeight: 600, whiteSpace: "nowrap" }}>
            {t("backgroundCalls.uncaptured")}
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
            title={t("backgroundCalls.uncapturedTooltip")}
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
