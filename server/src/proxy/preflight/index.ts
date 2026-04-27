// Preflight 评估器 —— 设计文档 §5.0。
// 三态结果：OK / WARN / BLOCK；任何 BLOCK 都拒绝继续安装。
// 关键不变量：preflight 不写盘、不改 env、不联网到 anthropic 以外的域。
import net from "node:net";
import { existsSync, accessSync, constants as FS } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import os from "node:os";
import { PATHS } from "../config";

export type Severity = "OK" | "WARN" | "BLOCK";

export interface CheckResult {
  id: string;
  name: string;
  severity: Severity;
  message: string;
  hint?: string;
}

interface CheckCtx {
  env: NodeJS.ProcessEnv;
  ourPort: number; // 我们计划占用的端口
}

type CheckFn = (ctx: CheckCtx) => CheckResult | Promise<CheckResult>;

const ok = (id: string, name: string, message: string): CheckResult => ({ id, name, severity: "OK", message });
const warn = (id: string, name: string, message: string, hint?: string): CheckResult => ({ id, name, severity: "WARN", message, hint });
const block = (id: string, name: string, message: string, hint?: string): CheckResult => ({ id, name, severity: "BLOCK", message, hint });

const P1_os: CheckFn = () => {
  const platform = process.platform;
  if (platform === "darwin" || platform === "linux") return ok("P1", "OS", `${platform} ${os.release()}`);
  if (platform === "win32") return ok("P1", "OS", "win32（v1 Windows 安装器待补，但代理本身可运行）");
  return block("P1", "OS", `不支持的平台: ${platform}`);
};

const P3_nodeExtraCa: CheckFn = ({ env }) => {
  const cur = env.NODE_EXTRA_CA_CERTS;
  if (!cur) return ok("P3", "NODE_EXTRA_CA_CERTS", "未设置");
  // 与 ensureCa() 写盘路径保持一致（受 API_DASHBOARD_DIR 控制）。
  if (cur === PATHS.caCert) return ok("P3", "NODE_EXTRA_CA_CERTS", "已指向我们");
  return block(
    "P3",
    "NODE_EXTRA_CA_CERTS",
    `已被占用: ${cur}`,
    `其它工具（zscaler / netskope 等）已经在用这个变量。期望值：${PATHS.caCert}。手动取消或合并 CA bundle 后重试。`,
  );
};

const P4_baseUrl: CheckFn = ({ env }) => {
  if (!env.ANTHROPIC_BASE_URL) return ok("P4", "ANTHROPIC_BASE_URL", "未设置");
  return block(
    "P4",
    "ANTHROPIC_BASE_URL",
    `已设置为 ${env.ANTHROPIC_BASE_URL}`,
    "会让 Claude Code 跳过 api.anthropic.com，绕过我们的白名单。请先 unset。",
  );
};

const P5_authToken: CheckFn = ({ env }) => {
  if (!env.ANTHROPIC_AUTH_TOKEN) return ok("P5", "ANTHROPIC_AUTH_TOKEN", "未设置");
  return warn("P5", "ANTHROPIC_AUTH_TOKEN", "已设置（绕过 OAuth）", "仍会经过我们，可继续；只是用户登录态不同。");
};

const SUPPORTED_PROXY_SCHEMES = new Set(["http:"]);
const BLOCKED_PROXY_SCHEMES = new Set(["https:", "socks:", "socks4:", "socks5:", "quic:"]);

function parseProxyUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

