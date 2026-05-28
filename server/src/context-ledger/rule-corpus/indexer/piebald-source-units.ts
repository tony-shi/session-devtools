// indexer/piebald-source-units.ts
//
// 扫 resources/piebald-system-prompts/system-prompts/*.md → SourceUnit[]。
//
// Piebald md 格式:
//   <!--
//   name: 'System Prompt: ...'
//   description: ...
//   ccVersion: 2.1.139
//   variables:
//     - VAR1
//   -->
//   <body>
//
// canonicalHash 用 strip 注释 + normalize whitespace 后的 sha256:16 计算。

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { load as yamlLoad } from "js-yaml";
import type { SourceUnit, SourceUnitKind } from "../schema";

// 默认 Piebald 快照路径:仓根/resources/piebald-system-prompts/
const __dirname = dirname(fileURLToPath(import.meta.url));
// indexer/ → rule-corpus/ → context-ledger/ → src/ → server/ → repo root
const DEFAULT_PIEBALD_ROOT = resolve(__dirname, "../../../../../resources/piebald-system-prompts");

const PIEBALD_REPO_ID = "Piebald-AI/claude-code-system-prompts";

// 文件 basename(去 .md)→ SourceUnitKind 前缀映射
function kindFromBasename(basename: string): SourceUnitKind | null {
  if (basename.startsWith("system-prompt-")) return "system-prompt";
  if (basename.startsWith("system-reminder-")) return "system-reminder";
  if (basename.startsWith("tool-")) return "tool-description";
  if (basename.startsWith("agent-prompt-")) return "agent-prompt";
  if (basename.startsWith("skill-")) return "skill";
  if (basename.startsWith("data-")) return "data";
  return null;
}

// 从 Piebald md 内容抽 HTML 注释 frontmatter,YAML-parse。
// 返回 { meta: parsed object, body: 注释之后的正文 }。
function parsePiebaldFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  // <!--\nKEY: VAL\n...\n--> 匹配第一个块
  const m = raw.match(/^<!--\s*\n([\s\S]*?)\n-->\s*\n?/);
  if (!m) return { meta: {}, body: raw };
  const inner = m[1]!;
  // YAML parse;若失败给空对象(不抛,允许 Piebald 偶尔有奇怪 md)
  let meta: Record<string, unknown> = {};
  try {
    const parsed = yamlLoad(inner) as unknown;
    if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
  } catch {
    /* malformed Piebald frontmatter: keep meta={} */
  }
  return { meta, body: raw.slice(m[0].length) };
}

// canonicalHash:normalize body(去 \r、collapse 连续空白、trim),sha256 前 16 hex。
function canonicalHash(body: string): string {
  const norm = body.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  return "sha256:" + createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

export interface IndexPiebaldOptions {
  /** 默认读 resources/piebald-system-prompts/;允许覆盖以适应不同部署或测试 */
  root?: string;
  /** 默认 "v2.1.150";仅用于 SourceUnit.ccVersion 兜底(每个文件自身有 ccVersion frontmatter 时优先) */
  fallbackCcVersion?: string;
}

/**
 * 扫 Piebald 快照,产出 SourceUnit[]。
 * 不读 frontmatter 不存在的文件:那些不在 system-prompts/ 目录的 md 直接跳过。
 */
export function indexPiebaldSourceUnits(opts: IndexPiebaldOptions = {}): SourceUnit[] {
  const root = opts.root ?? DEFAULT_PIEBALD_ROOT;
  const fallbackCcVersion = opts.fallbackCcVersion ?? "v2.1.150";

  const subdir = join(root, "system-prompts");
  if (!existsSync(subdir) || !statSync(subdir).isDirectory()) {
    throw new Error(`[indexer] Piebald system-prompts/ 目录不存在: ${subdir}`);
  }

  const out: SourceUnit[] = [];
  for (const name of readdirSync(subdir).sort()) {
    if (!name.endsWith(".md")) continue;
    const basename = name.slice(0, -3);
    const kind = kindFromBasename(basename);
    if (!kind) continue;

    const filePath = join(subdir, name);
    const raw = readFileSync(filePath, "utf8");
    const { meta, body } = parsePiebaldFrontmatter(raw);

    const ccVersion =
      typeof meta.ccVersion === "string" || typeof meta.ccVersion === "number"
        ? String(meta.ccVersion)
        : fallbackCcVersion;

    out.push({
      unitId: basename,
      file: `system-prompts/${name}`,
      kind,
      ccVersion,
      canonicalHash: canonicalHash(body),
    });
  }
  return out;
}

/** 索引并按 unitId 建 Map(供 drift 脚本快速查找)。 */
export function indexBySourceUnitId(opts: IndexPiebaldOptions = {}): Map<string, SourceUnit> {
  const m = new Map<string, SourceUnit>();
  for (const u of indexPiebaldSourceUnits(opts)) m.set(u.unitId, u);
  return m;
}

/** 读一个 SourceUnit 的 body 文本(供 drift 校验 pattern 命中)。 */
export function readSourceUnitBody(unit: SourceUnit, opts: IndexPiebaldOptions = {}): string {
  const root = opts.root ?? DEFAULT_PIEBALD_ROOT;
  const filePath = join(root, unit.file);
  const raw = readFileSync(filePath, "utf8");
  return parsePiebaldFrontmatter(raw).body;
}

/** 暴露 default root 给脚本(便于把绝对路径打到日志里)。 */
export const PIEBALD_DEFAULT_ROOT = DEFAULT_PIEBALD_ROOT;
export const PIEBALD_REPO = PIEBALD_REPO_ID;
