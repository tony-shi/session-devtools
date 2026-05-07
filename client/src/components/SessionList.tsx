import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Session, SessionsResponse } from "../types";
import { SessionDetail } from "./SessionDetail";

const TOOL_BADGE: Record<string, { bg: string; color: string }> = {
  claude: { bg: "#f3e8ff", color: "#7c3aed" },
  codex:  { bg: "#dbeafe", color: "#1d4ed8" },
  gemini: { bg: "#d1fae5", color: "#065f46" },
};

function fmtTime(ts: string, locale: string) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

// 表头列定义
const TH: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 11,
  fontWeight: 600,
  color: "#9ca3af",
  textAlign: "left",
  letterSpacing: "0.03em",
  borderBottom: "1px solid #f3f4f6",
  whiteSpace: "nowrap",
};

function SessionRow({
  session,
  onClick,
  locale,
}: {
  session: Session;
  onClick: () => void;
  locale: string;
}) {
  const [hovered, setHovered] = useState(false);
  const badge = TOOL_BADGE[session.tool] ?? { bg: "#f3f4f6", color: "#374151" };
  const totalTokens = (session.input_tokens ?? 0) + (session.output_tokens ?? 0);

  // 主标题：优先 ai/custom-title，其次 project 末段，最后 id 前 8 位
  const displayName =
    session.title ||
    session.project?.split("/").pop() ||
    session.id.slice(0, 8);

  // 最后一条 human input 摘要
  const preview = session.last_input_preview?.trim() ?? "";

  return (
    <tr
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        cursor: "pointer",
        background: hovered ? "#f9fafb" : "#fff",
        transition: "background 0.1s",
      }}
    >
      {/* 工具徽标 */}
      <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
        <span style={{
          fontSize: 11, padding: "2px 7px", borderRadius: 20, fontWeight: 600,
          background: badge.bg, color: badge.color,
        }}>
          {session.tool}
        </span>
      </td>

      {/* 会话名称 + 最后输入摘要 */}
      <td style={{ padding: "10px 12px", maxWidth: 320 }}>
        <p style={{
          fontSize: 13, fontWeight: 500, color: "#111827",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          marginBottom: preview ? 2 : 0,
        }}>
          {displayName}
        </p>
        {preview && (
          <p style={{
            fontSize: 11, color: "#9ca3af",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {preview}
          </p>
        )}
      </td>

      {/* 工作区路径 */}
      <td style={{ padding: "10px 12px", maxWidth: 240 }}>
        <p style={{
          fontSize: 11, color: "#9ca3af",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {session.cwd || "—"}
        </p>
      </td>

      {/* 人工交互次数 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {session.human_turn_count > 0 ? session.human_turn_count : "—"}
        </span>
      </td>

      {/* Tokens */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {totalTokens > 0 ? fmtTokens(totalTokens) : "—"}
        </span>
      </td>

      {/* 工具调用次数 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {session.tool_call_count > 0 ? session.tool_call_count : "—"}
        </span>
      </td>

      {/* 开始时间 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#9ca3af" }}>
          {fmtTime(session.started_at, locale)}
        </span>
      </td>

      {/* 箭头 */}
      <td style={{ padding: "10px 12px", width: 28 }}>
        <svg width="13" height="13" fill="none"
          stroke={hovered ? "#6b7280" : "#d1d5db"} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </td>
    </tr>
  );
}

interface Props {
  data: SessionsResponse | null;
  loading: boolean;
  date: string;
}

export function SessionList({ data, loading, date }: Props) {
  const { t, i18n } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", overflow: "hidden" }}>
      {/* 列表头部 */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 16px", borderBottom: "1px solid #f3f4f6",
      }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
          {t("sessionList.title")}
        </h2>
        {data && (
          <span style={{ fontSize: 11, color: "#9ca3af" }}>
            {t("sessionList.count", { count: data.total })}
          </span>
        )}
      </div>

      {/* 表格 */}
      {loading ? (
        <div>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{
              display: "flex", gap: 12, padding: "12px 16px",
              borderBottom: "1px solid #f9fafb",
            }}>
              <div style={{ width: 48, height: 18, background: "#e5e7eb", borderRadius: 20, animation: "pulse 1.5s ease-in-out infinite" }} />
              <div style={{ flex: 1 }}>
                <div style={{ height: 13, background: "#e5e7eb", borderRadius: 4, width: "35%", marginBottom: 5, animation: "pulse 1.5s ease-in-out infinite" }} />
                <div style={{ height: 11, background: "#f3f4f6", borderRadius: 4, width: "55%", animation: "pulse 1.5s ease-in-out infinite" }} />
              </div>
            </div>
          ))}
        </div>
      ) : !data || data.sessions.length === 0 ? (
        <p style={{ fontSize: 13, color: "#9ca3af", textAlign: "center", padding: "40px 0" }}>
          {t("sessionList.empty")}
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#fafafa" }}>
              <th style={TH}>工具</th>
              <th style={TH}>会话 / 最后输入</th>
              <th style={TH}>工作区</th>
              <th style={{ ...TH, textAlign: "right" }}>交互</th>
              <th style={{ ...TH, textAlign: "right" }}>Tokens</th>
              <th style={{ ...TH, textAlign: "right" }}>工具调用</th>
              <th style={{ ...TH, textAlign: "right" }}>开始</th>
              <th style={TH} />
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                onClick={() => setSelectedId(s.id)}
                locale={i18n.language}
              />
            ))}
          </tbody>
        </table>
      )}

      {selectedId && (
        <SessionDetail sessionId={selectedId} date={date} onClose={() => setSelectedId(null)} />
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }`}</style>
    </div>
  );
}
