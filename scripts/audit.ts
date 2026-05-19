#!/usr/bin/env tsx
//
// audit.ts —— Context Ledger 审计脚本
// =====================================
//
// 这个脚本是 ForwardAudit + ReverseAudit 的统一入口，只回答两个问题：
//   1. proxy 请求里的"叶子"（最小可对账单元）是否能在 jsonl 中找到来源
//      —— 按 coverageState 分桶为 full / partial / none。
//   2. jsonl 里的原子单元（user_input / assistant_text / tool_use /
//      tool_result / attachment）是否被任何 segment 引用 —— 没被引用的进入
//      `reverse.missing` 列表。
//
// 取代了已归档的 context-audit.ts / context-audit-rule-coverage.ts /
// context-audit-fixtures-full.ts，以及旧的 reconciliation / reconstruction /
// scorecard / verdict 链路。
//
// ─────────────────────────────────────────────────────────────────────────────
// 两种运行模式
// ─────────────────────────────────────────────────────────────────────────────
//
//   1) Fixture 模式（默认）—— 跑离线 fixture 目录，每个目录含
//      `proxy-request.json` + `session.jsonl`，主要用于回归测试和规则调试。
//
//   2) Local 模式（`--local`）—— 跑本地 SQLite (`~/.api-dashboard/sessions.db`)
//      里的真实 session，主要用于回答"我们到底覆盖了多少线上场景"。
//
// ─────────────────────────────────────────────────────────────────────────────
// 用法
// ─────────────────────────────────────────────────────────────────────────────
//
//   # —— Fixture 模式 ——
//   tsx scripts/audit.ts                       # 默认扫 server/test/fixtures/context-reconstruction/*
//   tsx scripts/audit.ts <fixture-dir>         # 单个 fixture
//   tsx scripts/audit.ts --json                # JSON 输出
//
//   # —— Local 模式 ——
//   tsx scripts/audit.ts --local               # 默认：每 session 只跑 last call，多进程
//   tsx scripts/audit.ts --local --last-n=3    # 每 session 跑最后 N 个 call（覆盖 compact 边界）
//   tsx scripts/audit.ts --local --all-calls   # 全量：每 session 跑所有 call（慢，发版基线用）
//   tsx scripts/audit.ts --local --limit=20    # 只跑前 20 个 session（按 last_event_at DESC）
//   tsx scripts/audit.ts --local --workers=4   # 指定 worker 数（默认 = cpu/2）
//   tsx scripts/audit.ts --local --serial      # 单进程串行（调试用，关掉 IPC）
//   tsx scripts/audit.ts --local --json        # JSON 输出
//
// ─────────────────────────────────────────────────────────────────────────────
// 性能与默认值（为什么默认 last-call）
// ─────────────────────────────────────────────────────────────────────────────
//
// 一个 session 里 N 个 call 的 reqBody 是累积的 —— call_N 几乎包含
// call_1..call_{N-1} 的所有上下文。对每个 call 都跑一遍 audit 是 O(N²) 量级
// 的重复计算。实测全量数据集（~360 sessions）：
//
//                    attr 调用数    wall time     内存
//   --all-calls      ~26,000        ~13 分钟      多进程会爆 10+ GiB
//   --last-call      ~360           ~6 秒         <1 GiB
//
// 因此默认改成 last-call，并保留 `--last-n=K` / `--all-calls` 兜底。
//
// ─────────────────────────────────────────────────────────────────────────────
// TODO(audit-coverage-vs-cost)
// ─────────────────────────────────────────────────────────────────────────────
//
// last-call 模式会漏掉两类信号：
//   (a) compact / summary 之后的 session：pre-compact turn 的 partial.byReason
//       不会再出现在 last call 的累积 context 中，对应的 rule 失配看不见；
//   (b) 仅在早期 call 出现、之后被覆盖/淘汰的一次性 leaf —— 同上。
//
// 缓解办法：
//   - 每周 / 发版前跑一次 `--all-calls` 作为基线，diff 出 last-call 漏掉的
//     partial.byReason / jsonl.missing 维度，决定是否调高默认 `--last-n=K`。
//   - 长期：在 last-call 之外，额外采样每个 session 的 compact 前后一个 call，
//     既覆盖 compact 边界，又远低于全量成本。
//
// 另：默认 last-call 之后，C（多进程 worker pool）+ D（proxy 文件 LRU 缓存）
// 这两层都不再是瓶颈，复杂度有进一步简化空间。

import { readFileSync, readdirSync, statSync, existsSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { attributeWithJsonl } from "../server/src/context-ledger/parser";
import type { LinkableJsonlEvent } from "../server/src/context-ledger/parser";
import {
  readSessionEventsForLinker,
  loadAttributionTree,
  type AttributionTreeResult,
} from "../server/src/attribution-service";
import { getDb } from "../server/src/db";
import { parseSessionDrilldown } from "../server/src/session-drilldown-parser";
import { findProxyRowForCall } from "../server/src/call-detail";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// worker 走独立 tsx 子进程（child_process.spawn + stdio: 'ipc'）：
// monorepo 下 worker_threads 不会带上仓库 tsx loader，最稳定是每个 worker 自己启 tsx。
const TSX_BIN = resolve(__dirname, "../server/node_modules/.bin/tsx");
const WORKER_ENV_FLAG = "AUDIT_SNAPSHOT_WORKER";

interface FixtureAudit {
  fixture: string;
  leafCount: number;
  full: number;
  partial: number;
  none: number;
  partialTopReasons: Array<[string, number]>;
  jsonlMissing: number;
  jsonlMissingByKind: Record<string, number>;
}

function discoverFixtures(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, "proxy-request.json"))) out.push(p);
  }
  return out;
}

