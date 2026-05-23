// Proxy v2 管理页 —— 顶部 TopBar (开关 + 状态) + 拦截目标 inline + 流量列表为主体 + 日志折叠 drawer。
//
// 布局意图：第一屏被 chrome 吃掉的高度尽可能少，让 ProxyTraffic 占主舞台。
// 拦截目标本身就是 chip 行 + 输入框，体积小，不值得折叠；日志会很长所以收起。
//
// 例外：lastError / lastWarnings / preflightWarnings 永远 inline 展示——
// 错误是信号不是配置，必须高亮可见。
//
// 样式：全部走 shadcn 组件（Button / Badge / Sheet）+ Tailwind tokens，
// 不再手写 inline styles。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Info, Settings } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProxyTraffic, CaptureTargets } from "./ProxyTraffic";

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

// Phase 色板：直接覆盖 Badge 的 className，因为现成的 indigo/violet/amber
// 没有 emerald（running），统一在这里 mapping 一次比四处散落 variant 干净。
const PHASE_BADGE: Record<Phase, string> = {
  running:  "bg-emerald-50 text-emerald-700 border-transparent",
  starting: "bg-indigo-50 text-indigo-700 border-transparent",
  stopping: "bg-amber-50 text-amber-700 border-transparent",
  idle:     "bg-muted text-muted-foreground border-transparent",
};

export function ProxyV2Setup() {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
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

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [snap?.log.length, showLog]);

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
  const isTransitioning = phase === "starting" || phase === "stopping";

  const phaseLabel =
    phase === "running"  ? t("proxy.phaseRunning") :
    phase === "starting" ? t("proxy.phaseStarting") :
    phase === "stopping" ? t("proxy.phaseStopping") : t("proxy.phaseIdle");

  // 永远只展示一个主操作：running/starting 时是"停止"，否则是"启动"。
  // 避免两个 button 同框时一个 disabled 一个 active 的视觉割裂。
  const showStop = phase === "running" || phase === "starting";
  const logCount = snap?.log?.length ?? 0;

  return (
    <div className="flex flex-col gap-2.5">
      {/* ── Top bar 紧凑工具栏 ───────────────────────────────────────────── */}
      <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-2.5">
        <Badge className={cn(PHASE_BADGE[phase], "px-2.5")}>
          ● {phaseLabel}
        </Badge>
        <Badge variant="outline" className="font-mono text-[11px] font-normal text-muted-foreground">
          :{snap?.port ?? "-"}
        </Badge>
        <Badge variant="outline" className="font-mono text-[11px] font-normal text-muted-foreground">
          pid {snap?.pid ?? "-"}
        </Badge>

        <div className="ml-auto flex items-center gap-2">
          {showStop ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => doAction("stop")}
              disabled={busy || isTransitioning}
            >
              {t("proxy.btnStop")}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => doAction("start")}
              disabled={busy || isTransitioning}
            >
              {t("proxy.btnStart")}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={fetchStatus} disabled={busy}>
            {t("proxy.btnRefresh")}
          </Button>
          <Button
            size="icon"
            variant="outline"
            className="size-8"
            title={t("proxy.intro")}
            aria-label={t("proxy.intro")}
          >
            <Info />
          </Button>
          <Button
            size="icon"
            variant="outline"
            className="size-8"
            onClick={() => setShowConfig(true)}
            aria-label={t("proxy.configTitle")}
          >
            <Settings />
          </Button>
        </div>
      </div>

      {/* ── 错误 / warnings inline ───────────────────────────────────────── */}
      {snap?.lastError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <div className="mb-1 font-semibold">{t("proxy.errorTitle")}</div>
          <div>{snap.lastError}</div>
          {snap.respawnAttempt > 0 && (
            <div className="mt-1 text-xs opacity-80">
              {t("proxy.crashCount", { n: snap.respawnAttempt })}
            </div>
          )}
        </div>
      )}

      {snap && snap.lastWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
          <div className="mb-1 font-semibold">{t("proxy.warningsTitle")}</div>
          <ul className="m-0 list-disc pl-5">
            {snap.lastWarnings.map((w, i) => <li key={i}>[{w.step}] {w.reason}</li>)}
          </ul>
        </div>
      )}

      {snap && snap.preflightWarnings.length > 0 && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-700">
          <div className="mb-1 font-semibold">{t("proxy.preflightTitle")}</div>
          <ul className="m-0 list-disc pl-5">
            {snap.preflightWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* ── 拦截目标 inline ──────────────────────────────────────────────── */}
      <CaptureTargets />

      {/* ── 主体：流量列表 ─────────────────────────────────────────────── */}
      <ProxyTraffic />

      {/* ── 日志折叠 drawer ────────────────────────────────────────────── */}
      <LogDrawer
        open={showLog}
        onToggle={() => setShowLog((v) => !v)}
        lines={snap?.log ?? []}
        emptyLabel={t("proxy.logEmpty")}
        title={t("proxy.logTitle")}
        summary={t("proxy.logCount", { n: logCount })}
        logRef={logRef}
      />

      {/* ── 配置 Sheet ─────────────────────────────────────────────────── */}
      <Sheet open={showConfig} onOpenChange={setShowConfig}>
        <SheetContent side="right" className="w-[min(420px,100vw)] sm:max-w-none">
          <SheetHeader>
            <SheetTitle>{t("proxy.configTitle")}</SheetTitle>
            <SheetDescription>{t("proxy.subtitle")}</SheetDescription>
          </SheetHeader>
          <div className="mt-4 grid grid-cols-2 gap-4 px-4">
            <Field label={t("proxy.fieldTarget")} value={target} />
            <Field label={t("proxy.fieldPort")} value={String(snap?.port ?? "-")} />
            <Field label={t("proxy.fieldPid")} value={snap?.pid ? String(snap.pid) : "-"} />
            <Field
              label={t("proxy.fieldActive")}
              value={snap?.active ? t("proxy.fieldActiveYes") : t("proxy.fieldActiveNo")}
              tone={snap?.active ? "ok" : "muted"}
            />
          </div>
          <div className="mx-4 mt-5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-xs leading-relaxed text-indigo-700">
            {t("proxy.intro")}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ── 日志折叠 drawer ─────────────────────────────────────────────────────────
function LogDrawer({ open, onToggle, lines, emptyLabel, title, summary, logRef }: {
  open: boolean;
  onToggle: () => void;
  lines: string[];
  emptyLabel: string;
  title: string;
  summary: string;
  logRef: React.RefObject<HTMLPreElement | null>;
}) {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-3.5 py-2 text-sm text-foreground hover:bg-muted/50"
      >
        <ChevronRight
          className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="font-semibold">{title}</span>
        <span className="text-xs font-normal text-muted-foreground">{summary}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {open ? t("proxy.collapse") : t("proxy.expand")}
        </span>
      </button>
      {open && (
        <div className="border-t px-4 py-3">
          <pre
            ref={logRef}
            className="m-0 max-h-[280px] overflow-auto rounded-md bg-neutral-800 p-3 font-mono text-[11px] leading-relaxed text-neutral-100 whitespace-pre-wrap break-all"
          >
            {lines.length > 0 ? lines.join("\n") : emptyLabel}
          </pre>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: "ok" | "muted" }) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-muted-foreground">{label}</div>
      <div className={cn(
        "text-sm font-semibold",
        tone === "ok" && "text-emerald-600",
        tone === "muted" && "text-muted-foreground",
      )}>
        {value}
      </div>
    </div>
  );
}
