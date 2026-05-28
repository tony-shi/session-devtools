import type { Story } from "../types";
import { agentLoopStory } from "./agent-loop";
import { contextWindowStory } from "./context-window";
import { contextDiffStory } from "./context-diff";
import { toolsStory } from "./tools";
import { cacheStory } from "./cache";
import { compactionStory } from "./compaction";
import { extendStory } from "./extend";
import { subagentStory } from "./subagent";

// 所有 walkthrough story 的注册表。访问 /demo/<id> 即播放对应 story。
// 课程顺序:loop → context → diff → tools → cache → compaction → extend → subagent。
export const STORIES: Record<string, Story> = {
  [agentLoopStory.id]: agentLoopStory,         // /demo/agent-loop
  [contextWindowStory.id]: contextWindowStory, // /demo/context-window
  [contextDiffStory.id]: contextDiffStory,     // /demo/context-diff
  [toolsStory.id]: toolsStory,                 // /demo/tools
  [cacheStory.id]: cacheStory,                 // /demo/cache
  [compactionStory.id]: compactionStory,       // /demo/compaction
  [extendStory.id]: extendStory,               // /demo/extend
  [subagentStory.id]: subagentStory,           // /demo/subagent
};
