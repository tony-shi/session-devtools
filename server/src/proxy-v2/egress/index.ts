// Egress 抽象 —— 设计文档 §3.2.1。
// 单一 connect(host, port) 入口；如有 API_DASHBOARD_PROXY_UPSTREAM 则建 CONNECT 隧道，否则直连。
// 上游不可达 / 5xx / 407 → 502 直接抛错，不降级直连（避免悄悄绕过用户合规链路）。
import net from "node:net";
import type { UpstreamProxy } from "../config";
import { loadUpstream } from "../config";

export type EgressSocket = net.Socket;

export class UpstreamProxyError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly via: "upstream" | "direct",
    message: string,
  ) {
    super(message);
    this.name = "UpstreamProxyError";
  }
}

export interface EgressOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  upstreamOverride?: UpstreamProxy | null; // 测试用
}

const DEFAULT_TIMEOUT = 10_000;

export function connectEgress(opts: EgressOptions): Promise<EgressSocket> {
  const upstream = opts.upstreamOverride !== undefined ? opts.upstreamOverride : loadUpstream();
  return upstream
    ? connectViaUpstream(opts.host, opts.port, upstream, opts.timeoutMs ?? DEFAULT_TIMEOUT)
    : connectDirect(opts.host, opts.port, opts.timeoutMs ?? DEFAULT_TIMEOUT);
}

function connectDirect(host: string, port: number, timeoutMs: number): Promise<EgressSocket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new UpstreamProxyError(504, "direct", `直连 ${host}:${port} 超时`));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(t);
      resolve(sock);
    });
    sock.once("error", (err) => {
      clearTimeout(t);
      reject(new UpstreamProxyError(502, "direct", `直连 ${host}:${port} 失败: ${err.message}`));
    });
  });
}

function connectViaUpstream(
  host: string,
  port: number,
  upstream: UpstreamProxy,
  timeoutMs: number,
): Promise<EgressSocket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: upstream.host, port: upstream.port });
    let settled = false;
    const fail = (code: number, msg: string) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new UpstreamProxyError(code, "upstream", msg));
    };

    const t = setTimeout(() => fail(504, `上游 ${upstream.host}:${upstream.port} 建链超时`), timeoutMs);
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("binary");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) {
        if (buf.length > 16 * 1024) fail(502, "上游 CONNECT 响应过长");
        return;
      }
      // 分离 header 与多余的 body（HTTP CONNECT 之后的字节是隧道里的目标 TLS handshake 起始字节）。
      const header = buf.slice(0, idx);
      const tail = Buffer.from(buf.slice(idx + 4), "binary");
      sock.removeListener("data", onData);
      const firstLine = header.split("\r\n")[0] ?? "";
      const m = firstLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
      if (!m) {
        fail(502, `上游 CONNECT 响应非法: ${firstLine}`);
        return;
      }
      const status = Number(m[1]);
      if (status !== 200) {
        fail(status === 407 ? 407 : 502, `上游 CONNECT 拒绝: ${firstLine}`);
        return;
      }
      clearTimeout(t);
      settled = true;
      // 把"已读但属于隧道里目标流"的字节回灌到 socket，让消费方能像直连一样读取。
      if (tail.length > 0) sock.unshift(tail);
      resolve(sock);
    };
    sock.once("connect", () => {
      const lines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Proxy-Connection: keep-alive",
        "User-Agent: session-dashboard-proxy/0.1",
      ];
      if (upstream.auth) lines.push(`Proxy-Authorization: ${upstream.auth}`);
      lines.push("", "");
      sock.write(lines.join("\r\n"));
      sock.on("data", onData);
    });
    sock.once("error", (err) => fail(502, `上游 ${upstream.host}:${upstream.port} 连接失败: ${err.message}`));
  });
}