function runOne(fixtureDir: string): FixtureAudit {
  // proxy-request.json fixture 是完整 record（含 ts / reqHeaders / reqBody），
  // 不是裸 reqBody — 这里解包后再喂给 parser。
  const raw = JSON.parse(readFileSync(join(fixtureDir, "proxy-request.json"), "utf-8"));
  const reqBody = raw.reqBody ?? raw;
  const reqHeaders = raw.reqHeaders ?? {};
  const ts = raw.ts ?? raw.startedAt;
  const jsonlPath = join(fixtureDir, "session.jsonl");
  const events: LinkableJsonlEvent[] = existsSync(jsonlPath)
    ? readSessionEventsForLinker(jsonlPath)
    : [];

  const { audit } = attributeWithJsonl({
    reqBody,
    proxyFile: fixtureDir,
    reqHeaders,
    ts,
    jsonl: events,
    call: { callId: 0, turnId: 0 },
  });

  const partialReasonCounts = Object.entries(audit.forward.partial.byReason)
    .map(([r, ids]) => [r, ids.length] as [string, number])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  const missingByKind: Record<string, number> = {};
  for (const m of audit.reverse.missing) {
    missingByKind[m.eventKind] = (missingByKind[m.eventKind] ?? 0) + 1;
  }

  return {
    fixture: fixtureDir.split("/").slice(-1)[0],
    leafCount: audit.forward.totals.leafCount,
    full: audit.forward.totals.full,
    partial: audit.forward.totals.partial,
    none: audit.forward.totals.none,
    partialTopReasons: partialReasonCounts.slice(0, 3),
    jsonlMissing: audit.reverse.missing.length,
    jsonlMissingByKind: missingByKind,
  };
}

function printTable(rows: FixtureAudit[]) {
  // Plain text columns; widths fixed for readability.
  const header = ["fixture", "leaves", "full", "partial", "none", "missing(jsonl)"];
  const widths = [32, 7, 5, 8, 5, 14];
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i])).join(" ");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join(" "));
  for (const r of rows) {
    console.log(fmt([
      r.fixture,
      String(r.leafCount),
      String(r.full),
      String(r.partial),
      String(r.none),
      String(r.jsonlMissing),
    ]));
  }
  console.log("");
  // Detailed partial reasons + missing kinds per fixture (only if non-empty).
  for (const r of rows) {
    if (r.partialTopReasons.length === 0 && r.jsonlMissing === 0) continue;
    console.log(`▸ ${r.fixture}`);
    if (r.partialTopReasons.length > 0) {
      console.log("    partial.byReason:");
      for (const [reason, n] of r.partialTopReasons) console.log(`      ${reason}: ${n}`);
    }
    if (r.jsonlMissing > 0) {
      console.log("    jsonl.missing byKind:");
      for (const [kind, n] of Object.entries(r.jsonlMissingByKind)) {
        console.log(`      ${kind}: ${n}`);
      }
    }
    console.log("");
  }
}

// ─── 本地 SQLite 批量模式 ────────────────────────────────────────────────────

interface CallAudit {
  sessionId: string;
  callId: number;
  leafCount: number;
  full: number;
  partial: number;
  none: number;
  jsonlMissing: number;
  /** 从 snapshot.ccVersion 拿到的 cc_version 四段字符串；header 漂移时为 undefined。 */
  ccVersion?: string;
}

interface SkippedCall {
  sessionId: string;
  callId: number;
  reason: string;
}

interface SessionAudit {
  sessionId: string;
  callCount: number;
  leafCount: number;
  full: number;
  partial: number;
  none: number;
  jsonlMissing: number;
  skipped: number;
  // 聚合 partial.byReason + reverse.missing.byKind + none.byKind 用于明细模式（默认折叠）。
  partialByReason: Record<string, number>;
  jsonlMissingByKind: Record<string, number>;
  noneByKind: Record<string, number>; // structural_no_rule | unknown
  /** 该 session 第一条成功 audit 的 call 取到的 cc_version；用于按版本分组。 */
  ccVersion?: string;
  /** structural_no_rule + unknown 叶子按 slotType 拆分，方便定位"哪个 slot 在该
   *  cc_version 下漏 rule"。 */
  noneBySlot: Record<string, number>;
}

// 内部 perf 计数：判断 A/D 缓存是否真起作用 + 分清耗时归宿。
const perf = {
  jsonlReads: 0,
  jsonlCacheHits: 0,
  proxyReads: 0,
  proxyReadMs: 0,
  proxyFileDecompresses: 0,
  proxyFileCacheHits: 0,
  attrMs: 0,
  attrCount: 0,
};

// ─── D: proxy traffic.jsonl.gz LRU 解压缓存 ──────────────────────────────────
//
// readProxyRecord（call-detail.ts）原实现每次都从 .gz 文件从头解压到 byte offset，
// 同一个 traffic 文件被多个 call 命中时反复浪费。这里做 in-memory 缓存：
//   - 第一次访问：整文件解压到 Buffer，存入 fileCache
//   - 后续访问：从 Buffer 按 byte offset 切到下一个 '\n'，O(1) 读取
//   - LRU 容量：默认 2 GiB（按整 Buffer 字节数累加），按插入顺序淘汰最早的
//
// 仅用于本批量脚本；server 运行时不变（不长期占用内存）。

