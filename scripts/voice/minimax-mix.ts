// MiniMax 音色混合扫描 —— 把两个音色按不同配比调和,各写一个文件,挑中间最对味的那档。
// 用 MiniMax 原生 timber_weights:presenter(专业稳) × audiobook(生动)取中间。
//
// 用法:
//   npm run voice:minimax:mix                                  # 默认 presenter×audiobook 多档配比
//   npm run voice:minimax:mix -- --a presenter_female --b audiobook_female_1
//   npm run voice:minimax:mix -- --ratios 70/30,60/40,50/50    # 自定义配比(A/B 权重)
//   npm run voice:minimax:mix -- --emotion happy --speed 0.95  # 统一调味
//
//   多音色 / 任意配比(每个 blend 用 ; 分隔,blend 内 voice:weight 用 , 分隔):
//   npm run voice:minimax:mix -- --mixes "presenter_female:35,audiobook_female_1:65; presenter_female:30,audiobook_female_1:60,female-tianmei:10"
//
// 输出:out/voice-compare/mix-<配比slug>.mp3

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MiniMaxProvider } from "./providers/minimax";

try { process.loadEnvFile(".env"); } catch { /* 走环境变量 */ }

function arg(flag: string, def?: string): string | undefined {
  const a = process.argv.slice(2); const i = a.indexOf(flag); return i >= 0 && a[i + 1] ? a[i + 1] : def;
}

// 文件名标签:去掉 female-/male-/presenter_/audiobook_ 等通用前缀,取真正有区分度的词,避免撞名
function tag(voiceId: string): string {
  const core = voiceId.replace(/^(female|male)[-_]/i, "").replace(/[-_](female|male|\d+)$/i, "");
  return core.replace(/[-_]/g, "").slice(0, 6);
}

const DEFAULT_TEXT = "更准确地说,它是一条执行链:一次 LLM Call 里,模型可能提出 tool_use,执行后拿到 tool_result。";

async function main() {
  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!apiKey || !groupId) {
    console.error("✗ 缺少凭据。请在仓库根 .env 设置 MINIMAX_API_KEY / MINIMAX_GROUP_ID。");
    process.exit(2);
  }

  const a = arg("--a") ?? "presenter_female";
  const b = arg("--b") ?? "audiobook_female_1";
  const text = arg("--text") ?? DEFAULT_TEXT;
  const speed = arg("--speed") ? parseFloat(arg("--speed")!) : (process.env.MINIMAX_SPEED ? parseFloat(process.env.MINIMAX_SPEED) : 0.97);
  // 混音默认退回 neutral —— "生动"交给音色,别再叠 happy 把人读得太兴奋
  const emotion = arg("--emotion") ?? "neutral";
  const host = process.env.MINIMAX_API_HOST;
  const model = process.env.MINIMAX_MODEL;

  // blend 列表:优先用 --mixes(任意多音色),否则退回 A×B 的 --ratios 两音色扫描
  type Blend = { weights: Array<{ voiceId: string; weight: number }>; slug: string };
  let blends: Blend[];
  const mixesArg = arg("--mixes");
  if (mixesArg) {
    blends = mixesArg.split(";").map((spec) => {
      const weights = spec.split(",").map((pair) => {
        const [voiceId, w] = pair.split(":").map((s) => s.trim());
        return { voiceId, weight: parseInt(w, 10) };
      }).filter((x) => x.voiceId && !Number.isNaN(x.weight));
      const slug = weights.map((x) => `${tag(x.voiceId)}${x.weight}`).join("-");
      return { weights, slug };
    }).filter((b) => b.weights.length > 0);
  } else {
    const ratios = (arg("--ratios") ?? "75/25,60/40,50/50,40/60").split(",").map((s) => {
      const [wa, wb] = s.split("/").map((n) => parseInt(n.trim(), 10));
      return { wa, wb };
    });
    blends = ratios.map(({ wa, wb }) => ({
      weights: [{ voiceId: a, weight: wa }, { voiceId: b, weight: wb }],
      slug: `${tag(a)}${wa}-${tag(b)}${wb}`,
    }));
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const outDir = resolve(repoRoot, "out/voice-compare");
  await mkdir(outDir, { recursive: true });

  console.log(`⟳ MiniMax 混音扫描 · ${blends.length} 档 · speed=${speed} · emotion=${emotion}`);
  console.log(`  文本:「${text}」`);
  console.log(`  输出:${outDir}/\n`);

  for (const { weights, slug } of blends) {
    const provider = new MiniMaxProvider({ apiKey, groupId, host, model, speed, emotion, timberWeights: weights });
    const t0 = Date.now();
    const label = weights.map((w) => `${w.voiceId}:${w.weight}`).join(" + ");
    try {
      const res = await provider.synth({ text, lang: "zh" });
      const name = `mix-${slug}.mp3`;
      await writeFile(resolve(outDir, name), res.audio);
      console.log(`  \x1b[36m✓ ${label.padEnd(54)} · ${res.durMs}ms · ${Date.now() - t0}ms → ${name}\x1b[0m`);
    } catch (e) {
      console.log(`  \x1b[31m✗ ${label}  ${(e as Error).message}\x1b[0m`);
    }
  }

  console.log("\n✓ 完成 · 挨个试听 out/voice-compare/mix-*.mp3,选中配比写进 .env(见下方说明)");
}

main().catch((e) => { console.error(e); process.exit(1); });
