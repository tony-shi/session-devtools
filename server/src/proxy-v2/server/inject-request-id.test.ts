import { describe, it, expect } from "vitest";
import { injectSyntheticRequestId } from "./index";

describe("injectSyntheticRequestId", () => {
  it("缺失 request-id 时注入 proxy- 前缀的合成 ID，同时维护 rawHeaders", () => {
    const headers = { "content-type": "text/event-stream" };
    const rawHeaders = ["Content-Type", "text/event-stream"];
    injectSyntheticRequestId(headers, rawHeaders);
    const injected = headers["request-id"] as string;
    expect(injected).toMatch(/^proxy-/);
    // rawHeaders 同步追加
    expect(rawHeaders[rawHeaders.length - 2]).toBe("request-id");
    expect(rawHeaders[rawHeaders.length - 1]).toBe(injected);
  });

  it("上游已有 request-id 时不覆盖", () => {
    const headers = { "request-id": "req_011CXXXOriginal" };
    const rawHeaders = ["request-id", "req_011CXXXOriginal"];
    injectSyntheticRequestId(headers, rawHeaders);
    expect(headers["request-id"]).toBe("req_011CXXXOriginal");
    expect(rawHeaders.length).toBe(2); // 未追加
  });

  it("大小写不敏感：上游送 'Request-Id' 也不会再注入", () => {
    const headers = { "Request-Id": "req_xyz" } as Record<string, string>;
    const rawHeaders = ["Request-Id", "req_xyz"];
    injectSyntheticRequestId(headers, rawHeaders);
    expect(headers["request-id"]).toBeUndefined();
    expect(rawHeaders.length).toBe(2);
  });

  it("空串 request-id 视为缺失，仍注入", () => {
    const headers = { "request-id": "" };
    const rawHeaders = ["request-id", ""];
    injectSyntheticRequestId(headers, rawHeaders);
    expect(headers["request-id"]).toMatch(/^proxy-/);
  });
});
