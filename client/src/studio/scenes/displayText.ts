// 「语音读法 → 字幕显示」替换层 —— 旁白单源的最后一块拼图。
//
// 问题:文案源(stories/*.ts)是 TTS 的输入,有些词必须写成「读法」才能读对
//   (如 CLAUDE.md → 「Claude 点 M D」,直接写 .md 会被读成 "点 em dee" 或吞掉);
//   但字幕/SRT 给眼睛看,应显示书面形式。
// 方案:源文件保持读法(喂 TTS);所有"显示"出口(NarrationCaption / export-srt)
//   过一遍 toDisplayText。规则按对出现,新增读法词条只改这里。
export const SPEECH_TO_DISPLAY: Array<[RegExp, string]> = [
  [/Claude ?点 ?M ?D/g, "CLAUDE.md"],
  // 注:JSON 一词 zh 旁白已改说「庞大的数据」(2026-06-07 用户定稿),不再需要读法替换。
];

export function toDisplayText(text: string): string {
  let out = text;
  for (const [re, rep] of SPEECH_TO_DISPLAY) out = out.replace(re, rep);
  return out;
}