const PROXY_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const proxyFileCache = new Map<string, Buffer>(); // 保序：先进先淘汰
let proxyFileCacheBytes = 0;

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function getDecompressedFile(path: string): Promise<Buffer> {
  const cached = proxyFileCache.get(path);
  if (cached) {
    // LRU bump：移到 Map 末尾
    proxyFileCache.delete(path);
    proxyFileCache.set(path, cached);
    perf.proxyFileCacheHits += 1;
    return cached;
  }
  perf.proxyFileDecompresses += 1;
  let buf: Buffer;
  if (path.endsWith(".gz")) {
    buf = await streamToBuffer(createReadStream(path).pipe(createGunzip()));
  } else {
    buf = readFileSync(path);
  }
  proxyFileCache.set(path, buf);
  proxyFileCacheBytes += buf.byteLength;
  // 容量驱逐：超过上限就从最早的 entry 开始淘汰
  while (proxyFileCacheBytes > PROXY_CACHE_MAX_BYTES && proxyFileCache.size > 1) {
    const [oldestPath, oldestBuf] = proxyFileCache.entries().next().value!;
    proxyFileCache.delete(oldestPath);
    proxyFileCacheBytes -= oldestBuf.byteLength;
  }
  return buf;
}

const NEWLINE = 0x0a;

async function readProxyRecordCached(
  file: string,
  byteOffset: number,
): Promise<Record<string, unknown> | null> {
  if (!existsSync(file)) return null;
  let buf: Buffer;
  try { buf = await getDecompressedFile(file); }
  catch { return null; }
  if (byteOffset >= buf.byteLength) return null;
  let end = buf.indexOf(NEWLINE, byteOffset);
  if (end < 0) end = buf.byteLength;
  const line = buf.slice(byteOffset, end).toString("utf8");
  try { return JSON.parse(line) as Record<string, unknown>; }
  catch { return null; }
}

// ─── Forked-agent ghost proxy 识别（audit-only） ────────────────────────────
//
// Claude Code 的若干背景服务通过 `runForkedAgent({ ..., skipTranscript: true })`
// 复制主线程上下文 + 追加一条专用 prompt，发起一次单独的 API call。这类 call：
//   - 在 proxy_requests 表里**存在**（真 HTTP request）
//   - 在主线程 JSONL 里**不存在**（skipTranscript:true）
//   - **不会**反向污染主线程 messages —— fork return 后整段 messages 被丢弃，
//     主线程下一次发请求时 reqBody 重新从 JSONL 重建，没有 fork 残留
//
// 后果：若某 session 的最近 proxy 恰好是一条 fork，
// `findProxyRowForCall` 时间窗 fallback 会把它错挂到下一个 JSONL 主线程 call 上
// （call 232 case：参见 docs/inner/context-ledger/roadmap.md §3）。audit 拿到
// 错号 reqBody 后会算出一堆"伪 partial / 伪 missing"。
//
// 这里做"宽容识别"：检查 reqBody 末尾的 user message 是否命中已知 fork prompt
// 字面常量集。命中 → 该 proxy 视为 ghost，audit skip。识别口径只覆盖能从
// reqBody 内容判定的 fork；speculation fork（restored-src/src/services/
// PromptSuggestion/speculation.ts）发送的是上一次的 suggestion 字符串，内容随
// 上下文变化，无法仅靠字面常量判定，roadmap 里登记为"待加 proxy 表 query_source 列"。
interface ForkDetection {
  label: string;
  prefix: string;
}
const FORK_PROMPT_DETECTORS: ForkDetection[] = [
  // restored-src/src/services/PromptSuggestion/promptSuggestion.ts:258
  { label: "prompt_suggestion", prefix: "[SUGGESTION MODE: Suggest what the user might naturally type" },
  // restored-src/src/services/AgentSummary/agentSummary.ts:28 (buildSummaryPrompt)
  { label: "agent_summary", prefix: "Describe your most recent action in 3-5 words using present tense" },
  // restored-src/src/services/autoDream/consolidationPrompt.ts:16
  { label: "auto_dream", prefix: "# Dream: Memory Consolidation" },
  // restored-src/src/services/extractMemories/prompts.ts:29 (opener)
  { label: "extract_memories", prefix: "You are now acting as the memory extraction subagent" },
];

function detectForkProxy(reqBody: Record<string, unknown>): ForkDetection | null {
  const msgs = reqBody.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  const last = msgs[msgs.length - 1] as { role?: unknown; content?: unknown };
  if (last?.role !== "user") return null;
  // 提取末条 user message 的首个 text block。
  let firstText: string | undefined;
  if (typeof last.content === "string") firstText = last.content;
  else if (Array.isArray(last.content)) {
    for (const b of last.content as Array<{ type?: unknown; text?: unknown }>) {
      if (b?.type === "text" && typeof b?.text === "string") {
        firstText = b.text;
        break;
      }
    }
  }
  if (!firstText) return null;
  for (const det of FORK_PROMPT_DETECTORS) {
    if (firstText.startsWith(det.prefix)) return det;
  }
  return null;
}

