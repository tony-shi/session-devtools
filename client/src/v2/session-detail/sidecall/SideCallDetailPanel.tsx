// SideCallDetailPanel —— 单个 side call（后台 LLM 请求）的 URL 可寻址详情视图。
//
// side call 只由 proxy_requests.id 寻址：没有 transcript turn、没有 prev call、
// 没有可归因的 jsonl 坐标。本面板复用 LLM-call 详情的三个 tab（Attribution /
// Response / Raw），通过给 AttributionTreeLensPanel / ResponseTreePanel 传
// `proxyRequestId` 走 side-call 专用端点。Diff 与 Cache 在此模式下被强制隐藏。
//
// Raw tab 仍走 proxyBody（原始 req/res body）：req_body 是 Anthropic 请求 JSON
// （{model, system, messages, tools}），res_body 是 SSE 文本（流式）或 JSON。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiV2, type ProxyBodyResponse } from "../../api";
import { shortModelName, modelColor, fmtDateShort } from "../../lib/format";
import { EventUnitCard, SegmentView, type EventSegment } from "../../shared/EventUnitCard";
import { AttributionTreeLensPanel } from "../../AttributionTreeLensPanel";
import { ResponseTreePanel } from "../../ResponseTreePanel";
import type { CallTab } from "../session-nav";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

// ── 解析 helpers（纯函数，文件内私有）—— 仅 Raw tab 用 ─────────────────────────

interface ParsedRequest {
  model: string | null;
  /** system blocks 拍平成文本段（string system → 单段；block 数组 → 逐段）。 */
  systemBlocks: string[];
  /** 每条 message 的 role + 抽出的文本（content 是 string 或 block 数组）。 */
  messages: Array<{ role: string; text: string }>;
}

function blockText(content: unknown): string {
  // content 可能是 string，或 [{type:"text",text}, {type:"tool_use",...}, …]。
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object") {
      const block = b as Record<string, unknown>;
      if (typeof block.text === "string") parts.push(block.text);
      else parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

function parseRequest(reqBody: string): ParsedRequest | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(reqBody) as Record<string, unknown>; }
  catch { return null; }

  const model = typeof obj.model === "string" ? obj.model : null;

  const systemBlocks: string[] = [];
  if (typeof obj.system === "string") {
    systemBlocks.push(obj.system);
  } else if (Array.isArray(obj.system)) {
    for (const b of obj.system) {
      if (typeof b === "string") systemBlocks.push(b);
      else if (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string") {
        systemBlocks.push((b as Record<string, unknown>).text as string);
      }
    }
  }

  const messages: Array<{ role: string; text: string }> = [];
  if (Array.isArray(obj.messages)) {
    for (const m of obj.messages) {
      if (m && typeof m === "object") {
        const msg = m as Record<string, unknown>;
        const role = typeof msg.role === "string" ? msg.role : "?";
        messages.push({ role, text: blockText(msg.content) });
      }
    }
  }

  return { model, systemBlocks, messages };
}

// res_body 是 SSE（流式）时：扫描 `data: {...}` 行，把 content_block_delta 的
// delta.text 拼起来；否则当 JSON 解析，抽 .content[].text。两条路径都 best-effort，
// 失败时返回 null（UI 退回展示原始文本）。
function parseResponseText(resBody: string): string | null {
  const trimmed = resBody.trimStart();
  // JSON 响应（非流式）
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(resBody) as Record<string, unknown>;
      if (Array.isArray(obj.content)) return blockText(obj.content);
    } catch { /* fall through to SSE path */ }
  }
  // SSE：逐行抽 `data: {...}` 里的 content_block_delta.delta.text
  const parts: string[] = [];
  for (const line of resBody.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("data:")) continue;
    const payload = trimmedLine.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload) as Record<string, unknown>;
      if (evt.type === "content_block_delta") {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.text === "string") parts.push(delta.text);
      }
    } catch { /* skip非 JSON 行 */ }
  }
  return parts.length > 0 ? parts.join("") : null;
}

// ── Section 壳 ───────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: "#6b7280",
      textTransform: "uppercase", letterSpacing: "0.06em",
      marginBottom: 8,
    }}>
      {children}
    </div>
  );
}

