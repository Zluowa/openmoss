import { describe, expect, it } from "vitest";

import {
  assertSafeMacosSecurityCommand,
  exactGenericPasswordReadArgs,
} from "./macosKeychainPolicy";

describe("macOS Keychain command policy", () => {
  it("builds only an exact service plus account read", () => {
    const args = exactGenericPasswordReadArgs({
      service: "Moss Provider Credential KEK",
      account: "cn",
      revealSecret: true,
    });
    expect(args).toEqual([
      "find-generic-password",
      "-s",
      "Moss Provider Credential KEK",
      "-a",
      "cn",
      "-w",
    ]);
    expect(() => assertSafeMacosSecurityCommand(args)).not.toThrow();
  });

  it("rejects bulk, service-only, wildcard, and extra-argument reads", () => {
    const forbiddenBulk = ["dump", "keychain"].join("-");
    for (const args of [
      [forbiddenBulk, "-d"],
      ["find-generic-password", "-s", "service", "-w"],
      ["find-generic-password", "-s", "*", "-a", "cn", "-w"],
      ["find-generic-password", "-s", "service", "-a", "account", "-g"],
    ]) {
      expect(() => assertSafeMacosSecurityCommand(args)).toThrowError(
        expect.objectContaining({ code: "MACOS_KEYCHAIN_COMMAND_REJECTED" }),
      );
    }
  });
});
