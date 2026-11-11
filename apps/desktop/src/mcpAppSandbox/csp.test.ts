import { describe, expect, it } from "vitest";

import {
  buildMcpAppSandboxCsp,
  buildMcpAppSandboxPolicy,
  mcpAppSandboxAllowList,
  type McpAppSandboxEffectivePolicy,
} from "./csp";

const csp = {
  baseUriDomains: ["https://base.example.test"],
  connectDomains: ["https://api.example.test", "wss://socket.example.test"],
  frameDomains: [],
  includeDefaultDomains: false,
  isTrusted: true,
  resourceDomains: ["https://cdn.example.test"],
} as const;

function policyOf(
  overrides: Partial<typeof csp> = {},
  permissions: Record<string, boolean> = {},
): McpAppSandboxEffectivePolicy {
  const policy = buildMcpAppSandboxPolicy({ ...csp, ...overrides }, permissions);
  if (!policy) throw new Error("expected a policy");
  return policy;
}

function directives(value: string): Map<string, string> {
  return new Map(
    value.split("; ").map((directive) => {
      const space = directive.indexOf(" ");
      return [directive.slice(0, space), directive.slice(space + 1)];
    }),
  );
}

describe("MCP App sandbox CSP", () => {
  it("maps the declared lists onto the reference directives", () => {
    const result = buildMcpAppSandboxCsp(policyOf());
    const map = directives(result!.csp);
    const resources = "https://cdn.example.test moss-mcp-sandbox://assets";
    expect(map.get("default-src")).toBe("'self'");
    expect(map.get("script-src")).toBe(
      `'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resources}`,
    );
    expect(map.get("style-src")).toBe(`'self' 'unsafe-inline' ${resources}`);
    expect(map.get("img-src")).toBe(`'self' data: blob: ${resources}`);
    expect(map.get("font-src")).toBe(`'self' data: ${resources}`);
    expect(map.get("media-src")).toBe(`'self' blob: data: ${resources}`);
    expect(map.get("worker-src")).toBe(`'self' blob: ${resources}`);
    expect(map.get("connect-src")).toBe(
      "'self' blob: data: https://api.example.test wss://socket.example.test",
    );
    expect(map.get("frame-src")).toBe("blob: data:");
    // baseUriDomains are ignored.
    expect(map.get("base-uri")).toBe("'self'");
    expect(result!.csp).not.toContain("base.example.test");
    expect(map.get("object-src")).toBe("'none'");
    expect(map.get("form-action")).toBe("'self'");
    expect(map.get("frame-ancestors")).toBe("'none'");
  });

  it("always lists the sandbox asset origin, even with no declared domains", () => {
    const result = buildMcpAppSandboxCsp(
      policyOf({ resourceDomains: [], connectDomains: [] } as never),
    );
    const map = directives(result!.csp);
    expect(map.get("font-src")).toBe("'self' data: moss-mcp-sandbox://assets");
    expect(map.get("connect-src")).toBe("'self' blob: data:");
  });

  it("does not turn provenance flags into a default allowlist", () => {
    const explicit = buildMcpAppSandboxCsp(policyOf());
    const flagsOnly = buildMcpAppSandboxCsp(
      policyOf({ includeDefaultDomains: true, isTrusted: false } as never),
    );
    expect(explicit?.csp).toBe(flagsOnly?.csp);
  });

  it("filters frame sites and then withholds device permissions", () => {
    const policy = policyOf(
      {
        frameDomains: [
          "https://maps.example.com",
          "https://claude.ai",
          "https://x.inkcomicai.com",
          "https://*.github.io",
          "https://maps.example.com:443",
        ],
      } as never,
      { camera: true, clipboardWrite: true },
    );
    expect(policy.frameDomains).toEqual(["https://maps.example.com"]);
    expect(policy.refusedFrameDomains).toEqual([
      "https://claude.ai",
      "https://x.inkcomicai.com",
      "https://*.github.io",
    ]);
    expect(policy.withholdDevicePermissions).toBe(true);
    expect(policy.permissions).toEqual({});
    const result = buildMcpAppSandboxCsp(policy);
    expect(directives(result!.csp).get("frame-src")).toBe("blob: data: https://maps.example.com");
    expect(result!.headers["Permissions-Policy"]).toBe(
      "camera=(), microphone=(), geolocation=(), clipboard-write=(), usb=(), clipboard-read=(), display-capture=(), fullscreen=(), picture-in-picture=()",
    );
  });

  it("opens Permissions-Policy only for declared permissions", () => {
    const policy = policyOf({}, { camera: true, geolocation: true });
    expect(policy.permissions).toEqual({ camera: true, geolocation: true });
    expect(buildMcpAppSandboxCsp(policy)!.headers["Permissions-Policy"]).toBe(
      "camera=*, microphone=(), geolocation=*, clipboard-write=(), usb=(), clipboard-read=(), display-capture=()",
    );
    expect(mcpAppSandboxAllowList(policy.permissions)).toBe("camera *; geolocation *");
    expect(mcpAppSandboxAllowList({})).toBe("");
  });

  it("fails closed on malformed or oversized lists", () => {
    expect(buildMcpAppSandboxPolicy({ ...csp, connectDomains: ["http://api.example.test"] })).toBe(
      null,
    );
    expect(
      buildMcpAppSandboxPolicy({ ...csp, resourceDomains: ["https://a.test; script-src *"] }),
    ).toBe(null);
    expect(buildMcpAppSandboxPolicy({ ...csp, resourceDomains: ["wss://a.test"] })).toBe(null);
    expect(buildMcpAppSandboxPolicy({ ...csp, resourceDomains: ["https://x*.test"] })).toBe(null);
    expect(
      buildMcpAppSandboxPolicy({
        ...csp,
        resourceDomains: Array.from({ length: 33 }, (_, index) => `https://a${index}.test`),
      }),
    ).toBe(null);
  });

  it("keeps the response security headers", () => {
    expect(buildMcpAppSandboxCsp(policyOf())?.headers).toMatchObject({
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
  });
});
