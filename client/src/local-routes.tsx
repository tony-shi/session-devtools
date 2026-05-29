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
// Remotion-ized stories play through @remotion/player (single source = studio/scenes).
const RemotionStoryPlayer = lazy(() =>
  import("./v2/walkthrough/RemotionStoryPlayer").then((m) => ({ default: m.RemotionStoryPlayer }))
);

export default function LocalRoutes() {
  return (
    <Routes>
      <Route path="/demo" element={<Suspense fallback={null}><DemoIndex /></Suspense>} />
      {/* Story 1 已 Remotion 化:走 Player(和渲染视频同一套场景),不再用旧 view */}
      <Route path="/demo/agent-loop" element={<Suspense fallback={null}><RemotionStoryPlayer storyId="agent-loop" /></Suspense>} />
      <Route path="/demo/:storyId" element={<Suspense fallback={null}><DemoStage /></Suspense>} />
    </Routes>
  );
}
