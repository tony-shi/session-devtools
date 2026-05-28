// 监听 story + pace 文件,自动重跑 synth —— 让作者"保存即试听"。
//
// 用法:
//   npx tsx scripts/voice/watch.ts agent-loop              # 只 watch + synth 一集
//   npx tsx scripts/voice/watch.ts agent-loop --provider mock --langs zh,en
//
// 监听范围:
//   - client/src/v2/walkthrough/stories/<storyId>.ts   ← 文案 + pauseAfter
//   - client/src/v2/walkthrough/pace.ts                ← PACE 默认值
//   - client/src/v2/walkthrough/i18n.ts                ← lang fallback 逻辑
//
// 防抖 + 排队:连续保存(IDE 多次 fs event)合并成一次 synth;synth 跑的过程中再发
// 保存,记录一个"还有新变更",跑完接着再跑一次,避免漏掉最新文案。

import { spawn } from "node:child_process";
import { watch } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

interface Cli {
  storyId: string;
  provider: string;
  langs: string[];
}

function parseArgs(): Cli {
  const args = process.argv.slice(2);
  const storyId = args[0];
  if (!storyId) {
    console.error("usage: watch.ts <storyId> [--provider mock] [--langs zh,en]");
    process.exit(2);
  }
  const get = (flag: string, def: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  return {
    storyId,
    provider: get("--provider", "mock"),
    langs: get("--langs", "zh,en").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

const cli = parseArgs();

// 监听点:三处会影响合成结果的文件。pace 改了等价于"所有未填 pauseAfter 的拍变了";
// i18n 改了等价于"lang fallback 行为变了";单文件粒度足够稳。
const WATCH_PATHS = [
  resolve(repoRoot, "client/src/v2/walkthrough/stories"),
  resolve(repoRoot, "client/src/v2/walkthrough/pace.ts"),
  resolve(repoRoot, "client/src/v2/walkthrough/i18n.ts"),
];

let running = false;
let dirty = false;

async function runSynth(): Promise<void> {
  if (running) { dirty = true; return; }
  running = true;
  const start = Date.now();
  for (const lang of cli.langs) {
    await new Promise<void>((res) => {
      const p = spawn(
        "npx",
        ["tsx", "scripts/voice/synth.ts", cli.storyId, "--lang", lang, "--provider", cli.provider],
        { cwd: repoRoot, stdio: "inherit" },
      );
      p.on("exit", () => res());
    });
  }
  running = false;
  console.log(`  (synth done in ${((Date.now() - start) / 1000).toFixed(1)}s)\n`);
  if (dirty) { dirty = false; runSynth(); }
}

// 防抖:把 100ms 内的多次保存合并(IDE 频繁触发 fs event)
let debounceTimer: NodeJS.Timeout | null = null;
function scheduleSynth(reason: string) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log(`⟳ ${reason}`);
    runSynth();
  }, 100);
}

console.log(`👀 watching ${cli.storyId} (${cli.langs.join("+")}, provider=${cli.provider})`);
console.log(`   change story / pace / i18n → auto resynth\n`);

// 第一次:进来先跑一次,把当前文案的 manifest 烤好
runSynth();

for (const path of WATCH_PATHS) {
  (async () => {
    try {
      const watcher = watch(path, { recursive: true });
      for await (const event of watcher) {
        const f = event.filename;
        if (!f || !f.endsWith(".ts")) continue;
        scheduleSynth(`${f}`);
      }
    } catch (e) {
      console.error(`  watch failed for ${path}: ${(e as Error).message}`);
    }
  })();
}

// 优雅退出
process.on("SIGINT", () => { console.log("\n👋 bye"); process.exit(0); });
