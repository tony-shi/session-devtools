import { useEffect, useState } from "react";
import { api } from "./api";
import { Header } from "./components/Header";
import { ProxyPanel } from "./components/ProxyPanel";
import { SessionList } from "./components/SessionList";
import { SummaryCards } from "./components/SummaryCards";
import type { SessionsResponse, SummaryData } from "./types";

function getInitialDate(): string {
  const hash = window.location.hash.slice(1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(hash)) return hash;
  return new Date().toISOString().slice(0, 10);
}

type Tab = "sessions" | "proxy";

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

  const NAV_ITEMS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    {
      id: "sessions",
      label: "会话",
      icon: (
        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      ),
    },
    {
      id: "proxy",
      label: "代理",
      icon: (
        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#f0f2f5" }}>
      {/* Topbar */}
      <Header date={date} onDateChange={handleDateChange} />

      {/* Body: sidebar + content */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar */}
        <nav style={{
          width: 200,
          flexShrink: 0,
          background: "#fff",
          borderRight: "1px solid #e5e7eb",
          display: "flex",
          flexDirection: "column",
          padding: "12px 8px",
          gap: 2,
        }}>
          {NAV_ITEMS.map(({ id, label, icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                style={{
                  display: "flex", alignItems: "center", gap: 9,
                  padding: "7px 10px", borderRadius: 7, border: "none",
                  background: active ? "#f3e8ff" : "transparent",
                  color: active ? "#7c3aed" : "#4b5563",
                  cursor: "pointer", fontSize: 13, fontWeight: active ? 600 : 400,
                  textAlign: "left", width: "100%",
                  transition: "background 0.1s",
                }}
              >
                <span style={{ color: active ? "#7c3aed" : "#9ca3af", flexShrink: 0 }}>{icon}</span>
                {label}
              </button>
            );
          })}
        </nav>

        {/* Main content */}
        <main style={{
          flex: 1,
          overflow: "auto",
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          minWidth: 0,
        }}>
          {tab === "sessions" ? (
            <>
              <SummaryCards data={summary} loading={summaryLoading} />
              <SessionList data={sessions} loading={sessionsLoading} date={date} />
            </>
          ) : (
            <ProxyPanel />
          )}
        </main>
      </div>
    </div>
  );
}
