import { describe, expect, it } from "vitest";

import {
  isAllowedMcpAppNetworkUrl,
  isExactMcpAppSandboxContentUrl,
  isExactMcpAppSandboxUrl,
  mcpAppSandboxContentUrl,
  isMcpAppSandboxPartition,
} from "./policy";

const csp = {
  baseUriDomains: ["https://base.example.test"],
  connectDomains: ["https://api.example.test", "wss://socket.example.test"],
  frameDomains: ["https://frames.example.test"],
  includeDefaultDomains: false,
  isTrusted: true,
  resourceDomains: ["https://cdn.example.test", "data:", "blob:"],
} as const;

const descriptor = {
  generation: 0,
  initId: "init-1",
  origin: "moss-mcp-sandbox://mcp-test",
  partition: "moss-mcp-mcp-test",
  sandboxId: "mcp-test",
  src: "moss-mcp-sandbox://mcp-test/ui?generation=0#init=init-1",
} as const;

describe("MCP App sandbox policy", () => {
  it("requires the exact main-frame authority and non-persistent partition", () => {
    expect(isMcpAppSandboxPartition(descriptor.partition, descriptor.sandboxId)).toBe(true);
    expect(isMcpAppSandboxPartition("persist:moss-browser", descriptor.sandboxId)).toBe(false);
    expect(isExactMcpAppSandboxUrl(descriptor.src, descriptor)).toBe(true);
    expect(isExactMcpAppSandboxUrl(`${descriptor.src}&extra=1`, descriptor)).toBe(false);
    expect(
      isExactMcpAppSandboxUrl(descriptor.src.replace("#init=init-1", "#init=other"), descriptor),
    ).toBe(false);
  });

  it("denies privileged shell subframes and enforces exact declared ports", () => {
    expect(
      isAllowedMcpAppNetworkUrl(
        "moss-mcp-sandbox://mcp-test/ui?generation=0#init=init-1",
        "frame-src",
        csp,
        descriptor.origin,
      ),
    ).toBe(false);
    expect(
      isAllowedMcpAppNetworkUrl(
        "https://api.example.test/path",
        "connect-src",
        csp,
        descriptor.origin,
      ),
    ).toBe(true);
    expect(
      isAllowedMcpAppNetworkUrl(
        "https://cdn.example.test/script.js",
        "connect-src",
        csp,
        descriptor.origin,
      ),
    ).toBe(true);
    expect(
      isAllowedMcpAppNetworkUrl(
        "https://api.example.test:8443/path",
        "connect-src",
        csp,
        descriptor.origin,
      ),
    ).toBe(false);
    expect(
      isAllowedMcpAppNetworkUrl("wss://socket.example.test", "connect-src", csp, descriptor.origin),
    ).toBe(true);
    expect(
      isAllowedMcpAppNetworkUrl(
        "wss://socket.example.test:8443",
        "connect-src",
        csp,
        descriptor.origin,
      ),
    ).toBe(false);
    expect(
      isAllowedMcpAppNetworkUrl("https://frames.example.test", "frame-src", csp, descriptor.origin),
    ).toBe(true);
    expect(
      isAllowedMcpAppNetworkUrl("https://evil.example.test", "frame-src", csp, descriptor.origin),
    ).toBe(false);
  });

  it("admits only the exact current same-origin inner content route", () => {
    const contentUrl = mcpAppSandboxContentUrl(descriptor);
    expect(contentUrl).toBe("moss-mcp-sandbox://mcp-test/content?generation=0&init=init-1");
    expect(isExactMcpAppSandboxContentUrl(contentUrl, descriptor)).toBe(true);
    for (const invalid of [
      `${contentUrl}&extra=1`,
      contentUrl.replace("?generation=0&init=init-1", "?init=init-1&generation=0"),
      contentUrl.replace("&init=init-1", "&init=stale"),
      contentUrl.replace("&init=init-1", "&init=init-1&init=duplicate"),
      `${contentUrl}#fragment`,
      "moss-mcp-sandbox://other/content?generation=0&init=init-1",
      "moss-mcp-sandbox://mcp-test/ui?generation=0&init=init-1",
    ]) {
      expect(isExactMcpAppSandboxContentUrl(invalid, descriptor)).toBe(false);
    }
  });
});
