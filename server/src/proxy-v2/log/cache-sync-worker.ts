import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROXY_SERVER_PATHS as PATHS } from "../paths";
import { SYNC_TICK_MS, SYNC_BATCH_RECORDS } from "./config";
import { parseTrafficLine } from "../../parsers/proxy-traffic";
import { getDb, serializeWrite } from "../../db";
import { indexNow } from "./cold-indexer";

// 匹配旋转后的文件（中间态或已压缩），用于 inode 查找
const ROTATED_RE = /^traffic\.jsonl\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.\d{4}(\.gz)?$/;

// 通过 inode 在目录下找出 proxy 刚 rename 的中间态文件路径
function findRotatedByInode(ino: number): string | null {
  const dir = dirname(PATHS.trafficLog);
  if (!existsSync(dir)) return null;
  try {
    for (const name of readdirSync(dir)) {
      if (!ROTATED_RE.test(name)) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).ino === ino) return full;
      } catch {}
    }
  } catch {}
  return null;
}

async function insertRecords(records: Array<Record<string, unknown>>): Promise<void> {
  if (records.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO proxy_requests
      (ts, started_at, sni, method, url, status, bytes_in, bytes_out, duration_ms,
       req_headers, res_headers, sse_event_count, is_stream,
       jsonl_file, jsonl_byte_offset)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < records.length; i += SYNC_BATCH_RECORDS) {
    const batch = records.slice(i, i + SYNC_BATCH_RECORDS);
    await serializeWrite(() => {
      db.transaction(() => {
        for (const r of batch) {
          stmt.run(
            r.ts, r.started_at, r.sni, r.method, r.url, r.status,
            r.bytes_in, r.bytes_out, r.duration_ms,
            r.req_headers, r.res_headers,
            r.sse_event_count, r.is_stream ? 1 : 0,
            r.jsonl_file, r.jsonl_byte_offset,
          );
        }
      })();
    }).catch((e) => console.warn("[cache-sync] insertRecords error:", e));
    await new Promise((r) => setImmediate(r));
  }
}

class CacheSyncWorker {
  private fd: number | null = null;
  private inode: number = 0;
  private offset: number = 0;

  async tick(): Promise<void> {
    if (this.fd === null) await this.openCache();
    if (this.fd === null) return;

    let pathIno: number;
    try {
      pathIno = statSync(PATHS.trafficLog).ino;
    } catch {
      // cache 文件不存在（被删除或已 rotate 但新 cache 还没建）
      await this.drainAndClose();
      return;
    }

    if (pathIno !== this.inode) {
      // proxy 已 rotate，旧 inode 由 fd 持有
      const oldInode = this.inode;
      await this.drainAndClose();
      await this.handleRotation(oldInode);
      await this.openCache();
      return;
    }

    const currentSize = fstatSync(this.fd).size;
    if (currentSize > this.offset) {
      const committed = await this.readAndInsert(this.offset, currentSize);
      this.offset += committed;
    }
  }

  private async openCache(): Promise<void> {
    if (!existsSync(PATHS.trafficLog)) return;
    this.fd = openSync(PATHS.trafficLog, "r");
    this.inode = fstatSync(this.fd).ino;
    this.offset = 0;
  }

  private async drainAndClose(): Promise<void> {
    if (this.fd === null) return;
    const finalSize = fstatSync(this.fd).size;
    if (finalSize > this.offset) {
      const committed = await this.readAndInsert(this.offset, finalSize);
      this.offset += committed;
    }
    closeSync(this.fd);
    this.fd = null;
  }

  // 选项 B：rotate 发生后，cache-sync 删除自己写入的 cache 阶段预览数据。
  // 通过旧 inode 找到 proxy 刚 rename 的中间态路径，通知 cold-indexer 优先处理，
  // 避免等 30s idle 扫描造成的数据空窗期。
  private async handleRotation(oldInode: number): Promise<void> {
    const rotatedPath = findRotatedByInode(oldInode);

    await serializeWrite(() => {
      getDb().prepare("DELETE FROM proxy_requests WHERE jsonl_file = ?")
        .run(PATHS.trafficLog);
    }).catch((e) => console.warn("[cache-sync] handleRotation error:", e));

    if (rotatedPath) {
      // rotation-worker 会把 .0001 压缩成 .0001.gz；通知 cold-indexer 等 gz 出现后立即索引
      const gzPath = rotatedPath.endsWith(".gz") ? rotatedPath : rotatedPath + ".gz";
      console.log(`[cache-sync] rotated → ${gzPath}, notifying cold-indexer`);
      indexNow(gzPath);
    }
  }

  // 只 commit 到最后一个完整 \n，返回实际消费的字节数
  private async readAndInsert(from: number, to: number): Promise<number> {
    const len = to - from;
    if (len <= 0 || this.fd === null) return 0;
    const buf = Buffer.alloc(len);
    readSync(this.fd, buf, 0, len, from);

    // 找到 buf 中最后一个 '\n' 的位置，只 parse 到它
    let lastNl = buf.lastIndexOf(0x0a); // '\n'
    if (lastNl < 0) return 0; // 整段都是一行的一部分，等待更多数据
    const safeLen = lastNl + 1; // 包含这个 '\n'

    const text = buf.slice(0, safeLen).toString("utf8");
    // split("\n") 在末尾 \n 后会多出一个 "" 元素，pop 掉避免 lineOffset 多累加 1
    const lines = text.split("\n");
    lines.pop();

    const records: Array<Record<string, unknown>> = [];
    let lineOffset = from;
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (line.trim()) {
        const rec = parseTrafficLine(line);
        if (rec) {
          records.push({ ...rec, jsonl_file: PATHS.trafficLog, jsonl_byte_offset: lineOffset });
        }
      }
      lineOffset += lineBytes + 1; // +1 for '\n'
    }

    await insertRecords(records);
    return safeLen;
  }
}

const worker = new CacheSyncWorker();
let _timer: ReturnType<typeof setTimeout> | null = null;

export function startCacheSyncWorker(): void {
  const tick = () => {
    worker.tick().catch((e) => console.warn("[cache-sync] tick error:", e))
      .finally(() => { _timer = setTimeout(tick, SYNC_TICK_MS); });
  };
  tick();
}

export function stopCacheSyncWorker(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}
