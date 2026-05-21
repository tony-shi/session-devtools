import { describe, it, expect } from "vitest";
import { normalizeHost, normalizeHosts } from "./host-normalize";

describe("normalizeHost", () => {
  it("returns bare hostname unchanged", () => {
    expect(normalizeHost("my-gw.example.com")).toBe("my-gw.example.com");
  });

  it("strips https:// scheme", () => {
    expect(normalizeHost("https://my-gw.example.com")).toBe("my-gw.example.com");
  });

  it("strips http:// scheme", () => {
    expect(normalizeHost("http://my-gw.example.com")).toBe("my-gw.example.com");
  });

  it("preserves explicit port", () => {
    expect(normalizeHost("my-gw.example.com:8080")).toBe("my-gw.example.com:8080");
    expect(normalizeHost("https://my-gw.example.com:8080")).toBe("my-gw.example.com:8080");
  });

  it("drops default ports (80 for http, 443 for https)", () => {
    // URL ctor 把默认 port 隐去；这是符合预期的，proxy 端匹配是 `host:port`
    // 双查，且大多数客户端发的 CONNECT 不会带 :443 / :80 这种默认值。
    expect(normalizeHost("https://my-gw.example.com:443")).toBe("my-gw.example.com");
    expect(normalizeHost("http://my-gw.example.com:80")).toBe("my-gw.example.com");
  });

  it("accepts bare IPv4 and IPv4:port", () => {
    expect(normalizeHost("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeHost("127.0.0.1:8742")).toBe("127.0.0.1:8742");
  });

  it("lowercases hostname", () => {
    expect(normalizeHost("My-GW.Example.COM")).toBe("my-gw.example.com");
    expect(normalizeHost("HTTPS://My-GW.Example.COM")).toBe("my-gw.example.com");
  });

  it("strips trailing slash and path", () => {
    expect(normalizeHost("my-gw.example.com/")).toBe("my-gw.example.com");
    expect(normalizeHost("https://my-gw.example.com/v1/messages")).toBe("my-gw.example.com");
    expect(normalizeHost("https://my-gw.example.com:8080/v1?foo=1")).toBe("my-gw.example.com:8080");
  });

  it("trims whitespace", () => {
    expect(normalizeHost("  my-gw.example.com  ")).toBe("my-gw.example.com");
  });

  it("rejects empty / whitespace-only", () => {
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("   ")).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost(undefined)).toBeNull();
    expect(normalizeHost(123)).toBeNull();
    expect(normalizeHost({})).toBeNull();
  });

  it("rejects strings with embedded whitespace", () => {
    expect(normalizeHost("my gw.example.com")).toBeNull();
  });

  it("rejects malformed url-like inputs", () => {
    expect(normalizeHost("https://")).toBeNull();
    expect(normalizeHost(":8080")).toBeNull();
  });
});

describe("normalizeHosts", () => {
  it("normalizes, de-dupes, and drops api.anthropic.com", () => {
    const out = normalizeHosts([
      "https://my-gw.example.com",
      "my-gw.example.com",          // dup post-normalize
      "MY-GW.example.com",           // dup post-normalize (case)
      "api.anthropic.com",           // baseline, dropped
      "https://api.anthropic.com",   // baseline, dropped after normalize
      "127.0.0.1:8742",
      "",                            // empty, dropped
      " bad input ",                 // whitespace in middle, dropped
    ]);
    expect(out).toEqual(["my-gw.example.com", "127.0.0.1:8742"]);
  });

  it("returns empty array on all-invalid input", () => {
    expect(normalizeHosts([null, "", "   ", 42 as unknown as string])).toEqual([]);
  });
});
