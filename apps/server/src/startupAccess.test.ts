import { describe, expect, it } from "vitest";

import {
  formatHostForUrl,
  isDirectLoopbackRequest,
  isLocalOnlyAccess,
  isLoopbackHost,
  isLoopbackStartupBearer,
  isWildcardHost,
  resolveListeningPort,
} from "./startupAccess";

describe("startupAccess", () => {
  it("keeps startup bearer credentials private to loopback without a public origin", () => {
    const base = {
      host: "127.0.0.1",
      publicUrl: undefined,
      authToken: "fixture",
      authorization: "Bearer fixture",
    };
    expect(isLoopbackStartupBearer(base)).toBe(true);
    for (const change of [
      { host: undefined },
      { host: "0.0.0.0" },
      { publicUrl: "https://example.com" },
      { authToken: undefined },
      { authorization: "Bearer wrong" },
      { authorization: undefined },
    ]) {
      expect(isLoopbackStartupBearer({ ...base, ...change })).toBe(false);
    }
  });
  describe("a desktop that lets phones connect", () => {
    const here = { remoteAddress: "127.0.0.1", headers: {} };
    const phone = { remoteAddress: "192.168.1.23", headers: {} };
    const lan = {
      mode: "desktop" as const,
      host: "0.0.0.0",
      publicUrl: undefined,
      desktopPhoneAccess: true,
    };
    const tailnet = {
      mode: "desktop" as const,
      host: "127.0.0.1",
      publicUrl: "https://mac.tail1234.ts.net",
      desktopPhoneAccess: true,
    };

    it("keeps this computer's own requests local and never a phone's", () => {
      expect(isLocalOnlyAccess(lan, here)).toBe(true);
      expect(isLocalOnlyAccess(lan, { ...here, remoteAddress: "::ffff:127.0.0.1" })).toBe(true);
      expect(isLocalOnlyAccess(lan, phone)).toBe(false);
      expect(isLocalOnlyAccess(lan, undefined)).toBe(false);
    });

    it("treats a request relayed by a proxy on this computer as remote", () => {
      expect(isLocalOnlyAccess(tailnet, here)).toBe(true);
      for (const name of ["x-forwarded-for", "forwarded", "tailscale-user-login", "x-real-ip"]) {
        const relayed = { remoteAddress: "127.0.0.1", headers: { [name]: "100.64.0.9" } };
        expect(isDirectLoopbackRequest(relayed)).toBe(false);
        expect(isLocalOnlyAccess(tailnet, relayed)).toBe(false);
        expect(isLocalOnlyAccess(lan, relayed)).toBe(false);
      }
    });

    it("needs the desktop's explicit setting", () => {
      expect(isLocalOnlyAccess({ ...lan, desktopPhoneAccess: false }, here)).toBe(false);
      expect(isLocalOnlyAccess({ ...lan, mode: "web" }, here)).toBe(false);
      expect(isLocalOnlyAccess({ ...lan, host: "192.168.1.5" }, here)).toBe(false);
      expect(isLocalOnlyAccess({ ...tailnet, desktopPhoneAccess: false }, here)).toBe(false);
    });

    it("accepts the startup bearer only from this computer", () => {
      const bearer = { ...lan, authToken: "fixture", authorization: "Bearer fixture" };
      expect(isLoopbackStartupBearer({ ...bearer, peer: here })).toBe(true);
      expect(isLoopbackStartupBearer({ ...bearer, peer: phone })).toBe(false);
      expect(isLoopbackStartupBearer(bearer)).toBe(false);
      expect(
        isLoopbackStartupBearer({ ...bearer, peer: here, authorization: "Bearer wrong" }),
      ).toBe(false);
    });
  });

  it("detects wildcard hosts", () => {
    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
    expect(isWildcardHost("127.0.0.1")).toBe(false);
  });

  it("detects loopback hosts", () => {
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.50")).toBe(false);
  });

  it("formats IPv6 hosts for URLs", () => {
    expect(formatHostForUrl("::1")).toBe("[::1]");
    expect(formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
  });

  it("prefers the actual bound port when an HTTP server address is available", () => {
    expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
    expect(resolveListeningPort("pipe", 3773)).toBe(3773);
    expect(resolveListeningPort(null, 3773)).toBe(3773);
  });
});
