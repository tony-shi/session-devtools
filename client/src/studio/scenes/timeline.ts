// 会话幕的「帧时间轴」—— 唯一计时真源(纯函数,无副作用、无墙钟)。
//
// Phase 1:每一拍时长由「文字长度 + 固定停顿」推导,等价现在 ConversationView 的
//   USER_HOLD / THINK_MS / TYPE_TICK 墙钟常量,只是改写成「帧」。
// Phase 2:assistant 段会被 voice manifest 的 durMs 覆盖 —— 本文件接口不变,
//   buildConversationTimeline 多接一个可选 manifest 参数即可。
//
// 与 walkthrough 解耦:Scene 只认这里的最小 SceneTurn,不依赖庞大的 UserTurn。
// 真实 drilldown → SceneTurn 的适配器(fromUserTurns)留到接真数据时再加。

export type SceneTurn = {
  id: number;
  user: string;
  assistant: string;
  llmCalls: number;
  tools: { name: string; count: number }[];
};

export type TurnTiming = {
  turn: SceneTurn;
  start: number;        // 这一轮起始帧
  userTypeEnd: number;  // 用户气泡打字结束
  thinkEnd: number;     // 思考结束 = assistant 开始打字
  asstTypeEnd: number;  // assistant 打字结束
  end: number;          // 这一轮结束(含 done hold)
};

export type ConversationTimeline = {
  turns: TurnTiming[];
  total: number;        // 整幕总帧数
};

// 可调节奏旋钮(秒)。Phase 2 起 assistant 段被 manifest 覆盖,这些只管 user / 停顿。
const TYPE_CPS = 28;        // 打字速度:字符/秒(中文阅读舒适区)
const USER_HOLD_S = 0.5;    // 用户气泡打完后的停顿
const THINK_S = 0.8;        // “思考中” 时长
const DONE_HOLD_S = 0.7;    // 一轮结束后进入下一轮的停顿
const MIN_TYPE_S = 0.3;     // 极短文本也给一点打字时间

const sec = (fps: number, s: number) => Math.round(s * fps);
const typeFrames = (fps: number, text: string) =>
  Math.max(sec(fps, MIN_TYPE_S), sec(fps, text.length / TYPE_CPS));

export function buildConversationTimeline(turns: SceneTurn[], fps: number): ConversationTimeline {
  const out: TurnTiming[] = [];
  let cursor = 0;
  for (const turn of turns) {
    const start = cursor;
    const userTypeEnd = start + typeFrames(fps, turn.user);
    const hasAsst = !!turn.assistant;
    const thinkEnd = userTypeEnd + sec(fps, USER_HOLD_S) + (hasAsst ? sec(fps, THINK_S) : 0);
    const asstTypeEnd = thinkEnd + (hasAsst ? typeFrames(fps, turn.assistant) : 0);
    const end = asstTypeEnd + sec(fps, DONE_HOLD_S);
    out.push({ turn, start, userTypeEnd, thinkEnd, asstTypeEnd, end });
    cursor = end;
  }
  return { turns: out, total: cursor };
}
