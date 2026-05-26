import type { Story } from "../types";
import { agentLoopStory } from "./agent-loop";
import { contextWindowStory } from "./context-window";

// 所有 walkthrough story 的注册表。访问 /demo/<id> 即播放对应 story。
export const STORIES: Record<string, Story> = {
  [agentLoopStory.id]: agentLoopStory,       // /demo/agent-loop
  [contextWindowStory.id]: contextWindowStory, // /demo/context-window
};
