import { useEffect, useState } from "react";
import { api } from "./api";
import { apiV2 } from "./v2/api";
import { Header } from "./components/Header";
import { ProxyV2Setup } from "./components/ProxyV2Setup";
import { SessionList } from "./components/SessionList";
import { SummaryCards } from "./components/SummaryCards";
import { SummaryCardsV2 } from "./v2/SummaryCardsV2";
import { SessionListV2 } from "./v2/SessionListV2";
import type { SessionsResponse, SummaryData } from "./types";
import type { DashboardV2, SessionsV2Response } from "./v2/types";

function getInitialDate(): string {
  const hash = window.location.hash.slice(1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(hash)) return hash;
  return new Date().toISOString().slice(0, 10);
}

type Tab = "sessions" | "sessions-v2" | "proxy-v2";

export default function App() {
  const [date, setDate] = useState(getInitialDate);
  const [tab, setTab] = useState<Tab>("sessions");
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionsResponse | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // v2 state
  const [dashboardV2, setDashboardV2] = useState<DashboardV2 | null>(null);
  const [dashboardV2Loading, setDashboardV2Loading] = useState(true);
  const [sessionsV2, setSessionsV2] = useState<SessionsV2Response | null>(null);
  const [sessionsV2Loading, setSessionsV2Loading] = useState(true);

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

  useEffect(() => {
    setDashboardV2Loading(true);
    setSessionsV2Loading(true);
    setDashboardV2(null);
    setSessionsV2(null);

    apiV2.dashboard(date)
      .then(setDashboardV2)
      .catch(console.error)
      .finally(() => setDashboardV2Loading(false));

    apiV2.sessions(date)
      .then(setSessionsV2)
      .catch(console.error)
      .finally(() => setSessionsV2Loading(false));
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
      id: "sessions-v2",
      label: "会话 v2",
      icon: (
        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      ),
    },
    {
      id: "proxy-v2",
      label: "代理",
      icon: (
        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M13 10V3L4 14h7v7l9-11h-7z" />
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
          {tab === "sessions" && (
            <>
              <SummaryCards data={summary} loading={summaryLoading} />
              <SessionList data={sessions} loading={sessionsLoading} date={date} />
            </>
          )}
          {tab === "sessions-v2" && (
            <>
              <SummaryCardsV2 data={dashboardV2} loading={dashboardV2Loading} />
              <SessionListV2 data={sessionsV2} loading={sessionsV2Loading} date={date} />
            </>
          )}
          {tab === "proxy-v2" && <ProxyV2Setup />}
        </main>
      </div>
    </div>
  );
}
