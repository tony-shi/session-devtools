// MiniMax 音色横向对比 —— 同一句话、同一参数,把候选音色逐个合成到独立文件,方便一次性挨个试听。
// 不像 ping 那样反复覆盖 out/minimax-sample.mp3,这里每个音色一个文件:out/voice-compare/<voice>.mp3
//
// 用法:
//   npm run voice:minimax:compare                                  # 跑内置解读类候选清单
//   npm run voice:minimax:compare -- --voices presenter_female,audiobook_female_1
//   npm run voice:minimax:compare -- --speed 0.95 --emotion happy   # 统一调味再对比
//   npm run voice:minimax:compare -- --text "自定义这一句"           # 换测试文本
//   npm run voice:minimax:compare -- --lang en                      # 试英文集音色
//
// 默认文本含中英混读(LLM Call / tool_use),最能暴露音色处理英文术语的能力。

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MiniMaxProvider } from "./providers/minimax";

try { process.loadEnvFile(".env"); } catch { /* 走环境变量 */ }

function arg(flag: string, def?: string): string | undefined {
  const a = process.argv.slice(2); const i = a.indexOf(flag); return i >= 0 && a[i + 1] ? a[i + 1] : def;
}

// 解读 / 科普自媒体常用的"中性偏活泼"候选 —— 不存在的 id 会单独报错跳过,不影响其它。
const DEFAULT_VOICES = [
  "presenter_female",     // 主持女声:清晰播讲、专业带亲和(最像解读号)
  "audiobook_female_1",   // 有声书女声:娓娓道来、不端着
  "female-chengshu",      // 成熟女声(当前默认):稳但偏正经
  "male-qn-jingying",     // 精英青年男声:自信清亮(男声首选)
  "male-qn-daxuesheng",   // 大学生男声:年轻有活力
];

const DEFAULT_ZH = "更准确地说,它是一条执行链:一次 LLM Call 里,模型可能提出 tool_use,执行后拿到 tool_result。";
const DEFAULT_EN = "More precisely, it's an execution chain: in one LLM Call, the model may emit a tool_use and then get a tool_result.";

async function main() {
  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!apiKey || !groupId) {
    console.error("✗ 缺少凭据。请在仓库根 .env 设置 MINIMAX_API_KEY / MINIMAX_GROUP_ID。");
    process.exit(2);
  }

  const lang = (arg("--lang") ?? "zh") as "zh" | "en";
  const text = arg("--text") ?? (lang === "en" ? DEFAULT_EN : DEFAULT_ZH);
  const voices = (arg("--voices") ?? DEFAULT_VOICES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const model = arg("--model") ?? process.env.MINIMAX_MODEL; // 默认走 provider 的 speech-02-hd(最强)
  const speed = arg("--speed") ? parseFloat(arg("--speed")!) : (process.env.MINIMAX_SPEED ? parseFloat(process.env.MINIMAX_SPEED) : undefined);
  const emotion = arg("--emotion") ?? process.env.MINIMAX_EMOTION;
  const host = process.env.MINIMAX_API_HOST;

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const outDir = resolve(repoRoot, "out/voice-compare");
  await mkdir(outDir, { recursive: true });

  console.log(`⟳ MiniMax 音色对比 · ${voices.length} 个 · model=${model ?? "speech-02-hd"} · speed=${speed ?? 1.0} · emotion=${emotion ?? "(默认)"} · lang=${lang}`);
  console.log(`  文本:「${text}」`);
  console.log(`  输出:${outDir}/\n`);

  let ok = 0, fail = 0;
  for (const voiceId of voices) {
    const provider = new MiniMaxProvider({ apiKey, groupId, host, model, voiceId, speed, emotion });
    const t0 = Date.now();
    try {
      const res = await provider.synth({ text, lang });
      const outPath = resolve(outDir, `${voiceId}.mp3`);
      await writeFile(outPath, res.audio);
      ok += 1;
      console.log(`  \x1b[36m✓ ${voiceId.padEnd(22)} ${String(res.durMs).padStart(5)}ms 音频 · ${Date.now() - t0}ms 往返 → ${voiceId}.mp3\x1b[0m`);
    } catch (e) {
      fail += 1;
      console.log(`  \x1b[31m✗ ${voiceId.padEnd(22)} ${(e as Error).message}\x1b[0m`);
    }
  }

  console.log(`\n✓ 完成 · ${ok} 成功 · ${fail} 失败`);
  console.log(`  挨个试听 ${outDir}/*.mp3,选中后写进 .env:MINIMAX_VOICE / MINIMAX_SPEED / MINIMAX_EMOTION`);
  console.log("  再跑全程:npm run voice:agent-loop:zh:minimax");
}

main().catch((e) => { console.error(e); process.exit(1); });
