// 呈现模式 —— 同一份 story / view,不同壳子。
//
// live   —— 在线 demo / 排练。字幕条 + 自动节拍 + 语言切换可见。
// record —— 录画面。所有 chrome 隐藏(字幕条、LangToggle、进度点),节拍手动控制(← / →),
//           留一个微小角标方便你裁掉。最终成片 = 这层动画 + 后期音轨。
// tele   —— 提词器。大字当前句 + 灰色下一句 + 节拍进度,给配音师用。(预留,本次不实现)
//
// 通过 URL ?mode=record 进入;无参数 = live(向后兼容)。

export type Mode = "live" | "record" | "tele";

export function readModeFromUrl(): Mode {
  if (typeof window === "undefined") return "live";
  const p = new URLSearchParams(window.location.search).get("mode");
  return p === "record" || p === "tele" ? p : "live";
}

/** 录屏模式下 chrome 应当全部隐藏 —— 字幕条、语言切换、进度点 */
export const hidesChrome = (m: Mode) => m === "record";

/** 录屏模式禁止自动节拍(必须手动 ← / →);其它模式按 playing 状态 */
export const forcesManualBeat = (m: Mode) => m === "record";

/** 录屏时锁定 URL ?lang= 给定的语言,不允许中途切 —— 避免录到一半切到另一语 */
export function readLockedLang(): "zh" | "en" | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search).get("lang");
  return p === "zh" || p === "en" ? p : null;
}
