import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiV2 } from "./v2/api";
import { Header } from "./components/Header";
import { ProxyV2Setup } from "./components/ProxyV2Setup";
import { SummaryCardsV2 } from "./v2/SummaryCardsV2";
import { SessionListV2 } from "./v2/SessionListV2";
import type { SessionsV2Response, SummaryV2 } from "./v2/types";

type Tab = "sessions-v2" | "proxy-v2" | "trends";

export default function App() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("sessions-v2");
  const [navOpen, setNavOpen] = useState(true);

  // v2 state
  const [summaryV2, setSummaryV2] = useState<SummaryV2 | null>(null);
  const [summaryV2Loading, setSummaryV2Loading] = useState(true);
  const [sessionsV2, setSessionsV2] = useState<SessionsV2Response | null>(null);
  const [sessionsV2Loading, setSessionsV2Loading] = useState(true);
  const [v2Page, setV2Page] = useState(0);
  const [v2PageSize, setV2PageSize] = useState(8);
  const [v2Search, setV2Search] = useState("");
  const [v2SearchInput, setV2SearchInput] = useState("");

  function fetchV2Sessions(page: number, pageSize = v2PageSize, search = v2Search) {
    setSessionsV2Loading(true);
    apiV2.sessions({ limit: pageSize, offset: page * pageSize, search: search || undefined })
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

  useEffect(() => { fetchV2(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchV2Sessions(v2Page, v2PageSize, v2Search); }, [v2Page, v2PageSize, v2Search]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounce search input: only fire API after 350ms of inactivity
  useEffect(() => {
    const id = setTimeout(() => {
      setV2Search(v2SearchInput);
      setV2Page(0);
    }, 350);
    return () => clearTimeout(id);
  }, [v2SearchInput]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSyncV2() {
    const result = await apiV2.sync();
    setV2Page(0);
    fetchV2();
    return result;
  }

  const NAV_ITEMS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    {
      id: "sessions-v2",
      label: t("nav.sessions"),
      icon: (
        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      ),
    },
    {
      id: "trends",
      label: t("nav.trends"),
      icon: (
        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
        </svg>
      ),
    },
    {
      id: "proxy-v2",
      label: t("nav.proxy"),
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
      <Header />

      <div style={{ display: "flex", flex: 1 }}>
        {/* Sidebar */}
        <nav style={{
          width: navOpen ? 160 : 40,
          flexShrink: 0,
          background: "#fff",
          borderRight: "1px solid #e5e7eb",
          display: "flex",
          flexDirection: "column",
          padding: "8px 6px",
          gap: 2,
          transition: "width 0.15s ease",
          overflow: "hidden",
        }}>
          {/* nav items */}
          {NAV_ITEMS.map(({ id, label, icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                title={!navOpen ? label : undefined}
                style={{
                  display: "flex", alignItems: "center", gap: navOpen ? 8 : 0,
                  justifyContent: navOpen ? "flex-start" : "center",
                  padding: "6px 8px", borderRadius: 7, border: "none",
                  background: active ? "#eef2ff" : "transparent",
                  color: active ? "#6366f1" : "#4b5563",
                  cursor: "pointer", fontSize: 12, fontWeight: active ? 600 : 400,
                  textAlign: "left", width: "100%", whiteSpace: "nowrap",
                  transition: "background 0.1s",
                }}
              >
                <span style={{ color: active ? "#6366f1" : "#9ca3af", flexShrink: 0 }}>{icon}</span>
                {navOpen && label}
              </button>
            );
          })}

          {/* collapse toggle — just below nav items */}
          <div style={{ height: 8 }} />
          <button
            onClick={() => setNavOpen((v) => !v)}
            title={navOpen ? "Collapse" : "Expand"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: "6px", borderRadius: 6, border: "none",
              background: "transparent", cursor: "pointer", color: "#d1d5db",
              flexShrink: 0, marginBottom: 2,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#9ca3af")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#d1d5db")}
          >
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {navOpen
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              }
            </svg>
          </button>
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
                search={v2SearchInput}
                onPageChange={(p) => setV2Page(p)}
                onPageSizeChange={(size) => { setV2PageSize(size); setV2Page(0); }}
                onSearchChange={(s) => setV2SearchInput(s)}
                onSync={handleSyncV2}
              />
            </>
          )}
          {tab === "trends" && (
            <div style={{
              background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb",
              padding: "40px", textAlign: "center",
            }}>
              <p style={{ fontSize: 16, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Trends</p>
              <p style={{ fontSize: 13, color: "#9ca3af" }}>DOING — day-level token and usage trend charts coming soon.</p>
            </div>
          )}
          {tab === "proxy-v2" && <ProxyV2Setup />}
        </main>
      </div>
    </div>
  );
}
