import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

// Remotion 渲染入口 —— 独立于 Vite app(App.tsx),互不影响。
// CLI:remotion studio src/studio/index.ts  /  remotion render src/studio/index.ts <id> <out>
registerRoot(RemotionRoot);
