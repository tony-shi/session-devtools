import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionV2, SessionsV2Response } from "./types";
import { getSessionTitle, getSessionSubtitle } from "./session-display";
import { AggregateLedger } from "./shared/AggregateLedger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TablePagination } from "@/components/ui/table-pagination";
import { RefreshCw, Search, ChevronRight } from "lucide-react";
import { BRAND } from "./shared/brand";
import { selectionRowShadow } from "./shared/selection";
import { StatusBadgeStrip, type StatusBadge } from "./shared/HeaderStats";
import { renderStatusIcon } from "./shared/SessionBadges";

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


const TH: React.CSSProperties = {
  padding: "8px 12px", fontSize: 11, fontWeight: 600, color: "#9ca3af",
  textAlign: "left", letterSpacing: "0.03em",
  borderBottom: "1px solid #f3f4f6", whiteSpace: "nowrap",
  // 表头吸顶：长列表滚动时列名常驻。背景必须不透明以遮住下方滚过的行；
  // sticky 相对最近的滚动祖先生效，无滚动祖先时优雅退化为普通表头。
  position: "sticky", top: 0, zIndex: 1, background: "#fafafa",
};

// session 行的风险信号 → 统一 StatusBadge[]（与 Session/Turn/Call 头部同款徽标）。
// 数据全部来自列表 payload，无需额外请求：错误数 / 子 agent 数 / 无法回链代理的
// call 数（llm_call_count 超出带 request-id 的 proxy 行数的部分）。
function sessionRiskBadges(s: SessionV2, t: (k: string, o?: Record<string, unknown>) => string): StatusBadge[] {
  const badges: StatusBadge[] = [];
  if (s.claude_code_api_error_count > 0)
    badges.push({ kind: "error", count: s.claude_code_api_error_count, tooltip: t("sessionOverview.badges.errors") });
  if (s.sub_agent_count > 0)
    badges.push({ kind: "subAgent", count: s.sub_agent_count, tooltip: t("sessionOverview.badges.subAgents") });
  const proxyGap = Math.max(0, s.llm_call_count - s.proxy_request_id_count);
  if (proxyGap > 0)
    badges.push({ kind: "noProxy", count: proxyGap, tooltip: t("sessionOverview.badges.noProxyDetail", { count: proxyGap }) });
  return badges;
}


function SessionRowV2({ session, onClick, maxTotal, selected = false }: { session: SessionV2; onClick: () => void; maxTotal: number; selected?: boolean }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const fmtRelative = useRelativeTime();
  const badge = TOOL_BADGE[session.tool] ?? { bg: "#f3f4f6", color: "#374151" };
  const riskBadges = sessionRiskBadges(session, t);

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
      style={{
        cursor: "pointer", transition: "background 0.1s",
        // 统一选中态（设计契约）：与左 rail 同款 3px 左条 + #eef2ff 底；
        // 表格行用 inset box-shadow 画左条，避免 border-collapse 裁切。
        ...(selected
          ? selectionRowShadow(true, "indigo")
          : { background: hovered ? "#f9fafb" : "#fff" }),
      }}
    >
      {/* 状态：风险信号（错误 / 子 agent / 无 proxy）。靠近会话标题（第 2 列），
          不再散落到右侧。无风险时显示淡 "—" 占位以保持列对齐。 */}
      <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
        {riskBadges.length > 0
          ? <StatusBadgeStrip badges={riskBadges} size="compact" renderIcon={renderStatusIcon} />
          : <span style={{ fontSize: 12, color: "#d1d5db" }}>—</span>}
      </td>

      {/* 会话名 + 首条消息预览（工具徽标弱化为标题前的小灰 chip） */}
      <td style={{ padding: "10px 12px", maxWidth: 300 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 600, background: badge.bg, color: badge.color, flexShrink: 0, opacity: 0.7 }}>
            {session.tool}
          </span>
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

      {/* Sub-agent 计数已并入第 1 列「状态」徽标（靠近标题），此处不再单列。 */}

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
          <TablePagination
            page={page} pageSize={pageSize} total={total} loading={loading}
            onPageChange={onPageChange} onPageSizeChange={onPageSizeChange}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            perPageLabel={t("dashboard.perPage")}
            info={({ page1, totalPages, count }) => t("dashboard.pageInfo", { page: page1, total: totalPages, count })}
          />
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
            <tr>
              <th style={TH}>{t("dashboard.colStatus")}</th>
              <th style={TH}>{t("dashboard.colSession")}</th>
              <th style={TH}>{t("dashboard.colWorkdir")}</th>
              <th style={{ ...TH, textAlign: "right" }}>{t("dashboard.colUserTurns")}</th>
              <th style={{ ...TH, textAlign: "right" }}>{t("dashboard.colLlmCalls")}</th>
              <th style={TH}>{t("dashboard.colTokenLedger")}</th>
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
