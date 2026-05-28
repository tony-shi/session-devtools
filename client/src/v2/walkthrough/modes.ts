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

/**
 * 全局节拍倍率。?speed=0.7 = 整体放慢到 70% 速度(durMs 拉长 30%);
 * ?speed=1.3 = 加速 30%。调试节奏用,不需要改 manifest 也不需要改 BEAT_MS。
 * 范围 [0.3, 3.0] 防止意外把整集拖到几小时 / 闪过去。
 */
export function readSpeedFromUrl(): number {
  if (typeof window === "undefined") return 1;
  const v = parseFloat(new URLSearchParams(window.location.search).get("speed") ?? "1");
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.max(0.3, Math.min(3.0, v));
}

/** ?dev=1 显示完整 HUD —— 当前 step / line / durMs / gapMs / 倍率 / 是否走音轨 */
export function readDevFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("dev") === "1";
}
