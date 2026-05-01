// 主代理服务。监听 127.0.0.1:PORT，接受标准 HTTP CONNECT。
// - 白名单内 (api.anthropic.com 等): 用我们的 CA 签发该 host 的叶子，TLSSocket 包裹客户端 socket → 解密 → 旁路 → 经 egress 发到上游
// - 白名单外: 透传 CONNECT 隧道（仍走 egress，所以不会绕过用户原代理）
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import zlib from "node:zlib";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { getMitmWhitelist, PATHS, LISTEN_HOST, loadTargetCaPems } from "../config";
import { connectEgress, UpstreamProxyError } from "../egress";
import { ensureCa, issueLeaf } from "../ca";
import { writeTraffic, parseSseChunk } from "../log/jsonl";

interface StartOptions {
  port: number;
  onListening?: (port: number) => void;
}

const debug = process.env.API_DASHBOARD_PROXY_DEBUG ? (...args: unknown[]) => console.error("[mitm]", ...args) : () => {};

// 模块级统计（供 /_health 和 B3.2 连续失败检测使用）
let _requestCount = 0;
let _startTime = 0;
let _listenPort = 0;
let _consecutiveFailures = 0;
const UPSTREAM_WARN_THRESHOLD = 5;

function recordUpstreamSuccess() { _consecutiveFailures = 0; }
function recordUpstreamFailure(sni: string, reason: string) {
  _consecutiveFailures++;
  if (_consecutiveFailures >= UPSTREAM_WARN_THRESHOLD) {
    writeTraffic({
      ts: new Date().toISOString(),
      kind: "event",
      msg: "upstream_consecutive_failures",
      sni,
      meta: { count: _consecutiveFailures, reason },
    });
  }
}

export async function startProxy(opts: StartOptions): Promise<{ close: () => Promise<void> }> {
  await ensureCa();
  _startTime = Date.now();
  _requestCount = 0;
  _consecutiveFailures = 0;

  // 内部 http.Server：消费"已解密的 TLSSocket"上的 HTTP/1.1 流量。
  // 必须 listen 一下（端口随机、仅本机）让其内部的 'connection' 事件机制启用，再通过 emit 接收外部 socket。
  const httpServer = http.createServer(handleMitmRequest);
  httpServer.on("clientError", (e: Error) => debug("internal clientError:", e.message));
  await new Promise<void>((res) => httpServer.listen(0, "127.0.0.1", () => res()));

  // 主入口：标准 HTTP 代理协议。
  const proxy = http.createServer((req, res) => {
    // B3.1: /_health 端点
    if (req.url === "/_health" && req.method === "GET") {
      const upstream = process.env.API_DASHBOARD_PROXY_UPSTREAM;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        listening: true,
        upstream: upstream ? "configured" : "none",
        pid: process.pid,
        port: _listenPort,
        mode: process.env.API_DASHBOARD_PROXY_MODE ?? "standalone",
        uptime: Math.floor((Date.now() - _startTime) / 1000),
        requestCount: _requestCount,
      }));
      return;
    }
    // 明文 HTTP 代理请求（如 ANTHROPIC_BASE_URL=http://127.0.0.1:8742 的流量）。
    // 白名单内的 host 记录旁路；白名单外透传。
    handleHttpForward(req, res);
  });

  proxy.on("connect", async (req, clientSock, head) => {
    _requestCount++;
    const target = req.url ?? "";
    const m = target.match(/^([^:]+):(\d+)$/);
    if (!m) {
      clientSock.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSock.end();
      return;
    }
    const host = m[1]!;
    const port = Number(m[2]);
    // 必须先 ack CONNECT，客户端才会发 TLS Client Hello。
    clientSock.write("HTTP/1.1 200 Connection established\r\n\r\n");

    // A5.1: 每次 CONNECT 时读最新白名单（已支持热重载）。
    // 白名单条目可以是 "hostname" 或 "hostname:port" 两种格式。
    const wl = getMitmWhitelist();
    if (wl.has(host) || wl.has(`${host}:${port}`)) {
      try {
        await mitmIntercept(clientSock, head, host, port, httpServer);
      } catch (err) {
        debug("mitm intercept fail:", (err as Error).message);
        clientSock.destroy();
      }
    } else {
      handleTransparentTunnel(clientSock as net.Socket, host, port, head).catch((err) => {
        if (err instanceof UpstreamProxyError) {
          writeTraffic({ ts: new Date().toISOString(), kind: "event", msg: "tunnel_fail", sni: host, meta: { code: err.statusCode, via: err.via } });
        }
        clientSock.destroy();
      });
    }
  });

  proxy.on("clientError", (e) => debug("proxy clientError:", e.message));

  return new Promise((resolve, reject) => {
    (proxy as any).once("error", reject);
    proxy.listen(opts.port, LISTEN_HOST, () => {
      const addr = proxy.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : opts.port;
      _listenPort = actualPort;
      try {
        writeFileSync(PATHS.portFile, String(actualPort));
        writeFileSync(PATHS.pidFile, String(process.pid));
      } catch {}
      writeTraffic({ ts: new Date().toISOString(), kind: "event", msg: "listening", meta: { port: actualPort, pid: process.pid } });
      opts.onListening?.(actualPort);
      resolve({
        close: () =>
          new Promise<void>((r) => {
            proxy.close(() => httpServer.close(() => {
              cleanupPidFiles();
              r();
            }));
          }),
      });
    });
  });
}

