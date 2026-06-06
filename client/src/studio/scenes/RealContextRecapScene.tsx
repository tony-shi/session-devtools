import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import type { ActClock } from "./storyClock";

// Story 2 回顾 + 下一章幕 —— 与 Story 3 RecapTeaserShot 同款卡片风格:
// 关键句逐拍浮现,与字幕(step16/17 旁白)对齐。
//
// beat 映射(本 shot 含 step 16(6 拍)+ step 17(2 拍)):
//   16.0 标题            「回顾本章:顶层就三个核心字段」
//   16.1 卡片 1/2/3 依次  「Tools…System…Messages…」(一拍内三连,按 1/3 错峰)
//   16.2 卡片 4          「你输入的只是极小一部分…」
//   16.3-4 版本脚注       「素材取自 2.1.167…细节可能已不同」
//   16.5 要点框(琥珀)    「重点是理解核心组成与演变机制」
//   17.* 下一章框(靛蓝)  「context 如何演变 · 披露如何生效」
// 文案暂 zh 硬编(en 轨未接,与 RealContextJsonScene 同策略)。
const CARDS = [
  { head: "Tools", tail: "—— 模型的能力说明书" },
  { head: "System", tail: "—— 行为准则,也带着你项目的元信息" },
  { head: "Messages", tail: "—— 注入的上下文 · 能力声明 · 你的对话" },
  { head: "0.01%", tail: "—— 你输入的只是极小一部分,其余由 Claude Code 构建" },
];

export const RealContextRecapScene = ({ clock }: { clock: ActClock }) => {
  const frame = useCurrentFrame();
  const segStart = (stepIdx: number, beat: number) =>
    clock.segments.find((s) => s.stepIdx === stepIdx && s.beat === beat)?.start ?? 0;
  const seg16_1 = clock.segments.find((s) => s.stepIdx === 16 && s.beat === 1);
  const fadeAt = (start: number) =>
    interpolate(frame, [start, start + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // 卡片 1-3 在 16.1 一拍内按 1/3 拍长错峰浮现;卡片 4 对齐 16.2。
  const cardStart = (i: number) => {
    if (i < 3) {
      const s = seg16_1?.start ?? 0;
      const len = seg16_1 ? seg16_1.end - seg16_1.start : 0;
      return s + Math.round((len / 3) * i);
    }
    return segStart(16, 2);
  };
  return (
    <AbsoluteFill style={{
      background: "#fff", alignItems: "center", justifyContent: "center",
      fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ width: 1280 }}>
        <div style={{ fontSize: 44, fontWeight: 800, color: "#0f172a", marginBottom: 36, opacity: fadeAt(segStart(16, 0)) }}>
          回顾 · 看见真实的 Context
        </div>
        {CARDS.map((c, i) => (
          <div key={i} style={{
            opacity: fadeAt(cardStart(i)),
            display: "flex", alignItems: "center", gap: 22, marginBottom: 20,
            background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 16, padding: "16px 30px",
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12, background: "#eef2ff", color: "#4338ca",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 800, flexShrink: 0,
            }}>{i + 1}</div>
            <div style={{ fontSize: 30, color: "#334155", fontWeight: 500 }}>
              <b style={{ color: "#0f172a" }}>{c.head}</b> {c.tail}
            </div>
          </div>
        ))}
        {/* 版本脚注:16.3 浮现(16.4 继续讲,不再加视觉元素) */}
        <div style={{ opacity: fadeAt(segStart(16, 3)), fontSize: 21, color: "#94a3b8", margin: "26px 4px 0" }}>
          素材取自 Claude Code 2.1.167 —— 迭代非常频繁,用 session-devtools 打开你的会话时,细节可能已不同。
        </div>
        {/* 要点框(琥珀):16.5 */}
        <div style={{
          opacity: fadeAt(segStart(16, 5)),
          marginTop: 22, padding: "20px 30px", borderRadius: 18,
          background: "#fffbeb", border: "2px solid #fde68a",
        }}>
          <div style={{ fontSize: 30, color: "#92400e", fontWeight: 700 }}>
            重点不是掌握每条提示词的细节,而是理解 context 的核心组成与演变机制
          </div>
        </div>
        {/* 下一章框(靛蓝):step 17 */}
        <div style={{
          opacity: fadeAt(segStart(17, 0)),
          marginTop: 22, padding: "20px 30px", borderRadius: 18,
          background: "#eef2ff", border: "2px solid #c7d2fe",
        }}>
          <div style={{ fontSize: 22, color: "#6366f1", fontWeight: 700, marginBottom: 6 }}>下一章</div>
          <div style={{ fontSize: 32, color: "#312e81", fontWeight: 800 }}>
            Context 的演变:逐轮填充 · 调用与思考交替 · 渐进式披露生效
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
