// 代理流量列表 + 单请求详情（lazy load）。
//
// i18n：本文件原先维护一份局部 T zh/en 字典 + getLang() / Lang 类型从
// localStorage 读取语言，现在统一迁到 react-i18next 的 `proxyTraffic.*`
// 命名空间，和应用其他部分共享 i18n 切换路径。每个子组件自己 useTranslation()，
// 不再通过 `lang: Lang` prop 链式传递。
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { BRAND } from "../v2/shared/brand";

// ── 请求分类 ──────────────────────────────────────────────────────────────────

type Category = "llm" | "auth" | "telemetry" | "mcp" | "other";

interface CategoryMeta {
  /** i18n key suffix under `proxyTraffic.categories.*` — caller resolves via t(). */
  labelKey: Category;
  color: string;
  bg: string;
}

const CATEGORY_META: Record<Category, CategoryMeta> = {
  llm:       { labelKey: "llm",       color: BRAND.violet600, bg: "#f5f0ff" },
  auth:      { labelKey: "auth",      color: "#0369a1", bg: "#e0f2fe" },
  telemetry: { labelKey: "telemetry", color: "#92400e", bg: "#fef3c7" },
  mcp:       { labelKey: "mcp",       color: "#065f46", bg: "#d1fae5" },
  other:     { labelKey: "other",     color: "#374151", bg: "#f3f4f6" },
};

/** Resolve a category's display label via i18n. Centralized so call sites
 *  don't need to know about the key path. */
function categoryLabel(t: (k: string) => string, cat: Category): string {
  return t(`proxyTraffic.categories.${CATEGORY_META[cat].labelKey}`);
}

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

type Visibility =
  | "visible"
  | "hidden"
  | "session-gone"
  | "unattributed"
  | "computing"
  | "disabled";

// 服务端 proxy-visibility 算好的跳转坐标，对应 URL /sessions/:id/turn/:t/call/:c。
interface CallTarget {
  turnId: number;
  callId: number;
}

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
  sse_event_count: number;
  is_stream: number | boolean;
  session_id?: string | null;
  request_id?: string | null;
  // 由 proxy-visibility 模块在后端打的徽章。disabled 时整列不展示。
  visibility?: Visibility;
  // 仅 visibility==="visible" 时非 null：可直达对应 session 的那条 call。
  link_target?: CallTarget | null;
}

// i18n key 用 camelCase（session-gone → sessionGone），visibility 值是
// kebab-case。这张表负责两者的映射 + 颜色。
const VISIBILITY_META: Record<Exclude<Visibility, "disabled">, { color: string; bg: string; border: string; i18nKey: string }> = {
  "visible":       { color: "#047857", bg: "#ecfdf5", border: "#a7f3d0", i18nKey: "visible" },
  "hidden":        { color: "#b45309", bg: "#fef3c7", border: "#fcd34d", i18nKey: "hidden" },
  "session-gone":  { color: "#6b7280", bg: "#f3f4f6", border: "#d1d5db", i18nKey: "sessionGone" },
  "unattributed":  { color: "#6b7280", bg: "#fff",    border: "#e5e7eb", i18nKey: "unattributed" },
  "computing":     { color: "#9ca3af", bg: "#f9fafb", border: "#e5e7eb", i18nKey: "computing" },
};

type VisibilityFilter = "all" | "hidden" | "orphan";

// hidden / orphan 互斥分类：
//   hidden = 属于已知 session 但 parser 没渲染（典型：sub-agent、合成调用）
//   orphan = jsonl 不在了 或 没有 session 归属（session-gone + unattributed）
// 用户想看的两类不同问题：前者诊断 parser 覆盖盲区，后者诊断数据完整性。
function visibilityMatchesFilter(v: Visibility | undefined, f: VisibilityFilter): boolean {
  if (f === "all") return true;
  if (!v || v === "disabled") return false;
  if (f === "hidden") return v === "hidden";
  // orphan
  return v === "session-gone" || v === "unattributed";
}

