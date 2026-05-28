import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, useMatch } from "react-router-dom";
import { SessionDetailV2 } from "./v2/SessionDetailV2";
import { apiV2 } from "./v2/api";
import { Header } from "./components/Header";
import { ProxyV2Setup } from "./components/ProxyV2Setup";
import { SummaryCardsV2 } from "./v2/SummaryCardsV2";
import { SessionListV2 } from "./v2/SessionListV2";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { BarChart3, TrendingUp, Zap, ChevronLeft, ChevronRight } from "lucide-react";
import type { SessionsV2Response, SummaryV2, SessionV2 } from "./v2/types";
import { BRAND } from "./v2/shared/brand";

// Optional local-only dev routes. To mount routes like /demo, create
// `client/src/local-routes.tsx` (gitignored) exporting a default React component
// that renders its own <Routes>...</Routes>. import.meta.glob returns an empty
// object when the file is absent, so prod, CI, and fresh clones build cleanly.
const localRoutesModules = import.meta.glob<{ default?: React.ComponentType }>("./local-routes.tsx");
const localRoutesLoader = localRoutesModules["./local-routes.tsx"];
const LocalRoutes = import.meta.env.DEV && localRoutesLoader
  ? lazy(() => localRoutesLoader().then((m) => ({ default: m.default ?? (() => null) })))
  : null;

type Tab = "sessions-v2" | "proxy-v2" | "trends";

// 深链到不在当前列表页的 session 时（刷新 / 别人发的链接），列表里 find 不到
// 这条。用 session_id 造一个最小 stub —— SessionDetailV2 只硬依赖 session_id
// （API 调用 + drilldown），标题等显示字段会被 drilldown.title 覆盖，
// 没覆盖前退化成 session_id。其余统计字段 SessionDetailV2 不直接读（走 drilldown）。
function makeSessionStub(sessionId: string): SessionV2 {
  return {
    session_id: sessionId,
    tool: "claude",
    source_file: "",
    file_mtime: 0,
    file_size: 0,
    parser_version: 0,
    schema_fingerprint: "",
    source_present: 1,
    first_event_at: "",
    last_event_at: "",
    cwd: "",
    project: "",
    custom_title: null,
    ai_title: null,
    first_user_message: "",
    event_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    models: [],
    tool_call_count: 0,
    llm_call_count: 0,
    human_input_count: 0,
    sub_agent_count: 0,
    claude_code_api_error_count: 0,
    parser_warnings: [],
    proxy_count: 0,
    proxy_request_id_count: 0,
    away_summary: null,
    last_assistant_text: null,
  };
}

// 路由层 gate：从 :sessionId 解析出会话，优先用列表里已加载的对象（有完整 meta），
// 找不到就 stub。onClose 回 /sessions。SessionDetailV2 是 Sheet（portal 到 body），
// 渲染位置不影响视觉。
function SessionDetailGate({ sessionId, sessions, onClose }: {
  sessionId: string;
  sessions: SessionV2[];
  onClose: () => void;
}) {
  const session = sessions.find((s) => s.session_id === sessionId) ?? makeSessionStub(sessionId);
  return <SessionDetailV2 session={session} onClose={onClose} />;
}

// Tab ↔ URL path 映射。tab 是历史遗留的 UI 概念，path 是新的 source of truth。
const TAB_TO_PATH: Record<Tab, string> = {
  "sessions-v2": "/sessions",
  "trends": "/trends",
  "proxy-v2": "/proxy",
};
function pathToTab(pathname: string): Tab {
  if (pathname.startsWith("/proxy")) return "proxy-v2";
  if (pathname.startsWith("/trends")) return "trends";
  return "sessions-v2"; // 默认（含 "/" 和 "/sessions"）
}

export default function App() {
  // 全局 history 容器。Phase 1 只接管 tab 切换；session 详情的深链在 Phase 2+
  // 接入，但 BrowserRouter 现在就位以便后续嵌套路由直接用。
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

function AppShell() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  // tab 从 URL 派生（不再是独立 state）—— URL 是唯一真相。
  const tab = pathToTab(location.pathname);
  // 选中的 session 从 URL 派生。useMatch 在 splat 路由 /sessions/:sessionId/* 上
  // 抓 sessionId —— 深链如 /sessions/abc/turn/3 也能拿到 abc。
  const sessionMatch = useMatch("/sessions/:sessionId/*");
  const selectedSessionId = sessionMatch?.params.sessionId ?? null;
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
  // 现在改成 navigate 到对应 path —— 保留这个事件 API 不变（调用方无感），
  // 只是内部从 setTab 换成了 router navigate。
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: Tab }>).detail;
      if (detail?.tab) navigate(TAB_TO_PATH[detail.tab]);
    };
    window.addEventListener("dashboard:navigate", onNav);
    return () => window.removeEventListener("dashboard:navigate", onNav);
  }, [navigate]);

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
                onClick={() => navigate(TAB_TO_PATH[id])}
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
          <Routes>
            {/* 根路径重定向到 sessions */}
            <Route path="/" element={<Navigate to="/sessions" replace />} />
            {/* splat：/sessions、/sessions/:id、/sessions/:id/turn/3 都命中同一元素，
                SessionListV2 不会随深链 remount。selectedSessionId 由 useMatch 派生。 */}
            <Route
              path="/sessions/*"
              element={
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
                    selectedId={selectedSessionId}
                    onOpenSession={(id) => navigate(`/sessions/${id}`)}
                  />
                  {selectedSessionId && (
                    <SessionDetailGate
                      sessionId={selectedSessionId}
                      sessions={sessionsV2?.sessions ?? []}
                      onClose={() => navigate("/sessions")}
                    />
                  )}
                </>
              }
            />
            <Route
              path="/trends"
              element={
                <Card className="py-12">
                  <CardHeader className="text-center items-center">
                    <CardTitle className="text-base">Trends</CardTitle>
                    <CardDescription>DOING — day-level token and usage trend charts coming soon.</CardDescription>
                  </CardHeader>
                </Card>
              }
            />
            <Route path="/proxy" element={<ProxyV2Setup />} />
          </Routes>
          {LocalRoutes && (
            <Suspense fallback={null}><LocalRoutes /></Suspense>
          )}
        </main>
      </div>
    </div>
    </TooltipProvider>
  );
}
