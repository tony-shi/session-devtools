import { describe, expect, test } from "bun:test";
import {
  assertSectionsLossless,
  blockHasDynamicSections,
  splitProxyBlockSections,
} from "./block-splitter";
import type { ProxyRequestInput } from "./snapshot-parser";
import { parseClaudeProxyRequest } from "./snapshot-parser";

// ── 单元测试：splitter 核心逻辑 ───────────────────────────────────────────────

describe("splitProxyBlockSections", () => {
  test("空字符串返回空数组", () => {
    expect(splitProxyBlockSections("")).toHaveLength(0);
  });

  test("无 h1 header：整块作为单 section，header=null", () => {
    const text = "hello\nworld\nno headers here";
    const sections = splitProxyBlockSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.header).toBeNull();
    expect(sections[0]!.startChar).toBe(0);
    expect(sections[0]!.endChar).toBe(text.length);
    expect(sections[0]!.text).toBe(text);
    expect(sections[0]!.stabilityHint).toBe("unknown");
  });

  test("单 h1 header，无 prelude", () => {
    const text = "# System\nsome content\n";
    const sections = splitProxyBlockSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.header).toBe("System");
    expect(sections[0]!.startChar).toBe(0);
    expect(sections[0]!.endChar).toBe(text.length);
    expect(sections[0]!.stabilityHint).toBe("static");
  });

  test("多 h1 header，无 prelude", () => {
    const text = "# System\ncontent1\n# Doing tasks\ncontent2\n";
    const sections = splitProxyBlockSections(text);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.header).toBe("System");
    expect(sections[1]!.header).toBe("Doing tasks");
  });

  test("header 前有 prelude：prelude 作为 header=null section", () => {
    const text = "\npreamble text\n\n# System\ncontent\n";
    const sections = splitProxyBlockSections(text);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.header).toBeNull();
    expect(sections[0]!.text).toBe("\npreamble text\n\n");
    expect(sections[1]!.header).toBe("System");
  });

  test("dynamic headers 被标记为 stabilityHint=dynamic", () => {
    const text = "# Session-specific guidance\nsome\n# auto memory\nmem\n# Environment\nenv\n";
    const sections = splitProxyBlockSections(text);
    expect(sections).toHaveLength(3);
    for (const s of sections) {
      expect(s.stabilityHint).toBe("dynamic");
    }
  });

  test("static header 被标记为 stabilityHint=static", () => {
    const text = "# Tone and style\ncontent\n";
    const sections = splitProxyBlockSections(text);
    expect(sections[0]!.stabilityHint).toBe("static");
  });

  test("未知 header 保持 stabilityHint=unknown", () => {
    const text = "# My Custom Section\ncontent\n";
    const sections = splitProxyBlockSections(text);
    expect(sections[0]!.stabilityHint).toBe("unknown");
  });

  test("dynamic headers 混在 static headers 后面", () => {
    const text = [
      "# System",
      "sys content",
      "# Doing tasks",
      "task content",
      "# Session-specific guidance",
      "session content",
      "# Environment",
      "env content",
      "",
    ].join("\n");

    const sections = splitProxyBlockSections(text);
    expect(sections).toHaveLength(4);
    expect(sections[0]!.stabilityHint).toBe("static");    // System
    expect(sections[1]!.stabilityHint).toBe("static");    // Doing tasks
    expect(sections[2]!.stabilityHint).toBe("dynamic");   // Session-specific guidance
    expect(sections[3]!.stabilityHint).toBe("dynamic");   // Environment
  });

  test("char range 可精确还原原文 slice", () => {
    const text = "prelude\n# System\ncontent\n# Environment\nenv\n";
    const sections = splitProxyBlockSections(text);
    for (const s of sections) {
      expect(text.slice(s.startChar, s.endChar)).toBe(s.text);
    }
  });

  test("## 二级标题不被识别为分界点", () => {
    const text = "# System\ncontent\n## subsection\nmore content\n";
    const sections = splitProxyBlockSections(text);
    // 只有一个 section（# System 整体，## 不分割）
    expect(sections).toHaveLength(1);
    expect(sections[0]!.header).toBe("System");
  });

  test("#无空格不被识别为 header", () => {
    const text = "#System\ncontent\n";
    const sections = splitProxyBlockSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.header).toBeNull();
  });
});

// ── assertSectionsLossless ─────────────────────────────────────────────────────

describe("assertSectionsLossless", () => {
  test("正常拼接不抛出", () => {
    const text = "# System\ncontent\n# Environment\nenv\n";
    const sections = splitProxyBlockSections(text);
    expect(() => assertSectionsLossless(text, sections)).not.toThrow();
  });
});

// ── blockHasDynamicSections ───────────────────────────────────────────────────

describe("blockHasDynamicSections", () => {
  test("包含 dynamic section 时返回 true", () => {
    const sections = splitProxyBlockSections("# System\nc\n# Environment\nenv\n");
    expect(blockHasDynamicSections(sections)).toBe(true);
  });

  test("全部 static 时返回 false", () => {
    const sections = splitProxyBlockSections("# System\nc\n# Doing tasks\nd\n");
    expect(blockHasDynamicSections(sections)).toBe(false);
  });

  test("无 header 时返回 false", () => {
    const sections = splitProxyBlockSections("just text");
    expect(blockHasDynamicSections(sections)).toBe(false);
  });
});

// ── fixture 回归测试：system-tools-overhead ────────────────────────────────────

const FIXTURES_DIR = new URL(
  "../../../test/fixtures/context-reconstruction/",
  import.meta.url,
);

