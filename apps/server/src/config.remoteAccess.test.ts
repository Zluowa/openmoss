import { describe, expect, it } from "vitest";

import { normalizeHttpsPublicOrigin, remoteAccessPolicyError } from "./config";

const remoteBase = {
  host: "0.0.0.0",
  authToken: "remote-secret",
  devUrl: undefined,
  publicUrl: undefined,
  allowInsecureRemote: false,
} as const;

describe("remote access policy", () => {
  it("requires authentication when an HTTPS proxy publishes a loopback bind", () => {
    expect(
      remoteAccessPolicyError({
        ...remoteBase,
        host: "127.0.0.1",
        authToken: undefined,
        publicUrl: new URL("https://moss.example.test/"),
      }),
    ).toContain("without MOSS_AUTH_TOKEN");
  });

  it("rejects invalid public URLs in the shared embedded-server policy", () => {
    for (const publicUrl of [
      new URL("http://moss.example.test/"),
      new URL("https://moss.example.test/app"),
    ]) {
      expect(
        remoteAccessPolicyError({
          ...remoteBase,
          host: "127.0.0.1",
          publicUrl,
        }),
      ).toContain("must be an HTTPS root origin");
    }
  });

  it("accepts only credential-free HTTPS root origins", () => {
    expect(normalizeHttpsPublicOrigin(new URL("https://moss.example.test/"))?.origin).toBe(
      "https://moss.example.test",
    );
    for (const value of [
      "http://moss.example.test/",
      "https://user:pass@moss.example.test/",
      "https://moss.example.test/app",
      "https://moss.example.test/?query=1",
      "https://moss.example.test/#fragment",
    ]) {
      expect(normalizeHttpsPublicOrigin(new URL(value))).toBeNull();
    }
  });
});
