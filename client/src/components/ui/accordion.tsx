import * as React from "react"
import { Accordion as AccordionPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// 为 SessionNavRail 定制的精简 Accordion（基于 Radix）。与社区 shadcn 版的刻意差异：
//   · AccordionContent 不带 overflow-hidden / 高度动画 —— 本栏要的是"展开面板 flex
//     撑满剩余高度 + 内部滚动"，社区版的 max-height 过渡会和 flex-1 打架。
//   · AccordionTrigger 不内置 chevron —— 由调用方按域决定是否渲染（overview 是叶子，
//     无展开内容、不显示 chevron）。
// 仍复用 Radix 的单开状态机 + 键盘（↑↓ / Home / End 在各 trigger 间移动）+ aria 接线。

function Accordion({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      className={cn("flex flex-col min-h-0", className)}
      {...props}
    />
  )
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("flex flex-col", className)}
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex flex-none">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "w-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-300",
          className
        )}
        {...props}
      />
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className={cn("min-h-0", className)}
      {...props}
    />
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
