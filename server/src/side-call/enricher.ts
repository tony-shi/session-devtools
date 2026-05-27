// side-call/enricher.ts —— side_call_facts 派生索引的应用域模块（隔离旁路）
// =============================================================================
//
// 这是唯一持有 query_kind 语义的地方。cold-indexer 通过 registerProxyEnricher 注册
// 本模块的 hook，对每条入库 proxy 记录做指纹分类并写 side_call_facts —— 让 per-session
// 的 side-call 扫描改读派生表，不再在热路径上解压几十个 .gz。
//
//   • 入库即填：proxyEnricherHook 在 cold-indexer 解析每行时被调用（带原始 record，
//     无需再解压）。任何异常都被吞掉，绝不冒泡进 indexer。
//   • 惰性回扫：ensureSessionScanned 对存量 session 跑一次 classifyResidualProxies
//     （读 body，一次性成本），把结果落表并打 scanned 标记，下次加载即走表。
//
// query_kind / link_fact 语义：
//   link_fact 仅对 generate_session_title 有意义（= 响应标题文本），其余 kind 为 null。

import type { Database } from "better-sqlite3";
import {
  CLASSIFIER_VERSION as GHOST_CLASSIFIER_VERSION,
  classifyReqBody,
  classifyResidualProxies,
  extractTitle,
  extractResponseText,
} from "../ghost-attribution.ts";
import { registerProxyEnricher } from "../proxy-v2/log/cold-indexer.ts";
import { getDb, serializeWrite } from "../db.ts";

export const CLASSIFIER_VERSION = GHOST_CLASSIFIER_VERSION;

// 纯函数：原始 proxy record（含 reqBody/resBody 字符串）→ { queryKind, linkFact }。
// 非后台调用（不命中任何 detector）返回 null。
export function classifyRawRecord(
  rec: Record<string, unknown>,
): { queryKind: string; linkFact: string | null } | null {
  let reqBody: Record<string, unknown>;
  try {
    reqBody = JSON.parse(typeof rec.reqBody === "string" ? rec.reqBody : "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
  const kind = classifyReqBody(reqBody);
  if (!kind) return null;

  let linkFact: string | null = null;
  if (kind === "generate_session_title" || kind === "away_summary") {
    const meta = (rec.meta as Record<string, unknown> | undefined) ?? undefined;
    let isStream: boolean;
    if (meta && typeof meta.isStream === "boolean") {
      isStream = meta.isStream;
    } else {
      // 兼容旧格式：resBody 里 "[sse N events, M bytes]" 占位符即视为流式
      const resBody = typeof rec.resBody === "string" ? rec.resBody : "";
      isStream = /^\[sse \d+ events, \d+ bytes\]$/.test(resBody);
    }
    // generate_session_title 解 {title}；away_summary 用响应摘要全文。
    linkFact = (kind === "generate_session_title" ? extractTitle(rec, isStream) : extractResponseText(rec, isStream)) ?? null;
  }
  return { queryKind: kind, linkFact };
}

// INSERT OR REPLACE 一条 fact。幂等：重复入库/回扫同 (session_id, request_id) 覆盖。
export function upsertFact(
  db: Database,
  sessionId: string,
  requestId: string,
  queryKind: string,
  linkFact: string | null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO side_call_facts
       (session_id, request_id, query_kind, link_fact, classifier_version)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, requestId, queryKind, linkFact, CLASSIFIER_VERSION);
}

// cold-indexer 注册的 hook：对每条入库 record 做分类并落表。
// 全程 try/catch —— 任何错误绝不冒泡进 indexer（坏 record 不能中断冷索引）。
export function proxyEnricherHook(
  rec: Record<string, unknown>,
  ctx: { sessionId: string | null; requestId: string | null },
): void {
  try {
    if (!ctx.sessionId || !ctx.requestId) return;
    const classified = classifyRawRecord(rec);
    if (!classified) return;
    upsertFact(getDb(), ctx.sessionId, ctx.requestId, classified.queryKind, classified.linkFact);
  } catch (e) {
    console.warn("[side-call] enricher hook failed (swallowed):", e);
  }
}

// 同一 session 的并发 ensureSessionScanned 去重：第一个调用建 promise，后续复用。
const _inFlight = new Map<string, Promise<void>>();

// 惰性 per-session 回扫：若该 session 已在当前 CLASSIFIER_VERSION 下扫描过则直接返回；
// 否则跑 classifyResidualProxies（读 body，一次性成本），落表 + 打 scanned 标记。
export function ensureSessionScanned(db: Database, sessionId: string): Promise<void> {
  const marker = db
    .prepare("SELECT classifier_version FROM side_call_scanned_sessions WHERE session_id = ?")
    .get(sessionId) as { classifier_version: number } | undefined;
  if (marker && marker.classifier_version >= CLASSIFIER_VERSION) return Promise.resolve();

  const existing = _inFlight.get(sessionId);
  if (existing) return existing;

  const run = (async () => {
    const ghosts = await classifyResidualProxies(db, sessionId, new Set<string>());
    await serializeWrite(() => {
      db.transaction(() => {
        for (const g of ghosts) {
          if (!g.requestId) continue;
          // g.title 已被 classifyResidualProxies 复用为通用 link_fact
          // （generate_session_title=标题 / away_summary=摘要全文 / 其余=undefined）。
          upsertFact(db, sessionId, g.requestId, g.kind, g.title ?? null);
        }
        db.prepare(
          `INSERT OR REPLACE INTO side_call_scanned_sessions
             (session_id, classifier_version, scanned_at)
           VALUES (?, ?, ?)`,
        ).run(sessionId, CLASSIFIER_VERSION, new Date().toISOString());
      })();
    });
  })().finally(() => {
    _inFlight.delete(sessionId);
  });

  _inFlight.set(sessionId, run);
  return run;
}

// 启动时调用一次，把 hook 注册进 cold-indexer。
export function registerSideCallEnricher(): void {
  registerProxyEnricher(proxyEnricherHook);
}
