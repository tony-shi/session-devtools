import { describe, it, expect } from "vitest";
import { extractAttributionContext } from "./context";

describe("extractAttributionContext", () => {
  function makeReqBody(system0Text: string | null) {
    if (system0Text === null) return { system: [] };
    return { system: [{ type: "text", text: system0Text }] };
  }

  it("抽取完整 cc_version / entrypoint / cch", () => {
    const res = extractAttributionContext(
      makeReqBody("x-anthropic-billing-header: cc_version=2.1.140.453; cc_entrypoint=cli; cch=e7a06;"),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ctx.ccVersion).toBe("2.1.140.453");
      expect(res.ctx.entrypoint).toBe("cli");
      expect(res.ctx.cch).toBe("e7a06");
      expect(res.ctx.workload).toBeUndefined();
    }
  });

  it("缺 cch 也合法", () => {
    const res = extractAttributionContext(
      makeReqBody("x-anthropic-billing-header: cc_version=2.1.142.6c2; cc_entrypoint=cli;"),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ctx.ccVersion).toBe("2.1.142.6c2");
      expect(res.ctx.cch).toBeUndefined();
    }
  });

  it("带 cc_workload", () => {
    const res = extractAttributionContext(
      makeReqBody("x-anthropic-billing-header: cc_version=2.1.140.453; cc_entrypoint=cli; cch=e7a06; cc_workload=cron;"),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ctx.workload).toBe("cron");
    }
  });

  it("IDE entrypoint（kebab）", () => {
    const res = extractAttributionContext(
      makeReqBody("x-anthropic-billing-header: cc_version=2.1.140.453; cc_entrypoint=claude-vscode;"),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ctx.entrypoint).toBe("claude-vscode");
    }
  });

  it("system[0] 缺失 → no_system_block_0", () => {
    const res = extractAttributionContext(makeReqBody(null));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe("no_system_block_0");
  });

  it("system[0] 不是 text → system_block_0_not_text", () => {
    const res = extractAttributionContext({ system: [{ type: "image" } as { type: string }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe("system_block_0_not_text");
  });

  it("text 不符合 billing header 形态 → billing_header_not_matched", () => {
    const res = extractAttributionContext(
      makeReqBody("You are Claude Code, Anthropic's official CLI for Claude."),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe("billing_header_not_matched");
  });
});
