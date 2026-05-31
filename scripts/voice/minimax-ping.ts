// MiniMax 连通性 + 试音:验证凭据,合成一句含中英混读的样本,写到 out/minimax-sample.mp3。
// 用法:
//   npm run voice:minimax:ping                       # 默认音色试一句
//   npm run voice:minimax:ping -- --voice female-tianmei --speed 0.95
//   npm run voice:minimax:ping -- --text "自定义这一句"
// 凭据缺失 / 报错会打印清晰原因。听满意了再跑 npm run voice:agent-loop:zh:minimax。

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MiniMaxProvider } from "./providers/minimax";

try { process.loadEnvFile(".env"); } catch { /* 走环境变量 */ }

function arg(flag: string, def?: string): string | undefined {
  const a = process.argv.slice(2); const i = a.indexOf(flag); return i >= 0 && a[i + 1] ? a[i + 1] : def;
}

async function main() {
  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!apiKey || !groupId) {
    console.error("✗ 缺少凭据。请在仓库根 .env 设置:\n    MINIMAX_API_KEY=...\n    MINIMAX_GROUP_ID=...\n  (国际平台另加 MINIMAX_API_HOST=api.minimaxi.chat)");
    process.exit(2);
  }
  const voiceId = arg("--voice") ?? process.env.MINIMAX_VOICE;
  const model = arg("--model") ?? process.env.MINIMAX_MODEL;
  const speed = arg("--speed") ? parseFloat(arg("--speed")!) : (process.env.MINIMAX_SPEED ? parseFloat(process.env.MINIMAX_SPEED) : undefined);
  const text = arg("--text") ?? "更准确地说,它是一条执行链:一次 LLM Call 里,模型可能提出 tool_use,执行后拿到 tool_result。";

  const host = process.env.MINIMAX_API_HOST ?? "api.minimax.chat";
  console.log(`⟳ MiniMax 试音 · host=${host} · model=${model ?? "speech-02-hd"} · voice=${voiceId ?? "(默认)"} · speed=${speed ?? 1.0}`);
  console.log(`  文本:「${text}」`);

  const provider = new MiniMaxProvider({ apiKey, groupId, host: process.env.MINIMAX_API_HOST, model, voiceId, speed, emotion: process.env.MINIMAX_EMOTION });
  const t0 = Date.now();
  let res;
  try {
    res = await provider.synth({ text, lang: "zh" });
  } catch (e) {
    console.error(`✗ 失败:${(e as Error).message}`);
    console.error("  常见原因:① key/GroupId 平台不匹配(国内 api.minimax.chat / 国际 api.minimaxi.chat)" +
      "\n           ② voice_id 在你账号里不存在(用 --voice 指定控制台里的 id)" +
      "\n           ③ 余额 / 实名 / 该模型未开通");
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const outDir = resolve(repoRoot, "out");
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, "minimax-sample.mp3");
  await writeFile(outPath, res.audio);
  console.log(`\n✓ 成功 · ${res.durMs}ms · ${res.voice} · ${(Date.now() - t0)}ms 往返`);
  console.log(`  试听:${outPath}`);
  console.log("  满意 → 跑全程:npm run voice:agent-loop:zh:minimax");
}

main().catch((e) => { console.error(e); process.exit(1); });