function cleanupPidFiles(): void {
  try {
    if (existsSync(PATHS.pidFile) && readFileSync(PATHS.pidFile, "utf8").trim() === String(process.pid)) {
      unlinkSync(PATHS.pidFile);
    }
    if (existsSync(PATHS.portFile)) unlinkSync(PATHS.portFile);
  } catch {}
}

async function mitmIntercept(clientSock: any, head: Buffer, host: string, port: number, httpServer: http.Server): Promise<void> {
  const { cert, key } = await issueLeaf(host);
  const ctx = tls.createSecureContext({ cert, key });
  // CONNECT ack 之后客户端通常立刻发 TLS Client Hello；如果在主入口 'connect' 事件给我们的 head 里已经有，先回灌。
  if (head.length > 0) clientSock.unshift(head);
  const tlsSock = new tls.TLSSocket(clientSock, {
    isServer: true,
    secureContext: ctx,
    ALPNProtocols: ["http/1.1"],
  } as any);
  (tlsSock as any)._mitmHost = host;
  (tlsSock as any)._mitmPort = port;
  tlsSock.on("error", (e) => debug("tlsSock err for", host, ":", e.message));
  tlsSock.once("secure", () => httpServer.emit("connection", tlsSock));
}

async function handleTransparentTunnel(client: net.Socket, host: string, port: number, head: Buffer) {
  const upstream = await connectEgress({ host, port });
  if (head.length > 0) upstream.write(head);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
}

function handleMitmRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const sock = req.socket as any;
  const host = (sock?._mitmHost as string | undefined) || (req.headers.host?.split(":")[0] ?? "");
  // CONNECT 目标端口是上游真实端口。这里不能写死 443：
  // 自定义网关常见形态是 https://host:8742，若丢失端口会把已解密请求发到 host:443，
  // 网关通常返回 openresty 400，UI 看起来像"已拦截但请求坏了"。
  const port = Number(sock?._mitmPort ?? 443);
  const sni = host;
  const startedAt = Date.now();
  const origin = port === 443 ? `https://${host}` : `https://${host}:${port}`;

  const reqHeaders: Record<string, string> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    reqHeaders[req.rawHeaders[i]!] = req.rawHeaders[i + 1]!;
  }

  const reqChunks: Buffer[] = [];
  req.on("data", (c) => reqChunks.push(c));
  req.on("end", () => {
    const reqBody = Buffer.concat(reqChunks);

    // A5.3: 追加用户上传的上游自签 CA（不替换系统信任链）
    const extraCaPems = loadTargetCaPems();

    // 用 rawHeaders 保留原始 header name 大小写。req.headers 是 Node 标准化后的小写形式，
    // 某些上游网关（如企业 openresty）对 header 大小写敏感，传过去会被拒绝。
    const fwdHeaders: Record<string, string | string[]> = {};
    {
      const seenLower = new Set<string>();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]!;
        const v = req.rawHeaders[i + 1]!;
        const lk = k.toLowerCase();
        if (seenLower.has(lk)) {
          const cur = fwdHeaders[k];
          if (Array.isArray(cur)) cur.push(v);
          else if (typeof cur === "string") fwdHeaders[k] = [cur, v];
          else fwdHeaders[k] = v;
        } else {
          fwdHeaders[k] = v;
          seenLower.add(lk);
        }
      }
    }
    // B1.3: 强制上游只用我们能解的压缩算法，确保 dump 能解出原文
    normalizeAcceptEncoding(fwdHeaders);

    const proxyReq = https.request(
      {
        host,
        port,
        path: req.url,
        method: req.method,
        headers: fwdHeaders,
        createConnection: (_opts, cb) => {
          connectEgress({ host, port })
            .then((rawSock) => {
              const tlsOpts: tls.ConnectionOptions = {
                socket: rawSock,
                servername: host,
                ALPNProtocols: ["http/1.1"],
              };
              // A5.3: 追加用户自签 CA，保留系统根（tls.rootCertificates）。
              // 直接赋值 ca 会替换系统根，导致 api.anthropic.com 等公开域名 TLS 失败。
              if (extraCaPems.length > 0) {
                tlsOpts.ca = [...tls.rootCertificates, ...extraCaPems];
              }
              const t = tls.connect(tlsOpts);
              t.once("secureConnect", () => cb!(null, t as any));
              t.once("error", (e) => {
                // A5.4: 上游 TLS 校验失败 → 写 traffic.jsonl 事件，含证书 fingerprint
                const certErr = e as any;
                const fingerprint = certErr?.cert?.fingerprint256 ?? certErr?.cert?.fingerprint ?? "unknown";
                writeTraffic({
                  ts: new Date().toISOString(),
                  kind: "event",
                  msg: "upstream_cert_untrusted",
                  sni: host,
                  meta: {
                    error: e.message,
                    fingerprint,
                    hint: `如需信任此证书，将 CA PEM 放入 ${PATHS.targetCaDir}/<host>.pem`,
                  },
                });
                cb!(e, undefined as any);
              });
            })
            .catch((err) => cb!(err, undefined as any));
          return undefined as any;
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage ?? "", proxyRes.headers as any);
        const resHeaders: Record<string, string> = {};
        for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
          resHeaders[proxyRes.rawHeaders[i]!] = proxyRes.rawHeaders[i + 1]!;
        }
        // B1.3: 累积全部原始（可能压缩）字节，end 时一次性解压并落盘。
        // 原方案是边收边 parseSseChunk，但响应若 gzip 压缩则 c.toString("utf8") 全是乱码，事件计数永远为 0。
        const resChunks: Buffer[] = [];
        let resBytes = 0;
        const isStream = (proxyRes.headers["content-type"] ?? "").includes("event-stream");
        proxyRes.on("data", (c: Buffer) => {
          res.write(c); // 客户端透传压缩字节，client 自行解压
          resBytes += c.length;
          resChunks.push(c);
        });
        proxyRes.on("end", () => {
          res.end();
          recordUpstreamSuccess();
          const rawBuf = Buffer.concat(resChunks);
          const resContentEncoding = getContentEncoding(proxyRes.headers as Record<string, string | string[] | undefined>);
          const decoded = decompressBody(rawBuf, resContentEncoding);
          // 请求体目前 client→proxy 不会压缩（HTTP 客户端基本不会主动 gzip 请求体），
          // 但仍按统一路径处理 reqHeaders 里的 Content-Encoding，未来兼容。
          const reqContentEncoding = getContentEncoding(reqHeaders as Record<string, string | string[] | undefined>);
          const reqDecoded = decompressBody(reqBody, reqContentEncoding);
          const reqEncoded = encodeBodyForDump(reqDecoded);

          let resBodyField: string;
          let resBodyEncoding: "utf8" | "base64";
          let sseEventCount = 0;
          if (isStream) {
            // SSE：解压后整段喂给 parser，每个事件单独写一行 sse_event
            const sseState = { buf: "", index: 0 };
            parseSseChunk(decoded.toString("utf8"), (eventType, data, idx) => {
              writeTraffic({
                ts: new Date().toISOString(),
                kind: "sse_event",
                sni,
                url: `${origin}${req.url}`,
                sseEventType: eventType,
                sseData: data,
                sseIndex: idx,
              });
            }, sseState);
            sseEventCount = sseState.index;
            // resBody 仍存解压后的完整 SSE 文本（不只是 placeholder），便于回放和调试
            const decodedEncoded = encodeBodyForDump(decoded);
            resBodyField = decodedEncoded.body;
            resBodyEncoding = decodedEncoded.encoding;
          } else {
            const decodedEncoded = encodeBodyForDump(decoded);
            resBodyField = decodedEncoded.body;
            resBodyEncoding = decodedEncoded.encoding;
          }

          writeTraffic({
            ts: new Date(startedAt).toISOString(),
            startedAt: new Date(startedAt).toISOString(),
            kind: "response",
            sni,
            method: req.method,
            url: `${origin}${req.url}`,
            status: proxyRes.statusCode,
            reqHeaders,
            resHeaders,
            reqBody: reqEncoded.body,
            reqBodyEncoding: reqEncoded.encoding,
            reqContentEncoding,
            resBody: resBodyField,
            resBodyEncoding,
            resContentEncoding,
            meta: {
              durationMs: Date.now() - startedAt,
              upstream: !!process.env.API_DASHBOARD_PROXY_UPSTREAM,
              // 保留这些字段方便 audit / UI 显示而不必再去算
              isStream,
              sseEventCount,
              rawBytes: resBytes,
              decodedBytes: decoded.length,
            },
          });
        });
        proxyRes.on("error", () => res.destroy());
      },
    );
    proxyReq.on("error", (err) => {
      const code = err instanceof UpstreamProxyError ? err.statusCode : 502;
      try {
        res.writeHead(code, { "content-type": "text/plain" });
        res.end(`upstream error: ${err.message}`);
      } catch {}
      recordUpstreamFailure(sni, err.message);
      writeTraffic({
        ts: new Date(startedAt).toISOString(),
        kind: "event",
        msg: "mitm_upstream_error",
        sni,
        url: `${origin}${req.url}`,
        meta: { error: err.message, code },
      });
    });
    if (reqBody.length > 0) proxyReq.write(reqBody);
    proxyReq.end();
  });
  req.on("error", () => res.destroy());
}

