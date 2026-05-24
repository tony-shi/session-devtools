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

// session 内导航坐标：和客户端 URL /sessions/:id/turn/:turnId/call/:callId
// 直接对应（turnId=UserTurn.id，callId=LlmCall.id，都是数字 id）。
export interface CallCoord {
  turnId: number;
  callId: number;
}

// 单行的判定结果。target 仅 visibility==="visible" 时非 null——
// 服务端已经把跳转坐标算好，前端点击即跳完整 URL，无需二次 resolve。
export interface VisibilityResult {
  visibility: Visibility;
  target: CallCoord | null;
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
  // 跑 parser，返回该 session 在 UI 上会渲染的 apiRequestId → 导航坐标 映射。
  // 用 Map 而非 Set：proxy 行不仅要知道"是否渲染"，还要知道"跳到哪条 call"，
  // 把坐标在服务端一次算好 = 前端从确定性出发，点击直达完整 URL。
  // parser 异步（compact-proxy 精确匹配需要读 traffic.jsonl body），所以
  // 这个接口也是 Promise；worker 那一侧已经在 setImmediate 上排队执行，
  // 切到 async 后队列变成"上一条完成才调下一条"，避免并发解 gzip。
  // 抛错时 service 不污染缓存，下次 enqueue 时重试。
  computeRenderedSet(meta: SessionMeta): Promise<Map<string, CallCoord>>;
}

export class VisibilityService {
  private readonly cache = new RenderedSetLRU(VISIBILITY_CACHE_CAPACITY);
  private enqueueFn: ((sessionId: string) => void) | null = null;

  constructor(private readonly deps: VisibilityDeps) {}

  // worker 创建后回填——避免构造期的循环依赖。
  setEnqueueFn(fn: (sessionId: string) => void): void {
    this.enqueueFn = fn;
  }

  enrichRows(rows: VisibilityQuery[]): VisibilityResult[] {
    if (!isVisibilityEnabled()) return rows.map(() => ({ visibility: "disabled" as const, target: null }));

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
  ): VisibilityResult {
    if (!q.sessionId) return { visibility: "unattributed", target: null };
    // proxy 端给缺失 request-id 的响应注入了 proxy-<uuid>。这种 id 永远不会
    // 出现在 jsonl 里，单独标为 unattributed 而不是 hidden，避免误导用户。
    if (!q.requestId || q.requestId.startsWith("proxy-")) return { visibility: "unattributed", target: null };

    const meta = metas.get(q.sessionId);
    if (!meta || !meta.sourcePresent) return { visibility: "session-gone", target: null };

    const entry = this.cache.get(q.sessionId);
    if (entry && entry.jsonlMtime === meta.fileMtime) {
      const target = entry.requestIdMap.get(q.requestId) ?? null;
      return target
        ? { visibility: "visible", target }
        : { visibility: "hidden", target: null };
    }

    toEnqueue.add(q.sessionId);
    return { visibility: "computing", target: null };
  }

  // 由 worker 调用：parser 现在异步（compact 匹配要读 traffic.jsonl body），
  // worker 已经把它调度到 setImmediate 上并且并发=1，所以一条 await 完才走下一条。
  async compute(sessionId: string): Promise<void> {
    const metas = this.deps.loadMetas([sessionId]);
    const meta = metas.get(sessionId);
    if (!meta || !meta.sourcePresent) return;

    try {
      const map = await this.deps.computeRenderedSet(meta);
      this.cache.set(sessionId, {
        jsonlMtime: meta.fileMtime,
        requestIdMap: map,
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
