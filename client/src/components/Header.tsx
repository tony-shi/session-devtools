import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import i18n from "../i18n";

interface Props {
  date: string;
  onDateChange: (date: string) => void;
}

function addDays(date: string, n: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function Header({ date, onDateChange }: Props) {
  const { t } = useTranslation();
  const today = new Date().toISOString().slice(0, 10);
  const isToday = date === today;
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [lang, setLang] = useState(i18n.language);

  const navBtnStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 28, height: 28, borderRadius: 6, border: "none",
    background: "transparent", cursor: "pointer", color: "#6b7280",
  };

  async function handleSync() {
    setSyncing(true);
    setSyncMsg("");
    try {
      const r = await api.sync();
      setSyncMsg(`synced ${r.synced}, skipped ${r.skipped}`);
      setTimeout(() => setSyncMsg(""), 4000);
    } catch {
      setSyncMsg("sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function toggleLang() {
    const next = lang === "zh-CN" ? "en" : "zh-CN";
    i18n.changeLanguage(next);
    localStorage.setItem("lang", next);
    setLang(next);
  }

  return (
    <header style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 20px", height: 48, background: "#fff",
      borderBottom: "1px solid #e5e7eb",
      position: "sticky", top: 0, zIndex: 10, flexShrink: 0,
    }}>
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: 200, flexShrink: 0 }}>
        <div style={{
          width: 24, height: 24, borderRadius: 6, background: "#7c3aed",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}>
          <svg width="13" height="13" fill="none" stroke="white" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <span style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>session-devtools</span>
      </div>

      {/* Date nav — center */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button onClick={() => onDateChange(addDays(date, -1))} style={navBtnStyle} title={t("header.prevDay")}>
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <input
          type="date" value={date}
          onChange={(e) => e.target.value && onDateChange(e.target.value)}
          style={{
            fontSize: 13, fontWeight: 500, color: "#374151",
            border: "1px solid #d1d5db", borderRadius: 6,
            padding: "3px 7px", outline: "none", cursor: "pointer",
          }}
        />
        <button onClick={() => onDateChange(addDays(date, 1))} disabled={isToday}
          style={{ ...navBtnStyle, opacity: isToday ? 0.3 : 1 }} title={t("header.nextDay")}>
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        {!isToday && (
          <button onClick={() => onDateChange(today)} style={{
            fontSize: 12, padding: "3px 8px", borderRadius: 5,
            background: "#f3e8ff", color: "#7c3aed", border: "none",
            cursor: "pointer", fontWeight: 500,
          }}>{t("header.today")}</button>
        )}
      </div>

      {/* Right controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: 200, justifyContent: "flex-end", flexShrink: 0 }}>
        {syncMsg && <span style={{ fontSize: 11, color: "#6b7280" }}>{syncMsg}</span>}
        <button onClick={handleSync} disabled={syncing} style={{
          display: "flex", alignItems: "center", gap: 5,
          fontSize: 12, padding: "4px 10px", borderRadius: 6,
          background: "#f3f4f6", color: "#374151", border: "none",
          cursor: syncing ? "default" : "pointer", opacity: syncing ? 0.6 : 1,
        }}>
          <svg width="12" height="12" style={{ animation: syncing ? "spin 1s linear infinite" : "none" }}
            fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {syncing ? t("header.syncing") : t("header.sync")}
        </button>
        <button onClick={toggleLang} title={t("header.langLabel")} style={{
          fontSize: 11, padding: "4px 8px", borderRadius: 5,
          background: "#f3f4f6", color: "#374151", border: "none",
          cursor: "pointer", fontWeight: 500,
        }}>
          {lang === "zh-CN" ? "EN" : "中文"}
        </button>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </header>
  );
}
