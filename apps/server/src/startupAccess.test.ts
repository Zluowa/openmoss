import { describe, expect, it } from "vitest";

import {
  formatHostForUrl,
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