// 明文 HTTP 代理转发。
// 处理 ANTHROPIC_BASE_URL=http://host:port 这类场景——流量不走 HTTPS CONNECT，而是直接 HTTP 请求。
// 白名单内的 host 记录旁路；白名单外直接透传（不记录）。
function handleHttpForward(req: http.IncomingMessage, res: http.ServerResponse) {
  // 代理请求的 URL 是绝对路径，如 http://127.0.0.1:8742/v1/messages
  let targetUrl: URL;
  try {
    targetUrl = new URL(req.url ?? "");
  } catch {
    res.writeHead(400);
    res.end("Bad Request: invalid URL");
    return;
  }

  const host = targetUrl.hostname;
  const port = Number(targetUrl.port || 80);
  const inWhitelist = getMitmWhitelist().has(host) || getMitmWhitelist().has(`${host}:${targetUrl.port}`);
  const startedAt = Date.now();

  const reqHeaders: Record<string, string> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    reqHeaders[req.rawHeaders[i]!] = req.rawHeaders[i + 1]!;
  }

  const reqChunks: Buffer[] = [];
  req.on("data", (c) => reqChunks.push(c));
  req.on("end", () => {
    const reqBody = Buffer.concat(reqChunks);

    // 清理代理专用 headers + transfer-encoding（我们用 content-length 替代，避免 chunked 导致目标 400）
    const STRIP_HEADERS = new Set(["proxy-connection", "proxy-authorization", "proxy-authenticate", "transfer-encoding"]);
    // 用 rawHeaders 保留客户端发的原始 header name 大小写（Host vs host）。
    // 某些上游网关（如企业 openresty）对 header 大小写敏感，全小写 host 会被拒绝 400。
    // req.headers 是 Node 标准化后的小写形式，不能直接转发。
    const seenLower = new Set<string>();
    const forwardHeaders: Record<string, string | string[]> = {};
    const rawHeaderOverrides = new Set(["host", "content-length", "connection"]);
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i]!;
      const v = req.rawHeaders[i + 1]!;
      const lk = k.toLowerCase();
      if (STRIP_HEADERS.has(lk)) continue;
      if (rawHeaderOverrides.has(lk)) continue; // 我们要重写这些，下面用规范大小写
      if (seenLower.has(lk)) {
        // 同名 header 多次出现：合并为数组
        const cur = forwardHeaders[k];
        if (Array.isArray(cur)) cur.push(v);
        else if (typeof cur === "string") forwardHeaders[k] = [cur, v];
        else forwardHeaders[k] = v;
      } else {
        forwardHeaders[k] = v;
        seenLower.add(lk);
      }
    }
    // 用规范大小写写回需要覆盖的 header（Host/Content-Length/Connection）。
    forwardHeaders["Host"] = targetUrl.host;
    if (reqBody.length > 0) {
      forwardHeaders["Content-Length"] = String(reqBody.length);
    }
    // 强制 Connection: close，兼容不支持 HTTP/1.1 keep-alive 的目标服务（如本地 Python 网关）
    forwardHeaders["Connection"] = "close";
    // B1.3: 限定上游用我们能解的压缩算法
    normalizeAcceptEncoding(forwardHeaders);

    // 转发到目标（直连，不再走 egress 避免循环）
    const fwdReq = http.request(
      {
        hostname: host,
        port,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: forwardHeaders,
      },
      (fwdRes) => {
        res.writeHead(fwdRes.statusCode ?? 502, fwdRes.headers as any);
        const resHeaders: Record<string, string> = {};
        for (let i = 0; i < fwdRes.rawHeaders.length; i += 2) {
          resHeaders[fwdRes.rawHeaders[i]!] = fwdRes.rawHeaders[i + 1]!;
        }
        const resChunks: Buffer[] = [];
        let resBytes = 0;
        const isStream = (fwdRes.headers["content-type"] ?? "").includes("event-stream");

        fwdRes.on("data", (c: Buffer) => {
          res.write(c); // 透传压缩字节
          resBytes += c.length;
          resChunks.push(c);
        });

        fwdRes.on("end", () => {
          res.end();
          if (!inWhitelist) return;
          const rawBuf = Buffer.concat(resChunks);
          const resContentEncoding = getContentEncoding(fwdRes.headers as Record<string, string | string[] | undefined>);
          const decoded = decompressBody(rawBuf, resContentEncoding);
          const reqContentEncoding = getContentEncoding(reqHeaders as Record<string, string | string[] | undefined>);
          const reqDecoded = decompressBody(reqBody, reqContentEncoding);
          const reqEncoded = encodeBodyForDump(reqDecoded);

          let resBodyField: string;
          let resBodyEncoding: "utf8" | "base64";
          let sseEventCount = 0;
          if (isStream) {
            const sseState = { buf: "", index: 0 };
            parseSseChunk(decoded.toString("utf8"), (eventType, data, idx) => {
              writeTraffic({
                ts: new Date().toISOString(),
                kind: "sse_event",
                sni: host,
                url: req.url ?? "",
                sseEventType: eventType,
                sseData: data,
                sseIndex: idx,
              });
            }, sseState);
            sseEventCount = sseState.index;
            const decodedEncoded = encodeBodyForDump(decoded);
            resBodyField = decodedEncoded.body;
            resBodyEncoding = decodedEncoded.encoding;
          } else {
            const decodedEncoded = encodeBodyForDump(decoded);
            resBodyField = decodedEncoded.body;
            resBodyEncoding = decodedEncoded.encoding;
          }

          writeTraffic({
            ts: new Date(startedAt).toISOString(),
            startedAt: new Date(startedAt).toISOString(),
            kind: "response",
            sni: host,
            method: req.method,
            url: req.url ?? "",
            status: fwdRes.statusCode,
            reqHeaders,
            resHeaders,
            reqBody: reqEncoded.body,
            reqBodyEncoding: reqEncoded.encoding,
            reqContentEncoding,
            resBody: resBodyField,
            resBodyEncoding,
            resContentEncoding,
            meta: {
              durationMs: Date.now() - startedAt,
              httpForward: true,
              isStream,
              sseEventCount,
              rawBytes: resBytes,
              decodedBytes: decoded.length,
            },
          });
        });
        fwdRes.on("error", () => res.destroy());
      },
    );
    fwdReq.on("error", (err) => {
      try { res.writeHead(502); res.end(`forward error: ${err.message}`); } catch {}
      if (inWhitelist) {
        writeTraffic({
          ts: new Date(startedAt).toISOString(),
          kind: "event",
          msg: "http_forward_error",
          sni: host,
          url: req.url ?? "",
          meta: { error: err.message },
        });
      }
    });
    if (reqBody.length > 0) fwdReq.write(reqBody);
    fwdReq.end();
  });
  req.on("error", () => res.destroy());
}

