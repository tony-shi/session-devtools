import { useState } from "react";
import { SessionDetail } from "../components/SessionDetail";
import type { SessionV2, SessionsV2Response } from "./types";

const TOOL_BADGE: Record<string, { bg: string; color: string }> = {
  claude: { bg: "#f3e8ff", color: "#7c3aed" },
  codex:  { bg: "#dbeafe", color: "#1d4ed8" },
  gemini: { bg: "#d1fae5", color: "#065f46" },
};

const STOP_COLORS: Record<string, string> = {
  end_turn:  "#059669",
  tool_use:  "#0891b2",
  max_tokens:"#d97706",
};

function fmtTime(ts: string) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function fmtRelative(ts: string) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m 前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h 前`;
  return `${Math.floor(diff / 86_400_000)}d 前`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

const TH: React.CSSProperties = {
  padding: "8px 12px", fontSize: 11, fontWeight: 600, color: "#9ca3af",
  textAlign: "left", letterSpacing: "0.03em",
  borderBottom: "1px solid #f3f4f6", whiteSpace: "nowrap",
};

function StatusDot({ lastEventAt }: { lastEventAt: string }) {
  const diff = Date.now() - new Date(lastEventAt).getTime();
  const active = diff < 5 * 60 * 1000;
  return (
    <span style={{
      display: "inline-block", width: 7, height: 7, borderRadius: "50%",
      background: active ? "#22c55e" : "#d1d5db",
      marginRight: 6, flexShrink: 0,
    }} title={active ? "活跃" : "已结束"} />
  );
}

function SessionRowV2({ session, date, onClick }: { session: SessionV2; date: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const badge = TOOL_BADGE[session.tool] ?? { bg: "#f3f4f6", color: "#374151" };

  const displayName = session.title || session.project || session.session_id.slice(0, 8);
  const cwdLabel = session.cwd
    ? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd
    : session.project?.split("/").pop() ?? "—";
  const preview = session.first_user_message?.trim() ?? "";

  // Detect cross-day: first and last event are on different dates
  const firstDate = session.first_event_at?.slice(0, 10);
  const lastDate = session.last_event_at?.slice(0, 10);
  const crossDay = firstDate && lastDate && firstDate !== lastDate;

  return (
    <tr
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ cursor: "pointer", background: hovered ? "#f9fafb" : "#fff", transition: "background 0.1s" }}
    >
      {/* 工具徽标 */}
      <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 20, fontWeight: 600, background: badge.bg, color: badge.color }}>
          {session.tool}
        </span>
      </td>

      {/* 状态点 + 会话名 + 首条消息预览 */}
      <td style={{ padding: "10px 12px", maxWidth: 300 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <StatusDot lastEventAt={session.last_event_at} />
          <p style={{ fontSize: 13, fontWeight: 500, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: preview ? 2 : 0 }}>
            {displayName}
            {crossDay && <span style={{ marginLeft: 5, fontSize: 10, color: "#9ca3af", fontWeight: 400 }}>跨天</span>}
          </p>
        </div>
        {preview && (
          <p style={{ fontSize: 11, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: 13 }}>
            {preview}
          </p>
        )}
      </td>

      {/* 工作区 */}
      <td style={{ padding: "10px 12px", maxWidth: 160 }}>
        <p style={{ fontSize: 11, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {cwdLabel}
        </p>
      </td>

      {/* 人工交互 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {session.human_input_count > 0 ? session.human_input_count : "—"}
        </span>
      </td>

      {/* Tokens (lifetime) */}
      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 10px" }}>
          <span style={{ fontSize: 10, color: "#d97706" }}>W {session.cache_creation_tokens > 0 ? fmtTokens(session.cache_creation_tokens) : "—"}</span>
          <span style={{ fontSize: 10, color: "#059669" }}>R {session.cache_read_tokens > 0 ? fmtTokens(session.cache_read_tokens) : "—"}</span>
          <span style={{ fontSize: 10, color: "#6366f1" }}>in {session.input_tokens > 0 ? fmtTokens(session.input_tokens) : "—"}</span>
          <span style={{ fontSize: 10, color: "#7c3aed" }}>out {session.output_tokens > 0 ? fmtTokens(session.output_tokens) : "—"}</span>
        </div>
      </td>

      {/* 工具调用 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {session.tool_call_count > 0 ? session.tool_call_count : "—"}
        </span>
      </td>

      {/* Models */}
      <td style={{ padding: "8px 12px", maxWidth: 130 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {session.models.map((m) => (
            <span key={m} style={{ fontSize: 10, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {m.replace("claude-", "").replace(/-\d{8}$/, "")}
            </span>
          ))}
        </div>
      </td>

      {/* Proxy 请求数 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        {session.proxy_count > 0 ? (
          <span style={{
            fontSize: 11, padding: "1px 7px", borderRadius: 12,
            background: "#eff6ff", color: "#3b82f6", fontWeight: 500,
          }}>
            {session.proxy_count}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "#d1d5db" }}>—</span>
        )}
      </td>

      {/* 最后活跃 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 11, color: "#9ca3af" }} title={session.last_event_at}>
          {fmtRelative(session.last_event_at)}
        </span>
        <br />
        <span style={{ fontSize: 10, color: "#d1d5db" }}>
          {fmtTime(session.first_event_at)}
        </span>
      </td>

      {/* 箭头 */}
      <td style={{ padding: "10px 12px", width: 28 }}>
        <svg width="13" height="13" fill="none" stroke={hovered ? "#6b7280" : "#d1d5db"} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </td>
    </tr>
  );
}

interface Props {
  data: SessionsV2Response | null;
  loading: boolean;
  date: string;
}

export function SessionListV2({ data, loading, date }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid #f3f4f6" }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
          会话列表
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: "#9ca3af", background: "#f3f4f6", padding: "2px 7px", borderRadius: 12 }}>v2</span>
        </h2>
        {data && (
          <span style={{ fontSize: 11, color: "#9ca3af" }}>{data.total} 条</span>
        )}
      </div>

      {loading ? (
        <div>
          {[1,2,3,4,5].map((i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "12px 16px", borderBottom: "1px solid #f9fafb" }}>
              <div style={{ width: 48, height: 18, background: "#e5e7eb", borderRadius: 20, animation: "pulse 1.5s ease-in-out infinite" }} />
              <div style={{ flex: 1 }}>
                <div style={{ height: 13, background: "#e5e7eb", borderRadius: 4, width: "35%", marginBottom: 5, animation: "pulse 1.5s ease-in-out infinite" }} />
                <div style={{ height: 11, background: "#f3f4f6", borderRadius: 4, width: "55%", animation: "pulse 1.5s ease-in-out infinite" }} />
              </div>
            </div>
          ))}
        </div>
      ) : !data || data.sessions.length === 0 ? (
        <p style={{ fontSize: 13, color: "#9ca3af", textAlign: "center", padding: "40px 0" }}>暂无会话</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#fafafa" }}>
              <th style={TH}>工具</th>
              <th style={TH}>会话 / 首条消息</th>
              <th style={TH}>工作区</th>
              <th style={{ ...TH, textAlign: "right" }}>交互</th>
              <th style={TH}>Tokens (lifetime)</th>
              <th style={{ ...TH, textAlign: "right" }}>工具调用</th>
              <th style={TH}>模型</th>
              <th style={{ ...TH, textAlign: "right" }}>Proxy</th>
              <th style={{ ...TH, textAlign: "right" }}>最后活跃</th>
              <th style={TH} />
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <SessionRowV2
                key={s.session_id}
                session={s}
                date={date}
                onClick={() => setSelectedId(s.session_id)}
              />
            ))}
          </tbody>
        </table>
      )}

      {/* 复用 v1 SessionDetail — session_id 格式相同，v1 API 仍然可用 */}
      {selectedId && (
        <SessionDetail sessionId={selectedId} date={date} onClose={() => setSelectedId(null)} />
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }`}</style>
    </div>
  );
}
