import { Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { getManifest, buildNarrationClips } from "./narration";

// 旁白音轨 —— 把某一幕的旁白音频按帧位置铺到时间轴上。视觉场景在它下方并行播放。
// 每条音频包在 <Sequence from=...> 里,Remotion render 时由 ffmpeg 混进最终 mp4。
//
// 缓存防线:mp3 文件名按 step-line 命名,重合成后 URL 不变 —— 浏览器/dev server 会把
// 旧音频缓存继续喂给 studio,造成「字幕按新 manifest 走、声音却是旧版」的音画错位。
// 给 URL 拼 manifest.builtAt 做版本号:重合成 → builtAt 变 → URL 变 → 缓存必失效。
// (render 进程读本地文件,query 参数无副作用;音画单源自此闭环。)
export const NarrationTrack = ({ storyId, lang, stepIdxs, master = false }: { storyId: string; lang: string; stepIdxs: number[]; master?: boolean }) => {
  const { fps } = useVideoConfig();
  const manifest = getManifest(storyId, lang);
  if (!manifest) return null;
  const v = encodeURIComponent(manifest.builtAt ?? "");
  // 出片模式:挂 master 单轨(scripts/voice/master-audio.ts 产物 —— 按同一份 manifest
  // 时间轴拼装 + 整条 loudnorm)。预览默认逐句,改一句无需重出母带。
  if (master) {
    return <Audio src={`${staticFile(`voice/${storyId}/${lang}-master.m4a`)}?v=${v}`} />;
  }
  const { clips } = buildNarrationClips(manifest, stepIdxs, fps);
  return (
    <>
      {clips.map((c, i) => (
        <Sequence key={i} from={c.fromFrame} durationInFrames={c.durFrames}>
          <Audio src={`${staticFile(c.src)}?v=${v}`} />
        </Sequence>
      ))}
    </>
  );
};
