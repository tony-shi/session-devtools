import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Session, SessionsResponse } from "../types";
import { SessionDetail } from "./SessionDetail";

const TOOL_BADGE: Record<string, { bg: string; color: string }> = {
  claude: { bg: "#f3e8ff", color: "#7c3aed" },
  codex:  { bg: "#dbeafe", color: "#1d4ed8" },
  gemini: { bg: "#d1fae5", color: "#065f46" },
};

function fmt(ts: string, locale: string) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function SessionRow({ session, onClick, locale }: { session: Session; onClick: () => void; locale: string }) {
  const [hovered, setHovered] = useState(false);
  const badge = TOOL_BADGE[session.tool] ?? { bg: "#f3f4f6", color: "#374151" };
  const totalTokens = (session.input_tokens ?? 0) + (session.output_tokens ?? 0);
  const name = session.project || session.cwd?.split("/").pop() || session.id.slice(0, 8);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 20px", cursor: "pointer",
        background: hovered ? "#f9fafb" : "#fff",
        borderBottom: "1px solid #f3f4f6",
        transition: "background 0.1s",
      }}
    >
      <span style={{
        fontSize: 12, padding: "2px 8px", borderRadius: 20, fontWeight: 500,
        background: badge.bg, color: badge.color, flexShrink: 0, whiteSpace: "nowrap",
      }}>
        {session.tool}
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 14, fontWeight: 500, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </p>
        {session.cwd && (
          <p style={{ fontSize: 12, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
            {session.cwd}
          </p>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "#9ca3af", flexShrink: 0 }}>
        {session.human_turn_count > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            {session.human_turn_count}
          </span>
        )}
        {totalTokens > 0 && (
          <span>{(totalTokens / 1000).toFixed(1)}k tok</span>
        )}
        {session.tool_call_count > 0 && (
          <span>🔧 {session.tool_call_count}</span>
        )}
        <span>{fmt(session.started_at, locale)}</span>
        <svg width="14" height="14" fill="none" stroke={hovered ? "#6b7280" : "#d1d5db"} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </div>
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
    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 20px", borderBottom: "1px solid #f3f4f6",
      }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>{t("sessionList.title")}</h2>
        {data && (
          <span style={{ fontSize: 12, color: "#9ca3af" }}>
            {t("sessionList.count", { count: data.total })}
          </span>
        )}
      </div>

      {loading ? (
        <div>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: "1px solid #f3f4f6" }}>
              <div style={{ width: 56, height: 22, background: "#e5e7eb", borderRadius: 20, animation: "pulse 1.5s ease-in-out infinite" }} />
              <div style={{ flex: 1 }}>
                <div style={{ height: 14, background: "#e5e7eb", borderRadius: 4, width: "40%", marginBottom: 6, animation: "pulse 1.5s ease-in-out infinite" }} />
                <div style={{ height: 12, background: "#f3f4f6", borderRadius: 4, width: "60%", animation: "pulse 1.5s ease-in-out infinite" }} />
              </div>
            </div>
          ))}
        </div>
      ) : !data || data.sessions.length === 0 ? (
        <p style={{ fontSize: 14, color: "#9ca3af", textAlign: "center", padding: "40px 0" }}>{t("sessionList.empty")}</p>
      ) : (
        <div>
          {data.sessions.map((s) => (
            <SessionRow key={s.id} session={s} onClick={() => setSelectedId(s.id)} locale={i18n.language} />
          ))}
        </div>
      )}

      {selectedId && (
        <SessionDetail sessionId={selectedId} date={date} onClose={() => setSelectedId(null)} />
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }`}</style>
    </div>
  );
}
