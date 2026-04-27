// B2.3: 实时流量列表 + 单请求详情。
// 复用 SessionDetail.tsx 的样式语言（卡片 + 抽屉）。
import { useEffect, useRef, useState } from "react";

// 集中放置 UI 文案（AGENTS.md §5 过渡期方案）
const T = {
  title: { "zh-CN": "代理流量", en: "Proxy Traffic" },
  live: { "zh-CN": "实时", en: "Live" },
  paused: { "zh-CN": "已暂停", en: "Paused" },
  noData: { "zh-CN": "暂无流量记录", en: "No traffic yet" },
  method: { "zh-CN": "方法", en: "Method" },
  status: { "zh-CN": "状态", en: "Status" },
  host: { "zh-CN": "主机", en: "Host" },
  duration: { "zh-CN": "耗时", en: "Duration" },
  size: { "zh-CN": "大小", en: "Size" },
  stream: { "zh-CN": "流式", en: "Stream" },
  reqHeaders: { "zh-CN": "请求头", en: "Request Headers" },
  resHeaders: { "zh-CN": "响应头", en: "Response Headers" },
  reqBody: { "zh-CN": "请求体", en: "Request Body" },
  resBody: { "zh-CN": "响应体", en: "Response Body" },
  close: { "zh-CN": "关闭", en: "Close" },
  sync: { "zh-CN": "同步", en: "Sync" },
  syncing: { "zh-CN": "同步中…", en: "Syncing…" },
  captureTargets: { "zh-CN": "拦截目标", en: "Capture Targets" },
  addHost: { "zh-CN": "添加主机", en: "Add Host" },
  removeHost: { "zh-CN": "移除", en: "Remove" },
  saveTargets: { "zh-CN": "保存", en: "Save" },
  targetsSaved: { "zh-CN": "已生效，无需重启", en: "Applied, no restart needed" },
};

type Lang = "zh-CN" | "en";

function t(key: keyof typeof T, lang: Lang): string {
  return T[key][lang] ?? T[key]["zh-CN"];
}

function getLang(): Lang {
  const saved = localStorage.getItem("lang");
  return saved === "en" ? "en" : "zh-CN";
}

interface ProxyRequest {
  id: number;
  ts: string;
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
  if (typeof h === "string") {
    try { return JSON.parse(h); } catch { return {}; }
  }
  return h ?? {};
}

function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function statusColor(status: number | null): string {
  if (!status) return "#999";
  if (status < 300) return "#34c759";
  if (status < 400) return "#ff9f0a";
  return "#ff3b30";
}

