// Proxy 安装管理面板 —— 独立 tab。
// 展示：当前状态（未安装 / OK / DEGRADED / DOWN）+ preflight 检查 + 安装/卸载/启停按钮。
import { useEffect, useRef, useState } from "react";

// 集中文案（AGENTS.md §5 过渡期方案）
const T = {
  title:        { zh: "代理管理", en: "Proxy Setup" },
  subtitle:     { zh: "MITM 代理 — 本机内部工具", en: "MITM Proxy — Local Internal Tool" },
  statusLabel:  { zh: "当前状态", en: "Status" },
  notInstalled: { zh: "未安装", en: "Not Installed" },
  ok:           { zh: "运行中", en: "Running" },
  degraded:     { zh: "降级", en: "Degraded" },
  down:         { zh: "已停止", en: "Stopped" },
  install:      { zh: "安装并启动", en: "Install & Start" },
  uninstall:    { zh: "卸载", en: "Uninstall" },
  start:        { zh: "启动", en: "Start" },
  stop:         { zh: "停止（临时）", en: "Stop (temp)" },
  stopHint:     { zh: "⚠ 停止后 settings.json 仍指向代理端口。重启 Claude Code 前请先「启动」或「卸载」，否则 API 请求会失败。", en: "⚠ settings.json still points to proxy after stop. Start or Uninstall before restarting Claude Code." },
  preflight:    { zh: "运行检查", en: "Run Checks" },
  dryRun:       { zh: "预览变更（不写盘）", en: "Preview changes (dry-run)" },
  loading:      { zh: "处理中…", en: "Processing…" },
  refreshing:   { zh: "刷新中…", en: "Refreshing…" },
  refresh:      { zh: "刷新状态", en: "Refresh" },
  outputTitle:  { zh: "输出日志", en: "Output Log" },
  preflightTitle: { zh: "Preflight 检查", en: "Preflight Checks" },
  pid:          { zh: "进程 PID", en: "Process PID" },
  port:         { zh: "监听端口", en: "Listen Port" },
  settingsInjected: { zh: "settings.json 已注入", en: "settings.json injected" },
  settingsNotInjected: { zh: "settings.json 未注入", en: "settings.json not injected" },
  warning:      { zh: "⚠ 内部工具：仅供本机使用，流量明文存储在本地。", en: "⚠ Internal tool: local use only, traffic stored in plaintext." },
  restartHint:  { zh: "安装完成后需重启 Claude Code 使 settings.json 生效。", en: "Restart Claude Code after install for settings.json to take effect." },
};

type Lang = "zh" | "en";
function getLang(): Lang {
  return localStorage.getItem("lang") === "en" ? "en" : "zh";
}
function t(key: keyof typeof T, lang: Lang): string {
  return T[key][lang];
}

type DaemonStatus = "OK" | "DEGRADED" | "DOWN";

interface SetupStatus {
  injected: boolean;
  daemonStatus: DaemonStatus;
  statusHint?: string;
  pid: number | null;
  port: number | null;
  health: Record<string, unknown> | null;
}

interface CheckResult {
  id: string;
  name: string;
  severity: "OK" | "WARN" | "BLOCK";
  message: string;
  hint?: string;
  source?: "managed" | "settings" | "shell" | "system";
}

interface PreflightReport {
  results: CheckResult[];
  blocked: boolean;
}

// ── 颜色 / 图标 ────────────────────────────────────────────────────────────────

function statusColor(s: DaemonStatus | "notInstalled"): string {
  if (s === "OK") return "#34c759";
  if (s === "DEGRADED") return "#ff9f0a";
  return "#ff3b30";
}

function severityIcon(s: "OK" | "WARN" | "BLOCK"): string {
  return s === "OK" ? "✓" : s === "WARN" ? "⚠" : "✗";
}
function severityColor(s: "OK" | "WARN" | "BLOCK"): string {
  return s === "OK" ? "#34c759" : s === "WARN" ? "#ff9f0a" : "#ff3b30";
}

