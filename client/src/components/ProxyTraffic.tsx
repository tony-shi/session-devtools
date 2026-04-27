// 代理流量列表 + 单请求详情（lazy load）。
import { useCallback, useEffect, useRef, useState } from "react";

const T = {
  title:          { zh: "代理流量", en: "Proxy Traffic" },
  live:           { zh: "实时", en: "Live" },
  paused:         { zh: "已暂停", en: "Paused" },
  noData:         { zh: "暂无流量记录", en: "No traffic yet" },
  category:       { zh: "类别", en: "Category" },
  method:         { zh: "方法", en: "Method" },
  status:         { zh: "状态", en: "Status" },
  path:           { zh: "路径", en: "Path" },
  duration:       { zh: "耗时", en: "Duration" },
  size:           { zh: "大小", en: "Size" },
  reqHeaders:     { zh: "请求头", en: "Request Headers" },
  resHeaders:     { zh: "响应头", en: "Response Headers" },
  reqBody:        { zh: "请求体（明文）", en: "Request Body (plaintext)" },
  resBody:        { zh: "响应体（明文）", en: "Response Body (plaintext)" },
  loading:        { zh: "加载中…", en: "Loading…" },
  loadBody:       { zh: "点击展开", en: "Click to expand" },
  sync:           { zh: "同步", en: "Sync" },
  syncing:        { zh: "同步中…", en: "Syncing…" },
  filterAll:      { zh: "全部", en: "All" },
  captureTargets: { zh: "拦截目标", en: "Capture Targets" },
  addHost:        { zh: "添加主机", en: "Add Host" },
  removeHost:     { zh: "移除", en: "Remove" },
  saveTargets:    { zh: "保存", en: "Save" },
  targetsSaved:   { zh: "已生效，无需重启", en: "Applied, no restart needed" },
  parseCol:       { zh: "解析", en: "Parse" },
  loadMore:       { zh: "加载更多", en: "Load more" },
  loadingMore:    { zh: "加载中…", en: "Loading…" },
  noMore:         { zh: "已加载全部", en: "All loaded" },
};

type Lang = "zh" | "en";
function getLang(): Lang { return localStorage.getItem("lang") === "en" ? "en" : "zh"; }
function t(key: keyof typeof T, lang: Lang): string { return T[key][lang]; }

// ── 请求分类 ──────────────────────────────────────────────────────────────────

type Category = "llm" | "auth" | "telemetry" | "mcp" | "other";

interface CategoryMeta {
  label: { zh: string; en: string };
  color: string;
  bg: string;
}

const CATEGORY_META: Record<Category, CategoryMeta> = {
  llm:       { label: { zh: "LLM 推理", en: "LLM"       }, color: "#7c3aed", bg: "#f5f0ff" },
  auth:      { label: { zh: "认证",     en: "Auth"      }, color: "#0369a1", bg: "#e0f2fe" },
  telemetry: { label: { zh: "遥测",     en: "Telemetry" }, color: "#92400e", bg: "#fef3c7" },
  mcp:       { label: { zh: "MCP",      en: "MCP"       }, color: "#065f46", bg: "#d1fae5" },
  other:     { label: { zh: "其他",     en: "Other"     }, color: "#555",    bg: "#f0f0f0" },
};

function classifyRequest(url: string, sni: string): Category {
  const u = url.toLowerCase();
  // LLM 推理：/v1/messages、/v1/complete、count_tokens
  if (/\/v1\/messages|\/v1\/complete|count_tokens/.test(u)) return "llm";
  // 认证：oauth、create_api_key、platform.claude.com/oauth
  if (/oauth|api_key|platform\.claude\.com/.test(u)) return "auth";
  // 遥测：metrics、sentry、statsig、amplitude、telemetry
  if (/metrics|sentry|statsig|amplitude|telemetry/.test(u)) return "telemetry";
  // MCP：mcp-proxy、mcp-registry、/v1/mcp/
  if (/mcp/.test(u) || /mcp/.test(sni.toLowerCase())) return "mcp";
  return "other";
}

// ── 数据结构 ──────────────────────────────────────────────────────────────────

