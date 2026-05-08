import { Controller, Get, Param, Post, Query, Req, Res } from "@nestjs/common";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "./db.ts";
import { syncProxyTraffic } from "./sync.ts";

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

@Controller("api/proxy")
export class ProxyTrafficController {
  // ── Proxy sync ────────────────────────────────────────────────────────────────
  @Post("sync")
  async proxySync() {
    return syncProxyTraffic();
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
    const rows = db.prepare(
      `SELECT * FROM proxy_requests ${where} ORDER BY COALESCE(started_at, ts) DESC, id DESC LIMIT ? OFFSET ?`,
    ).all([...params, limit, offset]);

    return { requests: rows, total, limit, offset };
  }

  // ── Proxy request detail ──────────────────────────────────────────────────────
  @Get("requests/:id")
  requestDetail(@Param("id") id: string) {
    const db = getDb();
    const row = db.prepare("SELECT * FROM proxy_requests WHERE id = ?").get(Number(id)) as Record<string, unknown> | undefined;
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

    const poll = setInterval(async () => {
      if (closed) return;
      try {
        await syncProxyTraffic();
        const db = getDb();
        const rows = db.prepare(
          `SELECT * FROM proxy_requests WHERE id > ? ORDER BY COALESCE(started_at, ts) ASC, id ASC LIMIT 20`,
        ).all(lastId) as Record<string, unknown>[];
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
  @Get("whitelist")
  async whitelistGet() {
    const { PROXY_SERVER_PATHS } = await import("./proxy-v2/paths.ts");
    let hosts: string[] = [];
    if (existsSync(PROXY_SERVER_PATHS.mitmHostsFile)) {
      try {
        const raw = JSON.parse(readFileSync(PROXY_SERVER_PATHS.mitmHostsFile, "utf8")) as { hosts?: string[] };
        if (Array.isArray(raw.hosts)) hosts = raw.hosts;
      } catch { /* ignore */ }
    }
    return { hosts: ["api.anthropic.com", ...hosts], base: ["api.anthropic.com"], user: hosts };
  }

  // ── Proxy whitelist SET ───────────────────────────────────────────────────────
  @Post("whitelist")
  async whitelistSet(@Req() req: FastifyRequest) {
    const body = req.body as { hosts?: unknown } | null;
    if (!body || !Array.isArray(body.hosts)) {
      throw Object.assign(new Error("invalid body"), { status: 400 });
    }
    const { PROXY_SERVER_PATHS } = await import("./proxy-v2/paths.ts");
    mkdirSync(PROXY_SERVER_PATHS.home, { recursive: true, mode: 0o700 });
    const userHosts = (body.hosts as string[]).filter((h) => h !== "api.anthropic.com");
    writeFileSync(PROXY_SERVER_PATHS.mitmHostsFile, JSON.stringify({ hosts: userHosts }, null, 2) + "\n");
    return { ok: true, hosts: userHosts };
  }
}
