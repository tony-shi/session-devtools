#!/usr/bin/env tsx
// backfill-proxy-request-id.ts
//
// 一次性回填 proxy_requests.request_id（从 res_headers 中提取 Anthropic 的
// request-id 头）。新逻辑用 request_id 与 JSONL 端 assistant 事件的
// `requestId` 字段做精确匹配，老数据需要补回这个键。
//
// 用法（建议先停服务再跑）：
//   npm run backfill:proxy-request-id              # 实跑
//   npm run backfill:proxy-request-id -- --dry-run # 只统计，不写库
//
// 安全：
// - 幂等。仅处理 WHERE request_id IS NULL 的行；已有值的不动。
// - 只读取 res_headers JSON 字符串本身，不需要再读 jsonl 文件。
// - 失败的行（res_headers 缺失 / 解析失败 / 没有 request-id 头）跳过，
//   留 NULL，匹配会自动 fallback 到时间戳，行为与现状一致。
//
// 进度报告：每 5000 行打一次摘要。

import { initDb, getDb } from "../server/src/db";

const DRY_RUN = process.argv.includes("--dry-run");

interface Row {
  id: number;
  res_headers: string | null;
}

function extractRequestId(resHeadersJson: string | null): string | null {
  if (!resHeadersJson) return null;
  let headers: Record<string, unknown>;
  try {
    headers = JSON.parse(resHeadersJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "request-id" && typeof v === "string" && v) {
      return v;
    }
  }
  return null;
}

function main(): void {
  initDb();
  const db = getDb();

  const total = (db.prepare("SELECT COUNT(*) AS c FROM proxy_requests").get() as { c: number }).c;
  const pending = (db.prepare("SELECT COUNT(*) AS c FROM proxy_requests WHERE request_id IS NULL").get() as { c: number }).c;
  console.log(`[backfill] total proxy_requests = ${total}; rows missing request_id = ${pending}`);
  if (pending === 0) {
    console.log("[backfill] nothing to do.");
    return;
  }

  const selectStmt = db.prepare<[], Row>(
    "SELECT id, res_headers FROM proxy_requests WHERE request_id IS NULL"
  );
  const updateStmt = db.prepare("UPDATE proxy_requests SET request_id = ? WHERE id = ?");

  let scanned = 0;
  let filled = 0;
  let skipped = 0;
  const t0 = Date.now();

  const apply = db.transaction((rows: Row[]) => {
    for (const r of rows) {
      const rid = extractRequestId(r.res_headers);
      scanned++;
      if (rid) {
        if (!DRY_RUN) updateStmt.run(rid, r.id);
        filled++;
      } else {
        skipped++;
      }
      if (scanned % 5000 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[backfill] scanned=${scanned} filled=${filled} skipped=${skipped} (${elapsed}s)`);
      }
    }
  });

  apply(selectStmt.all());

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[backfill] done. scanned=${scanned} filled=${filled} skipped=${skipped} (${elapsed}s)${DRY_RUN ? " [DRY-RUN]" : ""}`);
}

main();
