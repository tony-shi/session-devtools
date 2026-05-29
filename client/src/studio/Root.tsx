import { Composition } from "remotion";
import { HelloProbe } from "./HelloProbe";
import { ConversationScene } from "./scenes/ConversationScene";
import { buildConversationTimeline } from "./scenes/timeline";
import { conversationFixture } from "./fixtures/conversation";

// Remotion 的 composition 注册表。1920×1080 / 30fps —— 各幕统一画布规格。
const FPS = 30;

// 时长由时间轴算 —— Phase 1 用 fixture 在 FPS 下算出总帧数(将来按 lang 走 calculateMetadata)。
const conversationDuration = buildConversationTimeline(conversationFixture, FPS).total;

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="HelloProbe"
        component={HelloProbe}
        durationInFrames={90}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="Conversation"
        component={ConversationScene}
        durationInFrames={conversationDuration}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ turns: conversationFixture }}
      />
    </>
  );
};
