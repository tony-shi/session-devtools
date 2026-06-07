// 一次性采样工具:zh「整段生成」A/B 样本 —— S2 开场 steps 0-2 全文一次合成,
// PACE 节拍用 MiniMax <#秒#> 停顿标记编入;音色/语速/模型与产线 zh 完全一致(.env 三混)。
// 对照组 = out/voice-compare/perline-zh-master-excerpt.m4a(逐句 + 母带管线,同段落)。
//
//   npx tsx scripts/voice/sample-wholepiece-zh.ts
//   → out/voice-compare/wholepiece-zh-with-pauses.mp3

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MiniMaxProvider } from "./providers/minimax";

try { process.loadEnvFile(".env"); } catch { /* env 直读 */ }

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

// S2 zh steps 0-2(与 stories/real-context.ts 逐字一致,含「杰森」读法);
// <#x#> = 该句 pauseAfter 的秒数(beat 0.2 / breath 0.5 / pause 0.9),末句不留尾标。
const TEXT = [
  "当你打开 Claude Code,敲下一句话 ——「请输出现在时间」。", "<#0.2#>",
  "你也许认为,模型看到的就是你输入的这句话。", "<#0.5#>",
  "但模型这一次真正读到的,其实不是一句话。", "<#0.2#>",
  "而是一份庞大的 杰森,约 6.5 万字符。展开看,结构层层嵌套,信息量惊人。", "<#0.5#>",
  "但先别被它吓到 —— 它的顶层,其实只有三个核心字段:Tools、System、Messages。", "<#0.5#>",
  "我们用工具拦下 Claude Code 发往远端的原始请求,再对它的内容做归因分析。", "<#0.9#>",
  "还记得上一章片尾那条横条吗?展开之后,就是眼前这三段。",
].join(" ");

function parseTimberWeights(raw?: string) {
  if (!raw || !raw.trim()) return undefined;
  const w = raw.split(",").map((p) => { const [voiceId, x] = p.split(":").map((s) => s.trim()); return { voiceId, weight: parseInt(x, 10) }; })
    .filter((x) => x.voiceId && !Number.isNaN(x.weight));
  return w.length ? w : undefined;
}

async function main() {
  const provider = new MiniMaxProvider({
    apiKey: process.env.MINIMAX_API_KEY!,
    groupId: process.env.MINIMAX_GROUP_ID!,
    host: process.env.MINIMAX_API_HOST,
    model: process.env.MINIMAX_MODEL,
    voiceId: process.env.MINIMAX_VOICE,
    speed: process.env.MINIMAX_SPEED ? parseFloat(process.env.MINIMAX_SPEED) : undefined,
    emotion: process.env.MINIMAX_EMOTION,
    timberWeights: parseTimberWeights(process.env.MINIMAX_TIMBER_WEIGHTS),
  });
  const res = await provider.synth({ text: TEXT, lang: "zh" });
  const out = resolve(repoRoot, "out/voice-compare/wholepiece-zh-with-pauses.mp3");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, res.audio);
  console.log(`✓ ${out} · ${(res.durMs / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