// 单请求详情抽屉
function RequestDetail({ req, lang, onClose }: { req: ProxyRequest; lang: Lang; onClose: () => void }) {
  const reqHeaders = parseHeaders(req.req_headers);
  const resHeaders = parseHeaders(req.res_headers);

  return (
    <div style={{
      position: "fixed", top: 0, right: 0, bottom: 0, width: "min(600px, 100vw)",
      background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
      zIndex: 1000, overflow: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 16,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{req.method}</span>
          {" "}
          <span style={{ color: statusColor(req.status), fontWeight: 600 }}>{req.status ?? "—"}</span>
          {" "}
          <span style={{ color: "#666", fontSize: 13 }}>{req.sni}</span>
        </div>
        <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 20, color: "#666" }}>✕</button>
      </div>
      <div style={{ fontSize: 12, color: "#999" }}>{req.ts} · {req.duration_ms != null ? `${req.duration_ms}ms` : "—"}</div>
      <div style={{ fontSize: 13, color: "#333", wordBreak: "break-all" }}>{req.url}</div>

      {/* 请求头 */}
      <Section title={t("reqHeaders", lang)}>
        <HeaderTable headers={reqHeaders} />
      </Section>

      {/* 请求体 */}
      {req.req_body && (
        <Section title={t("reqBody", lang)}>
          <JsonOrText value={req.req_body} />
        </Section>
      )}

      {/* 响应头 */}
      <Section title={t("resHeaders", lang)}>
        <HeaderTable headers={resHeaders} />
      </Section>

      {/* 响应体 */}
      {req.res_body && (
        <Section title={t("resBody", lang)}>
          {req.is_stream
            ? <div style={{ color: "#666", fontSize: 13 }}>{req.res_body}</div>
            : <JsonOrText value={req.res_body} />
          }
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 12, color: "#999", textTransform: "uppercase", marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return <div style={{ color: "#ccc", fontSize: 12 }}>—</div>;
  return (
    <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k} style={{ borderBottom: "1px solid #f0f0f0" }}>
            <td style={{ padding: "3px 8px 3px 0", color: "#666", whiteSpace: "nowrap", verticalAlign: "top" }}>{k}</td>
            <td style={{ padding: "3px 0", wordBreak: "break-all", color: "#333" }}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function JsonOrText({ value }: { value: string }) {
  let pretty = value;
  try {
    pretty = JSON.stringify(JSON.parse(value), null, 2);
  } catch {}
  return (
    <pre style={{
      background: "#f5f5f7", borderRadius: 6, padding: "10px 12px",
      fontSize: 11, overflow: "auto", maxHeight: 300, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all",
    }}>
      {pretty}
    </pre>
  );
}

// A5.5: Capture Targets 面板
function CaptureTargets({ lang, onSaved }: { lang: Lang; onSaved: () => void }) {
  const [hosts, setHosts] = useState<string[]>([]);
  const [newHost, setNewHost] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/proxy/whitelist")
      .then((r) => r.json())
      .then((d) => setHosts(d.user ?? []))
      .catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await fetch("/api/proxy/whitelist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hosts }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      onSaved();
    } catch {}
    setSaving(false);
  };

  const addHost = () => {
    const h = newHost.trim();
    if (!h || hosts.includes(h)) return;
    setHosts([...hosts, h]);
    setNewHost("");
  };

  return (
    <div style={{ background: "#fff", borderRadius: 10, padding: "16px 20px", border: "1px solid #e5e5e5" }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>{t("captureTargets", lang)}</div>
      <div style={{ marginBottom: 8, fontSize: 12, color: "#999" }}>api.anthropic.com（内置，不可删除）</div>
      {hosts.map((h) => (
        <div key={h} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ flex: 1, fontSize: 13 }}>{h}</span>
          <button onClick={() => setHosts(hosts.filter((x) => x !== h))}
            style={{ fontSize: 12, color: "#ff3b30", border: "none", background: "none", cursor: "pointer" }}>
            {t("removeHost", lang)}
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          value={newHost}
          onChange={(e) => setNewHost(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addHost()}
          placeholder="my-gw.example.com"
          style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", fontSize: 13 }}
        />
        <button onClick={addHost} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#f5f5f7", cursor: "pointer", fontSize: 13 }}>
          {t("addHost", lang)}
        </button>
        <button onClick={save} disabled={saving}
          style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#007aff", color: "#fff", cursor: "pointer", fontSize: 13 }}>
          {saving ? "…" : t("saveTargets", lang)}
        </button>
      </div>
      {saved && <div style={{ marginTop: 6, fontSize: 12, color: "#34c759" }}>{t("targetsSaved", lang)}</div>}
    </div>
  );
}

export function ProxyTraffic() {
  const lang = getLang();
  const [requests, setRequests] = useState<ProxyRequest[]>([]);
  const [selected, setSelected] = useState<ProxyRequest | null>(null);
  const [live, setLive] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const evtRef = useRef<EventSource | null>(null);

  // 初始加载
  useEffect(() => {
    fetch("/api/proxy/requests?limit=50")
      .then((r) => r.json())
      .then((d) => setRequests(d.requests ?? []))
      .catch(() => {});
  }, []);

  // B2.4: SSE 实时订阅
  useEffect(() => {
    if (!live) {
      evtRef.current?.close();
      evtRef.current = null;
      return;
    }
    const es = new EventSource("/api/proxy/stream");
    evtRef.current = es;
    es.onmessage = (e) => {
      try {
        const rec: ProxyRequest = JSON.parse(e.data);
        setRequests((prev) => [rec, ...prev].slice(0, 200));
      } catch {}
    };
    return () => { es.close(); evtRef.current = null; };
  }, [live]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/proxy/sync", { method: "POST" });
      const d = await fetch("/api/proxy/requests?limit=50").then((r) => r.json());
      setRequests(d.requests ?? []);
    } catch {}
    setSyncing(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Capture Targets */}
      <CaptureTargets lang={lang} onSaved={() => {}} />

      {/* 流量列表 */}
      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e5e5", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>{t("title", lang)}</span>
          <button
            onClick={() => setLive((v) => !v)}
            style={{
              padding: "4px 10px", borderRadius: 6, border: "1px solid",
              borderColor: live ? "#34c759" : "#ddd",
              background: live ? "#f0fff4" : "#f5f5f7",
              color: live ? "#34c759" : "#666",
              cursor: "pointer", fontSize: 12,
            }}
          >
            {live ? `● ${t("live", lang)}` : t("paused", lang)}
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#f5f5f7", cursor: "pointer", fontSize: 12 }}
          >
            {syncing ? t("syncing", lang) : t("sync", lang)}
          </button>
        </div>

        {requests.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "#999" }}>{t("noData", lang)}</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f5f5f7" }}>
                <th style={thStyle}>{t("method", lang)}</th>
                <th style={thStyle}>{t("status", lang)}</th>
                <th style={thStyle}>{t("host", lang)}</th>
                <th style={thStyle}>{t("duration", lang)}</th>
                <th style={thStyle}>{t("size", lang)}</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  style={{ cursor: "pointer", borderBottom: "1px solid #f0f0f0" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#f9f9f9")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                >
                  <td style={tdStyle}>
                    <span style={{ fontWeight: 600, color: "#007aff" }}>{r.method}</span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ color: statusColor(r.status), fontWeight: 600 }}>{r.status ?? "—"}</span>
                    {(r.is_stream === 1 || r.is_stream === true) && (
                      <span style={{ marginLeft: 4, fontSize: 10, color: "#666", background: "#f0f0f0", borderRadius: 3, padding: "1px 4px" }}>
                        {t("stream", lang)}
                      </span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.sni}
                  </td>
                  <td style={tdStyle}>{r.duration_ms != null ? `${r.duration_ms}ms` : "—"}</td>
                  <td style={tdStyle}>{formatBytes(r.bytes_out || r.bytes_in)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 详情抽屉 */}
      {selected && (
        <RequestDetail req={selected} lang={lang} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "8px 12px",
  textAlign: "left",
  fontWeight: 600,
  fontSize: 12,
  color: "#666",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
};
