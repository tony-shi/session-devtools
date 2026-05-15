// proxy-block-splitter：把 system text block 按 markdown h1 切成 ProxyBlockSection[]。
//
// 设计原则：
//   - 纯函数，不依赖外部状态，不修改输入
//   - 保守规则：只识别行首一级标题（/^# .+/），不解析二级及以下
//   - 无损：所有 section.text 拼接后与原始 block 内容完全一致
//   - char range 基于原始 block text 的 byte offset，不是行号
//   - 没有可识别 header 时，整块作为单 section 返回，行为兼容旧逻辑
//
// stabilityHint：
//   - "dynamic"：已知每次请求都会变化的 section（session/env/memory）
//   - "static"：已知内容稳定（session 级）的 section
//   - "unknown"：无法从 header 名称推断稳定性
//
// 参考 sourcemap：
//   restored-src/src/constants/prompts.ts（getSystemPrompt dynamic sections 列表）

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type SectionStabilityHint = "static" | "dynamic" | "unknown";

export interface ProxyBlockSection {
  // header 文本（不含 "# " 前缀和行尾空白），例如 "Environment"
  // prelude section（第一个 header 之前的内容）header 为 null
  header: string | null;
  // 在原始 block text 内的 char offset，左闭右开 [startChar, endChar)
  startChar: number;
  endChar: number;
  // block text 的 slice(startChar, endChar)，可直接使用
  text: string;
  // 稳定性提示，attribution rule 消费时可用
  stabilityHint: SectionStabilityHint;
}

// ── 已知 dynamic section headers（来自 sourcemap getSessionSpecificGuidanceSection
//    + computeSimpleEnvInfo + loadMemoryPrompt，均在 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 之后）
// 参考 restored-src/src/constants/prompts.ts:491-555
export const DYNAMIC_SECTION_HEADERS = new Set([
  "Session-specific guidance",
  "auto memory",
  "Environment",
  // Language section 只在用户配置了 settings.language 时出现，同样是 dynamic
  "Language",
]);

// 已知 static section headers（SYSTEM_PROMPT_DYNAMIC_BOUNDARY 之前的内容）
// 列出常见的几个，用于 stabilityHint=static 的快速识别
export const STATIC_SECTION_HEADERS = new Set([
  "System",
  "Doing tasks",
  "Executing actions with care",
  "Using your tools",
  "Tone and style",
  "Text output (does not apply to tool calls)",
  "Text output",
  // 以下是其他已知静态 section
  "Output efficiency",
  "Session-specific guidance context",
]);

// ── h1 header 识别正则
// 匹配行首 "# " 后跟至少一个非空字符，允许行尾空白
// 保守：不匹配 ## 及以下，不匹配 "#" 后没有空格的情况
const H1_HEADER_RE = /^# (.+?)\s*$/;

// ── 核心函数 ──────────────────────────────────────────────────────────────────

/**
 * 把 system block 的文本内容按 markdown h1 切分为 ProxyBlockSection[]。
 *
 * @param text 原始 block text（可含前导换行）
 * @returns 至少一个 section；sections 的 text 拼接等于输入 text
 */
export function splitProxyBlockSections(text: string): ProxyBlockSection[] {
  // 空 block 直接返回空数组（无内容可切）
  if (!text) return [];

  // 按行扫描，记录每个 h1 header 的 char offset
  interface HeaderMark {
    header: string;
    charOffset: number; // 该行在 text 中的起始 offset
  }

  const marks: HeaderMark[] = [];
  let charOffset = 0;

  for (const line of text.split("\n")) {
    const m = H1_HEADER_RE.exec(line);
    if (m) {
      marks.push({ header: m[1]!, charOffset });
    }
    // +1 是换行符本身
    charOffset += line.length + 1;
  }

  // 没有任何 h1：整块作为单 section，header=null
  if (marks.length === 0) {
    return [
      {
        header: null,
        startChar: 0,
        endChar: text.length,
        text,
        stabilityHint: "unknown",
      },
    ];
  }

  const sections: ProxyBlockSection[] = [];

  // prelude：第一个 header 之前的内容（可能是空字符串或换行）
  const firstMark = marks[0]!;
  if (firstMark.charOffset > 0) {
    const preludeText = text.slice(0, firstMark.charOffset);
    sections.push({
      header: null,
      startChar: 0,
      endChar: firstMark.charOffset,
      text: preludeText,
      stabilityHint: "unknown",
    });
  }

  // 每个 header section：从当前 header 行起始 → 下一个 header 行起始（或文本末尾）
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const nextMark = marks[i + 1];
    const startChar = mark.charOffset;
    const endChar = nextMark ? nextMark.charOffset : text.length;
    const sectionText = text.slice(startChar, endChar);

    sections.push({
      header: mark.header,
      startChar,
      endChar,
      text: sectionText,
      stabilityHint: inferStabilityHint(mark.header),
    });
  }

  return sections;
}

// ── 稳定性推断 ────────────────────────────────────────────────────────────────

function inferStabilityHint(header: string): SectionStabilityHint {
  if (DYNAMIC_SECTION_HEADERS.has(header)) return "dynamic";
  if (STATIC_SECTION_HEADERS.has(header)) return "static";
  return "unknown";
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 验证 sections 的 text 拼接是否与原始 text 完全一致（用于断言/测试）。
 */
export function assertSectionsLossless(text: string, sections: ProxyBlockSection[]): void {
  const reconstructed = sections.map((s) => s.text).join("");
  if (reconstructed !== text) {
    throw new Error(
      `splitProxyBlockSections: lossless check failed. ` +
        `original.length=${text.length}, reconstructed.length=${reconstructed.length}`,
    );
  }
}

/**
 * 判断 block 是否包含 dynamic section（至少一个 stabilityHint=dynamic）。
 * 用于 attribution rule 快速判断是否需要 section 级处理。
 */
export function blockHasDynamicSections(sections: ProxyBlockSection[]): boolean {
  return sections.some((s) => s.stabilityHint === "dynamic");
}
