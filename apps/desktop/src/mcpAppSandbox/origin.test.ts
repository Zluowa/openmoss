import * as Crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  isUsableMcpAppSandboxLabel,
  mcpAppSandboxConnectorLabel,
  mcpAppSandboxThreadLabel,
  normalizeMcpAppConnectorUrl,
  resolveMcpAppSandboxOrigin,
} from "./origin";

const sha32 = (value: string) =>
  Crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);

describe("MCP App sandbox origin labels", () => {
  it("hashes thread and server key with a NUL separator", () => {
    // Fixed vectors (sha256 of the UTF-8 bytes, first 32 hex characters).
    expect(mcpAppSandboxThreadLabel("thread-1", "moss")).toBe(sha32("thread-1\u0000moss"));
    expect(mcpAppSandboxThreadLabel("thread-1", "moss")).toBe("d81f3daede487093d937b9081aafe212");
    expect(mcpAppSandboxThreadLabel("thread-mcp-app-e2e", "fixture-server")).toBe(
      sha32("thread-mcp-app-e2e\u0000fixture-server"),
    );
    // The separator keeps ("ab","c") and ("a","bc") apart.
    expect(mcpAppSandboxThreadLabel("ab", "c")).not.toBe(mcpAppSandboxThreadLabel("a", "bc"));
    expect(mcpAppSandboxThreadLabel("线程", "连接器")).toBe(sha32("线程\u0000连接器"));
  });

  it("matches the reference Code-tab vector shape for the same inputs", () => {
    // Reference: sha256(session + session + "\0" + server)[:32] observed live.
    const session = "local_01f8078f-c96f-4c2e-86c9-3689b0825f10";
    expect(sha32(`${session}${session}\u0000moss-probe`)).toBe("96b37207b8e0534d4305dd324ed25bf5");
    // Moss deliberately hashes the thread id once (SPEC §4).
    expect(mcpAppSandboxThreadLabel(session, "moss-probe")).toBe(
      sha32(`${session}\u0000moss-probe`),
    );
  });

  it("normalises connector URLs before hashing them", () => {
    const cases: Array<[string, string]> = [
      ["https://Example.COM/mcp", "https://example.com/mcp"],
      ["HTTPS://example.com:443/mcp", "https://example.com/mcp"],
      ["http://example.com:80/mcp", "http://example.com/mcp"],
      ["https://example.com:8443/mcp", "https://example.com:8443/mcp"],
      ["https://example.com/", "https://example.com"],
      ["https://example.com/?a=1", "https://example.com?a=1"],
      ["https://example.com/mcp#frag", "https://example.com/mcp"],
      ["https://example.com/MCP/Path?Q=A", "https://example.com/MCP/Path?Q=A"],
      ["https://User@Example.com/mcp", "https://User@example.com/mcp"],
      ["https://[::1]:8443/mcp", "https://[::1]:8443/mcp"],
      ["https://example.com//", "https://example.com//"],
    ];
    for (const [input, expected] of cases) {
      expect(normalizeMcpAppConnectorUrl(input), input).toBe(expected);
    }
    for (const invalid of ["mcprelay://x/y", "ftp://example.com", "example.com/mcp", "https://"]) {
      expect(normalizeMcpAppConnectorUrl(invalid), invalid).toBe(null);
    }
    expect(mcpAppSandboxConnectorLabel("https://Example.com:443/")).toBe(
      sha32("https://example.com"),
    );
  });

  it("uses the stable variant only for stableOrigin with a usable connector URL", () => {
    const base = { threadId: "thread-1", server: "srv", serverKey: "conn-1" };
    expect(resolveMcpAppSandboxOrigin(base)).toEqual({
      label: mcpAppSandboxThreadLabel("thread-1", "conn-1"),
      variant: "isolated",
    });
    expect(resolveMcpAppSandboxOrigin({ ...base, connectorUrl: "https://a.example/mcp" })).toEqual({
      label: mcpAppSandboxThreadLabel("thread-1", "conn-1"),
      variant: "isolated",
    });
    expect(
      resolveMcpAppSandboxOrigin({
        ...base,
        stableOrigin: true,
        connectorUrl: "https://a.example/mcp",
      }),
    ).toEqual({ label: sha32("https://a.example/mcp"), variant: "stable" });
    // Local/CLI servers have no URL: isolated.
    expect(resolveMcpAppSandboxOrigin({ ...base, stableOrigin: true }).variant).toBe("isolated");
    expect(
      resolveMcpAppSandboxOrigin({ ...base, stableOrigin: true, connectorUrl: "stdio://x" })
        .variant,
    ).toBe("isolated");
    // serverKey falls back to the server name.
    expect(resolveMcpAppSandboxOrigin({ threadId: "thread-1", server: "srv" }).label).toBe(
      mcpAppSandboxThreadLabel("thread-1", "srv"),
    );
  });

  it("refuses labels that a URL parser would read as an IPv4 number", () => {
    expect(isUsableMcpAppSandboxLabel("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isUsableMcpAppSandboxLabel("01234567890123456789012345678901")).toBe(false);
    expect(isUsableMcpAppSandboxLabel("ABCDEF0123456789abcdef0123456789")).toBe(false);
    expect(isUsableMcpAppSandboxLabel("abc")).toBe(false);
  });
});
