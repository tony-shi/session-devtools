import { AbsoluteFill } from "remotion";
import "../../i18n";  // 初始化 react-i18next(真实面板用 useTranslation),否则 headless 渲染缺 i18n 实例
import { AttributionGraphProvider } from "../../v2/attribution-graph-context";
import { AttributionTreeLensPanel } from "../../v2/AttributionTreeLensPanel";
import { TooltipProvider } from "@/components/ui/tooltip";  // 真实面板用 Radix Tooltip,需要 Provider 祖先
import type { AttributionTreeResult } from "../../v2/attribution-tree-types";
import fixture from "../fixtures/attribution-real-context.json";

// 单轨(Decision C)落地探针 —— 把真实的产品组件 AttributionTreeLensPanel 喂静态 fixture,
// 在 Remotion 无头环境里渲出来。目的:验证"复用真实 UI 出片"这条路是否成立(样式 / i18n /
// CJK / 数据注入)。成立 → Story 2 就走这条;不成立 → 暴露具体阻塞点再决定。
//
// fixture = session 820f368b / turn 1 / call 1 的真实 attribution-tree(scripts 直接 dump)。
const RC = fixture as unknown as AttributionTreeResult;

export const RealContextProbe = () => (
  <AbsoluteFill
    style={{
      background: "#fff",
      fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
    }}
  >
    <div style={{ height: "100%", overflow: "hidden", padding: 32 }}>
      <TooltipProvider>
        <AttributionGraphProvider sessionId={RC.sessionId} onJumpToCall={null}>
          <AttributionTreeLensPanel
            sessionId={RC.sessionId}
            callId={RC.callId}
            hideDiff
            focusSection="tools"
            injected={RC}
          />
        </AttributionGraphProvider>
      </TooltipProvider>
    </div>
  </AbsoluteFill>
);
