// Local-only dev routes. This file is .gitignored — see App.tsx for the contract.
// App.tsx picks it up via import.meta.glob; absent in CI / prod → no /demo route.
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";

const DemoStage = lazy(() =>
  import("./v2/walkthrough/DemoStage").then((m) => ({ default: m.DemoStage }))
);
const DemoIndex = lazy(() =>
  import("./v2/walkthrough/DemoIndex").then((m) => ({ default: m.DemoIndex }))
);

// 注:Story 1(agent-loop)已迁到 Remotion —— 预览用 `npm run studio`(单源 = studio/scenes)。
// /demo 这套 live 路由只服务尚未 Remotion 化的存量 story,后续逐步减少。
export default function LocalRoutes() {
  return (
    <Routes>
      <Route path="/demo" element={<Suspense fallback={null}><DemoIndex /></Suspense>} />
      <Route path="/demo/:storyId" element={<Suspense fallback={null}><DemoStage /></Suspense>} />
    </Routes>
  );
}
