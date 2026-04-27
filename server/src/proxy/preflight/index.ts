// Preflight 评估器 —— 设计文档 §5.0。
// 三态结果：OK / WARN / BLOCK；任何 BLOCK 都拒绝继续安装。
// 关键不变量：preflight 不写盘、不改 env、不联网到 anthropic 以外的域。
//
// 配置层级（高 → 低，Claude Code 实际生效优先级）：
//   managed   managed-settings.json（企业锁死，最高，安装器无法覆盖）
//   settings  ~/.claude/settings.json env 块（用户级，安装器写入目标）
//   shell     当前 shell 继承的 process.env（低于 settings，CC 启动后被覆盖）
//
// 每个检查从对应层读取，message 里标注来源，避免层级混淆。
import net from "node:net";
import { existsSync, accessSync, readFileSync, constants as FS } from "node:fs";
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
  // 该结果来自哪一层配置
  source?: "managed" | "settings" | "shell" | "system";
}

// 三层配置上下文
export interface EnvLayers {
  // 企业 managed-settings.json 的 env 块（最高优先级，安装器不可覆盖）
  managed: Record<string, string>;
  // ~/.claude/settings.json 的 env 块（安装器的写入目标）
  settings: Record<string, string>;
  // 当前 shell process.env（Claude Code 启动后会被 settings 覆盖）
  shell: NodeJS.ProcessEnv;
}

interface CheckCtx {
  layers: EnvLayers;
  ourPort: number;
}

type CheckFn = (ctx: CheckCtx) => CheckResult | Promise<CheckResult>;

const ok    = (id: string, name: string, message: string, source?: CheckResult["source"]): CheckResult => ({ id, name, severity: "OK",    message, source });
const warn  = (id: string, name: string, message: string, hint?: string, source?: CheckResult["source"]): CheckResult => ({ id, name, severity: "WARN",  message, hint, source });
const block = (id: string, name: string, message: string, hint?: string, source?: CheckResult["source"]): CheckResult => ({ id, name, severity: "BLOCK", message, hint, source });

// 按优先级取某个 key：managed > settings > shell
function effectiveVal(layers: EnvLayers, key: string): { value: string | undefined; source: CheckResult["source"] } {
  const lk = key.toLowerCase();
  if (layers.managed[key] !== undefined)    return { value: layers.managed[key],  source: "managed"  };
  if (layers.managed[lk] !== undefined)     return { value: layers.managed[lk],   source: "managed"  };
  if (layers.settings[key] !== undefined)   return { value: layers.settings[key], source: "settings" };
  if (layers.settings[lk] !== undefined)    return { value: layers.settings[lk],  source: "settings" };
  if (layers.shell[key] !== undefined)      return { value: layers.shell[key],     source: "shell"    };
  if (layers.shell[lk] !== undefined)       return { value: layers.shell[lk],      source: "shell"    };
  return { value: undefined, source: undefined };
}

// ── P1 OS ─────────────────────────────────────────────────────────────────────

const P1_os: CheckFn = () => {
  const platform = process.platform;
  if (platform === "darwin" || platform === "linux") return ok("P1", "OS", `${platform} ${os.release()}`, "system");
  if (platform === "win32") return ok("P1", "OS", "win32（v1 Windows 安装器待补，但代理本身可运行）", "system");
  return block("P1", "OS", `不支持的平台: ${platform}`, undefined, "system");
};

// ── P3 NODE_EXTRA_CA_CERTS ────────────────────────────────────────────────────
// 只看 managed 和 shell 层——settings 层是我们自己写的，不需要检查冲突。

