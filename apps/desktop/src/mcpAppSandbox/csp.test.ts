import { describe, expect, it } from "vitest";

import { buildMcpAppSandboxCsp } from "./csp";

const csp = {
  baseUriDomains: [],
  connectDomains: ["https://api.example.test"],
  frameDomains: [],
  includeDefaultDomains: false,
  isTrusted: true,
  resourceDomains: ["https://cdn.example.test"],
} as const;

describe("MCP App sandbox CSP", () => {
  it("does not turn provenance flags into a default allowlist", () => {
    const explicit = buildMcpAppSandboxCsp(csp);
    const flagsOnly = buildMcpAppSandboxCsp({
      ...csp,
      includeDefaultDomains: true,
      isTrusted: false,
    });
    expect(explicit?.csp).toBe(flagsOnly?.csp);
    expect(explicit?.csp).toContain("base-uri 'none'");
    expect(explicit?.csp).toContain(
      "connect-src https://api.example.test https://cdn.example.test",
    );
    expect(explicit?.csp).not.toContain("https://*.chatgpt.com");
  });

  it("keeps the response security headers bounded", () => {
    const result = buildMcpAppSandboxCsp(csp);
    expect(result?.headers).toMatchObject({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    expect(result?.headers["Permissions-Policy"]).toContain("camera=()");
  });

  it("only relaxes frame ancestors for the fixed inner route", () => {
    const outer = buildMcpAppSandboxCsp(csp);
    const inner = buildMcpAppSandboxCsp(csp, { frameAncestors: "'self'" });
    expect(outer?.csp).toContain("frame-ancestors 'none'");
    expect(inner?.csp).toContain("frame-ancestors 'self'");
    expect(inner?.csp.replace("frame-ancestors 'self'", "frame-ancestors 'none'")).toBe(outer?.csp);
  });
});
