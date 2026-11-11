import { describe, expect, it } from "vitest";

import {
  isAllowedMcpAppNetworkUrl,
  isAllowedMcpAppSubframeUrl,
  isExactMcpAppSandboxUrl,
  isMcpAppSandboxPartition,
} from "./policy";

const policy = {
  connectDomains: ["https://api.example.test", "wss://socket.example.test"],
  frameDomains: ["https://frames.example.test"],
  resourceDomains: ["https://cdn.example.test"],
} as const;

const label = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const descriptor = {
  generation: 0,
  initId: "init-1",
  origin: `moss-mcp-sandbox://${label}`,
  partition: `moss-mcp-${label}`,
  sandboxId: label,
  src: `moss-mcp-sandbox://${label}/mcp_apps?generation=0&route=00112233aabbccdd#init=init-1`,
} as const;

describe("MCP App sandbox policy", () => {
  it("requires the exact main-frame authority and non-persistent partition", () => {
    expect(isMcpAppSandboxPartition(descriptor.partition, descriptor.sandboxId)).toBe(true);
    expect(isMcpAppSandboxPartition("persist:moss-browser", descriptor.sandboxId)).toBe(false);
    expect(isMcpAppSandboxPartition(`persist:${descriptor.partition}`)).toBe(false);
    expect(isExactMcpAppSandboxUrl(descriptor.src, descriptor)).toBe(true);
    for (const invalid of [
      `${descriptor.src}&extra=1`,
      descriptor.src.replace("#init=init-1", "#init=other"),
      descriptor.src.replace("/mcp_apps", "/ui"),
      descriptor.src.replace("generation=0", "generation=1"),
      descriptor.src.replace("&route=00112233aabbccdd", ""),
    ]) {
      expect(isExactMcpAppSandboxUrl(invalid, descriptor)).toBe(false);
    }
  });

  it("maps connect-src to connectDomains only and enforces exact declared ports", () => {
    expect(isAllowedMcpAppNetworkUrl("https://api.example.test/path", "connect-src", policy)).toBe(
      true,
    );
    // Resource domains are not connect sources (the reference mapping).
    expect(isAllowedMcpAppNetworkUrl("https://cdn.example.test/a.js", "connect-src", policy)).toBe(
      false,
    );
    expect(isAllowedMcpAppNetworkUrl("https://cdn.example.test/a.js", "resource", policy)).toBe(
      true,
    );
    expect(
      isAllowedMcpAppNetworkUrl("https://api.example.test:8443/path", "connect-src", policy),
    ).toBe(false);
    expect(isAllowedMcpAppNetworkUrl("wss://socket.example.test", "connect-src", policy)).toBe(
      true,
    );
    expect(isAllowedMcpAppNetworkUrl("wss://socket.example.test:8443", "connect-src", policy)).toBe(
      false,
    );
    expect(isAllowedMcpAppNetworkUrl("https://frames.example.test", "frame-src", policy)).toBe(
      true,
    );
    expect(isAllowedMcpAppNetworkUrl("https://evil.example.test", "frame-src", policy)).toBe(false);
  });

  it("never lets a widget reach the sandbox scheme except the exact font asset", () => {
    expect(isAllowedMcpAppNetworkUrl(descriptor.src, "frame-src", policy)).toBe(false);
    expect(isAllowedMcpAppNetworkUrl(descriptor.src, "connect-src", policy)).toBe(false);
    expect(isAllowedMcpAppNetworkUrl(descriptor.src, "resource", policy)).toBe(false);
    expect(
      isAllowedMcpAppNetworkUrl(
        "moss-mcp-sandbox://assets/fonts/inter-latin.woff2",
        "resource",
        policy,
      ),
    ).toBe(true);
    for (const invalid of [
      "moss-mcp-sandbox://assets/fonts/inter-latin.woff2?x=1",
      "moss-mcp-sandbox://assets/fonts/other.woff2",
      "moss-mcp-sandbox://assets/mcp_apps",
    ]) {
      expect(isAllowedMcpAppNetworkUrl(invalid, "resource", policy)).toBe(false);
    }
    expect(
      isAllowedMcpAppNetworkUrl(
        "moss-mcp-sandbox://assets/fonts/inter-latin.woff2",
        "connect-src",
        policy,
      ),
    ).toBe(false);
  });

  it("admits srcdoc, blank, data and blob sub-frames plus the allowed frame sites", () => {
    for (const url of [
      "about:srcdoc",
      "about:blank",
      "data:text/html,<p>x</p>",
      "blob:null/1234",
      "https://frames.example.test/embed",
    ]) {
      expect(isAllowedMcpAppSubframeUrl(url, policy)).toBe(true);
    }
    for (const url of [
      "https://evil.example.test/",
      descriptor.src,
      "moss-mcp-sandbox://assets/fonts/inter-latin.woff2",
      "file:///C:/Windows/win.ini",
      "javascript:alert(1)",
    ]) {
      expect(isAllowedMcpAppSubframeUrl(url, policy)).toBe(false);
    }
  });
});
