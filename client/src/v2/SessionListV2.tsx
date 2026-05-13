import { useState } from "react";
import { SessionDetailV2 } from "./SessionDetailV2";
import type { SessionV2, SessionsV2Response } from "./types";
import { getSessionTitle, getSessionSubtitle } from "./session-display";

const TOOL_BADGE: Record<string, { bg: string; color: string }> = {
  claude: { bg: "#f3e8ff", color: "#7c3aed" },
  codex:  { bg: "#dbeafe", color: "#1d4ed8" },
  gemini: { bg: "#d1fae5", color: "#065f46" },
};


function fmtTime(ts: string) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function fmtRelative(ts: string) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m 前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h 前`;
  return `${Math.floor(diff / 86_400_000)}d 前`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

const TH: React.CSSProperties = {
  padding: "8px 12px", fontSize: 11, fontWeight: 600, color: "#9ca3af",
  textAlign: "left", letterSpacing: "0.03em",
  borderBottom: "1px solid #f3f4f6", whiteSpace: "nowrap",
};


function SessionRowV2({ session, onClick }: { session: SessionV2; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const badge = TOOL_BADGE[session.tool] ?? { bg: "#f3f4f6", color: "#374151" };

  const displayName = getSessionTitle(session);
  const isIdFallback = !session.custom_title && !session.ai_title;
  const [copied, setCopied] = useState(false);

  function copySessionId(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(session.session_id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const cwdLabel = session.cwd
    ? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd
    : session.project?.split("/").pop() ?? "—";
  const preview = getSessionSubtitle(session) ?? "";

  // Detect cross-day: first and last event are on different dates
  const firstDate = session.first_event_at?.slice(0, 10);
  const lastDate = session.last_event_at?.slice(0, 10);
  const crossDay = firstDate && lastDate && firstDate !== lastDate;

  return (
    <tr
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ cursor: "pointer", background: hovered ? "#f9fafb" : "#fff", transition: "background 0.1s" }}
    >
      {/* 工具徽标 */}
      <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 20, fontWeight: 600, background: badge.bg, color: badge.color }}>
          {session.tool}
        </span>
      </td>

      {/* 状态点 + 会话名 + 首条消息预览 */}
      <td style={{ padding: "10px 12px", maxWidth: 300 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <p style={{ fontSize: 13, fontWeight: 500, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: preview ? 2 : 0 }}>
            {displayName}
            {crossDay && <span style={{ marginLeft: 5, fontSize: 10, color: "#9ca3af", fontWeight: 400 }}>跨天</span>}
          </p>
          {isIdFallback && (
            <button
              onClick={copySessionId}
              title={session.session_id}
              style={{ flexShrink: 0, fontSize: 10, padding: "1px 5px", borderRadius: 4, border: "1px solid #d1d5db", background: copied ? "#d1fae5" : "#f9fafb", color: copied ? "#065f46" : "#6b7280", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              {copied ? "copied" : "copy id"}
            </button>
          )}
        </div>
        {preview && (
          <p style={{ fontSize: 11, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: 13 }}>
            {preview}
          </p>
        )}
      </td>

      {/* 工作区 */}
      <td style={{ padding: "10px 12px", maxWidth: 160 }}>
        <p style={{ fontSize: 11, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {cwdLabel}
        </p>
      </td>

      {/* 人工交互 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {session.human_input_count > 0 ? session.human_input_count : "—"}
        </span>
      </td>

      {/* Tokens (lifetime) */}
      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 10px" }}>
          <span style={{ fontSize: 10, color: "#d97706" }}>W {session.cache_creation_tokens > 0 ? fmtTokens(session.cache_creation_tokens) : "—"}</span>
          <span style={{ fontSize: 10, color: "#059669" }}>R {session.cache_read_tokens > 0 ? fmtTokens(session.cache_read_tokens) : "—"}</span>
          <span style={{ fontSize: 10, color: "#6366f1" }}>in {session.input_tokens > 0 ? fmtTokens(session.input_tokens) : "—"}</span>
          <span style={{ fontSize: 10, color: "#7c3aed" }}>out {session.output_tokens > 0 ? fmtTokens(session.output_tokens) : "—"}</span>
        </div>
      </td>

      {/* 工具调用 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {session.tool_call_count > 0 ? session.tool_call_count : "—"}
        </span>
      </td>

      {/* Sub agents */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        {session.sub_agent_count > 0 ? (
          <span style={{
            fontSize: 11, padding: "1px 7px", borderRadius: 12,
            background: "#faf5ff", color: "#7c3aed", fontWeight: 500,
          }}>
            {session.sub_agent_count}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "#d1d5db" }}>—</span>
        )}
      </td>

      {/* Models */}
      <td style={{ padding: "8px 12px", maxWidth: 130 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {session.models.map((m) => (
            <span key={m} style={{ fontSize: 10, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {m.replace("claude-", "").replace(/-\d{8}$/, "")}
            </span>
          ))}
        </div>
      </td>

      {/* Proxy 请求数 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        {session.proxy_count > 0 ? (
          <span style={{
            fontSize: 11, padding: "1px 7px", borderRadius: 12,
            background: "#eff6ff", color: "#3b82f6", fontWeight: 500,
          }}>
            {session.proxy_count}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "#d1d5db" }}>—</span>
        )}
      </td>

      {/* 最后活跃 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 11, color: "#9ca3af" }} title={session.last_event_at}>
          {fmtRelative(session.last_event_at)}
        </span>
        <br />
        <span style={{ fontSize: 10, color: "#d1d5db" }}>
          {fmtTime(session.last_event_at)}
        </span>
      </td>

      {/* 箭头 */}
      <td style={{ padding: "10px 12px", width: 28 }}>
        <svg width="13" height="13" fill="none" stroke={hovered ? "#6b7280" : "#d1d5db"} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </td>
    </tr>
  );
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

interface Props {
  data: SessionsV2Response | null;
  loading: boolean;
  page: number;
  pageSize: number;
  search: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onSearchChange: (search: string) => void;
  onSync?: () => Promise<{ synced: number; skipped: number; errors: number }>;
}

function Pagination({ page, pageSize, total, loading, onChange, onPageSizeChange }: {
  page: number; pageSize: number; total: number; loading: boolean;
  onChange: (p: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const btnBase: React.CSSProperties = {
    padding: "4px 10px", borderRadius: 6, border: "1px solid #e5e7eb",
    background: "#fff", fontSize: 12, cursor: "pointer", color: "#374151",
    fontWeight: 500, lineHeight: 1.5,
  };
  const disabledStyle: React.CSSProperties = { opacity: 0.4, cursor: "not-allowed" };

  const pageNums: (number | "…")[] = [];
  if (totalPages <= 7) {
    for (let i = 0; i < totalPages; i++) pageNums.push(i);
  } else {
    pageNums.push(0);
    if (page > 2) pageNums.push("…");
    for (let i = Math.max(1, page - 1); i <= Math.min(totalPages - 2, page + 1); i++) pageNums.push(i);
    if (page < totalPages - 3) pageNums.push("…");
    pageNums.push(totalPages - 1);
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      {/* Page size selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginRight: 4 }}>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>每页</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          disabled={loading}
          style={{
            padding: "3px 6px", borderRadius: 6, border: "1px solid #e5e7eb",
            background: "#fff", fontSize: 12, color: "#374151", cursor: "pointer",
            outline: "none", appearance: "none", paddingRight: 20,
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
            backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center",
          }}
        >
          {PAGE_SIZE_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>条</span>
      </div>

      {/* Prev button */}
      <button
        style={{ ...btnBase, ...(page === 0 || loading ? disabledStyle : {}) }}
        disabled={page === 0 || loading}
        onClick={() => onChange(page - 1)}
      >‹</button>

      {/* Page number buttons */}
      {pageNums.map((p, i) =>
        p === "…" ? (
          <span key={`ellipsis-${i}`} style={{ fontSize: 12, color: "#9ca3af", padding: "0 4px" }}>…</span>
        ) : (
          <button
            key={p}
            style={{
              ...btnBase,
              background: p === page ? "#7c3aed" : "#fff",
              color: p === page ? "#fff" : "#374151",
              borderColor: p === page ? "#7c3aed" : "#e5e7eb",
            }}
            onClick={() => p !== page && onChange(p)}
          >{p + 1}</button>
        )
      )}

      {/* Next button */}
      <button
        style={{ ...btnBase, ...(page >= totalPages - 1 || loading ? disabledStyle : {}) }}
        disabled={page >= totalPages - 1 || loading}
        onClick={() => onChange(page + 1)}
      >›</button>

      <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 2 }}>
        第 {page + 1} / {totalPages} 页，共 {total} 条
      </span>
    </div>
  );
}

export function SessionListV2({ data, loading, page, pageSize, search, onPageChange, onPageSizeChange, onSearchChange, onSync }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [localFilter, setLocalFilter] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  async function handleSync() {
    if (!onSync) return;
    setSyncing(true);
    setSyncMsg("");
    try {
      const r = await onSync();
      setSyncMsg(`synced ${r.synced}`);
      setTimeout(() => setSyncMsg(""), 3000);
    } catch {
      setSyncMsg("failed");
      setTimeout(() => setSyncMsg(""), 3000);
    } finally {
      setSyncing(false);
    }
  }
  const selectedSession = selectedId ? (data?.sessions.find((s) => s.session_id === selectedId) ?? null) : null;
  const total = data?.total ?? 0;

  // Front-end filter on current page sessions
  const visibleSessions = localFilter.trim()
    ? (data?.sessions ?? []).filter((s) => {
        const q = localFilter.toLowerCase();
        return (
          s.session_id.toLowerCase().includes(q) ||
          (s.custom_title ?? "").toLowerCase().includes(q) ||
          (s.ai_title ?? "").toLowerCase().includes(q) ||
          (s.cwd ?? "").toLowerCase().includes(q) ||
          (s.first_user_message ?? "").toLowerCase().includes(q)
        );
      })
    : (data?.sessions ?? []);

  return (
    <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid #f3f4f6", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
            Sessions
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: "#6b7280" }}>· LLM interactions only</span>
          </h2>
          {onSync && (
            <button
              onClick={handleSync}
              disabled={syncing}
              title="Sync now"
              style={{
                display: "flex", alignItems: "center", gap: 4,
                fontSize: 12, padding: "3px 9px", borderRadius: 6,
                background: "#f3f4f6", color: "#374151", border: "none",
                cursor: syncing ? "default" : "pointer", opacity: syncing ? 0.6 : 1,
              }}
            >
              <svg width="11" height="11" style={{ animation: syncing ? "spin 1s linear infinite" : "none" }}
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {syncing ? "Syncing…" : "Sync"}
            </button>
          )}
          {syncMsg && <span style={{ fontSize: 11, color: "#6b7280" }}>{syncMsg}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {/* Search box */}
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <svg width="13" height="13" fill="none" stroke="#9ca3af" viewBox="0 0 24 24" style={{ position: "absolute", left: 8, pointerEvents: "none" }}>
              <circle cx="11" cy="11" r="8" strokeWidth={2} />
              <path strokeLinecap="round" strokeWidth={2} d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="搜索 ID / 名称 / 路径…"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              style={{
                paddingLeft: 28, paddingRight: 28, paddingTop: 5, paddingBottom: 5,
                fontSize: 12, borderRadius: 7, border: "1px solid #e5e7eb",
                outline: "none", width: 200, color: "#374151",
                background: search ? "#faf5ff" : "#fff",
                borderColor: search ? "#a78bfa" : "#e5e7eb",
              }}
            />
            {search && (
              <button
                onClick={() => onSearchChange("")}
                style={{ position: "absolute", right: 7, background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 14, lineHeight: 1, padding: 0 }}
              >×</button>
            )}
          </div>
          {/* Page-level quick filter */}
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <svg width="13" height="13" fill="none" stroke="#9ca3af" viewBox="0 0 24 24" style={{ position: "absolute", left: 8, pointerEvents: "none" }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h18M7 8h10M11 12h2" />
            </svg>
            <input
              type="text"
              placeholder="当页过滤…"
              value={localFilter}
              onChange={(e) => setLocalFilter(e.target.value)}
              style={{
                paddingLeft: 28, paddingRight: 28, paddingTop: 5, paddingBottom: 5,
                fontSize: 12, borderRadius: 7, border: "1px solid #e5e7eb",
                outline: "none", width: 160, color: "#374151",
                background: localFilter ? "#eff6ff" : "#fff",
                borderColor: localFilter ? "#93c5fd" : "#e5e7eb",
              }}
            />
            {localFilter && (
              <button
                onClick={() => setLocalFilter("")}
                style={{ position: "absolute", right: 7, background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 14, lineHeight: 1, padding: 0 }}
              >×</button>
            )}
          </div>
          <Pagination page={page} pageSize={pageSize} total={total} loading={loading} onChange={onPageChange} onPageSizeChange={onPageSizeChange} />
        </div>
      </div>

      {loading ? (
        <div>
          {[1,2,3,4,5].map((i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "12px 16px", borderBottom: "1px solid #f9fafb" }}>
              <div style={{ width: 48, height: 18, background: "#e5e7eb", borderRadius: 20, animation: "pulse 1.5s ease-in-out infinite" }} />
              <div style={{ flex: 1 }}>
                <div style={{ height: 13, background: "#e5e7eb", borderRadius: 4, width: "35%", marginBottom: 5, animation: "pulse 1.5s ease-in-out infinite" }} />
                <div style={{ height: 11, background: "#f3f4f6", borderRadius: 4, width: "55%", animation: "pulse 1.5s ease-in-out infinite" }} />
              </div>
            </div>
          ))}
        </div>
      ) : visibleSessions.length === 0 ? (
        <p style={{ fontSize: 13, color: "#9ca3af", textAlign: "center", padding: "40px 0" }}>
          {localFilter || search ? "未找到匹配的会话" : "暂无会话"}
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#fafafa" }}>
              <th style={TH}>工具</th>
              <th style={TH}>会话</th>
              <th style={TH}>工作区</th>
              <th style={{ ...TH, textAlign: "right" }}>交互</th>
              <th style={TH}>Tokens (lifetime)</th>
              <th style={{ ...TH, textAlign: "right" }}>工具调用</th>
              <th style={{ ...TH, textAlign: "right" }}>子 Agent</th>
              <th style={TH}>模型</th>
              <th style={{ ...TH, textAlign: "right" }}>Proxy</th>
              <th style={{ ...TH, textAlign: "right" }}>最后活跃</th>
              <th style={TH} />
            </tr>
          </thead>
          <tbody>
            {visibleSessions.map((s) => (
              <SessionRowV2
                key={s.session_id}
                session={s}
                onClick={() => setSelectedId(s.session_id)}
              />
            ))}
          </tbody>
        </table>
      )}

      {selectedSession && (
        <SessionDetailV2 session={selectedSession} onClose={() => setSelectedId(null)} />
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }`}</style>
    </div>
  );
}