const P3_nodeExtraCa: CheckFn = ({ layers }) => {
  // managed 层钉死了别的值 → BLOCK（安装器无法覆盖）
  const managedVal = layers.managed.NODE_EXTRA_CA_CERTS;
  if (managedVal && managedVal !== PATHS.caCert) {
    return block("P3", "NODE_EXTRA_CA_CERTS",
      `managed 层已锁定为: ${managedVal}`,
      `企业 managed-settings.json 钉死了此变量，安装器无法覆盖。请联系 IT 放行或排除。`,
      "managed");
  }

  // shell 层有其它工具占用（如 zscaler / netskope）
  const shellVal = layers.shell.NODE_EXTRA_CA_CERTS ?? layers.shell.node_extra_ca_certs;
  if (shellVal && shellVal !== PATHS.caCert) {
    return block("P3", "NODE_EXTRA_CA_CERTS",
      `shell 层已被占用: ${shellVal}`,
      `其它工具（zscaler / netskope 等）在 shell 里设置了此变量。安装后 settings 层会覆盖它，但重启终端后可能冲突。建议先 unset 或合并 CA bundle。`,
      "shell");
  }

  // settings 层已是我们的值（重装路径）
  const settingsVal = layers.settings.NODE_EXTRA_CA_CERTS;
  if (settingsVal === PATHS.caCert) return ok("P3", "NODE_EXTRA_CA_CERTS", `settings 层已指向我们（重装路径）`, "settings");

  return ok("P3", "NODE_EXTRA_CA_CERTS", "未被占用，安装器将写入 settings 层");
};

// ── P4 ANTHROPIC_BASE_URL ─────────────────────────────────────────────────────
// A5.1: 任意层有值都并入白名单，不再 BLOCK。

const P4_baseUrl: CheckFn = ({ layers }) => {
  const { value, source } = effectiveVal(layers, "ANTHROPIC_BASE_URL");
  if (!value) return ok("P4", "ANTHROPIC_BASE_URL", "未设置");
  try {
    const hostname = new URL(value).hostname;
    return ok("P4", "ANTHROPIC_BASE_URL",
      `${source} 层: ${value}，将一并 MITM ${hostname}`,
      source);
  } catch {
    return warn("P4", "ANTHROPIC_BASE_URL",
      `${source} 层已设置但无法解析: ${value}`,
      "格式应为 https://hostname[:port]，自定义 host 无法自动并入白名单。",
      source);
  }
};

// ── P5 ANTHROPIC_AUTH_TOKEN ───────────────────────────────────────────────────

const P5_authToken: CheckFn = ({ layers }) => {
  const { value, source } = effectiveVal(layers, "ANTHROPIC_AUTH_TOKEN");
  if (!value) return ok("P5", "ANTHROPIC_AUTH_TOKEN", "未设置");
  return warn("P5", "ANTHROPIC_AUTH_TOKEN",
    `${source} 层已设置（绕过 OAuth）`,
    "仍会经过我们，可继续；只是用户登录态不同。",
    source);
};

// ── P6 HTTPS_PROXY scheme ─────────────────────────────────────────────────────
// 关键：分层显示，明确"生效的是哪一层"。

const SUPPORTED_PROXY_SCHEMES = new Set(["http:"]);
const BLOCKED_PROXY_SCHEMES   = new Set(["https:", "socks:", "socks4:", "socks5:", "quic:"]);

function parseProxyUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try { return new URL(raw); } catch { return null; }
}

