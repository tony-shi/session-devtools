// TeammateMessageNode —— openerSource="teammate-message" 的 turn-opener 节点。
// agent teams 入站消息（含 spawn prompt 首行 / peer DM / idle 通知），不是人类
// 输入。青系（teams 域色）。跳链 → team 总览。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { UserTurn } from "../../../drilldown-types";
import { useSessionDetail } from "../../SessionDetailContext";

export function TeammateMessageNode({ turn }: { turn: UserTurn }) {
  const { t } = useTranslation();
  const { navigate } = useSessionDetail();
  const [expanded, setExpanded] = useState(false);

  const tone = { bg: "#ecfeff", border: "#a5f3fc", fg: "#155e75", dot: "#0e7490" };
  const sender = turn.openerTeammateId;

  return (
    <div style={{ position: "relative", zIndex: 1, display: "flex", gap: 10, padding: "6px 0", alignItems: "flex-start" }}>
      <div style={{ width: 24, display: "flex", justifyContent: "center", flexShrink: 0, paddingTop: 3 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: tone.dot, border: "2px solid #fff", boxShadow: "0 0 0 1px " + tone.border }} />
      </div>
      <div style={{ flex: 1, minWidth: 0, background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 6, padding: "7px 11px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, fontWeight: 800, color: tone.dot, letterSpacing: "0.05em" }}>
            {t("team.inboundLabel", { defaultValue: "队友消息" })}
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: tone.fg }}>
            {sender
              ? t("team.inboundFrom", { defaultValue: "来自 {{sender}}", sender })
              : t("team.inboundUnknownSender", { defaultValue: "发送者未知（无 teammate_id）" })}
          </span>
          {turn.startedAt && <span style={{ fontSize: 9, color: "#9ca3af" }}>{turn.startedAt.slice(11, 19)}</span>}
          <button
            onClick={() => navigate({ level: "team" })}
            className="hover:bg-cyan-100 transition-colors"
            style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: tone.dot, background: "#fff", border: `1px solid ${tone.border}`, borderRadius: 4, padding: "1px 7px", cursor: "pointer" }}
          >
            {t("team.openOverview", { defaultValue: "team 总览" })} ›
          </button>
        </div>
        <div style={{ marginTop: 4 }}>
          <div style={{
            fontSize: 12, color: "#374151", lineHeight: 1.6,
            ...(expanded ? {} : { overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const }),
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>{turn.userInput}</div>
          {turn.userInput.length > 200 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              style={{ fontSize: 10, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: "2px 0 0" }}
            >
              {expanded ? `▴ ${t("team.collapse", { defaultValue: "收起" })}` : `▾ ${t("team.expandFull", { defaultValue: "展开全文" })}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
