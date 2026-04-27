// Daemon 平台包装工具 —— A2.1 / A2.2 / A2.4。
// 提供 installDaemon / uninstallDaemon 供 install.ts / uninstall.ts 调用。
// 不作为独立 CLI；由 install/uninstall 在写 settings 后调用。
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { PATHS } from "../config";

// proxy:build 产物路径（相对于本文件的 dist/）
function getDistPath(): string {
  return join(import.meta.dir, "../dist/start.mjs");
}

// ── macOS LaunchAgent ─────────────────────────────────────────────────────────

const LAUNCH_AGENT_LABEL = "com.session-dashboard.proxy";
export const LAUNCH_AGENT_PLIST = join(
  homedir(),
  "Library/LaunchAgents",
  `${LAUNCH_AGENT_LABEL}.plist`,
);

function buildPlist(port: number): string {
  const nodePath = getNodePath();
  const distPath = getDistPath();
  const logDir = PATHS.home;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${distPath}</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <!-- A2.4: 自启失败超过 3 次停止尝试（ThrottleInterval 防崩溃循环） -->
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${logDir}/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/daemon.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>API_DASHBOARD_DIR</key>
    <string>${PATHS.projectHome}</string>
  </dict>
</dict>
</plist>`;
}

function getNodePath(): string {
  try {
    return execSync("which node", { encoding: "utf8" }).trim();
  } catch {
    return "/usr/local/bin/node";
  }
}

export function installLaunchAgent(port: number): void {
  const plistDir = dirname(LAUNCH_AGENT_PLIST);
  mkdirSync(plistDir, { recursive: true });
  writeFileSync(LAUNCH_AGENT_PLIST, buildPlist(port));
  try {
    // 先 unload 避免重装冲突
    execSync(`launchctl unload "${LAUNCH_AGENT_PLIST}" 2>/dev/null`, { stdio: "pipe" });
  } catch {}
  execSync(`launchctl load "${LAUNCH_AGENT_PLIST}"`, { stdio: "inherit" });
  console.log(`[daemon] LaunchAgent 已安装并加载: ${LAUNCH_AGENT_PLIST}`);
}

export function uninstallLaunchAgent(): void {
  if (!existsSync(LAUNCH_AGENT_PLIST)) return;
  try {
    execSync(`launchctl unload "${LAUNCH_AGENT_PLIST}" 2>/dev/null`, { stdio: "pipe" });
  } catch {}
  rmSync(LAUNCH_AGENT_PLIST, { force: true });
  console.log(`[daemon] LaunchAgent 已卸载: ${LAUNCH_AGENT_PLIST}`);
}

// ── Linux systemd user unit ───────────────────────────────────────────────────

export const SYSTEMD_UNIT_PATH = join(
  homedir(),
  ".config/systemd/user/session-dashboard-proxy.service",
);

function buildSystemdUnit(port: number): string {
  const nodePath = getNodePath();
  const distPath = getDistPath();
  return `[Unit]
Description=Session Dashboard MITM Proxy
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${distPath} --port ${port}
Restart=on-failure
# A2.4: 3 次失败后停止重试
StartLimitIntervalSec=60
StartLimitBurst=3
Environment=API_DASHBOARD_DIR=${PATHS.projectHome}
StandardOutput=append:${PATHS.home}/daemon.log
StandardError=append:${PATHS.home}/daemon.err

[Install]
WantedBy=default.target
`;
}

export function installSystemdUnit(port: number): void {
  const unitDir = dirname(SYSTEMD_UNIT_PATH);
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(SYSTEMD_UNIT_PATH, buildSystemdUnit(port));
  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync("systemctl --user enable --now session-dashboard-proxy.service", { stdio: "inherit" });
    console.log(`[daemon] systemd unit 已安装并启动: ${SYSTEMD_UNIT_PATH}`);
  } catch (err: any) {
    console.warn(`[daemon] systemd 启动失败: ${err.message}`);
  }
}

export function uninstallSystemdUnit(): void {
  if (!existsSync(SYSTEMD_UNIT_PATH)) return;
  try {
    execSync("systemctl --user stop session-dashboard-proxy.service 2>/dev/null", { stdio: "pipe" });
    execSync("systemctl --user disable session-dashboard-proxy.service 2>/dev/null", { stdio: "pipe" });
  } catch {}
  rmSync(SYSTEMD_UNIT_PATH, { force: true });
  try {
    execSync("systemctl --user daemon-reload 2>/dev/null", { stdio: "pipe" });
  } catch {}
  console.log(`[daemon] systemd unit 已卸载: ${SYSTEMD_UNIT_PATH}`);
}

// ── 平台分发 ─────────────────────────────────────────────────────────────────

export function installDaemon(port: number): void {
  if (process.platform === "darwin") installLaunchAgent(port);
  else if (process.platform === "linux") installSystemdUnit(port);
  else console.log("[daemon] Windows 平台暂不支持自动 daemon，请手动运行 node start.mjs");
}

export function uninstallDaemon(): void {
  if (process.platform === "darwin") uninstallLaunchAgent();
  else if (process.platform === "linux") uninstallSystemdUnit();
}
