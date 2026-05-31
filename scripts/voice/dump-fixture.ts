// 把一个真实 session 的 drilldown dump 成 Remotion 用的静态 fixture。
//
//   npx tsx scripts/voice/dump-fixture.ts <sessionId> [--turn N] [--port 5051]
//
// 为什么需要:Remotion 无头渲染没有后端,场景吃的是静态 fixture。这个脚本从本地
// 跑着的 server(GET /api/v2/sessions/:id/drilldown)拉真实数据,转成:
//   client/src/studio/fixtures/conversation.ts  (SceneTurn[] — 对话幕的多轮气泡)
//   client/src/studio/fixtures/turn.ts           (LoopTurn — turn-io 幕的调用链)
//
// 截断:为了视频节奏,user/assistant/finalOutput 做合理上限(打字不至于太久);
// toolCall 的 outputPreview 服务端已截到 ~300,原样保留。

import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function parse() {
  const args = process.argv.slice(2);
  const sessionId = args[0];
  if (!sessionId) { console.error("usage: dump-fixture.ts <sessionId> [--lang en|zh] [--turn N] [--port 5051]"); process.exit(2); }
  const g = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  // --lang 决定输出后缀:conversation.<lang>.ts / turn.<lang>.ts。默认 en
  // (zh 是手工本地化的,别用自动 dump 覆盖)。
  return { sessionId, lang: g("--lang", "en"), turn: args.indexOf("--turn") >= 0 ? parseInt(g("--turn", "0"), 10) : null, port: g("--port", "5051") };
}

// 去掉用户为强制英文加的元前缀(如 "Answer in English."),它对视频是噪声,不是真实问题。
const stripMeta = (s: unknown) => String(s ?? "").replace(/^\s*answer in english[.。]?\s*/i, "");
const clip = (s: unknown, n: number) => { const t = stripMeta(s).trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

interface DTool { name: string; inputPreview: string; outputPreview: string; outputSize: number; isError: boolean }
interface DCall { contextSize: number; assistantText: string; toolCalls: DTool[] }
interface DTurn { id: number; userInput: string; finalOutput: string | null; calls: DCall[] }

async function main() {
  const { sessionId, lang, turn, port } = parse();
  const url = `http://localhost:${port}/api/v2/sessions/${encodeURIComponent(sessionId)}/drilldown`;
  const r = await fetch(url);
  if (!r.ok) { console.error(`drilldown fetch failed: HTTP ${r.status} — is the server running on :${port} and the session present?`); process.exit(1); }
  const dd = await r.json() as { title?: string; turns: DTurn[] };
  const turns = dd.turns ?? [];
  if (turns.length === 0) { console.error("session has no turns"); process.exit(1); }

  // conversationFixture:所有 turn → 多轮气泡(user / final + 统计)。
  const conv = turns.map((t) => {
    const tally = new Map<string, number>();
    for (const c of t.calls) for (const tc of c.toolCalls ?? []) tally.set(tc.name, (tally.get(tc.name) ?? 0) + 1);
    return {
      id: t.id,
      user: clip(t.userInput, 200),
      assistant: clip(t.finalOutput ?? "", 380),
      llmCalls: t.calls.length,
      tools: [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    };
  });

  // turnFixture:选一个有最多工具轮次的 turn(或 --turn 指定)。
  const pick = turn != null ? turns.find((t) => t.id === turn) : null;
  const loopTurn = pick ?? [...turns].sort((a, b) =>
    b.calls.filter((c) => c.toolCalls?.length).length - a.calls.filter((c) => c.toolCalls?.length).length)[0];
  const turnFix = {
    userInput: clip(loopTurn.userInput, 220),
    finalOutput: clip(loopTurn.finalOutput ?? "", 420),
    calls: loopTurn.calls.map((c) => ({
      contextSize: c.contextSize,
      assistantText: clip(c.assistantText, 200),
      toolCalls: (c.toolCalls ?? []).map((tc) => ({
        name: tc.name,
        inputPreview: tc.inputPreview ?? "",
        outputPreview: (tc.outputPreview ?? "").trim(),
        outputSize: tc.outputSize,
        isError: tc.isError,
      })),
    })),
  };

  const stamp = `// 自动 dump 自真实 session(scripts/voice/dump-fixture.ts)。\n// session: ${sessionId}\n// title:   ${dd.title ?? ""}\n// 重新生成:npx tsx scripts/voice/dump-fixture.ts ${sessionId}${turn != null ? ` --turn ${turn}` : ""}`;

  const convFile = `import type { SceneTurn } from "../scenes/timeline";\n\n${stamp}\nexport const conversationFixture: SceneTurn[] = ${JSON.stringify(conv, null, 2)};\n`;

  const turnFile = `${stamp}\n
// 形状是 AgentLoopScene 消费的最小 LoopTurn(与庞大的 UserTurn 解耦)。
export type LoopToolCall = { name: string; inputPreview: string; outputPreview: string; outputSize: number; isError: boolean };
export type LoopCall = { contextSize: number; assistantText: string; toolCalls: LoopToolCall[] };
export type LoopTurn = { userInput: string; finalOutput: string; calls: LoopCall[] };

export const turnFixture: LoopTurn = ${JSON.stringify(turnFix, null, 2)};
`;

  await writeFile(resolve(repoRoot, `client/src/studio/fixtures/conversation.${lang}.ts`), convFile);
  await writeFile(resolve(repoRoot, `client/src/studio/fixtures/turn.${lang}.ts`), turnFile);

  console.log(`✓ dumped session ${sessionId} → fixtures/*.${lang}.ts`);
  console.log(`  conversation: ${conv.length} turns`);
  console.log(`  turn (loop):  turn ${loopTurn.id} · ${turnFix.calls.length} calls · ${turnFix.calls.filter((c) => c.toolCalls.length).length} tool iters`);
}

main().catch((e) => { console.error(e); process.exit(1); });