const P6_httpsProxyScheme: CheckFn = ({ layers, ourPort }) => {
  // managed 层最高优先，如果钉死了不支持的 scheme → BLOCK
  const managedProxy = layers.managed.HTTPS_PROXY ?? layers.managed.https_proxy;
  if (managedProxy) {
    const url = parseProxyUrl(managedProxy);
    if (!url) return warn("P6", "HTTPS_PROXY scheme", `managed 层设置了无法解析的值: ${managedProxy}`, undefined, "managed");
    if (url.hostname === "127.0.0.1" && Number(url.port) === ourPort)
      return ok("P6", "HTTPS_PROXY scheme", "managed 层已指向我们（重装路径）", "managed");
    if (BLOCKED_PROXY_SCHEMES.has(url.protocol))
      return block("P6", "HTTPS_PROXY scheme",
        `managed 层锁定了不支持的 scheme: ${url.protocol} (${managedProxy})`,
        "企业 managed-settings.json 钉死了此代理，安装器无法覆盖。请联系 IT 改为 http:// scheme。",
        "managed");
    if (SUPPORTED_PROXY_SCHEMES.has(url.protocol))
      return ok("P6", "HTTPS_PROXY scheme", `managed 层: ${url.protocol}//${url.hostname}:${url.port || 80}（将被迁移为上游）`, "managed");
  }

  // settings 层（安装器已写入的状态）
  const settingsProxy = layers.settings.HTTPS_PROXY ?? layers.settings.https_proxy;
  if (settingsProxy) {
    const url = parseProxyUrl(settingsProxy);
    if (url?.hostname === "127.0.0.1" && Number(url.port) === ourPort)
      return ok("P6", "HTTPS_PROXY scheme", "settings 层已指向我们（重装路径）", "settings");
    if (url && BLOCKED_PROXY_SCHEMES.has(url.protocol))
      return block("P6", "HTTPS_PROXY scheme",
        `settings 层有不支持的 scheme: ${url.protocol} (${settingsProxy})`,
        "请手动修改 ~/.claude/settings.json 改为 http:// scheme，或删除该 key 后重装。",
        "settings");
    if (url && SUPPORTED_PROXY_SCHEMES.has(url.protocol))
      return ok("P6", "HTTPS_PROXY scheme", `settings 层: ${url.protocol}//${url.hostname}:${url.port || 80}`, "settings");
  }

  // shell 层（安装后会被 settings 层覆盖，但现在要检查是否可迁移）
  const shellProxy = layers.shell.HTTPS_PROXY ?? layers.shell.https_proxy;
  if (shellProxy) {
    const url = parseProxyUrl(shellProxy);
    if (!url) return warn("P6", "HTTPS_PROXY scheme", `shell 层设置了无法解析的值: ${shellProxy}`, undefined, "shell");
    if (url.hostname === "127.0.0.1" && Number(url.port) === ourPort)
      return ok("P6", "HTTPS_PROXY scheme", "shell 层已指向我们（重装路径）", "shell");
    if (BLOCKED_PROXY_SCHEMES.has(url.protocol))
      return block("P6", "HTTPS_PROXY scheme",
        `shell 层有不支持的 scheme: ${url.protocol} (${shellProxy})`,
        "请改成 http:// scheme 的代理，或临时 unset 后重试。socks/quic/https 上游 v2 再支持。",
        "shell");
    if (SUPPORTED_PROXY_SCHEMES.has(url.protocol))
      return ok("P6", "HTTPS_PROXY scheme", `shell 层: ${url.protocol}//${url.hostname}:${url.port || 80}（将被迁移为上游）`, "shell");
    return warn("P6", "HTTPS_PROXY scheme", `shell 层未识别的 scheme: ${url.protocol}`, undefined, "shell");
  }

  return ok("P6", "HTTPS_PROXY scheme", "各层均未设置，安装后直连");
};

// ── P7 HTTP/HTTPS_PROXY 一致性 ────────────────────────────────────────────────
// 只看生效层（managed > settings > shell），避免跨层比较产生误报。

const P7_httpVsHttps: CheckFn = ({ layers }) => {
  const { value: h, source: hs } = effectiveVal(layers, "HTTPS_PROXY");
  const { value: p, source: ps } = effectiveVal(layers, "HTTP_PROXY");
  if (!h && !p) return ok("P7", "HTTP/HTTPS_PROXY 一致性", "各层均未设置");
  if (!h && p)  return warn("P7", "HTTP/HTTPS_PROXY 一致性",
    `仅 HTTP_PROXY 设置（${ps} 层: ${p}）`,
    "LLM 流量是 HTTPS，会被丢弃。建议同时设置 HTTPS_PROXY。", ps);
  if (h && p && h !== p) return warn("P7", "HTTP/HTTPS_PROXY 一致性",
    `两者不同 — HTTPS(${hs}): ${h} / HTTP(${ps}): ${p}`,
    "我们仅迁移 HTTPS_PROXY 作为上游；HTTP_PROXY 那一条会被丢弃。", hs);
  return ok("P7", "HTTP/HTTPS_PROXY 一致性", `一致（${hs} 层: ${h}）`, hs);
};

// ── P8 ALL_PROXY ──────────────────────────────────────────────────────────────