interface ProxyRequest {
  id: number;
  ts: string;
  started_at?: string;
  sni: string;
  method: string;
  url: string;
  status: number | null;
  bytes_in: number;
  bytes_out: number;
  duration_ms: number | null;
  req_headers: Record<string, string> | string;
  res_headers: Record<string, string> | string;
  req_body: string;
  res_body: string;
  sse_event_count: number;
  is_stream: number | boolean;
}

function parseHeaders(h: Record<string, string> | string): Record<string, string> {
  if (typeof h === "string") { try { return JSON.parse(h); } catch { return {}; } }
  return h ?? {};
}

function formatBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function statusColor(s: number | null): string {
  if (!s) return "#999";
  if (s < 300) return "#34c759";
  if (s < 400) return "#ff9f0a";
  return "#ff3b30";
}

function pathFromUrl(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function requestStartedAt(req: ProxyRequest): string {
  return req.started_at || req.ts;
}

function mergeRequests(prev: ProxyRequest[], incoming: ProxyRequest[]): ProxyRequest[] {
  const byId = new Map<number, ProxyRequest>();
  for (const req of prev) byId.set(req.id, req);
  for (const req of incoming) byId.set(req.id, req);
  return [...byId.values()]
    .sort((a, b) => {
      const byStartedAt = requestStartedAt(b).localeCompare(requestStartedAt(a));
      return byStartedAt !== 0 ? byStartedAt : b.id - a.id;
    });
}

// ── 懒加载消息体 ──────────────────────────────────────────────────────────────

// 解析占位符，返回可读描述
function parsePlaceholder(value: string, lang: Lang): string | null {
  // [truncated N bytes] — safeBody() 在 req_body > 256KB 时截断
  const truncMatch = value.match(/^\[truncated (\d+) bytes\]$/);
  if (truncMatch) {
    const bytes = Number(truncMatch[1]);
    return lang === "zh"
      ? `[请求体过大（${formatBytes(bytes)}），落盘时已截断；原始流量已完整转发]`
      : `[Body too large (${formatBytes(bytes)}), truncated on disk; original traffic forwarded intact]`;
  }
  // [sse N events, M bytes] — SSE 流式响应汇总
  const sseMatch = value.match(/^\[sse (\d+) events, (\d+) bytes\]$/);
  if (sseMatch) {
    const events = Number(sseMatch[1]);
    const bytes = Number(sseMatch[2]);
    if (events === 0) {
      return lang === "zh"
        ? `[SSE 流式响应，${formatBytes(bytes)}，未解析到完整事件（可能被提前关闭或格式非标准）]`
        : `[SSE stream, ${formatBytes(bytes)}, no complete events parsed (possibly closed early or non-standard format)]`;
    }
    return lang === "zh"
      ? `[SSE 流式响应，${events} 个事件，${formatBytes(bytes)}]`
      : `[SSE stream, ${events} events, ${formatBytes(bytes)}]`;
  }
  // [stream N bytes] / [binary N bytes]
  if (value.startsWith("[stream ") || value.startsWith("[binary ")) return value;
  return null;
}

function LazyBody({ value, lang }: { value: string; lang: Lang }) {
  const [open, setOpen] = useState(false);

  if (!value || value === "") return <span style={{ color: "#ccc", fontSize: 12 }}>—</span>;

  const placeholder = parsePlaceholder(value, lang);
  if (placeholder !== null) {
    return <span style={{ color: "#999", fontSize: 12, fontStyle: "italic" }}>{placeholder}</span>;
  }

  if (!open) {
    const preview = value.length > 80 ? value.slice(0, 80) + "…" : value;
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", width: "100%" }}
      >
        <span style={{ fontSize: 11, color: "#999", fontFamily: "monospace" }}>{preview}</span>
        <span style={{ marginLeft: 6, fontSize: 10, color: "#007aff" }}>{t("loadBody", lang)}</span>
      </button>
    );
  }

  let pretty = value;
  try { pretty = JSON.stringify(JSON.parse(value), null, 2); } catch { void 0; }

  return (
    <div>
      <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#999", marginBottom: 4, padding: 0 }}>
        ▲ 收起
      </button>
      <pre style={{
        background: "#1a1a1a", color: "#e8e8e8", borderRadius: 6,
        padding: "10px 12px", fontSize: 11, overflow: "auto",
        maxHeight: 400, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all",
        fontFamily: "monospace",
      }}>
        {pretty}
      </pre>
    </div>
  );
}

