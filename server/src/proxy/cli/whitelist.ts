// 白名单诊断命令 —— A5.8。
// 打印当前生效的 MITM 白名单及每个 host 的来源（base / settings / file）。
import { existsSync, readFileSync } from "node:fs";
import { PATHS } from "../config";

function main() {
  const hosts: Array<{ host: string; source: string }> = [];

  // 内置
  hosts.push({ host: "api.anthropic.com", source: "内置（base）" });

  // L0: settings.json 的 ANTHROPIC_BASE_URL
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    try {
      const hostname = new URL(baseUrl).hostname;
      if (hostname && hostname !== "api.anthropic.com") {
        hosts.push({ host: hostname, source: `L0 settings.json ANTHROPIC_BASE_URL=${baseUrl}` });
      }
    } catch {
      console.warn(`  ⚠ ANTHROPIC_BASE_URL 格式非法: ${baseUrl}`);
    }
  }

  // L1: mitm-hosts.json
  if (existsSync(PATHS.mitmHostsFile)) {
    try {
      const raw = JSON.parse(readFileSync(PATHS.mitmHostsFile, "utf8"));
      if (Array.isArray(raw.hosts)) {
        for (const h of raw.hosts) {
          if (typeof h === "string" && h.trim()) {
            hosts.push({ host: h.trim(), source: `L1 ${PATHS.mitmHostsFile}` });
          }
        }
      }
    } catch (err: any) {
      console.warn(`  ⚠ mitm-hosts.json 读取失败: ${err.message}`);
    }
  } else {
    console.log(`  （L1 文件不存在: ${PATHS.mitmHostsFile}）`);
  }

  // L2: target-ca/ 目录（不影响白名单，但列出以便排查）
  const targetCaDir = PATHS.targetCaDir;
  const caPems: string[] = [];
  if (existsSync(targetCaDir)) {
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      for (const name of readdirSync(targetCaDir)) {
        if (name.endsWith(".pem")) caPems.push(name);
      }
    } catch {}
  }

  console.log("\n当前生效的 MITM 白名单：");
  console.log("─".repeat(60));
  for (const { host, source } of hosts) {
    console.log(`  ✓ ${host.padEnd(35)} 来源: ${source}`);
  }
  console.log("─".repeat(60));
  console.log(`共 ${hosts.length} 个 host\n`);

  if (caPems.length > 0) {
    console.log(`上游自签 CA（L2, ${targetCaDir}）：`);
    for (const name of caPems) console.log(`  • ${name}`);
    console.log();
  } else {
    console.log(`上游自签 CA：未配置（${targetCaDir} 为空或不存在）\n`);
  }

  console.log("排查提示：");
  console.log("  • L0: 在 ~/.claude/settings.json 的 env.ANTHROPIC_BASE_URL 设置自定义 base URL");
  console.log(`  • L1: 编辑 ${PATHS.mitmHostsFile}，格式: { "hosts": ["your-host.example.com"] }`);
  console.log(`  • L2: 将上游自签 CA PEM 放入 ${PATHS.targetCaDir}/<host>.pem`);
}

main();