const P6_httpsProxyScheme: CheckFn = ({ env, ourPort }) => {
  const url = parseProxyUrl(env.HTTPS_PROXY ?? env.https_proxy);
  if (!url) return ok("P6", "HTTPS_PROXY scheme", "未设置 / 不会成为上游");
  if (url.hostname === "127.0.0.1" && Number(url.port) === ourPort) {
    return ok("P6", "HTTPS_PROXY scheme", "已经指向我们（重装路径）");
  }
  if (SUPPORTED_PROXY_SCHEMES.has(url.protocol)) {
    return ok("P6", "HTTPS_PROXY scheme", `${url.protocol}//${url.hostname}:${url.port || 80}`);
  }
  if (BLOCKED_PROXY_SCHEMES.has(url.protocol)) {
    return block(
      "P6",
      "HTTPS_PROXY scheme",
      `不支持 ${url.protocol} 上游`,
      "请改成 http:// scheme 的代理，或临时 unset 后重试。socks/quic/https 上游 v2 再支持。",
    );
  }
  return warn("P6", "HTTPS_PROXY scheme", `未识别的 scheme: ${url.protocol}`);
};

const P7_httpVsHttps: CheckFn = ({ env }) => {
  const h = env.HTTPS_PROXY ?? env.https_proxy;
  const p = env.HTTP_PROXY ?? env.http_proxy;
  if (!h && !p) return ok("P7", "HTTP/HTTPS_PROXY 一致性", "都未设置");
  if (!h && p) return warn("P7", "HTTP/HTTPS_PROXY 一致性", "仅 HTTP_PROXY 设置", "LLM 流量是 HTTPS，会被丢弃。建议同时设置 HTTPS_PROXY。");
  if (h && p && h !== p) {
    return warn(
      "P7",
      "HTTP/HTTPS_PROXY 一致性",
      `两者不同: HTTPS=${h} / HTTP=${p}`,
      "我们仅迁移 HTTPS_PROXY 作为上游；HTTP_PROXY 那一条会被丢弃。",
    );
  }
  return ok("P7", "HTTP/HTTPS_PROXY 一致性", "一致或仅 HTTPS_PROXY 设置");
};

const P8_allProxy: CheckFn = ({ env }) => {
  const url = parseProxyUrl(env.ALL_PROXY ?? env.all_proxy);
  if (!url) return ok("P8", "ALL_PROXY", "未设置");
  if (BLOCKED_PROXY_SCHEMES.has(url.protocol)) {
    return block(
      "P8",
      "ALL_PROXY",
      `不支持 ${url.protocol} 上游`,
      "ALL_PROXY 在 undici 里有特殊优先级，会绕过我们。请 unset 后重试，或换 http:// scheme。",
    );
  }
  return ok("P8", "ALL_PROXY", `${url.protocol}//${url.hostname}:${url.port || 80}`);
};

