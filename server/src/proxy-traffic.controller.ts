import { Controller, Get, Param, Post, Query, Req, Res } from "@nestjs/common";
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "./db.ts";
import { getColdIndexProgress } from "./proxy-v2/log/cold-indexer.ts";
import { normalizeHosts } from "./proxy-v2/host-normalize.ts";
import { getVisibilityService } from "./proxy-visibility/index.ts";

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

async function readLineFromGzip(filePath: string, offset: number): Promise<string> {
  const stream = createReadStream(filePath).pipe(createGunzip());
  const decoder = new StringDecoder("utf8");
  let consumed = 0;
  let buffer = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const chunkLen = chunk.length;
    if (consumed + chunkLen <= offset) {
      consumed += chunkLen;
      continue;
    }
    const skipInChunk = Math.max(0, offset - consumed);
    buffer += decoder.write(chunk.slice(skipInChunk));
    const newlineIdx = buffer.indexOf("\n");
    if (newlineIdx >= 0) return buffer.slice(0, newlineIdx);
    consumed += chunkLen;
  }
  return buffer + decoder.end();
}

async function readLineFromPlain(filePath: string, offset: number): Promise<string> {
  const { openSync, readSync, closeSync } = await import("node:fs");
  const fd = openSync(filePath, "r");
  try {
    // Read up to 1MB from offset to find the line
    const maxRead = 1024 * 1024;
    const buf = Buffer.alloc(maxRead);
    const bytesRead = readSync(fd, buf, 0, maxRead, offset);
    const text = buf.slice(0, bytesRead).toString("utf8");
    const newlineIdx = text.indexOf("\n");
    return newlineIdx >= 0 ? text.slice(0, newlineIdx) : text;
  } finally {
    closeSync(fd);
  }
}

@Controller("api/proxy")
export class ProxyTrafficController {
  // ── Proxy sync (deprecated — kept for UI compat) ──────────────────────────────
  @Post("sync")
  async proxySync() {
    return { ok: true, message: "sync is now handled by background workers" };
  }

  // ── Proxy requests list ───────────────────────────────────────────────────────
  @Get("requests")
  requests(
    @Query("limit") limitParam?: string,
    @Query("offset") offsetParam?: string,
    @Query("sni") sni?: string,
    @Query("status") status?: string,
  ) {
    const db = getDb();
    const limit = Math.min(parseInt(limitParam ?? "50"), 200);
    const offset = parseInt(offsetParam ?? "0");

    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (sni) { conds.push("sni = ?"); params.push(sni); }
    if (status) { conds.push("status = ?"); params.push(Number(status)); }
    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";

    const total = ((db.prepare(`SELECT COUNT(*) as cnt FROM proxy_requests ${where}`).get(params)) as { cnt: number })?.cnt ?? 0;
    const rows = db.prepare(`
      SELECT id, ts, started_at, sni, method, url, status,
             bytes_in, bytes_out, duration_ms,
             req_headers, res_headers, sse_event_count, is_stream,
             session_id, request_id
      FROM proxy_requests ${where}
      ORDER BY COALESCE(started_at, ts) DESC, id DESC
      LIMIT ? OFFSET ?
    `).all([...params, limit, offset]) as Array<{ session_id: string | null; request_id: string | null } & Record<string, unknown>>;

    // 用 RenderedSetService 给每行打 visibility 徽章 + 跳转坐标。整条路径独立
    // 模块，不在核心查询链路上：disabled 时直接全部回 'disabled'，零开销。
    // link_target 仅 visible 行非 null —— 前端据此把徽章变成可点的"跳到 call"。
    const visService = getVisibilityService();
    const results = visService.enrichRows(
      rows.map((r) => ({ sessionId: r.session_id, requestId: r.request_id })),
    );
    const enriched = rows.map((r, i) => ({
      ...r,
      visibility: results[i].visibility,
      link_target: results[i].target,
    }));

    return { requests: enriched, total, limit, offset, indexProgress: getColdIndexProgress() };
  }

  // ── Proxy request body (lazy fetch from file) ─────────────────────────────────
  // NOTE: must be declared before requests/:id to avoid route conflict
  @Get("requests/:id/body")
  async requestBody(@Param("id") id: string) {
    const db = getDb();
    const row = db.prepare(`
      SELECT jsonl_file, jsonl_byte_offset FROM proxy_requests WHERE id = ?
    `).get(Number(id)) as { jsonl_file: string; jsonl_byte_offset: number } | undefined;
    if (!row) return { error: "not_found" };

    if (!row.jsonl_file || !existsSync(row.jsonl_file)) {
      return { error: "file_deleted", message: "原始日志文件已被删除" };
    }

    try {
      const isCold = row.jsonl_file.endsWith(".gz");
      const line = isCold
        ? await readLineFromGzip(row.jsonl_file, row.jsonl_byte_offset)
        : await readLineFromPlain(row.jsonl_file, row.jsonl_byte_offset);

      const rec = JSON.parse(line);
      return {
        req_body: rec.reqBody ?? "",
        res_body: rec.resBody ?? "",
        req_body_encoding: rec.reqBodyEncoding ?? "utf8",
        res_body_encoding: rec.resBodyEncoding ?? "utf8",
      };
    } catch (e: any) {
      return { error: "parse_error", message: e?.message };
    }
  }