// ── Raw tab：原始 proxy req/res body ──────────────────────────────────────────
// 沿用旧 SideCallDetailPanel 的 proxyBody 路径（按 proxyRequestId 取原始 body）。
function RawTab({ proxyRequestId, sessionId }: { proxyRequestId: number; sessionId: string }) {
  const { t } = useTranslation();
  const [body, setBody] = useState<ProxyBodyResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // 数据加载 effect：标准 fetch-on-mount 模式。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setBody(null);
    apiV2.proxyBody(proxyRequestId)
      .then(d => { if (!cancelled) setBody(d); })
      .catch(() => { if (!cancelled) setBody({ req_body: "", res_body: "", error: "request body unavailable" }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // sessionId 不参与 fetch（proxyBody 仅按 proxyRequestId 寻址），但保留在
    // 依赖里以便 session 切换时也刷新，语义更稳。
  }, [proxyRequestId, sessionId]);

  if (loading) {
    return <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0" }}>{t("callDetail.loading")}</div>;
  }
  if (body?.error) {
    return (
      <div style={{
        fontSize: 11, color: "#b45309",
        background: "#fffbeb", border: "1px solid #fde68a",
        borderRadius: 6, padding: "10px 12px",
      }}>
        {body.error === "request body unavailable" ? t("sideCall.bodyUnavailable") : body.error}
      </div>
    );
  }

  const parsedReq = body ? parseRequest(body.req_body) : null;
  const responseText = body ? parseResponseText(body.res_body) : null;

  return (
    <>
      {/* ══ REQUEST ══════════════════════════════ */}
      <SectionLabel>Request</SectionLabel>
      {!parsedReq ? (
        <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 16 }}>{t("sideCall.parseFailed")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
          {parsedReq.systemBlocks.map((sys, i) => (
            <EventUnitCard
              key={`sys-${i}`}
              color="#64748b"
              kindLabel="System"
              segments={[{ label: "SYSTEM", content: sys, monospace: false, truncateAt: 2000 }]}
              defaultExpanded
              expandable={false}
            />
          ))}
          {parsedReq.messages.map((m, i) => (
            <EventUnitCard
              key={`msg-${i}`}
              color={m.role === "assistant" ? "#16a34a" : "#3b82f6"}
              kindLabel={m.role}
              segments={[{ label: m.role.toUpperCase(), content: m.text || "(empty)", monospace: false, truncateAt: 2000 }]}
              defaultExpanded
              expandable={false}
            />
          ))}
          {parsedReq.systemBlocks.length === 0 && parsedReq.messages.length === 0 && (
            <div style={{ fontSize: 11, color: "#9ca3af" }}>{t("sideCall.emptyRequest")}</div>
          )}
        </div>
      )}

      {/* ══ RESPONSE ═════════════════════════════ */}
      <SectionLabel>Response</SectionLabel>
      {responseText != null ? (
        <div style={{
          border: "1px solid #bbf7d0", background: "#f0fdf4",
          borderRadius: 6, padding: "0 10px 8px",
        }}>
          <SegmentView seg={{ label: "ASSISTANT", content: responseText, monospace: false, truncateAt: 4000 } as EventSegment} />
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "#9ca3af" }}>{t("sideCall.emptyResponse")}</div>
      )}
    </>
  );
}

export function SideCallDetailPanel({
  sessionId, proxyRequestId, kind, model, startedAt, onClose,
}: {
  sessionId: string;
  proxyRequestId: number;
  /** side call 类别（generate_session_title / quota / …），来自 side-calls 列表。 */
  kind?: string;
  /** 模型名，来自 side-calls 列表（proxy 行的 model 列）。 */
  model?: string | null;
  /** 发起时间，来自 side-calls 列表。 */
  startedAt?: string | null;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CallTab>("attribution");

  const TAB_DEFS: Array<{ id: CallTab; label: string }> = [
    { id: "attribution", label: t("callTab.attribution") },
    { id: "response",    label: t("callTab.responseAnalysis") },
    { id: "raw",         label: t("callTab.raw") },
  ];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px", minWidth: 0 }}>
      {/* ── Header（kind / model / time / proxy#id；无 cache ledger） ──────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap", paddingBottom: 10, borderBottom: "1px solid #f3f4f6" }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: "#111827" }}>
          {kind ?? t("sideCall.defaultTitle")}
        </span>
        <span style={{ fontSize: 10, color: "#9ca3af" }}>proxy#{proxyRequestId}</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {model && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 7, height: 7, borderRadius: 2, background: modelColor(model), flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: "#6b7280" }}>{shortModelName(model)}</span>
            </div>
          )}
          {startedAt && <span style={{ fontSize: 10, color: "#9ca3af" }}>{fmtDateShort(startedAt)}</span>}
          {onClose && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onClose}
                  style={{
                    border: "1px solid #e5e7eb", background: "#fff", color: "#64748b",
                    borderRadius: 6, padding: "1px 7px", fontSize: 14, lineHeight: 1,
                    cursor: "pointer", fontWeight: 700,
                  }}
                >
                  ×
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("sideCall.close")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* ── Tabs（镜像 LlmCallDetailPanel 的 TabsList/TabsTrigger 样式） ──── */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as CallTab)}
          className="mb-3.5"
        >
          <TabsList variant="line" className="h-auto border-b border-border w-full justify-start gap-0 rounded-none p-0">
            {TAB_DEFS.map(({ id, label }) => (
              <TabsTrigger
                key={id}
                value={id}
                className="text-[11px] font-normal data-[state=active]:font-bold data-[state=active]:text-indigo-500 text-muted-foreground px-3 py-1.5 -mb-px after:bg-indigo-500"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* ══ Attribution —— side-call 模式：hideDiff + cache 也由 panel 内部隐藏 ══ */}
        {tab === "attribution" && (
          <AttributionTreeLensPanel
            sessionId={sessionId}
            proxyRequestId={proxyRequestId}
            callId={-proxyRequestId}
            hideDiff
          />
        )}

        {/* ══ Response —— assistant blocks ══ */}
        {tab === "response" && (
          <ResponseTreePanel
            sessionId={sessionId}
            proxyRequestId={proxyRequestId}
            callId={-proxyRequestId}
          />
        )}

        {/* ══ Raw —— 原始 proxy req/res body ══ */}
        {tab === "raw" && (
          <RawTab proxyRequestId={proxyRequestId} sessionId={sessionId} />
        )}
      </div>
    </div>
  );
}
