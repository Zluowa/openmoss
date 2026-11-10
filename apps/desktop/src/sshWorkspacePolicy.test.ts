// FILE: sshWorkspacePolicy.test.ts
// Purpose: Prevent remote transport credentials from reaching URLs or unrelated origins.
// Layer: SSH security tests
import { describe, expect, it } from "vitest";
import { sshWorkspaceHeaders, sshWorkspaceTransport } from "./sshWorkspacePolicy";
describe("SSH workspace credentials", () => {
  const fakeToken = "a".repeat(64);
  it("removes the private token from the renderer's transport URL", () => {
    const result = sshWorkspaceTransport(`ws://127.0.0.1:59151/?token=${fakeToken}`);
    expect(result.url).toBe("ws://127.0.0.1:59151/");
    expect(result.token.length).toBe(64);
  });
  it("adds the credential only to the exact forwarded HTTP/WebSocket endpoint", () => {
    expect(
      sshWorkspaceHeaders(
        "http://127.0.0.1:59151",
        fakeToken,
        "ws://127.0.0.1:59151/ws",
        {},
      ).Authorization?.startsWith("Bearer "),
    ).toBe(true);
    expect(
      sshWorkspaceHeaders("http://127.0.0.1:59151", fakeToken, "http://127.0.0.1:59152/", {}),
    ).toEqual({});
    expect(
      sshWorkspaceHeaders("http://127.0.0.1:59151", fakeToken, "https://example.test/", {}),
    ).toEqual({});
  });
  it("rejects non-loopback workspace transports", () => {
    expect(() => sshWorkspaceTransport(`ws://example.test/?token=${fakeToken}`)).toThrow(
      "invalid-remote-workspace",
    );
  });
  it("scopes paired-computer credentials to the same secure HTTP/WebSocket origin", () => {
    expect(
      sshWorkspaceHeaders("https://example.test:8443", fakeToken, "wss://example.test:8443/ws", {})
        .Authorization,
    ).toBe(`Bearer ${fakeToken}`);
    expect(
      sshWorkspaceHeaders("https://example.test:8443", fakeToken, "wss://other.test:8443/ws", {}),
    ).toEqual({});
    expect(
      sshWorkspaceHeaders("https://example.test", fakeToken, "http://example.test/", {}),
    ).toEqual({});
  });
});
