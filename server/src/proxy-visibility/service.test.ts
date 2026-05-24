import { describe, it, expect, beforeEach, vi } from "vitest";
import { VisibilityService, type VisibilityDeps, type SessionMeta, type CallCoord } from "./service.ts";
import { createVisibilityService } from "./index.ts";

function makeMeta(sessionId: string, opts: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId,
    sourceFile: `/tmp/${sessionId}.jsonl`,
    fileMtime: 1000,
    sourcePresent: true,
    ...opts,
  };
}

const coord = (turnId: number, callId: number): CallCoord => ({ turnId, callId });

function makeDeps(
  metas: Map<string, SessionMeta>,
  renderedMaps: Map<string, Map<string, CallCoord>>,
): VisibilityDeps {
  return {
    loadMetas: vi.fn((ids: string[]) => {
      const out = new Map<string, SessionMeta>();
      for (const id of ids) {
        const m = metas.get(id);
        if (m) out.set(id, m);
      }
      return out;
    }),
    computeRenderedSet: vi.fn(async (m: SessionMeta) => renderedMaps.get(m.sessionId) ?? new Map()),
  };
}

// enrichRows 返回 {visibility,target}[]；大多数断言只关心 visibility 序列。
const vis = (rs: { visibility: string }[]) => rs.map((r) => r.visibility);

describe("VisibilityService.classify (synchronous decisions)", () => {
  let service: VisibilityService;

  beforeEach(() => {
    delete process.env.PROXY_VISIBILITY_ENABLED;
  });

  it("session_id 缺失 → unattributed", () => {
    service = new VisibilityService(makeDeps(new Map(), new Map()));
    const out = service.enrichRows([{ sessionId: null, requestId: "req_abc" }]);
    expect(vis(out)).toEqual(["unattributed"]);
    expect(out[0].target).toBeNull();
  });

  it("request_id 是 proxy-* 合成 ID → unattributed", () => {
    service = new VisibilityService(makeDeps(
      new Map([["s1", makeMeta("s1")]]),
      new Map(),
    ));
    const out = service.enrichRows([{ sessionId: "s1", requestId: "proxy-uuid-xxx" }]);
    expect(vis(out)).toEqual(["unattributed"]);
  });

  it("session 在 DB 但 source_present=false → session-gone", () => {
    service = new VisibilityService(makeDeps(
      new Map([["s1", makeMeta("s1", { sourcePresent: false })]]),
      new Map(),
    ));
    const out = service.enrichRows([{ sessionId: "s1", requestId: "req_abc" }]);
    expect(vis(out)).toEqual(["session-gone"]);
  });

  it("session 完全查不到 → session-gone", () => {
    service = new VisibilityService(makeDeps(new Map(), new Map()));
    const out = service.enrichRows([{ sessionId: "s_missing", requestId: "req_abc" }]);
    expect(vis(out)).toEqual(["session-gone"]);
  });

  it("缓存未命中 → computing，并 enqueue", () => {
    const enqueue = vi.fn();
    service = new VisibilityService(makeDeps(
      new Map([["s1", makeMeta("s1")]]),
      new Map(),
    ));
    service.setEnqueueFn(enqueue);
    const out = service.enrichRows([{ sessionId: "s1", requestId: "req_abc" }]);
    expect(vis(out)).toEqual(["computing"]);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith("s1");
  });

  it("同一 session 多行只 enqueue 一次", () => {
    const enqueue = vi.fn();
    service = new VisibilityService(makeDeps(
      new Map([["s1", makeMeta("s1")]]),
      new Map(),
    ));
    service.setEnqueueFn(enqueue);
    service.enrichRows([
      { sessionId: "s1", requestId: "req_a" },
      { sessionId: "s1", requestId: "req_b" },
      { sessionId: "s1", requestId: "req_c" },
    ]);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith("s1");
  });

  it("compute 后命中 → visible 带坐标 / hidden 无坐标", async () => {
    const metas = new Map([["s1", makeMeta("s1")]]);
    const rendered = new Map([["s1", new Map([["req_visible", coord(2, 5)]])]]);
    service = new VisibilityService(makeDeps(metas, rendered));
    service.setEnqueueFn(() => {}); // 这里手动驱动 compute
    await service.compute("s1");

    const out = service.enrichRows([
      { sessionId: "s1", requestId: "req_visible" },
      { sessionId: "s1", requestId: "req_hidden" },
    ]);
    expect(vis(out)).toEqual(["visible", "hidden"]);
    expect(out[0].target).toEqual({ turnId: 2, callId: 5 });
    expect(out[1].target).toBeNull();
  });

  it("mtime 变化 → 缓存失效，重新报 computing", async () => {
    const metas = new Map([["s1", makeMeta("s1", { fileMtime: 1000 })]]);
    const rendered = new Map([["s1", new Map([["req_a", coord(1, 1)]])]]);
    const deps = makeDeps(metas, rendered);
    service = new VisibilityService(deps);
    const enqueue = vi.fn();
    service.setEnqueueFn(enqueue);
    await service.compute("s1");

    // 第一次 enrich：命中
    expect(vis(service.enrichRows([{ sessionId: "s1", requestId: "req_a" }]))).toEqual(["visible"]);

    // 模拟用户追加 turn 后 mtime 变了
    metas.set("s1", makeMeta("s1", { fileMtime: 2000 }));
    expect(vis(service.enrichRows([{ sessionId: "s1", requestId: "req_a" }]))).toEqual(["computing"]);
    expect(enqueue).toHaveBeenCalledWith("s1");
  });

  it("parser 抛错时不污染缓存", async () => {
    const deps: VisibilityDeps = {
      loadMetas: () => new Map([["s1", makeMeta("s1")]]),
      computeRenderedSet: async () => { throw new Error("boom"); },
    };
    service = new VisibilityService(deps);
    service.setEnqueueFn(() => {});

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await service.compute("s1");
    expect(service.cacheSize()).toBe(0);
    warn.mockRestore();
  });

  it("总开关 off → 全部 disabled，不查 meta、不 enqueue", () => {
    process.env.PROXY_VISIBILITY_ENABLED = "0";
    const deps = makeDeps(new Map(), new Map());
    service = new VisibilityService(deps);
    const enqueue = vi.fn();
    service.setEnqueueFn(enqueue);
    const out = service.enrichRows([{ sessionId: "s1", requestId: "req_a" }]);
    expect(vis(out)).toEqual(["disabled"]);
    expect(out[0].target).toBeNull();
    expect(deps.loadMetas).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("VisibilityService + worker (createVisibilityService)", () => {
  beforeEach(() => {
    delete process.env.PROXY_VISIBILITY_ENABLED;
  });

  it("worker 在 setImmediate 上跑 compute，不阻塞 enrichRows", async () => {
    const metas = new Map([["s1", makeMeta("s1")]]);
    const rendered = new Map([["s1", new Map([["req_a", coord(3, 7)]])]]);
    const deps = makeDeps(metas, rendered);
    const service = createVisibilityService(deps);

    // 第一次：必然是 computing
    const first = service.enrichRows([{ sessionId: "s1", requestId: "req_a" }]);
    expect(vis(first)).toEqual(["computing"]);

    // 让 setImmediate 执行
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // 第二次：应该命中缓存，并带坐标
    const second = service.enrichRows([{ sessionId: "s1", requestId: "req_a" }]);
    expect(vis(second)).toEqual(["visible"]);
    expect(second[0].target).toEqual({ turnId: 3, callId: 7 });
  });
});