// loadAttributionTree 的 helpers — 与 sessions-v2.controller.ts 中的实现一致，
// 外加一个 session 级别的 jsonl events 缓存（A: events 缓存）。
function buildHelpers(db: ReturnType<typeof getDb>, sessionId: string, sourceFile: string) {
  // A: 整个 session 的 LinkableJsonlEvent[] 只解析一次。
  let cachedEvents: LinkableJsonlEvent[] | null = null;
  function loadJsonlEvents(file: string): LinkableJsonlEvent[] | null {
    if (file !== sourceFile) return null; // 不是本 session 的 jsonl，让 server 默认逻辑处理
    if (cachedEvents === null) {
      perf.jsonlReads += 1;
      cachedEvents = readSessionEventsForLinker(file);
    } else {
      perf.jsonlCacheHits += 1;
    }
    return cachedEvents;
  }

  // drilldown 缓存：同一 session 内多次调用 resolveCallMeta 不重复解析。
  type CallMeta = {
    call: { id: number; timestamp: string; turnId: number; sourceFile: string; apiRequestId: string | null };
    prevCall: { id: number; timestamp: string; apiRequestId: string | null } | null;
  };
  let cachedCalls: Array<{ id: number; timestamp: string; turnId: number; apiRequestId: string | null }> | null = null;

  // fork 识别副信息：fetchProxyReqBodyAt 每次刷新；runOneSession 在 fetch 后读取
  // 以决定 skipped 行的 reason 区分（"forked-agent ..." vs "proxy reqBody unavailable"）。
  const lastForkDetection: { current: ForkDetection | null } = { current: null };

  function listCalls() {
    if (cachedCalls) return cachedCalls;
    const row = db.prepare(`SELECT * FROM sessions_meta_v2 WHERE session_id = ?`).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return (cachedCalls = []);
    const drilldown = parseSessionDrilldown(sourceFile, sessionId, row, db);
    cachedCalls = drilldown.turns.flatMap((t: { id: number; calls: Array<{ id: number; timestamp: string; apiRequestId?: string | null }> }) =>
      t.calls.map((c) => ({
        id: c.id,
        timestamp: c.timestamp,
        turnId: t.id,
        apiRequestId: c.apiRequestId ?? null,
      })),
    );
    return cachedCalls;
  }

  return {
    listCalls,
    resolveCallMeta(_sid: string, callId: number): CallMeta | null {
      const calls = listCalls();
      const idx = calls.findIndex((c) => c.id === callId);
      if (idx === -1) return null;
      const cur = calls[idx];
      const prev = idx > 0 ? calls[idx - 1] : null;
      return {
        call: { id: cur.id, timestamp: cur.timestamp, turnId: cur.turnId, sourceFile, apiRequestId: cur.apiRequestId },
        prevCall: prev ? { id: prev.id, timestamp: prev.timestamp, apiRequestId: prev.apiRequestId } : null,
      };
    },
    /** runOneSession 在每次 fetch 后读取此字段以区分 skipped reason。 */
    lastForkDetection,
    async fetchProxyReqBodyAt(sid: string, ts: string, excludeProxyId?: number, apiRequestId?: string | null) {
      // 每次进入清空，确保只反映"本次 fetch"的结果。
      lastForkDetection.current = null;
      // Strict mode (audit-only)：JSONL 给了 apiRequestId 但 proxy_requests 没有精确
      // 命中（mcli.sankuai.com 不透传 Anthropic 的 request-id）→ 直接放弃 audit。
      //
      // 默认 findProxyRowForCall 会退化到"started_at <= ts 最近一条"，但在长时间
      // 没有 proxy 记录的 mcli 段，那条 fallback 命中的可能是 30 分钟前的一个无关
      // call，reqBody 与当前 jsonl 时间窗错位，最终算出来的 partial/none/missing
      // 全是假的。聚焦在开源标准路径上的口径里，把这类 call 直接 skip 更诚实。
      // server runtime 仍走 findProxyRowForCall 的 fallback（HACK 兼容），不受影响。
      let proxyRow: ReturnType<typeof findProxyRowForCall>;
      if (apiRequestId) {
        // 仅按 request_id 精确查；没命中就 skip，**不**走时间窗 fallback。
        proxyRow = db.prepare(
          `SELECT id, jsonl_file, jsonl_byte_offset, req_headers, started_at
           FROM proxy_requests
           WHERE session_id = ? AND request_id = ?
           ${excludeProxyId !== undefined ? "AND id != ?" : ""}
           LIMIT 1`,
        ).get(
          ...(excludeProxyId !== undefined ? [sid, apiRequestId, excludeProxyId] : [sid, apiRequestId]),
        ) as ReturnType<typeof findProxyRowForCall>;
      } else {
        // JSONL 没有 apiRequestId 提示（legacy 录制）→ 退回时间窗 fallback 作为兜底。
        proxyRow = findProxyRowForCall(db, sid, null, ts, excludeProxyId);
      }
      if (!proxyRow) return null;
      const t0 = Date.now();
      perf.proxyReads += 1;
      const rec = await readProxyRecordCached(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
      perf.proxyReadMs += Date.now() - t0;
      const reqBodyStr = rec?.reqBody as string | undefined;
      if (typeof reqBodyStr !== "string") return null;
      let reqBody: Record<string, unknown> | null = null;
      try { reqBody = JSON.parse(reqBodyStr) as Record<string, unknown>; } catch { return null; }
      // forked-agent ghost proxy 检测：命中 → 跟当前主线程 call 完全不相干，
      // audit 不要拿这条 reqBody 算覆盖度。runOneSession 读 lastForkDetection
      // 给 skipped 行打"forked-agent ..."标签。
      const fork = detectForkProxy(reqBody);
      if (fork) {
        lastForkDetection.current = fork;
        return null;
      }
      let reqHeaders: Record<string, string> = {};
      try { reqHeaders = JSON.parse(proxyRow.req_headers ?? "{}") as Record<string, string>; } catch { /* ignore */ }
      return { reqBody, reqHeaders, proxyRequestId: proxyRow.id, startedAt: proxyRow.started_at ?? ts };
    },
    loadJsonlEvents,
  };
}

function auditFromResult(result: AttributionTreeResult): {
  call?: CallAudit;
  partialByReason?: Record<string, number>;
  jsonlMissingByKind?: Record<string, number>;
  noneByKind?: Record<string, number>;
  noneBySlot?: Record<string, number>;
  skipReason?: string;
} {
  if (!result.audit) {
    return { skipReason: result.error ?? "no audit (proxy missing?)" };
  }
  const f = result.audit.forward.totals;
  const partialByReason: Record<string, number> = {};
  for (const [reason, ids] of Object.entries(result.audit.forward.partial.byReason) as Array<[string, string[]]>) {
    if (ids.length > 0) partialByReason[reason] = ids.length;
  }
  const jsonlMissingByKind: Record<string, number> = {};
  for (const m of result.audit.reverse.missing) {
    jsonlMissingByKind[m.eventKind] = (jsonlMissingByKind[m.eventKind] ?? 0) + 1;
  }
  // none.byKind: structural_no_rule（模板切到但无 rule/jsonl） vs unknown（连模板都没识别）。
  const noneByKind: Record<string, number> = {};
  const nbk = result.audit.forward.none.byKind;
  if (nbk.structural_no_rule.length > 0) noneByKind.structural_no_rule = nbk.structural_no_rule.length;
  if (nbk.unknown.length > 0) noneByKind.unknown = nbk.unknown.length;
  // none.bySlot：把 structural_no_rule + unknown 的 segmentId 映射回 slotType，便于
  // 按版本看"哪个 slot 漏 rule"。snapshot.nodeSummaries 是已序列化的扁平 index。
  const noneBySlot: Record<string, number> = {};
  const summaries = result.snapshot?.nodeSummaries ?? {};
  for (const id of [...nbk.structural_no_rule, ...nbk.unknown]) {
    const slot = summaries[id]?.slotType ?? "<unknown-slot>";
    noneBySlot[slot] = (noneBySlot[slot] ?? 0) + 1;
  }
  return {
    call: {
      sessionId: result.sessionId,
      callId: result.callId,
      leafCount: f.leafCount,
      full: f.full,
      partial: f.partial,
      none: f.none,
      jsonlMissing: result.audit.reverse.missing.length,
      ...(result.snapshot?.ccVersion && { ccVersion: result.snapshot.ccVersion }),
    },
    partialByReason,
    jsonlMissingByKind,
    noneByKind,
    noneBySlot,
  };
}

function mergeCounts(into: Record<string, number>, from: Record<string, number>) {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

// ─── 单 session 跑 audit（worker / serial 共用） ────────────────────────────

interface SessionRunOutput {
  agg: SessionAudit;
  skipped: SkippedCall[];
}

async function runOneSession(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  sourceFile: string,
  proxyCountStmt: ReturnType<ReturnType<typeof getDb>["prepare"]>,
  lastN: number, // 0 = all calls; N>0 = 只跑最后 N 个 call
): Promise<SessionRunOutput> {
  const agg: SessionAudit = {
    sessionId,
    callCount: 0,
    leafCount: 0, full: 0, partial: 0, none: 0, jsonlMissing: 0,
    skipped: 0,
    partialByReason: {},
    jsonlMissingByKind: {},
    noneByKind: {},
    noneBySlot: {},
  };
  const skipped: SkippedCall[] = [];

  const proxyCount = (proxyCountStmt.get(sessionId) as { n: number }).n;
  if (proxyCount === 0) {
    skipped.push({ sessionId, callId: -1, reason: "no proxy requests in this session" });
    return { agg, skipped };
  }

  const helpers = buildHelpers(db, sessionId, sourceFile);
  const allCalls = helpers.listCalls();
  const calls = lastN > 0 ? allCalls.slice(-lastN) : allCalls;

  for (const c of calls) {
    let result: AttributionTreeResult;
    try {
      const t0 = Date.now();
      result = await loadAttributionTree(sessionId, c.id, db, helpers);
      perf.attrMs += Date.now() - t0;
      perf.attrCount += 1;
    } catch (err) {
      skipped.push({ sessionId, callId: c.id, reason: err instanceof Error ? err.message : String(err) });
      agg.skipped += 1;
      continue;
    }
    const piece = auditFromResult(result);
    if (!piece.call) {
      // 优先用 fork 标签覆盖通用 "proxy reqBody unavailable" 文案 —— 让 skipped
      // 汇总能区分"upstream 真的没录到 proxy" vs "时间窗 fallback 命中了一条 fork"。
      const fork = helpers.lastForkDetection.current;
      const reason = fork
        ? `forked-agent ghost proxy (${fork.label}) — not part of main transcript`
        : piece.skipReason ?? "unknown";
      skipped.push({ sessionId, callId: c.id, reason });
      agg.skipped += 1;
      continue;
    }
    agg.callCount += 1;
    agg.leafCount += piece.call.leafCount;
    agg.full += piece.call.full;
    agg.partial += piece.call.partial;
    agg.none += piece.call.none;
    agg.jsonlMissing += piece.call.jsonlMissing;
    if (piece.partialByReason) mergeCounts(agg.partialByReason, piece.partialByReason);
    if (piece.jsonlMissingByKind) mergeCounts(agg.jsonlMissingByKind, piece.jsonlMissingByKind);
    if (piece.noneByKind) mergeCounts(agg.noneByKind, piece.noneByKind);
    if (piece.noneBySlot) mergeCounts(agg.noneBySlot, piece.noneBySlot);
    // ccVersion 按"首条成功 audit 的 call"为准；进程级固定，session 内不会变。
    if (!agg.ccVersion && piece.call.ccVersion) agg.ccVersion = piece.call.ccVersion;
  }
  return { agg, skipped };
}

// ─── Worker 入口（child_process spawn + IPC） ────────────────────────────────
//
// 每个 worker 是独立 tsx 子进程，自己 open SQLite handle（WAL 多 reader 安全）+ 自己
// 维护 D 缓存。通过 IPC channel (`process.send` / `process.on('message')`) 通信。

type WorkerInMsg =
  | { kind: "job"; sessionId: string; sourceFile: string }
  | { kind: "shutdown" };
type WorkerOutMsg =
  | { kind: "ready"; workerIndex: number }
  | { kind: "done"; workerIndex: number; sessionId: string;
      agg: SessionAudit; skipped: SkippedCall[]; perfDelta: typeof perf };

async function runAsWorker(workerIndex: number): Promise<void> {
  const db = getDb();
  const proxyCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM proxy_requests WHERE session_id = ?`,
  );
  // lastN 通过 spawn 时的环境变量传递（每次跑全程不变）。0 = all calls。
  const lastN = parseInt(process.env.AUDIT_LAST_N ?? "0", 10) || 0;

  process.on("message", async (msg: WorkerInMsg) => {
    if (msg.kind === "shutdown") {
      process.exit(0);
    }
    const before = { ...perf };
    const out = await runOneSession(db, msg.sessionId, msg.sourceFile, proxyCountStmt, lastN);
    const perfDelta = {
      jsonlReads: perf.jsonlReads - before.jsonlReads,
      jsonlCacheHits: perf.jsonlCacheHits - before.jsonlCacheHits,
      proxyReads: perf.proxyReads - before.proxyReads,
      proxyReadMs: perf.proxyReadMs - before.proxyReadMs,
      proxyFileDecompresses: perf.proxyFileDecompresses - before.proxyFileDecompresses,
      proxyFileCacheHits: perf.proxyFileCacheHits - before.proxyFileCacheHits,
      attrMs: perf.attrMs - before.attrMs,
      attrCount: perf.attrCount - before.attrCount,
    };
    const done: WorkerOutMsg = {
      kind: "done", workerIndex, sessionId: msg.sessionId,
      agg: out.agg, skipped: out.skipped, perfDelta,
    };
    process.send!(done);
  });

  process.send!({ kind: "ready", workerIndex } satisfies WorkerOutMsg);
}

// ─── 主调度 ──────────────────────────────────────────────────────────────────

interface LocalOptions { asJson: boolean; limit?: number; workers: number; lastN: number; }

async function runLocal(opts: LocalOptions): Promise<void> {
  const db = getDb();
  const baseSql =
    `SELECT session_id AS sessionId, source_file AS sourceFile
     FROM sessions_meta_v2
     WHERE source_present = 1
     ORDER BY last_event_at DESC`;
  const sessions = (opts.limit && opts.limit > 0
    ? db.prepare(`${baseSql} LIMIT ?`).all(opts.limit)
    : db.prepare(baseSql).all()
  ) as Array<{ sessionId: string; sourceFile: string }>;

  if (sessions.length === 0) {
    console.error("no sessions in sessions_meta_v2 (source_present=1)");
    process.exit(1);
  }

  const sessionRows: SessionAudit[] = [];
  const skipped: SkippedCall[] = [];
  const startedAt = Date.now();
  const progress = (msg: string) => process.stderr.write(`\r${msg}\x1b[K`);

  if (opts.workers === 0) {
    // Serial path（调试用）
    const proxyCountStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM proxy_requests WHERE session_id = ?`,
    );
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      progress(`[${i + 1}/${sessions.length}] serial · ${truncate(s.sessionId, 32)} · ${elapsedSec}s`);
      const out = await runOneSession(db, s.sessionId, s.sourceFile, proxyCountStmt, opts.lastN);
      sessionRows.push(out.agg);
      skipped.push(...out.skipped);
    }
  } else {
    await runWorkerPool(sessions, opts.workers, opts.lastN, sessionRows, skipped, startedAt, progress);
  }

  process.stderr.write(`\r\x1b[K`);
  const modeLabel = opts.lastN === 0 ? "all-calls" : `last-${opts.lastN}`;
  process.stderr.write(`[mode] ${modeLabel} (see --all-calls / --last-n=K)\n`);
  const cacheMB = (proxyFileCacheBytes / (1024 * 1024)).toFixed(0);
  process.stderr.write(
    `[perf] jsonl=${perf.jsonlReads} reads / ${perf.jsonlCacheHits} hits | ` +
    `proxy-files=${perf.proxyFileDecompresses} decompresses / ${perf.proxyFileCacheHits} hits` +
    `${opts.workers === 0 ? ` (${proxyFileCache.size} files, ${cacheMB} MiB resident)` : ` (aggregated across ${opts.workers} workers)`} | ` +
    `proxy-records=${perf.proxyReads} reads ${perf.proxyReadMs}ms (avg ${(perf.proxyReadMs / Math.max(1, perf.proxyReads)).toFixed(1)}ms) | ` +
    `attr=${perf.attrCount} calls ${perf.attrMs}ms (avg ${(perf.attrMs / Math.max(1, perf.attrCount)).toFixed(1)}ms)\n`,
  );

  if (opts.asJson) {
    console.log(JSON.stringify({ sessions: sessionRows, skipped }, null, 2));
    return;
  }
  printLocalTable(sessionRows, skipped);
}

