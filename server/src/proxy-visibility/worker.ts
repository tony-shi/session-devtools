import type { VisibilityService } from "./service.ts";

// 单进程内的极简任务队列。parser 是同步的，所以这里也是同步执行，关键是
// setImmediate 让出事件循环 —— 请求线程立刻返回 'computing'，parser 在
// 后续 tick 里跑，不会阻塞 /api/proxy/requests 响应。
//
// 并发=1：parser 同步、读 jsonl 走文件 IO，没有真并行收益；如果将来发现
// 队列堆积，可以换成 worker_threads 或加并发，这里保持最简。
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
    setImmediate(() => this.tick());
  }

  private tick(): void {
    const id = this.queue.shift();
    if (!id) { this.isRunning = false; return; }
    this.seen.delete(id);
    try { this.service.compute(id); } catch { /* compute 自己已经吞了 */ }
    if (this.queue.length > 0) {
      setImmediate(() => this.tick());
    } else {
      this.isRunning = false;
    }
  }

  queueLength(): number { return this.queue.length; }
}