  // ── Proxy request detail ──────────────────────────────────────────────────────
  @Get("requests/:id")
  requestDetail(@Param("id") id: string) {
    const db = getDb();
    const row = db.prepare(`
      SELECT id, ts, started_at, sni, method, url, status,
             bytes_in, bytes_out, duration_ms,
             req_headers, res_headers, sse_event_count, is_stream
      FROM proxy_requests WHERE id = ?
    `).get(Number(id)) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("not found"), { status: 404 });
    return {
      ...row,
      req_headers: parseJsonField(row.req_headers as string, {}),
      res_headers: parseJsonField(row.res_headers as string, {}),
    };
  }

  // ── Proxy SSE stream ──────────────────────────────────────────────────────────
  @Get("stream")
  stream(
    @Query("since_id") sinceId: string,
    @Req() _req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): void {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
      Connection: "keep-alive",
    });

    let lastId = Number(sinceId ?? "0");
    let closed = false;

    const encoder = new TextEncoder();
    const write = (chunk: string) => {
      try { reply.raw.write(encoder.encode(chunk)); } catch { close(); }
    };

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(poll);
      try { reply.raw.end(); } catch { /* ignore */ }
    };

    const heartbeat = setInterval(() => {
      if (closed) return;
      write(": heartbeat\n\n");
    }, 8000);

    const poll = setInterval(() => {
      if (closed) return;
      try {
        const db = getDb();
        const rows = db.prepare(`
          SELECT id, ts, started_at, sni, method, url, status,
                 bytes_in, bytes_out, duration_ms,
                 req_headers, res_headers, sse_event_count, is_stream
          FROM proxy_requests WHERE id > ? ORDER BY COALESCE(started_at, ts) ASC, id ASC LIMIT 20
        `).all(lastId) as Record<string, unknown>[];
        for (const row of rows) {
          lastId = row.id as number;
          const data = JSON.stringify({
            ...row,
            req_headers: parseJsonField(row.req_headers as string, {}),
            res_headers: parseJsonField(row.res_headers as string, {}),
          });
          write(`data: ${data}\n\n`);
        }
      } catch { close(); }
    }, 2000);

    reply.raw.on("close", close);
    reply.raw.on("error", close);
  }

  // ── Proxy whitelist GET ───────────────────────────────────────────────────────
  // 读出时也跑一次 normalize，旧 mitm-hosts.json 里如果残留 `https://...` 之类
  // 脏数据，前端看到的就是规范化后的版本，从源头消除 UI 显示 / proxy 实际匹配
  // 不一致带来的误解。
  @Get("whitelist")
  async whitelistGet() {
    const { PROXY_SERVER_PATHS } = await import("./proxy-v2/paths.ts");
    let raw: unknown[] = [];
    if (existsSync(PROXY_SERVER_PATHS.mitmHostsFile)) {
      try {
        const parsed = JSON.parse(readFileSync(PROXY_SERVER_PATHS.mitmHostsFile, "utf8")) as { hosts?: unknown };
        if (Array.isArray(parsed.hosts)) raw = parsed.hosts;
      } catch { /* ignore */ }
    }
    const hosts = normalizeHosts(raw);
    return { hosts: ["api.anthropic.com", ...hosts], base: ["api.anthropic.com"], user: hosts };
  }

  // ── Proxy whitelist SET ───────────────────────────────────────────────────────
  // 防御纵深：前端已经规范化过；这里再跑一遍，CLI / curl 直接 POST 也能落到
  // 同一规约。任何无法规范化的条目（空、含空格、URL 解析失败）被静默丢弃。
  @Post("whitelist")
  async whitelistSet(@Req() req: FastifyRequest) {
    const body = req.body as { hosts?: unknown } | null;
    if (!body || !Array.isArray(body.hosts)) {
      throw Object.assign(new Error("invalid body"), { status: 400 });
    }
    const { PROXY_SERVER_PATHS } = await import("./proxy-v2/paths.ts");
    mkdirSync(PROXY_SERVER_PATHS.home, { recursive: true, mode: 0o700 });
    const userHosts = normalizeHosts(body.hosts as unknown[]);
    writeFileSync(PROXY_SERVER_PATHS.mitmHostsFile, JSON.stringify({ hosts: userHosts }, null, 2) + "\n");
    return { ok: true, hosts: userHosts };
  }
}
