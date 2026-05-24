import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionV2, SessionsV2Response } from "./types";
import { getSessionTitle, getSessionSubtitle } from "./session-display";
import { AggregateLedger } from "./shared/AggregateLedger";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { RefreshCw, Search, ChevronRight } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BRAND } from "./shared/brand";

const TOOL_BADGE: Record<string, { bg: string; color: string }> = {
  claude: { bg: BRAND.indigo50, color: BRAND.indigo500 },
  codex:  { bg: "#dbeafe", color: BRAND.blue700 },
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


function SessionRowV2({ session, onClick, maxTotal, selected = false }: { session: SessionV2; onClick: () => void; maxTotal: number; selected?: boolean }) {
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
      style={{ cursor: "pointer", background: selected ? "#eff6ff" : hovered ? "#f9fafb" : "#fff", transition: "background 0.1s" }}
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
          <Badge variant="violet" className="rounded-full px-2 text-[11px] font-medium">
            {session.sub_agent_count}
          </Badge>
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
        <ChevronRight size={13} className={hovered ? "text-gray-500" : "text-gray-300"} />
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
  /** 当前选中的 session（来自 URL :sessionId）。null = 列表态。 */
  selectedId?: string | null;
  /** 点击行 → 路由层 navigate(/sessions/:id)。列表不再自己持有选中态。 */
  onOpenSession?: (sessionId: string) => void;
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

export function SessionListV2({ data, loading, page, pageSize, search, onPageChange, onPageSizeChange, onSearchChange, onSync, selectedId = null, onOpenSession }: Props) {
  const { t } = useTranslation();
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
              <RefreshCw size={11} className={syncing ? "animate-spin" : ""} />
              {syncing ? t("dashboard.syncing") : t("dashboard.sync")}
            </Button>
          )}
          {syncMsg && <span style={{ fontSize: 11, color: "#6b7280" }}>{syncMsg}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {/* Search box */}
          <div className="relative flex items-center">
            <Search size={13} className="absolute left-2.5 pointer-events-none text-gray-400" />
            <Input
              type="text"
              placeholder={t("dashboard.searchPlaceholder")}
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className={`h-7 w-[200px] pl-8 pr-8 text-xs ${search ? "border-indigo-500 bg-indigo-50" : ""}`}
            />
            {search && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSearchChange("")}
                className="absolute right-1 h-6 w-6 p-0 text-base text-gray-400 hover:text-gray-600"
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
                selected={s.session_id === selectedId}
                onClick={() => onOpenSession?.(s.session_id)}
              />
            ))}
          </tbody>
        </table>
      )}

      {/* SessionDetailV2 现在由路由层（SessionDetailGate）渲染，不再挂在列表里。
          它是个 Sheet（portal 到 body），渲染位置不影响视觉。 */}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }`}</style>
    </div>
  );
}
