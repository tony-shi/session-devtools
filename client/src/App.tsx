import { useEffect, useState } from "react";
import { api } from "./api";
import { DigestPanel } from "./components/DigestPanel";
import { Header } from "./components/Header";
import { SessionList } from "./components/SessionList";
import { SummaryCards } from "./components/SummaryCards";
import { ProxyTraffic } from "./components/ProxyTraffic";
import type { DigestData, SessionsResponse, SummaryData } from "./types";

function getInitialDate(): string {
  const hash = window.location.hash.slice(1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(hash)) return hash;
  return new Date().toISOString().slice(0, 10);
}

// B2.3: 页面 tab 状态（sessions / proxy）
type Tab = "sessions" | "proxy";

export default function App() {
  const [date, setDate] = useState(getInitialDate);
  const [tab, setTab] = useState<Tab>("sessions");
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionsResponse | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [digest, setDigest] = useState<DigestData | null>(null);
  const [digestLoading, setDigestLoading] = useState(true);

  function handleDateChange(newDate: string) {
    setDate(newDate);
    window.location.hash = newDate;
  }

  useEffect(() => {
    setSummaryLoading(true);
    setSessionsLoading(true);
    setDigestLoading(true);
    setSummary(null);
    setSessions(null);
    setDigest(null);

    api.summary(date)
      .then(setSummary)
      .catch(console.error)
      .finally(() => setSummaryLoading(false));

    api.sessions(date)
      .then(setSessions)
      .catch(console.error)
      .finally(() => setSessionsLoading(false));

    api.digest(date)
      .then(setDigest)
      .catch(console.error)
      .finally(() => setDigestLoading(false));
  }, [date]);

  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f7" }}>
      <Header date={date} onDateChange={handleDateChange} />
      {/* Tab 切换 */}
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "12px 24px 0" }}>
        <div style={{ display: "flex", gap: 0, borderBottom: "2px solid #e5e5e5" }}>
          {(["sessions", "proxy"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "8px 20px",
                border: "none",
                background: "none",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: tab === t ? 600 : 400,
                color: tab === t ? "#007aff" : "#666",
                borderBottom: tab === t ? "2px solid #007aff" : "2px solid transparent",
                marginBottom: -2,
              }}
            >
              {t === "sessions" ? "会话" : "代理流量"}
            </button>
          ))}
        </div>
      </div>
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        {tab === "sessions" ? (
          <>
            <SummaryCards data={summary} loading={summaryLoading} />
            <DigestPanel
              date={date}
              data={digest}
              loading={digestLoading}
              onRefresh={setDigest}
            />
            <SessionList data={sessions} loading={sessionsLoading} date={date} />
          </>
        ) : (
          <ProxyTraffic />
        )}
      </main>
    </div>
  );
}
