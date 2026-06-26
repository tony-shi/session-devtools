import * as React from "react"

import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "@/components/ui/pagination"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

// 共享表格分页条 —— 把两个主表（SessionList / ProxyTraffic）的分页视觉收敛到同一种
// shadcn 风格：每页大小 Select + 数字页码（带省略号）+ 右侧状态文案。
//
// 背景：两表原本各写各的页脚（SessionList 用 shadcn 数字页码 + Select；ProxyTraffic
// 手写 "page X/Y" 文本 + 原生 <select>），差异 ~八成是血脉/时机造成的技术债而非需求。
// 本组件统一"视觉/结构"，同时用 props 保住两边真正不同的部分：
//   · zeroIndexed —— ProxyTraffic 的 page 是 1-based，且 page===1 绑定 SSE 直播流
//     （不可改基数），故用 flag 适配而非强行改它的页状态。
//   · pageSizeOptions —— proxy [25..200] vs 列表 [8..100]，属数据语义，各传各的。
//   · info(ctx) —— 右侧状态文案各保各的 i18n key（含 ProxyTraffic 的 loadingMore）。
export interface TablePaginationProps {
  /** 当前页（基数由 zeroIndexed 决定）。 */
  page: number
  pageSize: number
  /** 条目总数；页数 = ceil(total / pageSize)。 */
  total: number
  loading: boolean
  /** 回调用与入参相同的基数。 */
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
  pageSizeOptions: readonly number[]
  /** 每页大小标签（调用方用自己的 i18n 渲染）。 */
  perPageLabel: React.ReactNode
  /** 右侧状态文案 slot —— 收到组件算好的 1-based 当前页 / 总页 / 总数 / loading。 */
  info?: (ctx: { page1: number; totalPages: number; count: number; loading: boolean }) => React.ReactNode
  /** page 是否 0-based（默认 true，对齐 v2 主页面）。 */
  zeroIndexed?: boolean
  /** 单页时隐藏页码导航（保留 perPage + info）。ProxyTraffic 旧行为。 */
  hideWhenSinglePage?: boolean
  className?: string
}

export function TablePagination({
  page, pageSize, total, loading,
  onPageChange, onPageSizeChange,
  pageSizeOptions, perPageLabel, info,
  zeroIndexed = true,
  hideWhenSinglePage = false,
  className,
}: TablePaginationProps) {
  const base = zeroIndexed ? 0 : 1
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const cur = page - base // 0-based 当前页，供窗口计算与高亮

  // 数字页码窗口（移植自 SessionListV2，已验证）：<=7 全列；否则首/尾恒显 + 当前±1 + 省略号。
  const pageNums: (number | "…")[] = []
  if (totalPages <= 7) {
    for (let i = 0; i < totalPages; i++) pageNums.push(i)
  } else {
    pageNums.push(0)
    if (cur > 2) pageNums.push("…")
    for (let i = Math.max(1, cur - 1); i <= Math.min(totalPages - 2, cur + 1); i++) pageNums.push(i)
    if (cur < totalPages - 3) pageNums.push("…")
    pageNums.push(totalPages - 1)
  }

  const prevDisabled = cur <= 0 || loading
  const nextDisabled = cur >= totalPages - 1 || loading
  const showPager = !(hideWhenSinglePage && totalPages <= 1)

  return (
    <div className={cn("flex items-center gap-3 flex-wrap text-xs text-muted-foreground", className)}>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-gray-400">{perPageLabel}</span>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => onPageSizeChange(Number(v))}
          disabled={loading}
        >
          <SelectTrigger size="sm" className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizeOptions.map((s) => (
              <SelectItem key={s} value={String(s)} className="text-xs">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {showPager && (
        <Pagination className="mx-0 w-auto justify-start">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                aria-disabled={prevDisabled}
                className={cn("h-7 text-xs", prevDisabled && "pointer-events-none opacity-40")}
                onClick={(e) => { e.preventDefault(); if (!prevDisabled) onPageChange(page - 1); }}
              />
            </PaginationItem>
            {pageNums.map((p, i) =>
              p === "…" ? (
                <PaginationItem key={`ellipsis-${i}`}>
                  <PaginationEllipsis className="h-7" />
                </PaginationItem>
              ) : (
                <PaginationItem key={p}>
                  <PaginationLink
                    href="#"
                    isActive={p === cur}
                    className="h-7 min-w-7 text-xs"
                    onClick={(e) => { e.preventDefault(); if (p !== cur) onPageChange(p + base); }}
                  >
                    {p + 1}
                  </PaginationLink>
                </PaginationItem>
              )
            )}
            <PaginationItem>
              <PaginationNext
                href="#"
                aria-disabled={nextDisabled}
                className={cn("h-7 text-xs", nextDisabled && "pointer-events-none opacity-40")}
                onClick={(e) => { e.preventDefault(); if (!nextDisabled) onPageChange(page + 1); }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}

      {info && (
        <span className="text-[11px] text-gray-400">
          {info({ page1: cur + 1, totalPages, count: total, loading })}
        </span>
      )}
    </div>
  )
}
