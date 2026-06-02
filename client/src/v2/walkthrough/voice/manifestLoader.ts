// 加载音轨清单。约定路径 /voice/<storyId>/<lang>.json(Vite 把 client/public 映射到 /)。
//
// 缺失即静默:刚跑通这集第一遍录像、还没合成英文,manifest 不存在不应该让播放器崩。
// 调用方拿到 null → 自然 fallback 到旧的纯计时节拍(useTimerBeatClock)。

import type { Lang, Manifest } from "./types";

const cache = new Map<string, Promise<Manifest | null>>();

export function loadManifest(storyId: string, lang: Lang): Promise<Manifest | null> {
  const key = `${storyId}:${lang}`;
  let hit = cache.get(key);
  if (hit) return hit;
  hit = (async () => {
    try {
      const r = await fetch(`/voice/${storyId}/${lang}.json`, { cache: "no-store" });
      if (!r.ok) return null;
      return (await r.json()) as Manifest;
    } catch {
      // 网络错 / 解析错 → 同样视作"没合成",退回纯计时
      return null;
    }
  })();
  cache.set(key, hit);
  return hit;
}

/** 路由切走或 R 重启,可以清缓存让下次重新拉一份(开发期热更新很有用) */
export function clearManifestCache() {
  cache.clear();
}