async function runWorkerPool(
  sessions: Array<{ sessionId: string; sourceFile: string }>,
  workerCount: number,
  lastN: number,
  sessionRows: SessionAudit[],
  skipped: SkippedCall[],
  startedAt: number,
  progress: (msg: string) => void,
): Promise<void> {
  const queue = [...sessions];
  let completed = 0;
  let exited = 0;
  const workers: ChildProcess[] = [];

  await new Promise<void>((resolveAll, rejectAll) => {
    function dispatch(w: ChildProcess) {
      const next = queue.shift();
      if (!next) {
        w.send({ kind: "shutdown" } satisfies WorkerInMsg);
        return;
      }
      w.send({ kind: "job", sessionId: next.sessionId, sourceFile: next.sourceFile } satisfies WorkerInMsg);
    }

    for (let i = 0; i < workerCount; i++) {
      const w = spawn(TSX_BIN, [__filename], {
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        env: { ...process.env, [WORKER_ENV_FLAG]: String(i), AUDIT_LAST_N: String(lastN) },
      });
      workers.push(w);
      w.on("message", (m: WorkerOutMsg) => {
        if (m.kind === "ready") {
          dispatch(w);
          return;
        }
        sessionRows.push(m.agg);
        skipped.push(...m.skipped);
        perf.jsonlReads += m.perfDelta.jsonlReads;
        perf.jsonlCacheHits += m.perfDelta.jsonlCacheHits;
        perf.proxyReads += m.perfDelta.proxyReads;
        perf.proxyReadMs += m.perfDelta.proxyReadMs;
        perf.proxyFileDecompresses += m.perfDelta.proxyFileDecompresses;
        perf.proxyFileCacheHits += m.perfDelta.proxyFileCacheHits;
        perf.attrMs += m.perfDelta.attrMs;
        perf.attrCount += m.perfDelta.attrCount;
        completed += 1;
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        progress(`[${completed}/${sessions.length}] ${workerCount}× workers · ${elapsedSec}s · queue=${queue.length}`);
        dispatch(w);
      });
      w.on("error", (err) => rejectAll(err));
      w.on("exit", (code) => {
        exited += 1;
        if (code !== 0 && code !== null) {
          rejectAll(new Error(`worker ${i} exited with code ${code}`));
          return;
        }
        if (exited === workerCount) resolveAll();
      });
    }
  });
}

