// proxy-visibility 整个机制的总开关。env / settings 都能控制；off 时
// service 直接返回 'disabled'，列表里这一列不显示。
export function isVisibilityEnabled(): boolean {
  const v = process.env.PROXY_VISIBILITY_ENABLED;
  if (v == null || v === "") return true;
  return v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "off";
}

export const VISIBILITY_CACHE_CAPACITY = 1000;
