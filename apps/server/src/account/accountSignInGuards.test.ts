// FILE: accountSignInGuards.test.ts
// Purpose: Per-caller limits stay bounded, refusals block for a while, untrusted names are
//   cleaned, and the account is shown and keyed without exposing it.
// Layer: account (server) tests
// Exports: none
import { describe, expect, it } from "vitest";

import {
  accountDisplayLabel,
  accountKeyOf,
  describeAccountFailure,
  makeDenialBlocks,
  makeWindowLimiter,
  sanitizeDeviceName,
  unverifiedTokenSubject,
} from "./accountSignInGuards";
import { isAddressHost } from "./accountSignInRoute";

describe("makeWindowLimiter", () => {
  it("limits each key on its own and forgets old events", () => {
    const clock = { now: 0 };
    const limiter = makeWindowLimiter({
      limit: 2,
      windowMs: 1_000,
      maxKeys: 10,
      now: () => clock.now,
    });
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, false]);
    expect(limiter.take("b")).toBe(true);
    clock.now = 1_001;
    expect(limiter.take("a")).toBe(true);
  });

  it("never remembers more callers than it may", () => {
    const limiter = makeWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 8, now: () => 0 });
    for (let index = 0; index < 100; index += 1) limiter.take(`caller-${index}`);
    expect(limiter.size()).toBeLessThanOrEqual(8);
  });
});

describe("makeDenialBlocks", () => {
  it("blocks a key after the second refusal for the window, then lets it go", () => {
    const clock = { now: 0 };
    const blocks = makeDenialBlocks({
      denials: 2,
      windowMs: 600_000,
      maxKeys: 10,
      now: () => clock.now,
    });
    blocks.record(["account:a", "address:1"]);
    expect(blocks.isBlocked("account:a")).toBe(false);
    clock.now = 1_000;
    blocks.record(["account:a", "address:2"]);
    expect(blocks.isBlocked("account:a")).toBe(true);
    expect(blocks.isBlocked("address:1")).toBe(false);
    clock.now = 601_001;
    expect(blocks.isBlocked("account:a")).toBe(false);
  });

  it("does not block for refusals further apart than the window", () => {
    const clock = { now: 0 };
    const blocks = makeDenialBlocks({
      denials: 2,
      windowMs: 1_000,
      maxKeys: 10,
      now: () => clock.now,
    });
    blocks.record(["account:a"]);
    clock.now = 2_000;
    blocks.record(["account:a"]);
    expect(blocks.isBlocked("account:a")).toBe(false);
  });
});

describe("shown and stored values", () => {
  it("cleans device names", () => {
    expect(sanitizeDeviceName(undefined)).toBeNull();
    expect(sanitizeDeviceName("  iPhone\n\t15  ")).toBe("iPhone 15");
    expect(sanitizeDeviceName("evil‮gnp.exe")).toBe("evil gnp.exe");
    expect(sanitizeDeviceName('「a」『b』"c"')).toBe("abc");
    expect(sanitizeDeviceName("手".repeat(50))).toBe("手".repeat(40));
  });

  it("names the account by email or a masked number", () => {
    expect(accountDisplayLabel({ email: "ada@example.test", phone: null })).toBe(
      "ada@example.test",
    );
    expect(accountDisplayLabel({ email: null, phone: "+86 138 0013 8000" })).toBe("138****8000");
    expect(accountDisplayLabel({ email: null, phone: "12345" })).toBe("****2345");
    expect(accountDisplayLabel({ email: null, phone: null })).toBeNull();
  });

  it("keys accounts one-way and per realm", () => {
    const key = accountKeyOf("memfire-phone", "user-a");
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(key).not.toContain("user-a");
    expect(accountKeyOf("supabase-google", "user-a")).not.toBe(key);
  });

  it("reads the subject of this computer's own token, and nothing from junk", () => {
    const token = `h.${Buffer.from(JSON.stringify({ sub: "user-a" })).toString("base64url")}.s`;
    expect(unverifiedTokenSubject(token)).toBe("user-a");
    expect(unverifiedTokenSubject("not-a-token")).toBeNull();
  });

  it("describes failures without their message", () => {
    const failure = Object.assign(new Error("fake-secret-in-message"), {
      operation: "get_user",
      status: 401,
      code: "invalid_token",
    });
    expect(describeAccountFailure(failure)).toBe("get_user:401:invalid_token");
    expect(describeAccountFailure(new Error("fake-secret-in-message"))).toBe("Error");
    expect(describeAccountFailure("fake-secret-in-message")).toBe("unknown");
  });
});

describe("isAddressHost", () => {
  it("accepts addresses and localhost, with or without a port, and nothing else", () => {
    for (const host of [
      "192.168.1.20",
      "192.168.1.20:3773",
      "10.0.0.1:80",
      "localhost",
      "LOCALHOST:4113",
      "[::1]",
      "[fe80::1]:3773",
      "[fd12:3456::1]:3773",
    ]) {
      expect(isAddressHost(host), host).toBe(true);
    }
    for (const host of [
      undefined,
      "",
      "moss.example.test",
      "moss.example.test:3773",
      "evil.localhost",
      "localhost.evil.test",
      "192.168.1.256",
      "192.168.1",
      "192.168.1.20:port",
      "[::1",
      "[not-ipv6]:3773",
      "[]:3773",
    ]) {
      expect(isAddressHost(host), String(host)).toBe(false);
    }
  });
});
