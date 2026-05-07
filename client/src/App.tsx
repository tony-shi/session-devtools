import { useEffect, useState } from "react";
import { api } from "./api";
import { Header } from "./components/Header";
import { SessionList } from "./components/SessionList";
import { SummaryCards } from "./components/SummaryCards";
import { ProxyTraffic } from "./components/ProxyTraffic";
import { ProxySetup } from "./components/ProxySetup";
import type { SessionsResponse, SummaryData } from "./types";

function getInitialDate(): string {
  const hash = window.location.hash.slice(1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(hash)) return hash;
  return new Date().toISOString().slice(0, 10);
}

type Tab = "sessions" | "proxy" | "setup";

export default function App() {
  const [date, setDate] = useState(getInitialDate);
  const [tab, setTab] = useState<Tab>("sessions");
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionsResponse | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  function handleDateChange(newDate: string) {
    setDate(newDate);
    window.location.hash = newDate;
  }

  useEffect(() => {
    setSummaryLoading(true);
    setSessionsLoading(true);
    setSummary(null);
    setSessions(null);

    api.summary(date)
      .then(setSummary)
      .catch(console.error)
      .finally(() => setSummaryLoading(false));

    api.sessions(date)
      .then(setSessions)
      .catch(console.error)
      .finally(() => setSessionsLoading(false));
  }, [date]);

  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f7" }}>
      <Header date={date} onDateChange={handleDateChange} />
      {/* Tab 切换 */}
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "12px 24px 0" }}>
        <div style={{ display: "flex", gap: 0, borderBottom: "2px solid #e5e5e5" }}>
          {([
            { id: "sessions", label: "会话" },
            { id: "proxy",    label: "代理流量" },
            { id: "setup",    label: "代理管理" },
          ] as { id: Tab; label: string }[]).map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                padding: "8px 20px",
                border: "none",
                background: "none",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: tab === id ? 600 : 400,
                color: tab === id ? "#007aff" : "#666",
                borderBottom: tab === id ? "2px solid #007aff" : "2px solid transparent",
                marginBottom: -2,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        {tab === "sessions" ? (
          <>
            <SummaryCards data={summary} loading={summaryLoading} />
            <SessionList data={sessions} loading={sessionsLoading} date={date} />
          </>
        ) : tab === "proxy" ? (
          <ProxyTraffic />
        ) : (
          <ProxySetup />
        )}
      </main>
    </div>
  );
}
