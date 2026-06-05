// HoverTip — 自定义浮层 tooltip（ledger 白卡风格）。从 DiffPanel 抽出以便复用
// （DiffPanel / leaf-detail/ToolDefinitionBody …）。对齐 LedgerExplainer 的视觉语言：
// 白底 + 灰边 + 软阴影 + 深灰文字。
//   - 触发：onMouseEnter / onMouseLeave 切换 show
//   - 定位：浮层经 portal 挂到 document.body、position:fixed，按 trigger 的
//     getBoundingClientRect 计算坐标；底部空间不足时自动向上翻转。
//     之所以用 portal/fixed 而非 absolute：absolute 浮层会撑大祖先滚动容器
//     （AttributionTreePanel 的 overflowX:auto 等）→ 滚动条出现 → 重排 →
//     trigger 移出光标 → mouseleave/enter 反复触发 → tooltip 不停闪烁。
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Placement = { left: number; top: number; transform: string };

export function HoverTip({
  content,
  children,
  align = "center",
}: {
  content: ReactNode;
  children: ReactNode;
  /** 默认 center；right 时把 tooltip 锚到右下避免溢出 */
  align?: "left" | "center" | "right";
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    if (!show) {
      setPos(null);
      return;
    }
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const gap = 8;
      const anchorX =
        align === "center" ? r.left + r.width / 2 :
        align === "right"  ? r.right : r.left;
      const transformX =
        align === "center" ? "-50%" :
        align === "right"  ? "-100%" : "0";
      // 默认贴 trigger 下方；下方放不下且上方放得下时翻到上方
      let top = r.bottom + gap;
      let transformY = "0";
      const h = tipRef.current?.offsetHeight ?? 0;
      if (top + h > window.innerHeight - 8 && r.top - gap - h > 8) {
        top = r.top - gap;
        transformY = "-100%";
      }
      setPos({ left: anchorX, top, transform: `translate(${transformX}, ${transformY})` });
    };
    place();
    // hover 期间页面滚动/缩放时跟随重定位（浮层在 body 上，否则会与 trigger 脱节）
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [show, align]);

  return (
    <span
      ref={triggerRef}
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && createPortal(
        <div
          ref={tipRef}
          style={{
            position: "fixed",
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            transform: pos?.transform ?? "none",
            // 首帧未完成测量前先隐藏，避免在 (0,0) 闪一下
            visibility: pos ? "visible" : "hidden",
            zIndex: 1000,
            background: "#fff",
            color: "#374151",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: "12px 14px",
            fontSize: 11,
            lineHeight: 1.5,
            maxWidth: 420,
            minWidth: 280,
            boxShadow: "0 8px 24px rgba(15,23,42,0.12), 0 2px 6px rgba(15,23,42,0.06)",
            whiteSpace: "normal",
            textAlign: "left",
            pointerEvents: "none",
          }}
        >
          {content}
        </div>,
        document.body,
      )}
    </span>
  );
}