// ─── B1.3 忠实存原文：解压 + base64 兜底，绝不截断 ──────────────────────────────

// 我们能解压的 Content-Encoding 集合。zstd 仅在 Node 22.15+ 可用，做运行时探测。
const ZSTD_SYNC: ((buf: Buffer) => Buffer) | null =
  typeof (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync === "function"
    ? (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync
    : null;

const SUPPORTED_ENCODINGS = new Set(["gzip", "x-gzip", "deflate", "br", "identity", ""].concat(ZSTD_SYNC ? ["zstd"] : []));

// 按 Content-Encoding 解压。失败 / 未知算法返回原 buffer（调用方 encodeBodyForDump 会以 base64 落盘，原文不丢）。
function decompressBody(buf: Buffer, encoding?: string): Buffer {
  if (!encoding || buf.length === 0) return buf;
  const enc = encoding.toLowerCase().trim();
  if (enc === "" || enc === "identity") return buf;
  try {
    if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buf);
    if (enc === "deflate") {
      // RFC 7230 允许 zlib 包装或 raw deflate。先试带头，失败再试 raw。
      try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    }
    if (enc === "br") return zlib.brotliDecompressSync(buf);
    if (enc === "zstd" && ZSTD_SYNC) return ZSTD_SYNC(buf);
  } catch (e) {
    debug("decompress failed", enc, (e as Error).message);
  }
  return buf;
}

// 把字节落到 JSONL：能 utf8 round-trip 就用 utf8 原文，否则 base64。
// 关键约束：永不截断，永不丢。
function encodeBodyForDump(buf: Buffer): { body: string; encoding: "utf8" | "base64" } {
  if (buf.length === 0) return { body: "", encoding: "utf8" };
  const text = buf.toString("utf8");
  // utf8 round-trip 校验：解码再编码字节数和内容完全一致才视为合法文本。
  // 否则（含 NUL、半字符、二进制片段）一律 base64，保证下游可还原原始字节。
  const reEncoded = Buffer.from(text, "utf8");
  if (reEncoded.length === buf.length && reEncoded.equals(buf)) {
    return { body: text, encoding: "utf8" };
  }
  return { body: buf.toString("base64"), encoding: "base64" };
}

// 转发前剥离我们解不了的 Accept-Encoding 算法（zstd 等），强制上游只用我们能解的。
// 客户端那一侧仍然会拿到压缩字节（透传），所以不影响 client 兼容性——它本来就支持这些主流算法。
function normalizeAcceptEncoding(headers: Record<string, string | string[]>): void {
  const target = ZSTD_SYNC ? "gzip, deflate, br, zstd" : "gzip, deflate, br";
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== "accept-encoding") continue;
    headers[k] = target;
    return;
  }
  headers["Accept-Encoding"] = target;
}

// 取响应/请求 header 里的 content-encoding（大小写不敏感）。
function getContentEncoding(headers: Record<string, string | string[] | undefined>): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "content-encoding") {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}
