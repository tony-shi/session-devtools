import { describe, it, expect } from "vitest";
import { RenderedSetLRU } from "./rendered-set-cache.ts";

const entry = (mtime: number, ids: string[]) => ({
  jsonlMtime: mtime,
  requestIdSet: new Set(ids),
  computedAt: Date.now(),
});

describe("RenderedSetLRU", () => {
  it("超出容量后淘汰最旧条目", () => {
    const lru = new RenderedSetLRU(3);
    lru.set("a", entry(1, ["x"]));
    lru.set("b", entry(1, ["x"]));
    lru.set("c", entry(1, ["x"]));
    lru.set("d", entry(1, ["x"]));

    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("d")).toBeDefined();
    expect(lru.size()).toBe(3);
  });

  it("get 命中将条目挪到最末（最近使用）", () => {
    const lru = new RenderedSetLRU(3);
    lru.set("a", entry(1, []));
    lru.set("b", entry(1, []));
    lru.set("c", entry(1, []));

    // 访问 a，它变成最近使用
    lru.get("a");
    // 加入新条目 d，应该淘汰 b（现在是最旧的）
    lru.set("d", entry(1, []));

    expect(lru.get("a")).toBeDefined();
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("c")).toBeDefined();
    expect(lru.get("d")).toBeDefined();
  });

  it("set 同一 key 视为更新，不重复淘汰", () => {
    const lru = new RenderedSetLRU(2);
    lru.set("a", entry(1, ["x"]));
    lru.set("b", entry(1, ["x"]));
    lru.set("a", entry(2, ["y"])); // 更新 a

    expect(lru.size()).toBe(2);
    expect(lru.get("a")?.jsonlMtime).toBe(2);
    expect(lru.get("b")).toBeDefined();
  });
});