function VisibilityBadge({ v, onJump }: { v: Visibility | undefined; onJump?: () => void }) {
  const { t } = useTranslation();
  if (!v || v === "disabled") return null;
  const meta = VISIBILITY_META[v];
  const label = t(`proxyTraffic.visibility.${meta.i18nKey}`);
  const sharedStyle: React.CSSProperties = {
    fontSize: 10, padding: "2px 7px", borderRadius: 8,
    background: meta.bg, color: meta.color,
    border: `1px solid ${meta.border}`,
    fontWeight: 600, whiteSpace: "nowrap",
  };
  // visible 且服务端给了坐标 → 徽章可点，跳到对应 session 的那条 call。
  // 其余状态（hidden/session-gone/unattributed/computing）保持不可点：
  // UI 目前渲染不出对应 call，跳过去也没有落点。
  if (onJump) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onJump(); }}
        title={t("proxyTraffic.visibilityJumpTip")}
        style={{ ...sharedStyle, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3 }}
      >
        {label}
        <ExternalLink size={9} />
      </button>
    );
  }
  return (
    <span title={t(`proxyTraffic.visibilityTip.${meta.i18nKey}`)} style={sharedStyle}>
      {label}
    </span>
  );
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
  if (s < 300) return "#10b981";
  if (s < 400) return "#d97706";
  return "#dc2626";
}

function pathFromUrl(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

// session 内 call 的深链。格式必须和 SessionDetailV2 的 parseSessionNav 对齐：
// /sessions/:id/turn/:turnId/call/:callId。坐标由后端 proxy-visibility 算好。
function buildCallPath(sessionId: string, target: CallTarget): string {
  return `/sessions/${encodeURIComponent(sessionId)}/turn/${target.turnId}/call/${target.callId}`;
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

// ── 懒加载消息体（按需 fetch） ─────────────────────────────────────────────────

// base64 → utf8。失败时 fallback 到原字节描述。
function decodeBase64ToText(b64: string): { text: string; isBinary: boolean; bytes: number } {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let ctrl = 0;
    for (let i = 0; i < Math.min(bytes.length, 256); i++) {
      const c = bytes[i];
      if (c === 0 || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d)) ctrl++;
    }
    const isBinary = ctrl > 4;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { text, isBinary, bytes: bytes.length };
  } catch {
    return { text: "", isBinary: true, bytes: 0 };
  }
}

