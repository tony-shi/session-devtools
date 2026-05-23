// Proxy v2 管理页 —— 控制面板（Start / Stop）+ 流量展示。
//
// 视觉风格已对齐主站：indigo `#6366f1` 主色 / emerald `#10b981` 成功 /
// `#dc2626` 错误 / `#d97706` 警告。border `#e5e7eb` / `#f3f4f6`。和
// SessionDetail / Dashboard 同源。
//
// i18n：所有界面文字走 react-i18next 的 `proxy.*` 命名空间，方便在 zh/en
// 之间切。底部 ProxyTraffic 自己维护了一套 zh/en 的局部 T 字典，沿用不动。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProxyTraffic } from "./ProxyTraffic";
import { BRAND } from "../v2/shared/brand";

type Target = "STOPPED" | "RUNNING";
type Phase = "idle" | "starting" | "running" | "stopping";

interface Snapshot {
  target: Target;
  phase: Phase;
  port: number;
  pid: number | null;
  active: boolean;
  lastError: string | null;
  lastWarnings: { step: string; reason: string }[];
  preflightWarnings: string[];
  respawnAttempt: number;
  log: string[];
}

const POLL_INTERVAL_MS = 1000;

export function ProxyV2Setup() {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const fetchStatus = async () => {
    try {
      const r = await fetch("/api/proxy-v2/status");
      setSnap(await r.json());
    } catch {
      // 网络错误不动 snap，避免闪烁
    }
  };

  useEffect(() => {
    void fetchStatus();
    const id = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // 自动滚到日志底部
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [snap?.log.length]);

  const doAction = async (action: "start" | "stop") => {
    setBusy(true);
    try {
      const r = await fetch(`/api/proxy-v2/${action}`, { method: "POST" });
      setSnap(await r.json());
    } catch (e) {
      console.error(e);
    }
    setBusy(false);
  };

  const phase = snap?.phase ?? "idle";
  const target = snap?.target ?? "STOPPED";
  const isRunning = phase === "running";
  const isTransitioning = phase === "starting" || phase === "stopping";

  // Phase 颜色对齐主站：emerald running / indigo starting / amber stopping / gray idle
  const phaseColor =
    phase === "running"  ? "#10b981" :
    phase === "starting" ? BRAND.indigo500 :
    phase === "stopping" ? "#d97706" : "#9ca3af";

  const phaseLabel =
    phase === "running"  ? t("proxy.phaseRunning") :
    phase === "starting" ? t("proxy.phaseStarting") :
    phase === "stopping" ? t("proxy.phaseStopping") : t("proxy.phaseIdle");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 信息条 —— 用主站 indigo 配色 */}
      <div style={{
        background: BRAND.indigo50, border: "1px solid #c7d2fe", borderRadius: 8,
        padding: "10px 16px", fontSize: 13, color: "#3730a3",
      }}>
        {t("proxy.intro")}
      </div>

      {/* 状态卡片 */}
      <div style={{ background: "#fff", borderRadius: 8, border: "1px solid #e5e7eb", padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: "#111827" }}>{t("proxy.title")}</div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{t("proxy.subtitle")}</div>
          </div>
          <div style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600,
            background: `${phaseColor}1a`, color: phaseColor,
          }}>
            ● {phaseLabel}
          </div>
        </div>

        {/* 字段网格 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
          <Field label={t("proxy.fieldTarget")} value={target} />
          <Field label={t("proxy.fieldPort")}   value={String(snap?.port ?? "-")} />
          <Field label={t("proxy.fieldPid")}    value={snap?.pid ? String(snap.pid) : "-"} />
          <Field
            label={t("proxy.fieldActive")}
            value={snap?.active ? t("proxy.fieldActiveYes") : t("proxy.fieldActiveNo")}
            color={snap?.active ? "#10b981" : "#9ca3af"}
          />
        </div>

        {/* 按钮 */}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => doAction("start")}
            disabled={busy || isRunning || isTransitioning}
            style={btnStyle(isRunning ? "disabled" : "primary", busy || isRunning || isTransitioning)}
          >
            {t("proxy.btnStart")}
          </button>
          <button
            onClick={() => doAction("stop")}
            disabled={busy || (phase === "idle" && !snap?.active && !snap?.pid) || isTransitioning}
            style={btnStyle(isRunning ? "danger" : "neutral", busy || isTransitioning)}
          >
            {t("proxy.btnStop")}
          </button>
          <button
            onClick={fetchStatus}
            disabled={busy}
            style={btnStyle("ghost", busy)}
          >
            {t("proxy.btnRefresh")}
          </button>
        </div>

        {/* 错误展示 */}
        {snap?.lastError && (
          <div style={{
            marginTop: 14, padding: "10px 12px", borderRadius: 6,
            background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 13,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("proxy.errorTitle")}</div>
            <div>{snap.lastError}</div>
            {snap.respawnAttempt > 0 && (
              <div style={{ marginTop: 4, fontSize: 11, opacity: 0.8 }}>
                {t("proxy.crashCount", { n: snap.respawnAttempt })}
              </div>
            )}
          </div>
        )}

        {/* warnings */}
        {snap && snap.lastWarnings.length > 0 && (
          <div style={{
            marginTop: 14, padding: "10px 12px", borderRadius: 6,
            background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("proxy.warningsTitle")}</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {snap.lastWarnings.map((w, i) => <li key={i}>[{w.step}] {w.reason}</li>)}
            </ul>
          </div>
        )}

        {snap && snap.preflightWarnings.length > 0 && (
          <div style={{
            marginTop: 10, padding: "8px 12px", borderRadius: 6,
            background: BRAND.indigo50, border: "1px solid #c7d2fe", color: "#3730a3", fontSize: 12,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("proxy.preflightTitle")}</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {snap.preflightWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* 日志窗口 */}
      <div style={{ background: "#fff", borderRadius: 8, border: "1px solid #e5e7eb", padding: "14px 20px" }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14, color: "#111827" }}>{t("proxy.logTitle")}</div>
        <pre
          ref={logRef}
          style={{
            background: "#1f2937", color: "#e5e7eb", borderRadius: 6,
            padding: "10px 12px", fontSize: 11, overflow: "auto",
            maxHeight: 280, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          {snap?.log?.length ? snap.log.join("\n") : t("proxy.logEmpty")}
        </pre>
      </div>

      {/* 流量记录 */}
      <ProxyTraffic />
    </div>
  );
}

function Field({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 3 }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 13, color: color ?? "#111827" }}>{value}</div>
    </div>
  );
}

function btnStyle(variant: "primary" | "danger" | "neutral" | "ghost" | "disabled", disabled: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "8px 18px",
    borderRadius: 8,
    border: "none",
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
  // 主色 indigo / 危险 red / 中性 gray-50 / ghost 边框 —— 全部对齐主站调色板。
  if (variant === "primary") return { ...base, background: BRAND.indigo500, color: "#fff" };
  if (variant === "danger")  return { ...base, background: "#dc2626", color: "#fff" };
  if (variant === "neutral") return { ...base, background: "#f3f4f6", color: "#111827", border: "1px solid #e5e7eb" };
  if (variant === "ghost")   return { ...base, background: "transparent", border: "1px solid #e5e7eb", color: "#374151" };
  return { ...base, background: "#f3f4f6", color: "#9ca3af" };
}
