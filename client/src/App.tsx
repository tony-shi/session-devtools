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
import type { SessionsV2Response, SummaryV2 } from "./v2/types";

function getInitialDate(): string {
  const hash = window.location.hash.slice(1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(hash)) return hash;
  return new Date().toISOString().slice(0, 10);
}

type Tab = "sessions" | "sessions-v2" | "proxy-v2" | "daily-analysis";

export default function App() {
  const [date, setDate] = useState(getInitialDate);
  const [tab, setTab] = useState<Tab>("sessions-v2");
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionsResponse | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // v2 state — not date-driven
  const [summaryV2, setSummaryV2] = useState<SummaryV2 | null>(null);
  const [summaryV2Loading, setSummaryV2Loading] = useState(true);
  const [sessionsV2, setSessionsV2] = useState<SessionsV2Response | null>(null);
  const [sessionsV2Loading, setSessionsV2Loading] = useState(true);
  const [v2Page, setV2Page] = useState(0);
  const [v2PageSize, setV2PageSize] = useState(10);

  function handleDateChange(newDate: string) {
    setDate(newDate);
    window.location.hash = newDate;
  }

  // V1: re-fetch on date change
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

  function fetchV2Sessions(page: number, pageSize = v2PageSize) {
    setSessionsV2Loading(true);
    apiV2.sessions({ limit: pageSize, offset: page * pageSize })
      .then(setSessionsV2)
      .catch(console.error)
      .finally(() => setSessionsV2Loading(false));
  }

  function fetchV2() {
    setSummaryV2Loading(true);
    apiV2.summary()
      .then(setSummaryV2)
      .catch(console.error)
      .finally(() => setSummaryV2Loading(false));
    fetchV2Sessions(v2Page);
  }

  // V2: fetch once on mount (lifecycle view, not date-driven)
  useEffect(() => { fetchV2(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchV2Sessions(v2Page, v2PageSize); }, [v2Page, v2PageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSyncV2() {
    const result = await apiV2.sync();
    setV2Page(0);
    fetchV2();
    return result;
  }

  const NAV_ITEMS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    {
      id: "sessions-v2",
      label: "Sessions",
      icon: (
        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      ),
    },
    {
      id: "daily-analysis",
      label: "Daily Analysis",
      icon: (
        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      id: "sessions",
      label: "会话 (v1)",
      icon: (
        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
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
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", background: "#f0f2f5" }}>
      {/* Topbar */}
      <Header
        date={date}
        onDateChange={handleDateChange}
        onSync={tab === "sessions-v2" || tab === "daily-analysis" ? handleSyncV2 : undefined}
        showDatePicker={tab === "sessions"}
      />

      {/* Body: sidebar + content */}
      <div style={{ display: "flex", flex: 1 }}>
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
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          minWidth: 0,
          minHeight: 0,
        }}>
          {tab === "sessions-v2" && (
            <>
              <SummaryCardsV2 data={summaryV2} loading={summaryV2Loading} />
              <SessionListV2
                data={sessionsV2}
                loading={sessionsV2Loading}
                page={v2Page}
                pageSize={v2PageSize}
                onPageChange={(p) => setV2Page(p)}
                onPageSizeChange={(size) => { setV2PageSize(size); setV2Page(0); }}
              />
            </>
          )}
          {tab === "daily-analysis" && (
            <div style={{
              background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb",
              padding: "40px", textAlign: "center",
            }}>
              <p style={{ fontSize: 16, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Daily Analysis</p>
              <p style={{ fontSize: 13, color: "#9ca3af" }}>Working on it — day-level token and event breakdown coming soon.</p>
            </div>
          )}
          {tab === "sessions" && (
            <>
              <SummaryCards data={summary} loading={summaryLoading} />
              <SessionList data={sessions} loading={sessionsLoading} date={date} />
            </>
          )}
          {tab === "proxy-v2" && <ProxyV2Setup />}
        </main>
      </div>
    </div>
  );
}