describe("fixture 回归：system-tools-overhead non-global-cache system[2]", () => {
  async function loadFixtureSystem2Text(): Promise<string> {
    const url = new URL("system-tools-overhead/proxy-request.json", FIXTURES_DIR);
    const raw = await Bun.file(url).json();
    return (raw.reqBody.system[2] as { text: string }).text;
  }

  test("system[2] 被识别为多个 section（> 1）", async () => {
    const text = await loadFixtureSystem2Text();
    const sections = splitProxyBlockSections(text);
    expect(sections.length).toBeGreaterThan(1);
  });

  test("包含 '# Session-specific guidance'、'# auto memory'、'# Environment' 三个独立 section", async () => {
    const text = await loadFixtureSystem2Text();
    const sections = splitProxyBlockSections(text);
    const headers = sections.map((s) => s.header).filter(Boolean);
    expect(headers).toContain("Session-specific guidance");
    expect(headers).toContain("auto memory");
    expect(headers).toContain("Environment");
  });

  test("dynamic boundary 从 '# Session-specific guidance' 开始，不是从 '# Environment' 才开始", async () => {
    const text = await loadFixtureSystem2Text();
    const sections = splitProxyBlockSections(text);
    // 找第一个 dynamic section 的 index
    const firstDynamicIdx = sections.findIndex((s) => s.stabilityHint === "dynamic");
    // 找 # Environment 的 index
    const envIdx = sections.findIndex((s) => s.header === "Environment");
    // 第一个 dynamic 应该早于（或等于）# Environment（即 # Session-specific guidance 更早）
    expect(firstDynamicIdx).toBeGreaterThanOrEqual(0);
    expect(firstDynamicIdx).toBeLessThan(envIdx);
  });

  test("所有 section 拼接后与原始 block 内容完全一致（无损）", async () => {
    const text = await loadFixtureSystem2Text();
    const sections = splitProxyBlockSections(text);
    expect(() => assertSectionsLossless(text, sections)).not.toThrow();
    const reconstructed = sections.map((s) => s.text).join("");
    expect(reconstructed).toBe(text);
  });

  test("每个 section 的 text 等于原始 block 的 slice(startChar, endChar)", async () => {
    const text = await loadFixtureSystem2Text();
    const sections = splitProxyBlockSections(text);
    for (const s of sections) {
      expect(text.slice(s.startChar, s.endChar)).toBe(s.text);
    }
  });

  test("parseClaudeProxyRequest 对 system[2] 产出多个 segment（pseg-system-2-s*）", async () => {
    const url = new URL("system-tools-overhead/proxy-request.json", FIXTURES_DIR);
    const raw = await Bun.file(url).json() as ProxyRequestInput;
    const snapshot = parseClaudeProxyRequest(raw, {
      proxyFile: "system-tools-overhead/proxy-request.json",
    });

    // system[2] 有多个 sections → segment id 应该是 pseg-system-2-s0, pseg-system-2-s1, ...
    const system2Segments = snapshot.segments.filter((s) =>
      s.id.startsWith("pseg-system-2-s"),
    );
    expect(system2Segments.length).toBeGreaterThan(1);
  });

  test("parser 全保守：所有 system[2] section 的 category=system_prompt，lifecycle 不设", async () => {
    const url = new URL("system-tools-overhead/proxy-request.json", FIXTURES_DIR);
    const raw = await Bun.file(url).json() as ProxyRequestInput;
    const snapshot = parseClaudeProxyRequest(raw, {
      proxyFile: "system-tools-overhead/proxy-request.json",
    });

    const s2segs = snapshot.segments.filter((s) => s.id.startsWith("pseg-system-2-s"));
    expect(s2segs.length).toBeGreaterThan(1);
    for (const seg of s2segs) {
      expect(seg.category).toBe("system_prompt");
      expect(seg.lifecycle).toBeUndefined();
    }
  });

  test("parser metadata 只含中性结构事实（sectionHeader/sectionIndex/blockIndex，无 stabilityHint）", async () => {
    const url = new URL("system-tools-overhead/proxy-request.json", FIXTURES_DIR);
    const raw = await Bun.file(url).json() as ProxyRequestInput;
    const snapshot = parseClaudeProxyRequest(raw, {
      proxyFile: "system-tools-overhead/proxy-request.json",
    });

    const s2segs = snapshot.segments.filter((s) => s.id.startsWith("pseg-system-2-s"));
    for (const seg of s2segs) {
      const meta = seg.metadata as Record<string, unknown> | undefined;
      // 不应有 stabilityHint（已迁到 attribution）
      expect(meta?.["stabilityHint"]).toBeUndefined();
      // 有 sectionHeader（中性结构事实）
      expect(meta?.["sectionIndex"]).toBeDefined();
    }
  });

  test("dynamic section 的 sourceRef 含 charRange", async () => {
    const url = new URL("system-tools-overhead/proxy-request.json", FIXTURES_DIR);
    const raw = await Bun.file(url).json() as ProxyRequestInput;
    const snapshot = parseClaudeProxyRequest(raw, {
      proxyFile: "system-tools-overhead/proxy-request.json",
    });

    // 用 sectionHeader 找 Environment section（已知是 dynamic 的 section）
    const envSeg = snapshot.segments.find(
      (s) =>
        s.id.startsWith("pseg-system-2-s") &&
        (s.metadata as Record<string, unknown> | undefined)?.["sectionHeader"] === "Environment",
    );
    expect(envSeg).toBeDefined();
    const ref = envSeg!.sourceRefs[0]!;
    expect(ref.kind).toBe("proxy");
    if (ref.kind === "proxy") {
      expect(ref.proxy.charRange).toBeDefined();
      expect(ref.proxy.charRange!.start).toBeGreaterThan(0);
      expect(ref.proxy.charRange!.end).toBeGreaterThan(ref.proxy.charRange!.start);
    }
  });
});
