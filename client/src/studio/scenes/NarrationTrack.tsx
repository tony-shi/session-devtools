import { Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { getManifest, buildNarrationClips } from "./narration";

// 旁白音轨 —— 把某一幕的旁白音频按帧位置铺到时间轴上。视觉场景在它下方并行播放。
// 每条音频包在 <Sequence from=...> 里,Remotion render 时由 ffmpeg 混进最终 mp4。
export const NarrationTrack = ({ lang, stepIdxs }: { lang: string; stepIdxs: number[] }) => {
  const { fps } = useVideoConfig();
  const manifest = getManifest(lang);
  if (!manifest) return null;
  const { clips } = buildNarrationClips(manifest, stepIdxs, fps);
  return (
    <>
      {clips.map((c, i) => (
        <Sequence key={i} from={c.fromFrame} durationInFrames={c.durFrames}>
          <Audio src={staticFile(c.src)} />
        </Sequence>
      ))}
    </>
  );
};