// ── 单请求详情抽屉 ────────────────────────────────────────────────────────────

function RequestDetail({ req, lang, onClose }: { req: ProxyRequest; lang: Lang; onClose: () => void }) {
  const reqHeaders = parseHeaders(req.req_headers);
  const resHeaders = parseHeaders(req.res_headers);
  const cat = classifyRequest(req.url, req.sni);
  const catMeta = CATEGORY_META[cat];

  return (
    <div style={{
      position: "fixed", top: 0, right: 0, bottom: 0, width: "min(640px, 100vw)",
      background: "#fff", boxShadow: "-4px 0 32px rgba(0,0,0,0.14)",
      zIndex: 1000, display: "flex", flexDirection: "column",
    }}>
      {/* 固定头部 */}
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #f0f0f0", flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{req.method}</span>
              <span style={{ color: statusColor(req.status), fontWeight: 600, fontSize: 15 }}>{req.status ?? "—"}</span>
              <span style={{
                fontSize: 11, padding: "2px 7px", borderRadius: 10,
                background: catMeta.bg, color: catMeta.color, fontWeight: 600,
              }}>
                {catMeta.label[lang]}
              </span>
              {(req.is_stream === 1 || req.is_stream === true) && (
                <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 10, background: "#f0f0f0", color: "#666" }}>SSE</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#666", wordBreak: "break-all" }}>{req.url}</div>
            <div style={{ fontSize: 11, color: "#999" }}>
              {requestStartedAt(req)} · {req.duration_ms != null ? `${req.duration_ms}ms` : "—"} · {formatBytes(req.bytes_out || req.bytes_in)}
              {req.sse_event_count > 0 && ` · ${req.sse_event_count} SSE events`}
            </div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 22, color: "#999", flexShrink: 0, marginLeft: 12 }}>✕</button>
        </div>
      </div>

      {/* 滚动内容区 */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
        <DetailSection title={t("reqHeaders", lang)}>
          <HeaderTable headers={reqHeaders} />
        </DetailSection>

        <DetailSection title={t("reqBody", lang)}>
          <LazyBody value={req.req_body} lang={lang} />
        </DetailSection>

        <DetailSection title={t("resHeaders", lang)}>
          <HeaderTable headers={resHeaders} />
        </DetailSection>

        <DetailSection title={t("resBody", lang)}>
          <LazyBody value={req.res_body} lang={lang} />
        </DetailSection>
      </div>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 11, color: "#999", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (!entries.length) return <span style={{ color: "#ccc", fontSize: 12 }}>—</span>;
  return (
    <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k} style={{ borderBottom: "1px solid #f5f5f5" }}>
            <td style={{ padding: "3px 10px 3px 0", color: "#888", whiteSpace: "nowrap", verticalAlign: "top", width: 1 }}>{k}</td>
            <td style={{ padding: "3px 0", wordBreak: "break-all", color: "#333" }}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Capture Targets ───────────────────────────────────────────────────────────

function CaptureTargets({ lang, onSaved }: { lang: Lang; onSaved: () => void }) {
  const [hosts, setHosts] = useState<string[]>([]);
  const [newHost, setNewHost] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/proxy/whitelist").then((r) => r.json()).then((d) => setHosts(d.user ?? [])).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await fetch("/api/proxy/whitelist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hosts }),
      });
      setSaved(true); setTimeout(() => setSaved(false), 3000); onSaved();
    } catch { void 0; }
    setSaving(false);
  };

  const addHost = () => {
    const h = newHost.trim();
    if (!h || hosts.includes(h)) return;
    setHosts([...hosts, h]); setNewHost("");
  };

  return (
    <div style={{ background: "#fff", borderRadius: 10, padding: "14px 18px", border: "1px solid #e5e5e5" }}>
      <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>{t("captureTargets", lang)}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        <HostChip label="api.anthropic.com" removable={false} />
        {hosts.map((h) => (
          <HostChip key={h} label={h} removable onRemove={() => setHosts(hosts.filter((x) => x !== h))} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={newHost} onChange={(e) => setNewHost(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addHost()}
          placeholder="127.0.0.1:8742 / my-gw.example.com"
          style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", fontSize: 13 }}
        />
        <button onClick={addHost} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#f5f5f7", cursor: "pointer", fontSize: 13 }}>
          {t("addHost", lang)}
        </button>
        <button onClick={save} disabled={saving} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#007aff", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
          {saving ? "…" : t("saveTargets", lang)}
        </button>
      </div>
      {saved && <div style={{ marginTop: 6, fontSize: 12, color: "#34c759" }}>{t("targetsSaved", lang)}</div>}
    </div>
  );
}

function HostChip({ label, removable, onRemove }: { label: string; removable: boolean; onRemove?: () => void }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "3px 10px", borderRadius: 20,
      background: removable ? "#f0f4ff" : "#f5f5f7",
      border: `1px solid ${removable ? "#c7d7ff" : "#e0e0e0"}`,
      fontSize: 12, color: removable ? "#2563eb" : "#666",
    }}>
      {label}
      {removable && onRemove && (
        <button onClick={onRemove} style={{ background: "none", border: "none", cursor: "pointer", color: "#999", fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
      )}
    </div>
  );
}

// ── 分类过滤 tab ──────────────────────────────────────────────────────────────

function CategoryTabs({ active, counts, lang, onChange }: {
  active: Category | "all";
  counts: Record<string, number>;
  lang: Lang;
  onChange: (c: Category | "all") => void;
}) {
  const tabs: Array<{ id: Category | "all"; label: string; color?: string }> = [
    { id: "all",       label: t("filterAll", lang) },
    { id: "llm",       label: CATEGORY_META.llm.label[lang],       color: CATEGORY_META.llm.color },
    { id: "auth",      label: CATEGORY_META.auth.label[lang],      color: CATEGORY_META.auth.color },
    { id: "telemetry", label: CATEGORY_META.telemetry.label[lang], color: CATEGORY_META.telemetry.color },
    { id: "mcp",       label: CATEGORY_META.mcp.label[lang],       color: CATEGORY_META.mcp.color },
    { id: "other",     label: CATEGORY_META.other.label[lang],     color: CATEGORY_META.other.color },
  ];

  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {tabs.map(({ id, label, color }) => {
        const cnt = counts[id] ?? 0;
        const isActive = active === id;
        return (
          <button key={id} onClick={() => onChange(id)} style={{
            padding: "4px 10px", borderRadius: 20, border: "1.5px solid",
            borderColor: isActive ? (color ?? "#007aff") : "#e0e0e0",
            background: isActive ? (color ?? "#007aff") : "#fff",
            color: isActive ? "#fff" : (color ?? "#555"),
            cursor: "pointer", fontSize: 12, fontWeight: isActive ? 600 : 400,
            display: "flex", alignItems: "center", gap: 5,
          }}>
            {label}
            {cnt > 0 && (
              <span style={{
                background: isActive ? "rgba(255,255,255,0.3)" : "#f0f0f0",
                color: isActive ? "#fff" : "#666",
                borderRadius: 10, padding: "0 5px", fontSize: 10, fontWeight: 600,
              }}>{cnt}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

export function ProxyTraffic() {
  const lang = getLang();
  const [requests, setRequests] = useState<ProxyRequest[]>([]);
  const [selected, setSelected] = useState<ProxyRequest | null>(null);
  const [live, setLive] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // 默认选中 LLM 推理
  const [catFilter, setCatFilter] = useState<Category | "all">("llm");
  const [trafficReady, setTrafficReady] = useState(false);

  // 分页状态：已加载的行数 offset，服务端总数
  const [offset, setOffset] = useState(PAGE_SIZE);
  const [serverTotal, setServerTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const evtRef = useRef<EventSource | null>(null);
  const streamCursorRef = useRef<{ startedAt: string; id: number }>({ startedAt: "", id: 0 });
  // 用于无限滚动的哨兵元素
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch(`/api/proxy/requests?limit=${PAGE_SIZE}&offset=0`)
      .then((r) => r.json())
      .then((d) => {
        const initial = (d.requests ?? []) as ProxyRequest[];
        setRequests(initial);
        setServerTotal(d.total ?? 0);
        setOffset(initial.length);
        const newest = initial[0];
        const maxId = initial.reduce((max, req) => Math.max(max, req.id), 0);
        streamCursorRef.current = newest
          ? { startedAt: requestStartedAt(newest), id: maxId }
          : { startedAt: new Date().toISOString(), id: 0 };
        setTrafficReady(true);
      })
      .catch(() => setTrafficReady(true));
  }, []);

  useEffect(() => {
    if (!trafficReady) return;
    if (!live) { evtRef.current?.close(); evtRef.current = null; return; }
    const cursor = streamCursorRef.current;
    const params = new URLSearchParams();
    if (cursor.id) params.set("since_id", String(cursor.id));
    const streamUrl = `/api/proxy/stream${params.size > 0 ? `?${params.toString()}` : ""}`;
    const es = new EventSource(streamUrl);
    evtRef.current = es;
    es.onmessage = (e) => {
      try {
        const rec: ProxyRequest = JSON.parse(e.data);
        const current = streamCursorRef.current;
        if (rec.id > current.id) {
          streamCursorRef.current = { startedAt: requestStartedAt(rec), id: rec.id };
        }
        setRequests((prev) => mergeRequests(prev, [rec]));
        // 新增实时记录时同步更新 total（乐观）
        setServerTotal((t) => t + 1);
      } catch { void 0; }
    };
    return () => { es.close(); evtRef.current = null; };
  }, [live, trafficReady]);

  // 加载更多（分页）
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const d = await fetch(`/api/proxy/requests?limit=${PAGE_SIZE}&offset=${offset}`).then((r) => r.json());
      const more = (d.requests ?? []) as ProxyRequest[];
      if (more.length > 0) {
        setRequests((prev) => mergeRequests(prev, more));
        setOffset((o) => o + more.length);
        setServerTotal(d.total ?? serverTotal);
      }
    } catch { void 0; }
    setLoadingMore(false);
  }, [loadingMore, offset, serverTotal]);

  // IntersectionObserver 实现无限滚动：哨兵元素进入视口时触发加载
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && requests.length < serverTotal && !loadingMore) {
          loadMore();
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore, requests.length, serverTotal, loadingMore]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/proxy/sync", { method: "POST" });
      const d = await fetch(`/api/proxy/requests?limit=${PAGE_SIZE}&offset=0`).then((r) => r.json());
      const next = (d.requests ?? []) as ProxyRequest[];
      setRequests(next);
      setServerTotal(d.total ?? 0);
      setOffset(next.length);
      const newest = next[0];
      const maxId = next.reduce((max, req) => Math.max(max, req.id), 0);
      if (newest) streamCursorRef.current = { startedAt: requestStartedAt(newest), id: maxId };
    } catch { void 0; }
    setSyncing(false);
  };

  // 分类计数基于已加载的数据（实时计数）
  const counts = requests.reduce<Record<string, number>>((acc, r) => {
    const c = classifyRequest(r.url, r.sni);
    acc[c] = (acc[c] ?? 0) + 1;
    acc.all = (acc.all ?? 0) + 1;
    return acc;
  }, {});

  const filtered = catFilter === "all" ? requests : requests.filter((r) => classifyRequest(r.url, r.sni) === catFilter);
  const hasMore = requests.length < serverTotal;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <CaptureTargets lang={lang} onSaved={() => {}} />

      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e5e5", overflow: "hidden" }}>
        {/* 工具栏 */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>
              {t("title", lang)}
              {serverTotal > 0 && (
                <span style={{ marginLeft: 6, fontSize: 12, color: "#999", fontWeight: 400 }}>
                  {requests.length < serverTotal ? `${requests.length} / ${serverTotal}` : serverTotal}
                </span>
              )}
            </span>
            <button onClick={() => setLive((v) => !v)} style={{
              padding: "4px 10px", borderRadius: 6, border: "1px solid",
              borderColor: live ? "#34c759" : "#ddd",
              background: live ? "#f0fff4" : "#f5f5f7",
              color: live ? "#34c759" : "#666", cursor: "pointer", fontSize: 12,
            }}>
              {live ? `● ${t("live", lang)}` : t("paused", lang)}
            </button>
            <button onClick={handleSync} disabled={syncing} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#f5f5f7", cursor: "pointer", fontSize: 12 }}>
              {syncing ? t("syncing", lang) : t("sync", lang)}
            </button>
          </div>
          {/* 分类过滤 */}
          <CategoryTabs active={catFilter} counts={counts} lang={lang} onChange={setCatFilter} />
        </div>

        {/* 列表 */}
        {filtered.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "#999", fontSize: 13 }}>{t("noData", lang)}</div>
        ) : (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#fafafa" }}>
                  <th style={thStyle}>{t("category", lang)}</th>
                  <th style={thStyle}>{t("method", lang)}</th>
                  <th style={thStyle}>{t("status", lang)}</th>
                  <th style={{ ...thStyle, width: "99%" }}>{t("path", lang)}</th>
                  <th style={thStyle}>{t("duration", lang)}</th>
                  <th style={thStyle}>{t("size", lang)}</th>
                  <th style={thStyle}>{t("parseCol", lang)}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const cat = classifyRequest(r.url, r.sni);
                  const meta = CATEGORY_META[cat];
                  return (
                    <tr
                      key={r.id}
                      onClick={() => setSelected(r)}
                      style={{ cursor: "pointer", borderBottom: "1px solid #f5f5f5" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "#fafafa")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                    >
                      <td style={tdStyle}>
                        <span style={{
                          fontSize: 10, padding: "2px 7px", borderRadius: 10,
                          background: meta.bg, color: meta.color, fontWeight: 600, whiteSpace: "nowrap",
                        }}>
                          {meta.label[lang]}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 600, color: "#007aff" }}>{r.method}</span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ color: statusColor(r.status), fontWeight: 600 }}>{r.status ?? "—"}</span>
                        {(r.is_stream === 1 || r.is_stream === true) && (
                          <span style={{ marginLeft: 4, fontSize: 10, color: "#7c3aed", background: "#f5f0ff", borderRadius: 3, padding: "1px 4px" }}>SSE</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ color: "#555" }}>{r.sni}</span>
                        <span style={{ color: "#999", marginLeft: 4 }}>{pathFromUrl(r.url)}</span>
                      </td>
                      <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{r.duration_ms != null ? `${r.duration_ms}ms` : "—"}</td>
                      <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{formatBytes(r.bytes_out || r.bytes_in)}</td>
                      <td style={tdStyle}>
                        {/* SSE 响应但事件数为 0：解析不完备，可能连接提前断开或格式非标准 */}
                        {(r.is_stream === 1 || r.is_stream === true) && r.sse_event_count === 0 ? (
                          <span title={lang === "zh" ? "SSE 响应未解析到完整事件，可能连接提前断开或格式非标准" : "SSE response has no parsed events; possibly closed early or non-standard format"}
                            style={{ fontSize: 13, cursor: "default" }}>
                            ⚠️
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* 无限滚动哨兵 + 加载状态 */}
            <div ref={sentinelRef} style={{ padding: "12px 16px", textAlign: "center", fontSize: 12, color: "#999" }}>
              {loadingMore
                ? t("loadingMore", lang)
                : hasMore
                  ? <button onClick={loadMore} style={{ background: "none", border: "none", cursor: "pointer", color: "#007aff", fontSize: 12 }}>{t("loadMore", lang)}</button>
                  : requests.length > PAGE_SIZE
                    ? t("noMore", lang)
                    : null}
            </div>
          </>
        )}
      </div>

      {selected && <RequestDetail req={selected} lang={lang} onClose={() => setSelected(null)} />}
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: "7px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "#888", whiteSpace: "nowrap" };
const tdStyle: React.CSSProperties = { padding: "8px 12px" };
