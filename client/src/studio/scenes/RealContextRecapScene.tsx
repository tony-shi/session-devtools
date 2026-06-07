import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { useT } from "../i18n";
import type { ActClock } from "./storyClock";

// Story 2 回顾 + 下一章幕 —— 与 Story 3 RecapTeaserShot 同款卡片风格:
// 关键句逐拍浮现,与字幕(step17/18 旁白)对齐。文案走 studio i18n(双语)。
//
// beat 映射(本 shot 含 step 17(8 拍)+ step 18(3 拍)):
//   17.0 标题            「回顾本章:顶层就三个核心字段」
//   17.1 卡片 1/2 错峰    「Tools…;System…」(一拍内两连,按 1/2 拍长)
//   17.2 卡片 3          「Messages 承载…」
//   17.3 卡片 4          「你输入的只是极小一部分…」(主题句)
//   17.4-5 版本脚注       「素材取自 2.1.167…细节可能已不同」
//   17.6-7 要点框(琥珀)  「重点是理解核心组成与演变机制」
//   18.* 下一章框(靛蓝)  「生长 · 披露生效 · 触顶之后」
// 改 step17/18 句数必须同步本映射(见 real-context.ts 头注)。
export const RealContextRecapScene = ({ clock }: { clock: ActClock }) => {
  const frame = useCurrentFrame();
  const t = useT();
  const segStart = (stepIdx: number, beat: number) =>
    clock.segments.find((s) => s.stepIdx === stepIdx && s.beat === beat)?.start ?? 0;
  const seg17_1 = clock.segments.find((s) => s.stepIdx === 17 && s.beat === 1);
  const fadeAt = (start: number) =>
    interpolate(frame, [start, start + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // 卡片 1-2 在 17.1 一拍内按 1/2 拍长错峰;卡片 3 对齐 17.2;卡片 4 对齐 17.3(主题句)。
  const cardStart = (i: number) => {
    if (i < 2) {
      const s = seg17_1?.start ?? 0;
      const len = seg17_1 ? seg17_1.end - seg17_1.start : 0;
      return s + Math.round((len / 2) * i);
    }
    return segStart(17, i); // i=2 → 17.2;i=3 → 17.3
  };
  return (
    <AbsoluteFill style={{
      background: "#fff", alignItems: "center", justifyContent: "center",
      fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ width: 1280 }}>
        <div style={{ fontSize: 44, fontWeight: 800, color: "#0f172a", marginBottom: 36, opacity: fadeAt(segStart(17, 0)) }}>
          {t.rcRecapTitle}
        </div>
        {t.rcRecapCards.map((c, i) => (
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
        {/* 版本脚注:17.4 浮现(17.5 继续讲,不再加视觉元素) */}
        <div style={{ opacity: fadeAt(segStart(17, 4)), fontSize: 21, color: "#94a3b8", margin: "26px 4px 0" }}>
          {t.rcRecapFootnote}
        </div>
        {/* 要点框(琥珀):17.6 */}
        <div style={{
          opacity: fadeAt(segStart(17, 6)),
          marginTop: 22, padding: "20px 30px", borderRadius: 18,
          background: "#fffbeb", border: "2px solid #fde68a",
        }}>
          <div style={{ fontSize: 30, color: "#92400e", fontWeight: 700 }}>
            {t.rcRecapKeyPoint}
          </div>
        </div>
        {/* 下一章框(靛蓝):step 18 */}
        <div style={{
          opacity: fadeAt(segStart(18, 0)),
          marginTop: 22, padding: "20px 30px", borderRadius: 18,
          background: "#eef2ff", border: "2px solid #c7d2fe",
        }}>
          <div style={{ fontSize: 22, color: "#6366f1", fontWeight: 700, marginBottom: 6 }}>{t.nextKicker}</div>
          <div style={{ fontSize: 32, color: "#312e81", fontWeight: 800 }}>
            {t.rcNextTitle}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
