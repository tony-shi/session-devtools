export interface RenderedSetEntry {
  jsonlMtime: number;
  requestIdSet: Set<string>;
  computedAt: number;
}

// Map 的迭代顺序天然就是插入顺序，借此实现最简 LRU：命中时先 delete 再 set
// 把条目挪到末尾；满了从迭代器取第一个（最旧的）淘汰。不需要双向链表。
export class RenderedSetLRU {
  private readonly map = new Map<string, RenderedSetEntry>();
  constructor(private readonly capacity: number) {}

  get(sessionId: string): RenderedSetEntry | undefined {
    const entry = this.map.get(sessionId);
    if (!entry) return undefined;
    this.map.delete(sessionId);
    this.map.set(sessionId, entry);
    return entry;
  }

  set(sessionId: string, entry: RenderedSetEntry): void {
    if (this.map.has(sessionId)) this.map.delete(sessionId);
    this.map.set(sessionId, entry);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  delete(sessionId: string): boolean {
    return this.map.delete(sessionId);
  }

  size(): number { return this.map.size; }

  clear(): void { this.map.clear(); }
}
