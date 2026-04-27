// 状态命令 —— A2.3。
// 读 proxy.pid + proxy.port + ping /_health，输出 OK / DEGRADED / DOWN 三态。
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { PATHS } from "../config";

type ProxyStatus = "OK" | "DEGRADED" | "DOWN";

interface StatusReport {
  status: ProxyStatus;
  pid: number | null;
  port: number | null;
  health: Record<string, unknown> | null;
  reason?: string;
}

function readPidPort(): { pid: number | null; port: number | null } {
  let pid: number | null = null;
  let port: number | null = null;
  if (existsSync(PATHS.pidFile)) {
    const raw = readFileSync(PATHS.pidFile, "utf8").trim();
    const n = Number(raw);
    if (!isNaN(n) && n > 0) pid = n;
  }
  if (existsSync(PATHS.portFile)) {
    const raw = readFileSync(PATHS.portFile, "utf8").trim();
    const n = Number(raw);
    if (!isNaN(n) && n > 0) port = n;
  }
  return { pid, port };
}

// 检查进程是否存活
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ping /_health 端点
function pingHealth(port: number, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      req.destroy();
      resolve(null);
    }, timeoutMs);
    const req = http.get(`http://127.0.0.1:${port}/_health`, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        clearTimeout(t);
        try {
          resolve(JSON.parse(buf));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
  });
}

async function main() {
  const { pid, port } = readPidPort();

  if (!pid && !port) {
    const report: StatusReport = { status: "DOWN", pid: null, port: null, health: null, reason: "未找到 pid/port 文件，daemon 未安装或未运行" };
    printReport(report);
    process.exit(2);
  }

  // 检查进程是否存活
  const pidAlive = pid ? isPidAlive(pid) : false;

  // ping /_health
  const health = port ? await pingHealth(port) : null;

  let status: ProxyStatus;
  let reason: string | undefined;

  if (health?.ok === true) {
    status = "OK";
  } else if (pidAlive && !health) {
    status = "DEGRADED";
    reason = `进程 ${pid} 存活，但 /_health 无响应（port=${port}）`;
  } else if (!pidAlive) {
    status = "DOWN";
    reason = pid ? `进程 ${pid} 已不存在` : "未找到 PID";
  } else {
    status = "DEGRADED";
    reason = health ? `/_health 返回 ok=false: ${JSON.stringify(health)}` : "/_health 无响应";
  }

  const report: StatusReport = { status, pid, port, health, reason };
  printReport(report);

  // 退出码：OK=0, DEGRADED=1, DOWN=2
  process.exit(status === "OK" ? 0 : status === "DEGRADED" ? 1 : 2);
}

function printReport(r: StatusReport) {
  const icon = r.status === "OK" ? "✓" : r.status === "DEGRADED" ? "⚠" : "✗";
  console.log(`${icon} 状态: ${r.status}`);
  console.log(`  PID:  ${r.pid ?? "(未知)"}`);
  console.log(`  Port: ${r.port ?? "(未知)"}`);
  if (r.health) {
    console.log(`  Health: ${JSON.stringify(r.health)}`);
  }
  if (r.reason) {
    console.log(`  原因: ${r.reason}`);
  }
}

main().catch((err) => {
  console.error("[status] 错误:", err);
  process.exit(2);
});
