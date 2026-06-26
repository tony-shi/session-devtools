// HoverTip — 通用 hover 浮层（ledger 白卡风格），薄封装 shadcn HoverCard。
//
// 历史背景：之前是 ~106 行 createPortal + 手写 getBoundingClientRect + 上下翻转 +
// scroll/resize 跟随重定位；现迁移到 shadcn HoverCard（Radix 底层），自动处理
// portal、碰撞翻转、视口纠偏、focus/键盘可达性。对齐 LedgerExplainer 同款迁移
// （见其文件头注释）。
//
// API 保持不变（content / children / align）—— 调用方零改动。align 映射到 Radix
// HoverCardContent 的 align：center→center、right→end、left→start。
import type { ReactNode } from "react";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";

export function HoverTip({
  content,
  children,
  align = "center",
}: {
  content: ReactNode;
  children: ReactNode;
  /** 默认 center；left / right 把浮层锚到对应边，避免溢出。 */
  align?: "left" | "center" | "right";
}) {
  const radixAlign = align === "center" ? "center" : align === "right" ? "end" : "start";
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <span style={{ display: "inline-flex", alignItems: "center" }}>{children}</span>
      </HoverCardTrigger>
      <HoverCardContent
        align={radixAlign}
        className="w-auto min-w-[280px] max-w-[420px] p-3.5 text-[11px] leading-[1.5] text-gray-700"
      >
        {content}
      </HoverCardContent>
    </HoverCard>
  );
}
