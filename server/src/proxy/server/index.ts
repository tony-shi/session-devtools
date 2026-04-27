// 主代理服务。监听 127.0.0.1:PORT，接受标准 HTTP CONNECT。
// - 白名单内 (api.anthropic.com 等): 用我们的 CA 签发该 host 的叶子，TLSSocket 包裹客户端 socket → 解密 → 旁路 → 经 egress 发到上游
// - 白名单外: 透传 CONNECT 隧道（仍走 egress，所以不会绕过用户原代理）
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { writeFileSync } from "node:fs";
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
        uptime: Math.floor((Date.now() - _startTime) / 1000),
        requestCount: _requestCount,
      }));
      return;
    }
    // 极少数明文 HTTP 代理请求；MVP 阶段直接 501。
    res.writeHead(501);
    res.end("HTTP forward proxy (non-CONNECT) is not implemented");
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

    // A5.1: 每次 CONNECT 时读最新白名单（已支持热重载）
    if (getMitmWhitelist().has(host)) {
      try {
        await mitmIntercept(clientSock, head, host, httpServer);
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
      try {
        writeFileSync(PATHS.portFile, String(actualPort));
        writeFileSync(PATHS.pidFile, String(process.pid));
      } catch {}
      writeTraffic({ ts: new Date().toISOString(), kind: "event", msg: "listening", meta: { port: actualPort, pid: process.pid } });
      opts.onListening?.(actualPort);
      resolve({
        close: () =>
          new Promise<void>((r) => {
            proxy.close(() => httpServer.close(() => r()));
          }),
      });
    });
  });
}

async function mitmIntercept(clientSock: any, head: Buffer, host: string, httpServer: http.Server): Promise<void> {
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
  const port = 443;
  const sni = host;
  const startedAt = Date.now();

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

    const proxyReq = https.request(
      {
        host,
        port,
        path: req.url,
        method: req.method,
        headers: req.headers,
        createConnection: (_opts, cb) => {
          connectEgress({ host, port })
            .then((rawSock) => {
              const tlsOpts: tls.ConnectionOptions = {
                socket: rawSock,
                servername: host,
                ALPNProtocols: ["http/1.1"],
              };
              // A5.3: 有自定义 CA 时追加，不替换系统信任链
              if (extraCaPems.length > 0) {
                tlsOpts.ca = extraCaPems;
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
        const resChunks: Buffer[] = [];
        let resBytes = 0;
        const isStream = (proxyRes.headers["content-type"] ?? "").includes("event-stream");
        // B1.1: SSE 流式解析状态
        const sseState = { buf: "", index: 0 };
        proxyRes.on("data", (c: Buffer) => {
          res.write(c);
          resBytes += c.length;
          if (isStream) {
            // B1.1: 按 SSE 事件拆行落盘，每事件一条 JSONL
            parseSseChunk(c.toString("utf8"), (eventType, data, idx) => {
              writeTraffic({
                ts: new Date().toISOString(),
                kind: "sse_event",
                sni,
                url: `https://${host}${req.url}`,
                sseEventType: eventType,
                sseData: data,
                sseIndex: idx,
              });
            }, sseState);
          } else if (resBytes < 2 * 1024 * 1024) {
            resChunks.push(c);
          }
        });
        proxyRes.on("end", () => {
          res.end();
          recordUpstreamSuccess();
          writeTraffic({
            ts: new Date(startedAt).toISOString(),
            kind: "response",
            sni,
            method: req.method,
            url: `https://${host}${req.url}`,
            status: proxyRes.statusCode,
            reqHeaders,
            resHeaders,
            reqBody: safeBody(reqBody),
            // B1.1: 流式响应记录总字节数和事件数，不再是 placeholder
            resBody: isStream ? `[sse ${sseState.index} events, ${resBytes} bytes]` : safeBody(Buffer.concat(resChunks)),
            meta: { durationMs: Date.now() - startedAt, upstream: !!process.env.API_DASHBOARD_PROXY_UPSTREAM },
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
        url: `https://${host}${req.url}`,
        meta: { error: err.message, code },
      });
    });
    if (reqBody.length > 0) proxyReq.write(reqBody);
    proxyReq.end();
  });
  req.on("error", () => res.destroy());
}

function safeBody(buf: Buffer): string {
  if (buf.length === 0) return "";
  if (buf.length > 256 * 1024) return `[truncated ${buf.length} bytes]`;
  const sample = buf.subarray(0, Math.min(buf.length, 64)).toString("utf8");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0E-\x1F]/.test(sample)) return `[binary ${buf.length} bytes]`;
  return buf.toString("utf8");
}
