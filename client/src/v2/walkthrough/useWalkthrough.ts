import { useCallback, useState } from "react";

// 纯步进状态机 —— 不碰路由、不碰数据。导航/数据由 Controller 消费 index 后处理。
export function useWalkthrough(stepCount: number) {
  const [index, setIndex] = useState(0);

  const goTo = useCallback(
    (i: number) => setIndex(Math.max(0, Math.min(stepCount - 1, i))),
    [stepCount],
  );
  const next = useCallback(() => setIndex((i) => Math.min(stepCount - 1, i + 1)), [stepCount]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  return {
    index,
    next,
    prev,
    goTo,
    isFirst: index === 0,
    isLast: index === stepCount - 1,
  };
}
