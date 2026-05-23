// proxy-visibility 的核心判定层。完全无副作用（除了内存缓存）。
// 不依赖 getDb / parser 全局——所需能力由 VisibilityDeps 注入，方便测试和保持
// 与核心查询链路解耦。
import { isVisibilityEnabled, VISIBILITY_CACHE_CAPACITY } from "./config.ts";
import { RenderedSetLRU } from "./rendered-set-cache.ts";

export type Visibility =
  | "visible"        // request_id 命中 parser 产出的 rendered set
  | "hidden"         // session 属于这条 proxy，但 parser 没在 rendered set 里看到
  | "session-gone"   // session_id 对应的 jsonl 文件已被删除（source_present=false）
  | "unattributed"   // session_id 缺失，或 request_id 是 proxy-* 合成 ID（永远不会在 jsonl 里）
  | "computing"      // 缓存未命中，已 enqueue 后台计算
  | "disabled";      // 总开关 off

export interface VisibilityQuery {
  sessionId: string | null;
  requestId: string | null;
}

export interface SessionMeta {
  sessionId: string;
  sourceFile: string;
  fileMtime: number;
  sourcePresent: boolean;
}

export interface VisibilityDeps {
  // 批量查 meta：一次 SQL 拉到所有相关 session 的 source_file/mtime/source_present。
  // 单批调用，所以即使 50 行 proxy 也只一次 DB 命中。
  loadMetas(sessionIds: string[]): Map<string, SessionMeta>;
  // 跑 parser，返回该 session 在 UI 上会渲染的所有 apiRequestId 集合。
  // 抛错时 service 不污染缓存，下次 enqueue 时重试。
  computeRenderedSet(meta: SessionMeta): Set<string>;
}

export class VisibilityService {
  private readonly cache = new RenderedSetLRU(VISIBILITY_CACHE_CAPACITY);
  private enqueueFn: ((sessionId: string) => void) | null = null;

  constructor(private readonly deps: VisibilityDeps) {}

  // worker 创建后回填——避免构造期的循环依赖。
  setEnqueueFn(fn: (sessionId: string) => void): void {
    this.enqueueFn = fn;
  }

  enrichRows(rows: VisibilityQuery[]): Visibility[] {
    if (!isVisibilityEnabled()) return rows.map(() => "disabled");

    const sessionIds = new Set<string>();
    for (const r of rows) {
      if (r.sessionId) sessionIds.add(r.sessionId);
    }
    const metas = sessionIds.size > 0
      ? this.deps.loadMetas([...sessionIds])
      : new Map<string, SessionMeta>();

    const toEnqueue = new Set<string>();
    const results = rows.map((r) => this.classify(r, metas, toEnqueue));
    if (this.enqueueFn) {
      for (const id of toEnqueue) this.enqueueFn(id);
    }
    return results;
  }

  private classify(
    q: VisibilityQuery,
    metas: Map<string, SessionMeta>,
    toEnqueue: Set<string>,
  ): Visibility {
    if (!q.sessionId) return "unattributed";
    // proxy 端给缺失 request-id 的响应注入了 proxy-<uuid>。这种 id 永远不会
    // 出现在 jsonl 里，单独标为 unattributed 而不是 hidden，避免误导用户。
    if (!q.requestId || q.requestId.startsWith("proxy-")) return "unattributed";

    const meta = metas.get(q.sessionId);
    if (!meta || !meta.sourcePresent) return "session-gone";

    const entry = this.cache.get(q.sessionId);
    if (entry && entry.jsonlMtime === meta.fileMtime) {
      return entry.requestIdSet.has(q.requestId) ? "visible" : "hidden";
    }

    toEnqueue.add(q.sessionId);
    return "computing";
  }

  // 由 worker 调用，单 session 同步计算（worker 已经把它调度到 setImmediate 上）。
  compute(sessionId: string): void {
    const metas = this.deps.loadMetas([sessionId]);
    const meta = metas.get(sessionId);
    if (!meta || !meta.sourcePresent) return;

    try {
      const set = this.deps.computeRenderedSet(meta);
      this.cache.set(sessionId, {
        jsonlMtime: meta.fileMtime,
        requestIdSet: set,
        computedAt: Date.now(),
      });
    } catch (err) {
      // 不污染缓存。下次再被 enqueue 时会重试。
      console.warn(`[proxy-visibility] compute failed for ${sessionId}:`, err);
    }
  }

  cacheSize(): number { return this.cache.size(); }
  clearCache(): void { this.cache.clear(); }
  invalidate(sessionId: string): void { this.cache.delete(sessionId); }
}
