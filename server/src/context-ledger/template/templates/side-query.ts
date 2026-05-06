// Claude Code 侧查询（side_query）模板
// 适用范围：tools.length === 0 && messages.length === 1 的请求
// （典型场景：session title 生成、压缩摘要等一次性短查询）。
// 结构很扁——一个 system block + 一个 user message，整块不再细切。

import type { RequestTemplate } from "../types";

export const CLAUDE_CODE_SIDE_QUERY_TEMPLATE: RequestTemplate = {
  id: "claude-code-side-query",
  queryKindPredicate: "side_query",
  version: "phase1.v1",
  slots: {
    system: [
      {
        id: "side-query.system",
        jsonPathPattern: "reqBody.system[0]",
        multiplicity: "optional",
        // 整块，无 anchor
      },
    ],
    tools: [],
    messages: [
      {
        id: "side-query.user",
        jsonPathPattern: "reqBody.messages[0]",
        multiplicity: "one",
        // 整块，无 anchor
      },
    ],
  },
};