const P8_allProxy: CheckFn = ({ layers }) => {
  const { value, source } = effectiveVal(layers, "ALL_PROXY");
  const url = parseProxyUrl(value);
  if (!url) return ok("P8", "ALL_PROXY", "各层均未设置");
  if (BLOCKED_PROXY_SCHEMES.has(url.protocol))
    return block("P8", "ALL_PROXY",
      `${source} 层有不支持的 scheme: ${url.protocol} (${value})`,
      "ALL_PROXY 在 undici 里有特殊优先级，会绕过我们。请 unset 后重试，或换 http:// scheme。",
      source);
  return ok("P8", "ALL_PROXY", `${source} 层: ${url.protocol}//${url.hostname}:${url.port || 80}`, source);
};

// ── P9 上游可达性 ─────────────────────────────────────────────────────────────
// 用生效的 HTTPS_PROXY 探测，来源标注在 message 里。

async function probeUpstreamCanReachAnthropic(
  proxyUrl: string | undefined,
  timeoutMs = 5000,
): Promise<{ ok: boolean; reason: string }> {
  const url = parseProxyUrl(proxyUrl);
  if (!url || !SUPPORTED_PROXY_SCHEMES.has(url.protocol)) return { ok: true, reason: "无上游 / 不被纳入" };
  return new Promise((resolve) => {
    const sock = net.connect({ host: url.hostname, port: Number(url.port || 80) });
    const t = setTimeout(() => {
      sock.destroy();
      resolve({ ok: false, reason: `上游 ${url.hostname}:${url.port} 建链超时` });
    }, timeoutMs);
    sock.once("error", (e) => { clearTimeout(t); resolve({ ok: false, reason: `上游连接失败: ${e.message}` }); });
    sock.once("connect", () => {
      const auth = url.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}\r\n`
        : "";
      sock.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n${auth}\r\n`);
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("binary");
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        clearTimeout(t);
        const status = buf.match(/^HTTP\/\d\.\d\s+(\d{3})/)?.[1];
        sock.destroy();
        resolve(status === "200"
          ? { ok: true,  reason: "上游 CONNECT 200" }
          : { ok: false, reason: `上游 CONNECT 非 200: ${status ?? "unknown"}` });
      });
    });
  });
}

const P9_upstreamReach: CheckFn = async ({ layers }) => {
  const { value, source } = effectiveVal(layers, "HTTPS_PROXY");
  const r = await probeUpstreamCanReachAnthropic(value);
  if (r.ok) return ok("P9", "上游可达性", source ? `${r.reason}（来自 ${source} 层）` : r.reason, source);
  return block("P9", "上游可达性", r.reason,
    "请先修复你原本的代理（试 `curl -x $HTTPS_PROXY https://api.anthropic.com/`）。", source);
};

// ── P11 端口可用性 ────────────────────────────────────────────────────────────

const P11_portFree: CheckFn = ({ ourPort }) => {
  return new Promise<CheckResult>((resolve) => {
    const s: any = net.createServer();
    s.once("error", () => resolve(block("P11", "端口可用性", `127.0.0.1:${ourPort} 已占用`, "改用 API_DASHBOARD_PROXY_PORT=<其它端口>", "system")));
    s.listen(ourPort, "127.0.0.1", () => {
      s.close(() => resolve(ok("P11", "端口可用性", `127.0.0.1:${ourPort} 可绑定`, "system")));
    });
  });
};

// ── P12 文件权限 ──────────────────────────────────────────────────────────────

const P12_fsPerms: CheckFn = () => {
  const settings = join(homedir(), ".claude", "settings.json");
  for (const dir of [PATHS.home, PATHS.backups]) {
    try {
      if (existsSync(dir)) accessSync(dir, FS.W_OK);
      else accessSync(nearestExistingParent(dir), FS.W_OK);
    } catch {
      return block("P12", "文件权限", `${dir} 不可写`, undefined, "system");
    }
  }
  try {
    if (existsSync(settings)) accessSync(settings, FS.W_OK);
    else accessSync(join(homedir(), ".claude"), FS.W_OK);
  } catch {
    return block("P12", "文件权限", `${settings} 不可写`, undefined, "system");
  }
  return ok("P12", "文件权限", "proxy/ + backups/ + settings.json 均可写", "system");
};

function nearestExistingParent(p: string): string {
  let cur = p;
  while (cur !== "/" && cur.length > 0) {
    cur = dirname(cur);
    if (existsSync(cur)) return cur;
  }
  return "/";
}

