// 代理流量列表 + 单请求详情（lazy load）。
import { useEffect, useRef, useState } from "react";

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
    })
    .slice(0, 500);
}

// ── 懒加载消息体 ──────────────────────────────────────────────────────────────

function LazyBody({ value, lang }: { value: string; lang: Lang }) {
  const [open, setOpen] = useState(false);

  if (!value || value === "") return <span style={{ color: "#ccc", fontSize: 12 }}>—</span>;

  // 流式占位符直接展示，不折叠
  if (value.startsWith("[sse ") || value.startsWith("[stream ") || value.startsWith("[truncated ") || value.startsWith("[binary ")) {
    return <span style={{ color: "#999", fontSize: 12 }}>{value}</span>;
  }

  if (!open) {
    // 预览前 80 字符
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

export function ProxyTraffic() {
  const lang = getLang();
  const [requests, setRequests] = useState<ProxyRequest[]>([]);
  const [selected, setSelected] = useState<ProxyRequest | null>(null);
  const [live, setLive] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [catFilter, setCatFilter] = useState<Category | "all">("all");
  const [trafficReady, setTrafficReady] = useState(false);
  const evtRef = useRef<EventSource | null>(null);
  const streamCursorRef = useRef<{ startedAt: string; id: number }>({ startedAt: "", id: 0 });

  useEffect(() => {
    fetch("/api/proxy/requests?limit=100")
      .then((r) => r.json())
      .then((d) => {
        const initial = (d.requests ?? []) as ProxyRequest[];
        setRequests(initial);
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
      } catch { void 0; }
    };
    return () => { es.close(); evtRef.current = null; };
  }, [live, trafficReady]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/proxy/sync", { method: "POST" });
      const d = await fetch("/api/proxy/requests?limit=100").then((r) => r.json());
      const next = (d.requests ?? []) as ProxyRequest[];
      setRequests(next);
      const newest = next[0];
      const maxId = next.reduce((max, req) => Math.max(max, req.id), 0);
      if (newest) streamCursorRef.current = { startedAt: requestStartedAt(newest), id: maxId };
    } catch { void 0; }
    setSyncing(false);
  };

  // 分类计数
  const counts = requests.reduce<Record<string, number>>((acc, r) => {
    const c = classifyRequest(r.url, r.sni);
    acc[c] = (acc[c] ?? 0) + 1;
    acc.all = (acc.all ?? 0) + 1;
    return acc;
  }, {});

  const filtered = catFilter === "all" ? requests : requests.filter((r) => classifyRequest(r.url, r.sni) === catFilter);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <CaptureTargets lang={lang} onSaved={() => {}} />

      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e5e5", overflow: "hidden" }}>
        {/* 工具栏 */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>{t("title", lang)}</span>
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
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={thStyle}>{t("category", lang)}</th>
                <th style={thStyle}>{t("method", lang)}</th>
                <th style={thStyle}>{t("status", lang)}</th>
                <th style={{ ...thStyle, width: "99%" }}>{t("path", lang)}</th>
                <th style={thStyle}>{t("duration", lang)}</th>
                <th style={thStyle}>{t("size", lang)}</th>
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selected && <RequestDetail req={selected} lang={lang} onClose={() => setSelected(null)} />}
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: "7px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "#888", whiteSpace: "nowrap" };
const tdStyle: React.CSSProperties = { padding: "8px 12px" };
