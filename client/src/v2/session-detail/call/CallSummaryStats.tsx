import React from "react";
import { fmtGap } from "../../lib/format";
import { LedgerExplainerBody } from "../../shared/LedgerExplainer";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";

export function SummaryStat({
  label, tooltip, children, valueColor = "#111827", mono = false, minWidth, dotColor,
}: {
  label: string;
  tooltip: React.ReactNode;
  children: React.ReactNode;
  valueColor?: string;
  mono?: boolean;
  size?: "meta" | "metric";
  minWidth?: number;
  dotColor?: string;
}) {
  const valueSize = 11;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="hover:bg-slate-200/90 dark:hover:bg-slate-700/90 hover:shadow-sm border border-transparent hover:border-slate-200 dark:hover:border-slate-700 transition-all duration-150"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 3,
            minWidth,
            padding: "4px 8px",
            borderRadius: 6,
            cursor: "help",
          }}
        >
          <span
            style={{
              color: "#94a3b8",
              fontSize: 9,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "0.02em",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
          <span
            style={{
              color: valueColor,
              fontSize: valueSize,
              fontWeight: 650,
              lineHeight: 1.12,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              whiteSpace: "nowrap",
              fontFamily: mono ? "ui-monospace, SFMono-Regular, monospace" : undefined,
            }}
          >
            {dotColor && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: dotColor,
                  flexShrink: 0,
                  display: "inline-block",
                }}
              />
            )}
            {children}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px] text-xs">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function CacheSummaryStat({
  label, tooltip,
  ratio, freshIn, cacheRead, cacheWrite, output, cacheMiss, gapMs, minWidth,
}: {
  label: string;
  tooltip: string;
  ratio: number | null;
  freshIn: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cacheMiss?: boolean;
  gapMs?: number | null;
  minWidth?: number;
}) {
  const ratioText = ratio != null ? `${ratio.toFixed(1)}%` : "—";
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <div
          className="hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-150"
          title={tooltip}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 3,
            minWidth,
            padding: "4px 8px",
            borderRadius: 6,
            cursor: "help",
          }}
        >
          <span
            style={{
              color: "#94a3b8",
              fontSize: 9,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "0.02em",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
          <span
            style={{
              color: cacheMiss ? "#b45309" : "#15803d",
              fontSize: 11,
              fontWeight: 650,
              lineHeight: 1.12,
              whiteSpace: "nowrap",
            }}
          >
            {ratioText}
          </span>
        </div>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-[460px] p-3">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cacheMiss && (
            <div style={{ color: "#b45309", fontWeight: 700, fontSize: 11 }}>
              cache miss{gapMs != null ? ` · ${fmtGap(gapMs)} gap` : ""}
            </div>
          )}
          <LedgerExplainerBody
            variant="call"
            freshIn={freshIn}
            cacheRead={cacheRead}
            cacheWrite={cacheWrite}
            output={output}
            ratio={ratio}
          />
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