// ── P13 重装回环防御 ──────────────────────────────────────────────────────────
// 只看 settings 层——那是安装器上次写的，shell 层指向我们属于用户自己设的，不算回环。

const P13_reinstallLoop: CheckFn = ({ layers, ourPort }) => {
  const settingsProxy = layers.settings.HTTPS_PROXY ?? layers.settings.https_proxy;
  const url = parseProxyUrl(settingsProxy);
  if (url && url.hostname === "127.0.0.1" && Number(url.port) === ourPort) {
    return warn("P13", "重装回环防御",
      "settings 层 HTTPS_PROXY 已指向我们自己；迁移时会跳过避免死循环",
      undefined, "settings");
  }
  return ok("P13", "重装回环防御", "无回环", "settings");
};

// ── P14 managed-settings 冲突检测 ────────────────────────────────────────────
// 升级：不仅检测文件是否存在，还检测是否锁死了我们要写的 key。

const OUR_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "API_DASHBOARD_PROXY_UPSTREAM"];

const P14_managed: CheckFn = ({ layers }) => {
  const managedPaths =
    process.platform === "darwin"
      ? ["/Library/Application Support/ClaudeCode/managed-settings.json"]
      : process.platform === "linux"
        ? ["/etc/claude-code/managed-settings.json"]
        : ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];

  const foundPath = managedPaths.find(existsSync);
  if (!foundPath) return ok("P14", "managed-settings", "无企业 managed 配置", "system");

  // 检查是否有我们关心的 key 被锁定
  const lockedKeys = OUR_KEYS.filter((k) => layers.managed[k] !== undefined);
  if (lockedKeys.length > 0) {
    const detail = lockedKeys.map((k) => `${k}=${layers.managed[k]}`).join(", ");
    return block("P14", "managed-settings",
      `企业 managed 锁定了冲突 key: ${detail}`,
      `${foundPath} 中钉死了这些变量，安装器无法覆盖。请联系 IT 放行，或在 managed 里直接配置代理。`,
      "managed");
  }

  return warn("P14", "managed-settings",
    `检测到企业 managed: ${foundPath}（未锁定我们的 key，可继续）`,
    "如后续安装失败，请检查 managed-settings.json 是否有其它约束。",
    "managed");
};

// ── 导出 ──────────────────────────────────────────────────────────────────────

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

// 读取 managed-settings.json 的 env 块
function readManagedEnv(): Record<string, string> {
  const paths =
    process.platform === "darwin"
      ? ["/Library/Application Support/ClaudeCode/managed-settings.json"]
      : process.platform === "linux"
        ? ["/etc/claude-code/managed-settings.json"]
        : ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const s = JSON.parse(readFileSync(p, "utf8"));
      return (s?.env && typeof s.env === "object") ? s.env : {};
    } catch {}
  }
  return {};
}

// 读取 ~/.claude/settings.json 的 env 块
function readSettingsEnv(): Record<string, string> {
  const p = join(homedir(), ".claude", "settings.json");
  if (!existsSync(p)) return {};
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return (s?.env && typeof s.env === "object") ? s.env : {};
  } catch { return {}; }
}

export async function runPreflight(opts: {
  // 外部可传入覆盖（测试用）；不传则自动读取三层
  layers?: Partial<EnvLayers>;
  ourPort: number;
  // 兼容旧调用：单层 env（合并进 shell 层）
  env?: NodeJS.ProcessEnv;
}): Promise<PreflightReport> {
  const layers: EnvLayers = {
    managed:  opts.layers?.managed  ?? readManagedEnv(),
    settings: opts.layers?.settings ?? readSettingsEnv(),
    shell:    opts.layers?.shell    ?? opts.env ?? process.env,
  };
  const ctx: CheckCtx = { layers, ourPort: opts.ourPort };
  const results: CheckResult[] = [];
  for (const fn of ALL_CHECKS) {
    try {
      results.push(await fn(ctx));
    } catch (err) {
      results.push({ id: "??", name: fn.name, severity: "BLOCK", message: `检查自身崩溃: ${(err as Error).message}` });
    }
  }
  return { results, blocked: results.some((r) => r.severity === "BLOCK") };
}
