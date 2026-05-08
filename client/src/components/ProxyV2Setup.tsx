// Proxy v2 管理页 —— 控制面板（Start / Stop）+ 流量展示。
import { useEffect, useRef, useState } from "react";
import { ProxyTraffic } from "./ProxyTraffic";

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

  const phaseColor =
    phase === "running"  ? "#34c759" :
    phase === "starting" ? "#007aff" :
    phase === "stopping" ? "#ff9f0a" : "#8e8e93";

  const phaseLabel =
    phase === "running"  ? "运行中" :
    phase === "starting" ? "启动中…" :
    phase === "stopping" ? "停止中…" : "已停止";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 警告条 */}
      <div style={{
        background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8,
        padding: "10px 16px", fontSize: 13, color: "#1e40af",
      }}>
        Proxy v2 — 极简控制器版。Start = 注入 settings + 启动；Stop = 还原 settings + 停止。
        Dashboard 退出时自动 Stop。
      </div>

      {/* 状态卡片 */}
      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e5e5", padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17 }}>Proxy v2</div>
            <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>controller-managed</div>
          </div>
          <div style={{
            padding: "4px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600,
            background: `${phaseColor}15`, color: phaseColor,
          }}>
            ● {phaseLabel}
          </div>
        </div>

        {/* 字段网格 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
          <Field label="target" value={target} />
          <Field label="port" value={String(snap?.port ?? "-")} />
          <Field label="pid" value={snap?.pid ? String(snap.pid) : "-"} />
          <Field label="active.json" value={snap?.active ? "存在" : "无"} color={snap?.active ? "#34c759" : "#8e8e93"} />
        </div>

        {/* 按钮 */}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => doAction("start")}
            disabled={busy || isRunning || isTransitioning}
            style={btnStyle(isRunning ? "disabled" : "primary", busy || isRunning || isTransitioning)}
          >
            启动
          </button>
          <button
            onClick={() => doAction("stop")}
            disabled={busy || (phase === "idle" && !snap?.active && !snap?.pid) || isTransitioning}
            style={btnStyle(isRunning ? "danger" : "neutral", busy || isTransitioning)}
          >
            停止
          </button>
          <button
            onClick={fetchStatus}
            disabled={busy}
            style={btnStyle("ghost", busy)}
          >
            刷新
          </button>
        </div>

        {/* 错误展示 */}
        {snap?.lastError && (
          <div style={{
            marginTop: 14, padding: "10px 12px", borderRadius: 7,
            background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 13,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>✗ 上次失败</div>
            <div>{snap.lastError}</div>
            {snap.respawnAttempt > 0 && (
              <div style={{ marginTop: 4, fontSize: 11, opacity: 0.8 }}>
                连续崩溃 {snap.respawnAttempt} 次
              </div>
            )}
          </div>
        )}

        {/* warnings */}
        {snap && snap.lastWarnings.length > 0 && (
          <div style={{
            marginTop: 14, padding: "10px 12px", borderRadius: 7,
            background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>⚠ 清理 warnings（不阻断完成）</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {snap.lastWarnings.map((w, i) => <li key={i}>[{w.step}] {w.reason}</li>)}
            </ul>
          </div>
        )}

        {snap && snap.preflightWarnings.length > 0 && (
          <div style={{
            marginTop: 10, padding: "8px 12px", borderRadius: 7,
            background: "#f0f9ff", border: "1px solid #bae6fd", color: "#075985", fontSize: 12,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>preflight warnings（已通过）</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {snap.preflightWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* 日志窗口 */}
      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e5e5", padding: "14px 20px" }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>日志（最近 50 条）</div>
        <pre
          ref={logRef}
          style={{
            background: "#1a1a1a", color: "#d8d8d8", borderRadius: 7,
            padding: "10px 12px", fontSize: 11, overflow: "auto",
            maxHeight: 280, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          {snap?.log?.length ? snap.log.join("\n") : "(暂无日志)"}
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
      <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 13, color: color ?? "#111" }}>{value}</div>
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
  if (variant === "primary") return { ...base, background: "#007aff", color: "#fff" };
  if (variant === "danger")  return { ...base, background: "#ff3b30", color: "#fff" };
  if (variant === "neutral") return { ...base, background: "#e5e5ea", color: "#111" };
  if (variant === "ghost")   return { ...base, background: "transparent", border: "1px solid #ddd", color: "#444" };
  return { ...base, background: "#e5e5ea", color: "#999" };
}
