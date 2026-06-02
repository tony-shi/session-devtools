import { Composition } from "remotion";
import { HelloProbe } from "./HelloProbe";

// Remotion 的 composition 注册表。Phase 0 只有探针;Phase 1 起加 <Conversation> 等真幕。
// 1920×1080 / 30fps —— 之后各幕统一这个画布规格。
export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="HelloProbe"
        component={HelloProbe}
        durationInFrames={90}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
