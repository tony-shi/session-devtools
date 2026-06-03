// 归因取数的依赖注入 context。
//
// AttributionTreeLensPanel / attribution-graph-context 等组件原本直接 import apiV2（底层 fetch）
// 自取归因数据，无法在无后端环境（单测 / Storybook / 离线 demo / 无头出片）喂静态数据。这里把
// 「取数能力」抽象成可注入依赖：默认仍走真实 apiV2，需要时由外层 Provider 注入返回静态数据的
// 实现。注入的是语义化取数方法，不是原始 fetch，不做 URL 匹配。
//
// 离线 / 测试 / 出片用法示例：
//   <AttributionApiProvider value={{
//     attributionTree: async () => fixtureTree,
//     attributionGraph: async () => ({ events: [] }),
//     diffTree: async () => null,
//   }}>
//     <AttributionTreeLensPanel sessionId={...} callId={...} />
//   </AttributionApiProvider>
//
// 注意嵌套顺序：AttributionGraphProvider 内部会消费本 context，所以若要覆盖 graph，
// AttributionApiProvider 必须包在 AttributionGraphProvider 外层。
import React, { createContext, useContext } from "react";
import { apiV2 } from "./api";

// 归因相关取数方法的子集。默认实现 = 真实后端(apiV2)。
// 用 typeof 锁定签名，保证注入实现与线上完全一致。
export interface AttributionApi {
  attributionTree: typeof apiV2.attributionTree;
  subAgentAttributionTree: typeof apiV2.subAgentAttributionTree;
  compactAttributionTree: typeof apiV2.compactAttributionTree;
  sideCallAttributionTree: typeof apiV2.sideCallAttributionTree;
  diffTree: typeof apiV2.diffTree;
  subAgentDiffTree: typeof apiV2.subAgentDiffTree;
  attributionGraph: typeof apiV2.attributionGraph;
}

// 默认实现 = 真实后端。apiV2 的这些方法是独立箭头函数，解构引用不丢 this（不依赖 apiV2 对象）。
const DEFAULT_API: AttributionApi = {
  attributionTree: apiV2.attributionTree,
  subAgentAttributionTree: apiV2.subAgentAttributionTree,
  compactAttributionTree: apiV2.compactAttributionTree,
  sideCallAttributionTree: apiV2.sideCallAttributionTree,
  diffTree: apiV2.diffTree,
  subAgentDiffTree: apiV2.subAgentDiffTree,
  attributionGraph: apiV2.attributionGraph,
};

const AttributionApiCtx = createContext<AttributionApi>(DEFAULT_API);

/**
 * 注入归因取数实现。不包此 Provider = 默认走真实后端(apiV2)，线上零变化。
 * value 是 Partial：只覆盖你关心的方法，其余 fallback 到真实实现。
 *
 * 注意嵌套顺序：AttributionGraphProvider 内部会消费本 context，所以若要覆盖 graph，
 * AttributionApiProvider 必须包在 AttributionGraphProvider 外层。
 */
export function AttributionApiProvider({
  value, children,
}: { value?: Partial<AttributionApi>; children: React.ReactNode }) {
  const merged = React.useMemo<AttributionApi>(
    () => ({ ...DEFAULT_API, ...(value ?? {}) }),
    [value],
  );
  return <AttributionApiCtx.Provider value={merged}>{children}</AttributionApiCtx.Provider>;
}

export function useAttributionApi(): AttributionApi {
  return useContext(AttributionApiCtx);
}
