// 代理未启动 / 代理在跑但没数据 时的空态面板。
//
// 抽取自 SessionDetailV2.tsx。这块逻辑跟 LlmCallDetail 的 RawTab 紧密绑定
// （proxy 没数据时整个 tab 退化成这个面板），但它本身是关于 proxy 的，跟 turn /
// call 实体无关，所以放在 `v2/proxy/` 下。
//
// 包含：
//   - `ProxyMissingEmptyState`：主面板（loading / running / stopped 三态）
//   - `navigateToProxyTab`：跨视图导航 helper（dispatch CustomEvent）
//
// 逻辑零改动 —— 只是物理位置变了。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import proxyMissingUrl from "../../../assets/proxy-missing.png";
import { BRAND } from "../../shared/brand";
import { InlineLink, ProxyStatusPill } from "../../shared/SessionBadges";

type ProxyV2Phase = "idle" | "starting" | "running" | "stopping";

interface ProxyV2Status {
  phase: ProxyV2Phase;
  active: boolean;
  port: number;
  pid: number | null;
}

export function navigateToProxyTab() {
  window.dispatchEvent(new CustomEvent("dashboard:navigate", { detail: { tab: "proxy-v2" } }));
}

export function ProxyMissingEmptyState() {
  const { t } = useTranslation();
  const [imgOk, setImgOk] = useState(true);
  const [status, setStatus] = useState<ProxyV2Status | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // 拉一次当前 proxy 状态。后续如果用户点了「启动」，按钮内部会主动再拉。
  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-v2/status")
      .then((r) => r.json())
      .then((d: ProxyV2Status) => { if (!cancelled) setStatus(d); })
      .catch(() => { /* 网络错误也算 stopped 处理 */ })
      .finally(() => { if (!cancelled) setLoadingStatus(false); });
    return () => { cancelled = true; };
  }, []);

  const handleStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const r = await fetch("/api/proxy-v2/start", { method: "POST" });
      const next = await r.json() as ProxyV2Status & { lastError?: string | null };
      setStatus(next);
      if (next.lastError) setStartError(next.lastError);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  // running = phase 是 running 或 starting；都视作"代理已在工作 / 即将工作"
  const isRunning = status?.phase === "running" || status?.phase === "starting";

  // 列表项：左侧一个柔和的小圆点充当 marker，避免直接使用 ⚠ / · 这种突兀符号。
  const renderBullet = (content: React.ReactNode) => (
    <li style={{
      display: "flex", gap: 10, alignItems: "flex-start",
      fontSize: 12, lineHeight: 1.65, color: "#4b5563",
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: 999, background: "#cbd5e1",
        marginTop: 8, flexShrink: 0,
      }} />
      <span style={{ flex: 1 }}>{content}</span>
    </li>
  );

  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      textAlign: "center", padding: "32px 24px", gap: 16,
    }}>
      {imgOk && (
        <img
          src={proxyMissingUrl}
          alt=""
          onError={() => setImgOk(false)}
          style={{ maxWidth: 220, width: "100%", height: "auto", opacity: 0.95 }}
        />
      )}

      {loadingStatus ? (
        <div style={{ fontSize: 12, color: "#9ca3af" }}>
          {t("rawTab.noProxyStatusChecking")}
        </div>
      ) : isRunning ? (
        // ─── 代理已在运行 ───────────────────────────────────────────────────
        // 解释为什么这条 call 仍然没数据，并给出两条 actionable 建议（重启 /
        // 配置第三方域名）。第二条带 inline link 直跳代理 tab。
        <>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1f2937" }}>
            {t("rawTab.noProxyTitleRunning")}
          </div>
          <ProxyStatusPill running label={t("rawTab.noProxyStatusRunning")} />
          <ul style={{
            listStyle: "none", padding: 0, margin: "4px 0 0 0",
            maxWidth: 480, textAlign: "left",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            {renderBullet(t("rawTab.noProxyRunningHintRestart"))}
            {renderBullet(
              <>
                {t("rawTab.noProxyRunningHintThirdParty", {
                  tab: t("nav.proxy"),
                  section: t("proxyTraffic.captureTargets"),
                })}{" "}
                <InlineLink onClick={navigateToProxyTab}>
                  {t("rawTab.noProxyOpenProxyTab")}
                </InlineLink>
              </>,
            )}
          </ul>
        </>
      ) : (
        // ─── 代理未启动 ─────────────────────────────────────────────────────
        // 主 CTA = 内置「启动代理」按钮；副 CTA = 「去启动」inline link 跳到
        // 代理 tab 让用户看更多上下文后再启动。重启提示作为 bullet 收敛。
        <>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1f2937" }}>
            {t("rawTab.noProxyTitleStopped")}
          </div>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 10,
          }}>
            <ProxyStatusPill running={false} label={t("rawTab.noProxyStatusStopped")} />
            <InlineLink onClick={navigateToProxyTab}>
              {t("rawTab.noProxyGoStart")} →
            </InlineLink>
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.65, color: "#4b5563", maxWidth: 480 }}>
            {t("rawTab.noProxyBodyStopped")}
          </div>
          <button
            type="button"
            onClick={handleStart}
            disabled={starting}
            style={{
              padding: "8px 18px", borderRadius: 8,
              border: "none",
              background: starting ? BRAND.indigo200 : BRAND.indigo500,
              color: "#fff", fontWeight: 600, fontSize: 13,
              cursor: starting ? "not-allowed" : "pointer",
              minWidth: 120,
            }}
          >
            {starting ? t("rawTab.noProxyStartButtonBusy") : t("rawTab.noProxyStartButton")}
          </button>
          {startError && (
            <div style={{
              fontSize: 11, color: "#991b1b",
              background: "#fef2f2", border: "1px solid #fecaca",
              borderRadius: 6, padding: "6px 10px", maxWidth: 480,
            }}>
              {t("rawTab.noProxyStartFailed", { error: startError })}
            </div>
          )}
          <ul style={{
            listStyle: "none", padding: 0, margin: "4px 0 0 0",
            maxWidth: 480, textAlign: "left",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            {renderBullet(t("rawTab.noProxyRestartHint"))}
          </ul>
        </>
      )}
    </div>
  );
}