function LazyBody({ requestId, kind }: { requestId: number; kind: "req" | "res" }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<{ value: string; encoding: "utf8" | "base64" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpen = async () => {
    setOpen(true);
    if (!body && !error && !loading) {
      setLoading(true);
      try {
        const res = await fetch(`/api/proxy/requests/${requestId}/body`);
        const data = await res.json();
        if (data.error === "file_deleted") {
          setError(t("proxyTraffic.bodyFileDeleted"));
        } else if (data.error) {
          // server 透传的 data.message + 对常见 parse_error 的额外解读。
          const reason = data.message ? `${data.error} · ${data.message}` : data.error;
          const hint = data.error === "parse_error" ? t("proxyTraffic.bodyParseErrorHint") : "";
          setError(t("proxyTraffic.bodyReadFailedPrefix") + reason + hint);
        } else {
          const value = kind === "req" ? (data.req_body ?? "") : (data.res_body ?? "");
          const encoding = kind === "req" ? (data.req_body_encoding ?? "utf8") : (data.res_body_encoding ?? "utf8");
          setBody({ value, encoding });
        }
      } catch (e) {
        setError(String(e));
      }
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={handleOpen}
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
      >
        <span style={{ fontSize: 10, color: BRAND.indigo500 }}>{t("proxyTraffic.loadBody")}</span>
      </button>
    );
  }

  if (loading) {
    return <span style={{ color: "#9ca3af", fontSize: 12 }}>{t("proxyTraffic.loading")}</span>;
  }

  if (error) {
    return <span style={{ color: "#9ca3af", fontSize: 12, fontStyle: "italic" }}>{error}</span>;
  }

  if (!body || body.value === "") {
    return <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>;
  }

  // SSE / stream placeholder（legacy）
  const sseMatch = body.value.match(/^\[sse (\d+) events, (\d+) bytes\]$/);
  if (sseMatch) {
    const events = Number(sseMatch[1]);
    const bytes = Number(sseMatch[2]);
    const msg = t("proxyTraffic.ssePlaceholder", { events, size: formatBytes(bytes) });
    return <span style={{ color: "#9ca3af", fontSize: 12, fontStyle: "italic" }}>{msg}</span>;
  }

  let displayValue = body.value;
  if (body.encoding === "base64") {
    const decoded = decodeBase64ToText(body.value);
    if (decoded.isBinary) {
      const msg = t("proxyTraffic.binaryPlaceholder", { size: formatBytes(decoded.bytes) });
      return <span style={{ color: "#9ca3af", fontSize: 12, fontStyle: "italic" }}>{msg}</span>;
    }
    displayValue = decoded.text;
  }

  let pretty = displayValue;
  try { pretty = JSON.stringify(JSON.parse(displayValue), null, 2); } catch { void 0; }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#9ca3af", padding: 0 }}>
          {t("proxyTraffic.foldBody")}
        </button>
        <CopyButton text={pretty} />
      </div>
      <pre style={{
        background: "#1f2937", color: "#e8e8e8", borderRadius: 6,
        padding: "10px 12px", fontSize: 11, overflow: "auto",
        maxHeight: 400, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}>
        {pretty}
      </pre>
    </div>
  );
}

// ── 单请求详情抽屉 ────────────────────────────────────────────────────────────

function RequestDetail({ req, onClose }: { req: ProxyRequest; onClose: () => void }) {
  const { t } = useTranslation();
  const reqHeaders = parseHeaders(req.req_headers);
  const resHeaders = parseHeaders(req.res_headers);
  const cat = classifyRequest(req.url, req.sni);
  const catMeta = CATEGORY_META[cat];

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        className="w-[min(640px,100vw)] sm:max-w-none p-0 flex flex-col gap-0"
      >
        <SheetHeader className="px-5 py-4 border-b border-border space-y-1.5">
          <SheetTitle className="flex items-center gap-2 text-[15px] font-bold">
            <span>{req.method}</span>
            <span style={{ color: statusColor(req.status) }}>{req.status ?? "—"}</span>
            <span
              className="text-[11px] font-semibold rounded-lg px-1.5 py-0.5"
              style={{ background: catMeta.bg, color: catMeta.color }}
            >
              {categoryLabel(t, cat)}
            </span>
            {(req.is_stream === 1 || req.is_stream === true) && (
              <span className="text-[10px] rounded-lg px-1.5 py-0.5 bg-muted text-muted-foreground font-normal">
                SSE
              </span>
            )}
          </SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground break-all">
            {req.url}
          </SheetDescription>
          <div className="text-[11px] text-muted-foreground/80">
            {requestStartedAt(req)} · {req.duration_ms != null ? `${req.duration_ms}ms` : "—"} · {formatBytes(req.bytes_out || req.bytes_in)}
            {req.sse_event_count > 0 && ` · ${req.sse_event_count} ${t("proxyTraffic.sseEventsSuffix")}`}
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-auto px-5 py-4 flex flex-col gap-4">
          <DetailSection title={t("proxyTraffic.reqHeaders")}>
            <HeaderTable headers={reqHeaders} />
          </DetailSection>

          <DetailSection title={t("proxyTraffic.reqBody")}>
            <LazyBody requestId={req.id} kind="req" />
          </DetailSection>

          <DetailSection title={t("proxyTraffic.resHeaders")}>
            <HeaderTable headers={resHeaders} />
          </DetailSection>

          <DetailSection title={t("proxyTraffic.resBody")}>
            <LazyBody requestId={req.id} kind="res" />
          </DetailSection>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 11, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copiedAt, setCopiedAt] = useState<number>(0);
  const isCopied = copiedAt > 0 && Date.now() - copiedAt < 1500;
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(
      () => { setCopiedAt(Date.now()); setTimeout(() => setCopiedAt(0), 1500); },
      () => {},
    );
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={isCopied ? "已复制" : "复制"}
      style={{
        display: "inline-flex", alignItems: "center", gap: 2,
        border: "1px solid",
        borderColor: isCopied ? "#16a34a" : "#e5e7eb",
        background: isCopied ? "#dcfce7" : "transparent",
        color: isCopied ? "#15803d" : "#d1d5db",
        borderRadius: 3, fontSize: 9, fontWeight: 600,
        padding: "1px 5px", cursor: "pointer", lineHeight: 1.3,
        flexShrink: 0,
        transition: "background 0.12s, border-color 0.12s, color 0.12s",
      }}
      className={!isCopied ? "hover:!border-gray-300 hover:!text-gray-500" : ""}
    >
      {isCopied ? <Check size={8} strokeWidth={3} /> : <Copy size={8} />}
    </button>
  );
}

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (!entries.length) return <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>;
  return (
    <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k} className="group" style={{ borderBottom: "1px solid #f3f4f6" }}>
            <td style={{ padding: "3px 10px 3px 0", color: "#9ca3af", whiteSpace: "nowrap", verticalAlign: "top", width: 1 }}>{k}</td>
            <td style={{ padding: "3px 0", wordBreak: "break-all", color: "#374151" }}>{v}</td>
            <td style={{ padding: "3px 0 3px 8px", verticalAlign: "top", width: 1 }}>
              <span className="copy-btn invisible group-hover:visible inline-block">
                <CopyButton text={v} />
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Capture Targets ───────────────────────────────────────────────────────────
// 行为：添加 / 删除主机时 *立即* 发起 POST 持久化，结果通过 Toast 反馈，
// 不再有「保存」按钮 —— 旧版本的「先添加到 chip，再点保存」两步流程在用户
// 反馈中被认为是无意义的多余 confirm。chip × 删除同理：直接生效。
type ToastTone = "info" | "success" | "error";

