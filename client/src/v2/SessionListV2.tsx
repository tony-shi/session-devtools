import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SessionDetailV2 } from "./SessionDetailV2";
import type { SessionV2, SessionsV2Response } from "./types";
import { getSessionTitle, getSessionSubtitle } from "./session-display";
import { AggregateLedger } from "./shared/AggregateLedger";
import { Button } from "./shared/Button";
import { Input } from "@/components/ui/input";
import {
  Pagination as PaginationNav,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TOOL_BADGE: Record<string, { bg: string; color: string }> = {
  claude: { bg: "#eef2ff", color: "#6366f1" },
  codex:  { bg: "#dbeafe", color: "#1d4ed8" },
  gemini: { bg: "#d1fae5", color: "#065f46" },
};

function fmtTime(ts: string) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function useRelativeTime() {
  const { t } = useTranslation();
  return (ts: string) => {
    if (!ts) return "";
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60_000)       return t("dashboard.justNow");
    if (diff < 3_600_000)    return t("dashboard.minutesAgo", { n: Math.floor(diff / 60_000) });
    if (diff < 86_400_000)   return t("dashboard.hoursAgo",   { n: Math.floor(diff / 3_600_000) });
    return                          t("dashboard.daysAgo",    { n: Math.floor(diff / 86_400_000) });
  };
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


function SessionRowV2({ session, onClick, maxTotal }: { session: SessionV2; onClick: () => void; maxTotal: number }) {
  const [hovered, setHovered] = useState(false);
  const { t } = useTranslation();
  const fmtRelative = useRelativeTime();
  const badge = TOOL_BADGE[session.tool] ?? { bg: "#f3f4f6", color: "#374151" };

  const displayName = getSessionTitle(session);

  const cwdLabel = session.cwd
    ? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd
    : session.project?.split("/").pop() ?? "—";
  const preview = getSessionSubtitle(session) ?? "";

  return (
    <tr
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ cursor: "pointer", background: hovered ? "#f9fafb" : "#fff", transition: "background 0.1s" }}
    >
      {/* 工具徽标 + proxy 链接质量小角标 */}
      <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 20, fontWeight: 600, background: badge.bg, color: badge.color }}>
            {session.tool}
          </span>
          {/* 严格 request-id 匹配：proxy_request_id_count < llm_call_count
              就说明有 LLM call 没有对应的 proxy 数据，归因会降级。全部匹配时不展示。 */}
        </div>
      </td>

      {/* 状态点 + 会话名 + 首条消息预览 */}
      <td style={{ padding: "10px 12px", maxWidth: 300 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <p style={{ fontSize: 13, fontWeight: 500, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: preview ? 2 : 0 }}>
            {displayName}
          </p>
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

      {/* 用户轮次 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {session.human_input_count > 0 ? session.human_input_count : "—"}
        </span>
      </td>

      {/* LLM 调用 */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {session.llm_call_count > 0 ? session.llm_call_count : "—"}
        </span>
      </td>

      {/* Token Ledger (Σ aggregate, compact) */}
      <td style={{ padding: "8px 12px" }}>
        <AggregateLedger
          size="compact"
          maxTotal={maxTotal}
          freshIn={session.input_tokens}
          cacheRead={session.cache_read_tokens}
          cacheWrite={session.cache_creation_tokens}
          output={session.output_tokens}
        />
      </td>

      {/* Sub agents */}
      <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
        {session.sub_agent_count > 0 ? (
          <span style={{
            fontSize: 11, padding: "1px 7px", borderRadius: 8,
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

const PAGE_SIZE_OPTIONS = [8, 10, 20, 50, 100];

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
  const { t } = useTranslation();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

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

  const prevDisabled = page === 0 || loading;
  const nextDisabled = page >= totalPages - 1 || loading;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>{t("dashboard.perPage")}</span>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => onPageSizeChange(Number(v))}
          disabled={loading}
        >
          <SelectTrigger size="sm" className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((s) => (
              <SelectItem key={s} value={String(s)} className="text-xs">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <PaginationNav className="mx-0 w-auto justify-start">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              aria-disabled={prevDisabled}
              className={prevDisabled ? "pointer-events-none opacity-40 h-7 text-xs" : "h-7 text-xs"}
              onClick={(e) => { e.preventDefault(); if (!prevDisabled) onChange(page - 1); }}
            />
          </PaginationItem>
          {pageNums.map((p, i) =>
            p === "…" ? (
              <PaginationItem key={`ellipsis-${i}`}>
                <PaginationEllipsis className="h-7" />
              </PaginationItem>
            ) : (
              <PaginationItem key={p}>
                <PaginationLink
                  href="#"
                  isActive={p === page}
                  className="h-7 min-w-7 text-xs"
                  onClick={(e) => { e.preventDefault(); if (p !== page) onChange(p); }}
                >
                  {p + 1}
                </PaginationLink>
              </PaginationItem>
            )
          )}
          <PaginationItem>
            <PaginationNext
              href="#"
              aria-disabled={nextDisabled}
              className={nextDisabled ? "pointer-events-none opacity-40 h-7 text-xs" : "h-7 text-xs"}
              onClick={(e) => { e.preventDefault(); if (!nextDisabled) onChange(page + 1); }}
            />
          </PaginationItem>
        </PaginationContent>
      </PaginationNav>

      <span style={{ fontSize: 11, color: "#9ca3af" }}>
        {t("dashboard.pageInfo", { page: page + 1, total: totalPages, count: total })}
      </span>
    </div>
  );
}

export function SessionListV2({ data, loading, page, pageSize, search, onPageChange, onPageSizeChange, onSearchChange, onSync }: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const visibleSessions = data?.sessions ?? [];

  const maxTotal = visibleSessions.reduce((max, s) => {
    const t = s.input_tokens + s.cache_read_tokens + s.cache_creation_tokens + s.output_tokens;
    return t > max ? t : max;
  }, 0);

  return (
    <div style={{ background: "#fff", borderRadius: 8, border: "1px solid #e5e7eb", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid #f3f4f6", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, color: "#111827", display: "flex", alignItems: "baseline", gap: 8 }}>
            {t("dashboard.sessionList")}
            {!loading && total > 0 && (
              <span style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>{total}</span>
            )}
            <span style={{ fontSize: 11, fontWeight: 400, color: "#9ca3af" }}>{t("dashboard.llmOnly")}</span>
          </h2>
          {onSync && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSync}
              disabled={syncing}
              title="Sync now"
            >
              <svg width="11" height="11" style={{ animation: syncing ? "spin 1s linear infinite" : "none" }}
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {syncing ? t("dashboard.syncing") : t("dashboard.sync")}
            </Button>
          )}
          {syncMsg && <span style={{ fontSize: 11, color: "#6b7280" }}>{syncMsg}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {/* Search box */}
          <div className="relative flex items-center">
            <svg
              width="13" height="13" fill="none" stroke="#9ca3af" viewBox="0 0 24 24"
              className="absolute left-2.5 pointer-events-none"
            >
              <circle cx="11" cy="11" r="8" strokeWidth={2} />
              <path strokeLinecap="round" strokeWidth={2} d="M21 21l-4.35-4.35" />
            </svg>
            <Input
              type="text"
              placeholder={t("dashboard.searchPlaceholder")}
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className={`h-7 w-[200px] pl-8 pr-8 text-xs ${search ? "border-indigo-500 bg-indigo-50" : ""}`}
            />
            {search && (
              <Button
                variant="text"
                size="sm"
                onClick={() => onSearchChange("")}
                style={{ position: "absolute", right: 4, padding: "0 4px", fontSize: 14 }}
              >×</Button>
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
          {search ? t("dashboard.noResults") : t("dashboard.noSessions")}
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#fafafa" }}>
              <th style={TH}>{t("dashboard.colTool")}</th>
              <th style={TH}>{t("dashboard.colSession")}</th>
              <th style={TH}>{t("dashboard.colWorkdir")}</th>
              <th style={{ ...TH, textAlign: "right" }}>{t("dashboard.colUserTurns")}</th>
              <th style={{ ...TH, textAlign: "right" }}>{t("dashboard.colLlmCalls")}</th>
              <th style={TH}>{t("dashboard.colTokenLedger")}</th>
              <th style={{ ...TH, textAlign: "right" }}>{t("dashboard.colSubAgent")}</th>
              <th style={TH}>{t("dashboard.colModel")}</th>
              <th style={{ ...TH, textAlign: "right" }}>{t("dashboard.colLastActive")}</th>
              <th style={TH} />
            </tr>
          </thead>
          <tbody>
            {visibleSessions.map((s) => (
              <SessionRowV2
                key={s.session_id}
                session={s}
                maxTotal={maxTotal}
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