// ── 主组件 ─────────────────────────────────────────────────────────────────────

export function ProxySetup() {
  const lang = getLang();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  const fetchStatus = async () => {
    setStatusLoading(true);
    try {
      const r = await fetch("/api/proxy/setup/status");
      setStatus(await r.json());
    } catch {}
    setStatusLoading(false);
  };

  useEffect(() => { fetchStatus(); }, []);

  // 自动滚动输出到底部
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  const runPreflight = async () => {
    setPreflightLoading(true);
    setPreflight(null);
    try {
      const r = await fetch("/api/proxy/setup/preflight");
      setPreflight(await r.json());
    } catch {}
    setPreflightLoading(false);
  };

  const doAction = async (action: "install" | "uninstall" | "start" | "stop") => {
    setActionLoading(true);
    setOutput(null);
    try {
      let r: Response;
      if (action === "install") {
        r = await fetch("/api/proxy/setup/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun }),
        });
      } else {
        r = await fetch(`/api/proxy/setup/${action}`, { method: "POST" });
      }
      const data = await r.json();
      setOutput(data.output ?? (data.ok ? "完成" : data.reason ?? "失败"));
      await fetchStatus();
    } catch (e: any) {
      setOutput(`请求失败: ${e.message}`);
    }
    setActionLoading(false);
  };

  // 当前安装状态
  const isInstalled = status?.injected ?? false;
  const daemonStatus: DaemonStatus | "notInstalled" = !isInstalled ? "notInstalled" : (status?.daemonStatus ?? "DOWN");
  const isDaemonRunning = daemonStatus === "OK" || daemonStatus === "DEGRADED";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* 警告横幅 */}
      <div style={{
        background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 8,
        padding: "10px 16px", fontSize: 13, color: "#7a5c00",
      }}>
        {t("warning", lang)}
      </div>

      {/* 状态卡片 */}
      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e5e5", padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17 }}>{t("title", lang)}</div>
            <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>{t("subtitle", lang)}</div>
          </div>
          <button
            onClick={fetchStatus}
            disabled={statusLoading}
            style={{ padding: "6px 14px", borderRadius: 7, border: "1px solid #ddd", background: "#f5f5f7", cursor: "pointer", fontSize: 13 }}
          >
            {statusLoading ? t("refreshing", lang) : t("refresh", lang)}
          </button>
        </div>

        {/* 状态指示器 */}
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 20 }}>
          <StatusBadge
            label={t("statusLabel", lang)}
            value={
              daemonStatus === "notInstalled" ? t("notInstalled", lang) :
              daemonStatus === "OK" ? t("ok", lang) :
              daemonStatus === "DEGRADED" ? t("degraded", lang) : t("down", lang)
            }
            color={daemonStatus === "notInstalled" ? "#999" : statusColor(daemonStatus)}
          />
          <StatusBadge
            label="settings.json"
            value={isInstalled ? t("settingsInjected", lang) : t("settingsNotInjected", lang)}
            color={isInstalled ? "#34c759" : "#ff3b30"}
          />
          {status?.pid && <StatusBadge label={t("pid", lang)} value={String(status.pid)} color="#007aff" />}
          {status?.port && <StatusBadge label={t("port", lang)} value={String(status.port)} color="#007aff" />}
        </div>

        {/* 操作按钮区 */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {!isInstalled ? (
            <>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#666", cursor: "pointer" }}>
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                {t("dryRun", lang)}
              </label>
              <ActionButton
                label={t("install", lang)}
                loading={actionLoading}
                color="#007aff"
                onClick={() => doAction("install")}
              />
            </>
          ) : (
            <>
              {!isDaemonRunning ? (
                <ActionButton label={t("start", lang)} loading={actionLoading} color="#34c759" onClick={() => doAction("start")} />
              ) : (
                <ActionButton label={t("stop", lang)} loading={actionLoading} color="#ff9f0a" onClick={() => doAction("stop")} />
              )}
              {isDaemonRunning === false && isInstalled && (
                <span style={{ fontSize: 12, color: "#ff9f0a" }}>{t("stopHint", lang)}</span>
              )}
              <ActionButton
                label={t("uninstall", lang)}
                loading={actionLoading}
                color="#ff3b30"
                variant="outline"
                onClick={() => doAction("uninstall")}
              />
            </>
          )}
          <ActionButton
            label={preflightLoading ? t("loading", lang) : t("preflight", lang)}
            loading={preflightLoading}
            color="#666"
            variant="outline"
            onClick={runPreflight}
          />
        </div>

        {/* 降级原因提示 */}
        {status?.statusHint && (
          <div style={{ marginTop: 12, fontSize: 12, color: "#ff9f0a", background: "#fff8ee", borderRadius: 6, padding: "6px 10px" }}>
            ⚠ {status.statusHint}
          </div>
        )}
        {/* 安装后提示 */}
        {isInstalled && !status?.statusHint && (
          <div style={{ marginTop: 12, fontSize: 12, color: "#999" }}>{t("restartHint", lang)}</div>
        )}
      </div>

      {/* Preflight 结果 */}
      {preflight && (
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e5e5", padding: "16px 20px" }}>
          <div style={{ fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
            {t("preflightTitle", lang)}
            <span style={{
              fontSize: 11, padding: "2px 8px", borderRadius: 10,
              background: preflight.blocked ? "#fff0f0" : "#f0fff4",
              color: preflight.blocked ? "#ff3b30" : "#34c759",
            }}>
              {preflight.blocked ? "BLOCKED" : "PASSED"}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {preflight.results.map((r) => (
              <div key={r.id} style={{ display: "flex", gap: 10, fontSize: 13 }}>
                <span style={{ color: severityColor(r.severity), fontWeight: 700, minWidth: 16 }}>
                  {severityIcon(r.severity)}
                </span>
                <div style={{ flex: 1 }}>
                  <span style={{ color: "#999", fontSize: 11, marginRight: 6 }}>[{r.id}]</span>
                  <span style={{ fontWeight: 500 }}>{r.name}</span>
                  {r.source && r.source !== "system" && (
                    <span style={{
                      marginLeft: 6, fontSize: 10, padding: "1px 5px", borderRadius: 4,
                      background: r.source === "managed" ? "#fff0f0" : r.source === "settings" ? "#f0f4ff" : "#f5f5f7",
                      color:      r.source === "managed" ? "#c0392b" : r.source === "settings" ? "#2563eb"  : "#555",
                      fontWeight: 600,
                    }}>
                      {r.source}
                    </span>
                  )}
                  <span style={{ color: "#666", marginLeft: 6 }}>{r.message}</span>
                  {r.hint && (
                    <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>→ {r.hint}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 操作输出日志 */}
      {output !== null && (
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e5e5", padding: "16px 20px" }}>
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>{t("outputTitle", lang)}</div>
          <pre
            ref={outputRef}
            style={{
              background: "#1a1a1a", color: "#e8e8e8", borderRadius: 7,
              padding: "12px 14px", fontSize: 12, overflow: "auto",
              maxHeight: 320, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all",
              fontFamily: "monospace",
            }}
          >
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── 小组件 ─────────────────────────────────────────────────────────────────────

function StatusBadge({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 14, color }}>{value}</div>
    </div>
  );
}

function ActionButton({
  label, loading, color, variant = "filled", onClick,
}: {
  label: string;
  loading: boolean;
  color: string;
  variant?: "filled" | "outline";
  onClick: () => void;
}) {
  const filled = variant === "filled";
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        padding: "8px 18px",
        borderRadius: 8,
        border: filled ? "none" : `1.5px solid ${color}`,
        background: loading ? "#e5e5e5" : filled ? color : "transparent",
        color: loading ? "#999" : filled ? "#fff" : color,
        cursor: loading ? "not-allowed" : "pointer",
        fontSize: 14,
        fontWeight: 600,
        transition: "opacity 0.15s",
      }}
    >
      {loading ? "…" : label}
    </button>
  );
}
