import type { VisibilityService } from "./service.ts";

// 单进程内的极简任务队列。parser 现在异步（compact 匹配要读 traffic.jsonl
// body），所以 tick 也得 await。关键依然是 setImmediate 让出事件循环 ——
// 请求线程立刻返回 'computing'，parser 在后续 tick 里跑，不会阻塞
// /api/proxy/requests 响应。
//
// 并发=1：parser 内部已经在 gzip 解码层做了 IO 并行，串行调度避免重复打开
// 同一份 traffic.jsonl 文件。如果将来发现队列堆积，可以换 worker_threads
// 或加并发，这里保持最简。
export class VisibilityWorker {
  private readonly queue: string[] = [];
  private readonly seen = new Set<string>();
  private isRunning = false;

  constructor(private readonly service: VisibilityService) {}

  enqueue(sessionId: string): void {
    if (this.seen.has(sessionId)) return;
    this.seen.add(sessionId);
    this.queue.push(sessionId);
    this.pump();
  }

  private pump(): void {
    if (this.isRunning) return;
    if (this.queue.length === 0) return;
    this.isRunning = true;
    setImmediate(() => { void this.tick(); });
  }

  private async tick(): Promise<void> {
    const id = this.queue.shift();
    if (!id) { this.isRunning = false; return; }
    this.seen.delete(id);
    try { await this.service.compute(id); } catch { /* compute 自己已经吞了 */ }
    if (this.queue.length > 0) {
      setImmediate(() => { void this.tick(); });
    } else {
      this.isRunning = false;
    }
  }

  queueLength(): number { return this.queue.length; }
}