function fmtN(n: number): string {
  return n.toLocaleString("en-US");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function printLocalTable(rows: SessionAudit[], skipped: SkippedCall[]): void {
  const widths = [40, 6, 8, 8, 8, 6, 9, 8];
  const header = ["session", "calls", "leaves", "full", "partial", "none", "missing", "skipped"];
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join(" ");

  // callCount === 0 的 session（无 proxy 或所有 call 全 skip）对所有汇总贡献都是 0，
  // 列出来只是噪音 —— 显示时过滤掉，但 totals 还是基于全量 rows，结果不变。
  const displayRows = rows.filter((r) => r.callCount > 0);
  const hiddenCount = rows.length - displayRows.length;

  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join(" "));

  const totals = { calls: 0, leaves: 0, full: 0, partial: 0, none: 0, missing: 0, skipped: 0 };
  for (const r of displayRows) {
    console.log(fmt([
      truncate(r.sessionId, widths[0]),
      String(r.callCount),
      fmtN(r.leafCount),
      fmtN(r.full),
      fmtN(r.partial),
      fmtN(r.none),
      fmtN(r.jsonlMissing),
      String(r.skipped),
    ]));
    totals.calls += r.callCount;
    totals.leaves += r.leafCount;
    totals.full += r.full;
    totals.partial += r.partial;
    totals.none += r.none;
    totals.missing += r.jsonlMissing;
    totals.skipped += r.skipped;
  }
  console.log(widths.map((w) => "-".repeat(w)).join(" "));
  console.log(fmt([
    `TOTAL (${rows.length} sessions)`,
    String(totals.calls),
    fmtN(totals.leaves),
    fmtN(totals.full),
    fmtN(totals.partial),
    fmtN(totals.none),
    fmtN(totals.missing),
    String(totals.skipped),
  ]));
  if (hiddenCount > 0) {
    console.log(`  (${hiddenCount} session(s) hidden because callCount=0 — counted in TOTAL but not listed)`);
  }

  // 末尾 skipped 汇总（明细折叠：默认只显示 reason 计数，加 -v 才列每条）。
  if (skipped.length > 0) {
    console.log("");
    console.log(`▸ Skipped calls (${skipped.length}):`);
    const byReason = new Map<string, number>();
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${n}× ${reason}`);
    }
  }

  // 全局 partial / missing / none 来源分布（默认折叠到一行）。
  const partialAgg: Record<string, number> = {};
  const missingAgg: Record<string, number> = {};
  const noneAgg: Record<string, number> = {};
  for (const r of rows) {
    mergeCounts(partialAgg, r.partialByReason);
    mergeCounts(missingAgg, r.jsonlMissingByKind);
    mergeCounts(noneAgg, r.noneByKind);
  }
  const partialEntries = Object.entries(partialAgg).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const missingEntries = Object.entries(missingAgg).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const noneEntries = Object.entries(noneAgg).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (partialEntries.length > 0) {
    console.log("");
    console.log("▸ partial.byReason (all sessions):");
    for (const [reason, n] of partialEntries) console.log(`    ${reason}: ${n}`);
  }
  if (missingEntries.length > 0) {
    console.log("");
    console.log("▸ jsonl.missing byKind (all sessions):");
    for (const [kind, n] of missingEntries) console.log(`    ${kind}: ${n}`);
  }
  if (noneEntries.length > 0) {
    console.log("");
    console.log("▸ none.byKind (all sessions):");
    console.log("    structural_no_rule = 模板切到 slot 但无 rule、无 jsonl（待补 rule）");
    console.log("    unknown            = 连模板都未识别（parser/template 盲区）");
    for (const [kind, n] of noneEntries) console.log(`    ${kind}: ${n}`);
  }

  // ─── 按 cc_version 分组的汇总 ──────────────────────────────────────────────
  //
  // 目的：把"哪个版本还有 N 个 leaf 走 structural_no_rule、分别落在哪些 slot"
  // 这种 rule 维护视角的信息一眼可见。逐版本补 rule 时按这张表对账。
  printPerVersionSummary(displayRows);
}

function printPerVersionSummary(rows: SessionAudit[]): void {
  // 按版本分桶；ccVersion 缺失（billing-header 漂移）记到 "<unknown>"。
  // noneBySlot 顺带记下每个 slot 的"贡献 session 列表"，方便逐版本补 rule 时
  // 直接拿 sessionId 去 dashboard / found-ground-info 抓样本。
  type VerBucket = {
    sessions: number;
    calls: number;
    leaves: number;
    full: number;
    partial: number;
    none: number;
    missing: number;
    noneBySlot: Record<string, { count: number; sessionIds: string[] }>;
  };
  const byVer = new Map<string, VerBucket>();
  for (const r of rows) {
    const v = r.ccVersion ?? "<unknown>";
    let b = byVer.get(v);
    if (!b) {
      b = { sessions: 0, calls: 0, leaves: 0, full: 0, partial: 0, none: 0, missing: 0, noneBySlot: {} };
      byVer.set(v, b);
    }
    b.sessions += 1;
    b.calls += r.callCount;
    b.leaves += r.leafCount;
    b.full += r.full;
    b.partial += r.partial;
    b.none += r.none;
    b.missing += r.jsonlMissing;
    for (const [slot, n] of Object.entries(r.noneBySlot)) {
      const entry = (b.noneBySlot[slot] ??= { count: 0, sessionIds: [] });
      entry.count += n;
      // 同一 session 可能在同一 slot 贡献多条 leaf —— 但 sessionId 只需登记一次。
      if (!entry.sessionIds.includes(r.sessionId)) entry.sessionIds.push(r.sessionId);
    }
  }
  if (byVer.size === 0) return;

  // 版本号升序（按数值比较前三段；fingerprint 段不参与排序，因此完整字符串相同
  // 才认 equal —— 实际全 session 同 cc_version 都共享同一 fingerprint，无碰撞）。
  const sortedVers = [...byVer.keys()].sort((a, b) => {
    if (a === "<unknown>") return 1;
    if (b === "<unknown>") return -1;
    const pa = a.split(".").map((x) => parseInt(x, 10));
    const pb = b.split(".").map((x) => parseInt(x, 10));
    for (let i = 0; i < 3; i++) {
      const da = isNaN(pa[i]) ? 0 : pa[i];
      const db = isNaN(pb[i]) ? 0 : pb[i];
      if (da !== db) return da - db;
    }
    return a.localeCompare(b);
  });

  console.log("");
  console.log("▸ Per-version summary (cc_version 升序):");
  const vw = [16, 9, 6, 8, 8, 8, 6, 9];
  const vh = ["cc_version", "sessions", "calls", "leaves", "full", "partial", "none", "missing"];
  const vfmt = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(vw[i]) : c.padStart(vw[i]))).join(" ");
  console.log("  " + vfmt(vh));
  console.log("  " + vw.map((w) => "-".repeat(w)).join(" "));
  for (const v of sortedVers) {
    const b = byVer.get(v)!;
    console.log("  " + vfmt([
      v, String(b.sessions), String(b.calls),
      fmtN(b.leaves), fmtN(b.full), fmtN(b.partial), fmtN(b.none), fmtN(b.missing),
    ]));
  }

  // 每版本 structural_no_rule by slotType（仅展示该版本有 none 时）—— 逐版本补
  // rule 时直接读这块：每一行 "<slotType>: N [sessionIds...]" 就是该版本下漏
  // rule 的具体位置 + 取样用的 session id 清单。
  const versWithNone = sortedVers.filter((v) => Object.keys(byVer.get(v)!.noneBySlot).length > 0);
  if (versWithNone.length === 0) return;
  console.log("");
  console.log("▸ none by slotType, per cc_version (逐版本补 rule 的工作清单):");
  for (const v of versWithNone) {
    const b = byVer.get(v)!;
    const entries = Object.entries(b.noneBySlot).sort((a, b) => b[1].count - a[1].count);
    const total = entries.reduce((s, [, e]) => s + e.count, 0);
    console.log(`  ${v}  (${b.sessions} sessions · ${total} none-leaves):`);
    for (const [slot, { count, sessionIds }] of entries) {
      // sessionId 全量列出（n 很少时，逐条看是最快的；同 session 多条 leaf 已去重）。
      // 每行最多 4 个 id 折行避免横向爆屏。
      const ids = sessionIds.join(", ");
      console.log(`      ${slot}: ${count}  [${ids}]`);
    }
  }
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

async function main() {
  // Worker 角色短路（不解析 CLI 参数）—— 由环境变量 WORKER_ENV_FLAG 标识。
  const workerFlag = process.env[WORKER_ENV_FLAG];
  if (workerFlag !== undefined) {
    await runAsWorker(parseInt(workerFlag, 10));
    return;
  }

  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const isLocal = args.includes("--local");
  const positional = args.filter((a) => !a.startsWith("--"));

  if (isLocal) {
    const limitArg = args.find((a) => a.startsWith("--limit="));
    const limit = limitArg ? parseInt(limitArg.slice("--limit=".length), 10) : undefined;
    const workersArg = args.find((a) => a.startsWith("--workers="));
    const isSerial = args.includes("--serial");
    const defaultWorkers = Math.max(1, Math.floor(cpus().length / 2));
    const workers = isSerial
      ? 0
      : workersArg
        ? Math.max(1, parseInt(workersArg.slice("--workers=".length), 10))
        : defaultWorkers;
    // 默认 --last-call（lastN=1）；--last-n=K 覆盖；--all-calls 显式跑全量。
    // 多个互斥 flag 的优先级：--all-calls > --last-n=K > --last-call > 默认。
    const lastNArg = args.find((a) => a.startsWith("--last-n="));
    const lastN = args.includes("--all-calls")
      ? 0
      : lastNArg
        ? Math.max(1, parseInt(lastNArg.slice("--last-n=".length), 10))
        : 1;
    await runLocal({ asJson, limit, workers, lastN });
    return;
  }

  let fixtures: string[];
  if (positional.length > 0) {
    fixtures = positional.map((p) => resolve(p));
  } else {
    fixtures = discoverFixtures(
      resolve("server/test/fixtures/context-reconstruction"),
    );
  }

  if (fixtures.length === 0) {
    console.error("no fixtures found");
    process.exit(1);
  }

  const rows = fixtures.map(runOne);

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    printTable(rows);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