async function probeUpstreamCanReachAnthropic(env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<{ ok: boolean; reason: string }> {
  const url = parseProxyUrl(env.HTTPS_PROXY ?? env.https_proxy);
  if (!url || !SUPPORTED_PROXY_SCHEMES.has(url.protocol)) return { ok: true, reason: "无上游 / 不被纳入" };
  return new Promise((resolve) => {
    const sock = net.connect({ host: url.hostname, port: Number(url.port || 80) });
    const t = setTimeout(() => {
      sock.destroy();
      resolve({ ok: false, reason: `上游 ${url.hostname}:${url.port} 建链超时` });
    }, timeoutMs);
    sock.once("error", (e) => {
      clearTimeout(t);
      resolve({ ok: false, reason: `上游连接失败: ${e.message}` });
    });
    sock.once("connect", () => {
      const auth = url.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}\r\n`
        : "";
      sock.write(
        `CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n${auth}\r\n`,
      );
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("binary");
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        clearTimeout(t);
        const status = buf.match(/^HTTP\/\d\.\d\s+(\d{3})/)?.[1];
        sock.destroy();
        resolve(
          status === "200"
            ? { ok: true, reason: "上游 CONNECT 200" }
            : { ok: false, reason: `上游 CONNECT 非 200: ${status ?? "unknown"}` },
        );
      });
    });
  });
}

const P9_upstreamReach: CheckFn = async ({ env }) => {
  const r = await probeUpstreamCanReachAnthropic(env);
  return r.ok ? ok("P9", "上游可达性", r.reason) : block("P9", "上游可达性", r.reason, "请先修复你原本的代理（试 `curl -x $HTTPS_PROXY https://api.anthropic.com/`）。");
};

const P11_portFree: CheckFn = ({ ourPort }) => {
  return new Promise<CheckResult>((resolve) => {
    const s: any = net.createServer();
    s.once("error", () => resolve(block("P11", "端口可用性", `127.0.0.1:${ourPort} 已占用`, "改用 API_DASHBOARD_PROXY_PORT=<其它端口>")));
    s.listen(ourPort, "127.0.0.1", () => {
      s.close(() => resolve(ok("P11", "端口可用性", `127.0.0.1:${ourPort} 可绑定`)));
    });
  });
};

const P12_fsPerms: CheckFn = () => {
  const settings = join(homedir(), ".claude", "settings.json");
  // 我们要写的两个目录：proxy/ 与 backups/。如果父目录已存在但不可写，立刻 BLOCK。
  // 不存在则探测其最近的父目录是否可创建。
  for (const dir of [PATHS.home, PATHS.backups]) {
    try {
      if (existsSync(dir)) {
        accessSync(dir, FS.W_OK);
      } else {
        // 走父目录的可写性
        accessSync(nearestExistingParent(dir), FS.W_OK);
      }
    } catch {
      return block("P12", "文件权限", `${dir} 不可写`);
    }
  }
  try {
    if (existsSync(settings)) accessSync(settings, FS.W_OK);
    else accessSync(join(homedir(), ".claude"), FS.W_OK);
  } catch {
    return block("P12", "文件权限", `${settings} 不可写`);
  }
  return ok("P12", "文件权限", "proxy/ + backups/ + settings.json 均可写");
};

function nearestExistingParent(p: string): string {
  let cur = p;
  while (cur !== "/" && cur.length > 0) {
    cur = dirname(cur);
    if (existsSync(cur)) return cur;
  }
  return "/";
}

const P13_reinstallLoop: CheckFn = ({ env, ourPort }) => {
  const url = parseProxyUrl(env.HTTPS_PROXY ?? env.https_proxy);
  if (url && url.hostname === "127.0.0.1" && Number(url.port) === ourPort) {
    return warn("P13", "重装回环防御", "当前 HTTPS_PROXY 指向我们自己；迁移时会跳过避免死循环");
  }
  return ok("P13", "重装回环防御", "无回环");
};

const P14_managed: CheckFn = () => {
  const paths =
    process.platform === "darwin"
      ? ["/Library/Application Support/ClaudeCode/managed-settings.json"]
      : process.platform === "linux"
        ? ["/etc/claude-code/managed-settings.json"]
        : ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
  for (const p of paths) {
    if (existsSync(p)) {
      return warn("P14", "managed-settings", `检测到企业 managed: ${p}`, "如里面已钉死了 HTTPS_PROXY/NODE_EXTRA_CA_CERTS 不同值，安装会失败。请先咨询 IT。");
    }
  }
  return ok("P14", "managed-settings", "无企业 managed 配置");
};

export const ALL_CHECKS: CheckFn[] = [
  P1_os,
  P3_nodeExtraCa,
  P4_baseUrl,
  P5_authToken,
  P6_httpsProxyScheme,
  P7_httpVsHttps,
  P8_allProxy,
  P9_upstreamReach,
  P11_portFree,
  P12_fsPerms,
  P13_reinstallLoop,
  P14_managed,
];

export interface PreflightReport {
  results: CheckResult[];
  blocked: boolean;
}

export async function runPreflight(opts: { env?: NodeJS.ProcessEnv; ourPort: number }): Promise<PreflightReport> {
  const ctx: CheckCtx = { env: opts.env ?? process.env, ourPort: opts.ourPort };
  const results: CheckResult[] = [];
  for (const fn of ALL_CHECKS) {
    try {
      results.push(await fn(ctx));
    } catch (err) {
      results.push({
        id: "??",
        name: fn.name,
        severity: "BLOCK",
        message: `检查自身崩溃: ${(err as Error).message}`,
      });
    }
  }
  return { results, blocked: results.some((r) => r.severity === "BLOCK") };
}