// 规范化用户输入到 proxy 白名单可直接 lookup 的 host 字符串。
// 与服务端 server/src/proxy-v2/host-normalize.ts 保持同规则；客户端这边内联
// 一份，免去多 build/打包目标共享代码的麻烦。规则：
//   - 已含 http(s):// → URL.parse 取 host
//   - 否则补 http:// 再 parse 取 host
//   - 大小写不敏感，统一小写；path / query / hash 自动剥离
//   - 解析失败 / 空 / 非字符串 → null（调用方负责报错）
function normalizeHost(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const tryParse = (s: string): string | null => {
    try {
      const u = new URL(s);
      return u.host ? u.host.toLowerCase() : null;
    } catch {
      return null;
    }
  };
  return /^https?:\/\//i.test(raw)
    ? tryParse(raw)
    : tryParse(`http://${raw}`);
}

export function CaptureTargets() {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<string[]>([]);
  const [newHost, setNewHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: ToastTone } | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => {
    fetch("/api/proxy/whitelist").then((r) => r.json()).then((d) => setHosts(d.user ?? [])).catch(() => {});
  }, []);

  const showToast = useCallback((text: string, tone: ToastTone = "success") => {
    setToast({ text, tone });
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
  }, []);

  // 单一 commit：所有写入都走这里 —— 拿到下一份 hosts，POST 后写回 state。
  // 失败时不更新 state、不发 success toast，把错误 message 暴露给调用者。
  const commit = async (nextHosts: string[]): Promise<string | null> => {
    setBusy(true);
    try {
      const r = await fetch("/api/proxy/whitelist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hosts: nextHosts }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        return text || `HTTP ${r.status}`;
      }
      setHosts(nextHosts);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = async () => {
    const original = newHost.trim();
    const host = normalizeHost(newHost);
    if (!host) {
      showToast(t("proxyTraffic.hostInvalid"), "error");
      return;
    }
    if (hosts.includes(host) || host === "api.anthropic.com") {
      showToast(t("proxyTraffic.hostDuplicate", { host }), "info");
      return;
    }
    const err = await commit([...hosts, host]);
    if (err) {
      showToast(t("proxyTraffic.saveFailed", { error: err }), "error");
      return;
    }
    setNewHost("");
    // 规范化后的值与用户原始输入不同 —— 用 info 色提示用户实际入库的是什么，
    // 避免用户疑惑「我输入的明明是 https://...，为什么 chip 上显示的不是」。
    if (original !== host) {
      showToast(
        t("proxyTraffic.hostNormalizedAdded", { host, original }),
        "info",
      );
    } else {
      showToast(t("proxyTraffic.hostAdded", { host }), "success");
    }
  };

  const handleRemove = async (h: string) => {
    const err = await commit(hosts.filter((x) => x !== h));
    if (err) {
      showToast(t("proxyTraffic.saveFailed", { error: err }), "error");
      return;
    }
    showToast(t("proxyTraffic.hostRemoved", { host: h }), "success");
  };

  const toastStyles: Record<ToastTone, { bg: string; border: string; color: string }> = {
    success: { bg: "#ecfdf5", border: "#a7f3d0", color: "#047857" },
    info:    { bg: BRAND.indigo50, border: BRAND.indigo200, color: BRAND.indigo700 },
    error:   { bg: "#fef2f2", border: "#fecaca", color: "#991b1b" },
  };

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: "14px 18px", border: "1px solid #e5e7eb", position: "relative" }}>
      <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>{t("proxyTraffic.captureTargets")}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        <HostChip label="api.anthropic.com" removable={false} />
        {hosts.map((h) => (
          <HostChip key={h} label={h} removable onRemove={() => { void handleRemove(h); }} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={newHost} onChange={(e) => setNewHost(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { void handleAdd(); } }}
          placeholder="127.0.0.1:8742 / my-gw.example.com"
          disabled={busy}
          style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid #e5e7eb", fontSize: 13 }}
        />
        <button
          onClick={() => { void handleAdd(); }}
          disabled={busy}
          style={{
            padding: "6px 14px", borderRadius: 6, border: "none",
            background: busy ? BRAND.indigo200 : BRAND.indigo500, color: "#fff",
            cursor: busy ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600,
          }}
        >
          {busy ? "…" : t("proxyTraffic.addHost")}
        </button>
      </div>
      {toast && (
        <div style={{
          marginTop: 8,
          padding: "6px 10px", borderRadius: 6,
          fontSize: 12, lineHeight: 1.4,
          background: toastStyles[toast.tone].bg,
          border: `1px solid ${toastStyles[toast.tone].border}`,
          color: toastStyles[toast.tone].color,
        }}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

function HostChip({ label, removable, onRemove }: { label: string; removable: boolean; onRemove?: () => void }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "3px 10px", borderRadius: 20,
      background: removable ? "#f0f4ff" : "#f3f4f6",
      border: `1px solid ${removable ? "#c7d7ff" : "#e5e7eb"}`,
      fontSize: 12, color: removable ? BRAND.blue600 : "#666",
    }}>
      {label}
      {removable && onRemove && (
        <button onClick={onRemove} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
      )}
    </div>
  );
}

// ── 分类过滤 tab ──────────────────────────────────────────────────────────────

function CategoryTabs({ active, counts, onChange }: {
  active: Category | "all";
  counts: Record<string, number>;
  onChange: (c: Category | "all") => void;
}) {
  const { t } = useTranslation();
  const tabs: Array<{ id: Category | "all"; label: string; color?: string }> = [
    { id: "all",       label: t("proxyTraffic.filterAll") },
    { id: "llm",       label: categoryLabel(t, "llm"),       color: CATEGORY_META.llm.color },
    { id: "auth",      label: categoryLabel(t, "auth"),      color: CATEGORY_META.auth.color },
    { id: "telemetry", label: categoryLabel(t, "telemetry"), color: CATEGORY_META.telemetry.color },
    { id: "mcp",       label: categoryLabel(t, "mcp"),       color: CATEGORY_META.mcp.color },
    { id: "other",     label: categoryLabel(t, "other"),     color: CATEGORY_META.other.color },
  ];

  return (
    <Tabs value={active} onValueChange={(v) => onChange(v as Category | "all")}>
      <TabsList>
        {tabs.map(({ id, label, color }) => {
          const cnt = counts[id] ?? 0;
          return (
            <TabsTrigger key={id} value={id} className="gap-1.5">
              {color && (
                <span
                  className="inline-block size-1.5 rounded-full"
                  style={{ background: color }}
                />
              )}
              <span>{label}</span>
              {cnt > 0 && (
                <span className="rounded-md bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground data-[active=true]:bg-background/30 data-[active=true]:text-foreground">
                  {cnt}
                </span>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

// ── visibility 过滤器（segmented） ───────────────────────────────────────────

function VisibilityFilterBar({ active, onChange }: {
  active: VisibilityFilter;
  onChange: (v: VisibilityFilter) => void;
}) {
  const { t } = useTranslation();
  const items: Array<{ id: VisibilityFilter; label: string }> = [
    { id: "all",     label: t("proxyTraffic.visibilityFilterAll") },
    { id: "hidden",  label: t("proxyTraffic.visibilityFilterHidden") },
    { id: "orphan",  label: t("proxyTraffic.visibilityFilterOrphan") },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
      <span style={{ color: "#6b7280" }}>{t("proxyTraffic.visibilityFilterLabel")}:</span>
      <div style={{ display: "inline-flex", borderRadius: 6, overflow: "hidden", border: "1px solid #e5e7eb" }}>
        {items.map(({ id, label }, i) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            style={{
              padding: "4px 10px", border: "none",
              borderLeft: i > 0 ? "1px solid #e5e7eb" : "none",
              background: active === id ? BRAND.indigo500 : "#fff",
              color: active === id ? "#fff" : "#374151",
              cursor: "pointer", fontSize: 12, fontWeight: active === id ? 600 : 400,
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 表格 footer：页大小选择 + 分页器同一行 ─────────────────────────────────

function TableFooter({ page, totalPages, loading, onPageChange, pageSize, onPageSizeChange }: {
  page: number;
  totalPages: number;
  loading: boolean;
  onPageChange: (p: number) => void;
  pageSize: number;
  onPageSizeChange: (n: number) => void;
}) {
  const { t } = useTranslation();
  const canPrev = page > 1 && !loading;
  const canNext = page < totalPages && !loading;
  const hasPager = totalPages > 1;
  return (
    <div className="flex items-center gap-3 border-t bg-card px-4 py-2 text-xs text-muted-foreground">
      <label className="inline-flex items-center gap-1.5">
        {t("proxyTraffic.pageSizeLabel")}
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="rounded-md border border-input bg-background px-1.5 py-0.5 text-xs"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      {hasPager && (
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs"
            disabled={!canPrev}
            onClick={() => onPageChange(page - 1)}
          >
            {t("proxyTraffic.prevPage")}
          </Button>
          <span>
            {loading
              ? t("proxyTraffic.loadingMore")
              : t("proxyTraffic.page", { current: page, total: totalPages })}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs"
            disabled={!canNext}
            onClick={() => onPageChange(page + 1)}
          >
            {t("proxyTraffic.nextPage")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 50;

export function ProxyTraffic() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [requests, setRequests] = useState<ProxyRequest[]>([]);
  const [selected, setSelected] = useState<ProxyRequest | null>(null);
  const [live, setLive] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // 默认选中 LLM 推理
  const [catFilter, setCatFilter] = useState<Category | "all">("llm");
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("all");
  const [trafficReady, setTrafficReady] = useState(false);

  // 分页：当前页 (1-indexed) + 服务端总数 + 每页大小。无限下拉已弃用。
  // live SSE 还是有用——只是新到的请求会插到当前页头部，超出 pageSize 的会
  // 自然被截断到下一页；用户翻页时再 fetch 该页的快照。
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [serverTotal, setServerTotal] = useState(0);
  const [loadingPage, setLoadingPage] = useState(false);

  const evtRef = useRef<EventSource | null>(null);
  const streamCursorRef = useRef<{ startedAt: string; id: number }>({ startedAt: "", id: 0 });

  const totalPages = Math.max(1, Math.ceil(serverTotal / pageSize));

  const fetchPage = useCallback(async (targetPage: number, size: number, updateCursor = false) => {
    setLoadingPage(true);
    try {
      const offset = (targetPage - 1) * size;
      const d = await fetch(`/api/proxy/requests?limit=${size}&offset=${offset}`).then((r) => r.json());
      const next = (d.requests ?? []) as ProxyRequest[];
      setRequests(next);
      setServerTotal(d.total ?? 0);
      if (updateCursor && next.length > 0) {
        const newest = next[0];
        const maxId = next.reduce((max, req) => Math.max(max, req.id), 0);
        streamCursorRef.current = { startedAt: requestStartedAt(newest), id: maxId };
      }
    } catch { void 0; }
    setLoadingPage(false);
  }, []);

  useEffect(() => {
    fetch(`/api/proxy/requests?limit=${DEFAULT_PAGE_SIZE}&offset=0`)
      .then((r) => r.json())
      .then((d) => {
        const initial = (d.requests ?? []) as ProxyRequest[];
        setRequests(initial);
        setServerTotal(d.total ?? 0);
        const newest = initial[0];
        const maxId = initial.reduce((max, req) => Math.max(max, req.id), 0);
        streamCursorRef.current = newest
          ? { startedAt: requestStartedAt(newest), id: maxId }
          : { startedAt: new Date().toISOString(), id: 0 };
        setTrafficReady(true);
      })
      .catch(() => setTrafficReady(true));
  }, []);

  // 翻页 / 改 pageSize 时拉取对应页。初始 page=1 + size=DEFAULT 时跳过——
  // 已经在 mount effect 拉过同样的请求了，重复 fetch 没意义。
  useEffect(() => {
    if (!trafficReady) return;
    if (page === 1 && pageSize === DEFAULT_PAGE_SIZE) return;
    // fetchPage 内部首行就 setLoadingPage(true)，会触发 set-state-in-effect。
    // 与 attribution-graph-context.tsx 的 loadGraph 路径同模式，本仓库已接受。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPage(page, pageSize);
  }, [page, pageSize, trafficReady, fetchPage]);

  const handlePageSizeChange = (size: number) => {
    setPageSize(size);
    setPage(1); // 改大小后回到第 1 页，避免落到不存在的页
  };

  useEffect(() => {
    if (!trafficReady) return;
    // 只在第 1 页打开实时流：用户翻到其他页时，看的是历史快照，
    // 实时推送只会让分页紊乱。
    if (!live || page !== 1) { evtRef.current?.close(); evtRef.current = null; return; }
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
        // 只把新行 merge 进当前的第 1 页，超出 pageSize 自动尾部丢弃。
        setRequests((prev) => mergeRequests(prev, [rec]).slice(0, pageSize));
        setServerTotal((tot) => tot + 1);
      } catch { void 0; }
    };
    return () => { es.close(); evtRef.current = null; };
  }, [live, trafficReady, page, pageSize]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/proxy/sync", { method: "POST" });
      setPage(1);
      await fetchPage(1, pageSize, true);
    } catch { void 0; }
    setSyncing(false);
  };

  // 分类计数基于当前页已加载的数据（仅这一页内的相对计数）
  const counts = requests.reduce<Record<string, number>>((acc, r) => {
    const c = classifyRequest(r.url, r.sni);
    acc[c] = (acc[c] ?? 0) + 1;
    acc.all = (acc.all ?? 0) + 1;
    return acc;
  }, {});

  const filtered = requests.filter((r) => {
    if (catFilter !== "all" && classifyRequest(r.url, r.sni) !== catFilter) return false;
    if (!visibilityMatchesFilter(r.visibility, visibilityFilter)) return false;
    return true;
  });
  // 当前页是否有任何徽章——全列 disabled 时整列隐藏。
  const showVisibilityCol = requests.some((r) => r.visibility && r.visibility !== "disabled");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ background: "#fff", borderRadius: 8, border: "1px solid #e5e7eb", overflow: "hidden" }}>
        {/* 工具栏 */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #f3f4f6", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>
              {t("proxyTraffic.title")}
              {serverTotal > 0 && (
                <span style={{ marginLeft: 6, fontSize: 12, color: "#9ca3af", fontWeight: 400 }}>
                  {serverTotal}
                </span>
              )}
            </span>
            <button onClick={() => setLive((v) => !v)} style={{
              padding: "4px 10px", borderRadius: 6, border: "1px solid",
              borderColor: live ? "#10b981" : "#ddd",
              background: live ? "#f0fff4" : "#f3f4f6",
              color: live ? "#10b981" : "#666", cursor: "pointer", fontSize: 12,
            }}>
              {live ? `● ${t("proxyTraffic.live")}` : t("proxyTraffic.paused")}
            </button>
            <button onClick={handleSync} disabled={syncing} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #e5e7eb", background: "#f3f4f6", cursor: "pointer", fontSize: 12 }}>
              {syncing ? t("proxyTraffic.syncing") : t("proxyTraffic.sync")}
            </button>
          </div>
          {/* 分类过滤 */}
          <CategoryTabs active={catFilter} counts={counts} onChange={setCatFilter} />
          {/* visibility 过滤 —— 只在有徽章时才显示 */}
          {showVisibilityCol && (
            <VisibilityFilterBar active={visibilityFilter} onChange={setVisibilityFilter} />
          )}
        </div>

        {/* 列表 */}
        {filtered.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>{t("proxyTraffic.noData")}</div>
        ) : (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#fafafa" }}>
                  <th style={thStyle}>{t("proxyTraffic.category")}</th>
                  <th style={thStyle}>{t("proxyTraffic.method")}</th>
                  <th style={thStyle}>{t("proxyTraffic.status")}</th>
                  <th style={thStyle}>{t("proxyTraffic.streamCol")}</th>
                  <th style={{ ...thStyle, width: "99%" }}>{t("proxyTraffic.path")}</th>
                  <th style={thStyle}>{t("proxyTraffic.duration")}</th>
                  <th style={thStyle}>{t("proxyTraffic.size")}</th>
                  {showVisibilityCol && <th style={thStyle}>{t("proxyTraffic.visibilityCol")}</th>}
                  <th style={thStyle}>{t("proxyTraffic.parseCol")}</th>
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
                      className="hover:bg-neutral-50 transition-colors"
                      style={{ cursor: "pointer", borderBottom: "1px solid #f3f4f6" }}
                    >
                      <td style={tdStyle}>
                        <span style={{
                          fontSize: 10, padding: "2px 7px", borderRadius: 8,
                          background: meta.bg, color: meta.color, fontWeight: 600, whiteSpace: "nowrap",
                        }}>
                          {categoryLabel(t, cat)}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 600, color: BRAND.indigo500 }}>{r.method}</span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ color: statusColor(r.status), fontWeight: 600 }}>{r.status ?? "—"}</span>
                      </td>
                      <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                        {(r.is_stream === 1 || r.is_stream === true) ? (
                          <Badge variant="violet" className="text-[10px] px-1 py-0 rounded-sm">SSE</Badge>
                        ) : (
                          <span style={{ color: "#d1d5db" }}>—</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ color: "#374151" }}>{r.sni}</span>
                        <span style={{ color: "#9ca3af", marginLeft: 4 }}>{pathFromUrl(r.url)}</span>
                      </td>
                      <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{r.duration_ms != null ? `${r.duration_ms}ms` : "—"}</td>
                      <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{formatBytes(r.bytes_out || r.bytes_in)}</td>
                      {showVisibilityCol && (
                        <td style={tdStyle}>
                          <VisibilityBadge
                            v={r.visibility}
                            onJump={
                              r.visibility === "visible" && r.link_target && r.session_id
                                ? () => navigate(buildCallPath(r.session_id!, r.link_target!))
                                : undefined
                            }
                          />
                        </td>
                      )}
                      <td style={tdStyle}>
                        {/* SSE 响应但事件数为 0：解析不完备，可能连接提前断开或格式非标准 */}
                        {(r.is_stream === 1 || r.is_stream === true) && r.sse_event_count === 0 ? (
                          <span title={t("proxyTraffic.sseWarningTip")} style={{ fontSize: 13, cursor: "default" }}>
                            ⚠️
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <TableFooter
              page={page}
              totalPages={totalPages}
              loading={loadingPage}
              onPageChange={setPage}
              pageSize={pageSize}
              onPageSizeChange={handlePageSizeChange}
            />
          </>
        )}
      </div>

      {selected && <RequestDetail req={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: "7px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap" };
const tdStyle: React.CSSProperties = { padding: "8px 12px" };
