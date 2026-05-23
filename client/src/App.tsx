import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiV2 } from "./v2/api";
import { Header } from "./components/Header";
import { ProxyV2Setup } from "./components/ProxyV2Setup";
import { SummaryCardsV2 } from "./v2/SummaryCardsV2";
import { SessionListV2 } from "./v2/SessionListV2";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { BarChart3, TrendingUp, Zap, ChevronLeft, ChevronRight } from "lucide-react";
import type { SessionsV2Response, SummaryV2 } from "./v2/types";
import { BRAND } from "./v2/shared/brand";

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

  // Cross-component nav: any descendant can ask App to switch tabs via
  //   window.dispatchEvent(new CustomEvent("dashboard:navigate", { detail: { tab: "proxy-v2" } }))
  // We don't have a router; this glue is the minimum to let in-detail
  // links (e.g. "去启动 →", "打开代理设置 →" in ProxyMissingEmptyState)
  // jump out to the Proxy tab without prop-drilling setTab through 6 levels.
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: Tab }>).detail;
      if (detail?.tab) setTab(detail.tab);
    };
    window.addEventListener("dashboard:navigate", onNav);
    return () => window.removeEventListener("dashboard:navigate", onNav);
  }, []);

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
    { id: "sessions-v2", label: t("nav.sessions"), icon: <BarChart3 size={15} /> },
    { id: "trends",      label: t("nav.trends"),   icon: <TrendingUp size={15} /> },
    { id: "proxy-v2",    label: t("nav.proxy"),    icon: <Zap size={15} /> },
  ];

  return (
    <TooltipProvider delayDuration={150}>
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
                  padding: "6px 8px", borderRadius: 6, border: "none",
                  background: active ? BRAND.indigo50 : "transparent",
                  color: active ? BRAND.indigo500 : "#4b5563",
                  cursor: "pointer", fontSize: 12, fontWeight: active ? 600 : 400,
                  textAlign: "left", width: "100%", whiteSpace: "nowrap",
                  transition: "background 0.1s",
                }}
              >
                <span style={{ color: active ? BRAND.indigo500 : "#9ca3af", flexShrink: 0 }}>{icon}</span>
                {navOpen && label}
              </button>
            );
          })}

          {/* collapse toggle — just below nav items */}
          <div style={{ height: 8 }} />
          <button
            onClick={() => setNavOpen((v) => !v)}
            title={navOpen ? "Collapse" : "Expand"}
            className="text-gray-300 hover:text-gray-400 transition-colors"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: "6px", borderRadius: 6, border: "none",
              background: "transparent", cursor: "pointer",
              flexShrink: 0, marginBottom: 2,
            }}
          >
            {navOpen ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
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
            <Card className="py-12">
              <CardHeader className="text-center items-center">
                <CardTitle className="text-base">Trends</CardTitle>
                <CardDescription>DOING — day-level token and usage trend charts coming soon.</CardDescription>
              </CardHeader>
            </Card>
          )}
          {tab === "proxy-v2" && <ProxyV2Setup />}
        </main>
      </div>
    </div>
    </TooltipProvider>
  );
}
