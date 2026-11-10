import { describe, expect, it } from "vitest";

import {
  MOSS_MANAGED_PROVIDER_INSTANCE_IDS,
  readActiveMossAccessLane,
  resolveMossDownloadChannel,
} from "./mossDownloadChannel";

describe("readActiveMossAccessLane", () => {
  it("reads the lane from the first enabled managed instance", () => {
    expect(
      readActiveMossAccessLane({
        codex: { driver: "codex", enabled: true },
        claude_moss: { driver: "claudeAgent", enabled: true, config: { realm: "enterprise" } },
      }),
    ).toBe("enterprise");
  });

  it("treats disabled managed instances as signed out", () => {
    expect(
      readActiveMossAccessLane({
        codex_moss: { enabled: false, config: { realm: "cn" } },
        claude_moss: { enabled: false, config: { realm: "cn" } },
      }),
    ).toBeNull();
  });

  it("ignores instances Moss does not manage, even when they claim a lane", () => {
    expect(readActiveMossAccessLane({ my_codex: { config: { realm: "cn" } } })).toBeNull();
  });

  it("survives malformed settings", () => {
    for (const malformed of [
      null,
      undefined,
      "cn",
      [],
      { codex_moss: null },
      { codex_moss: { config: "cn" } },
      { codex_moss: { config: { realm: "mars" } } },
    ]) {
      expect(readActiveMossAccessLane(malformed)).toBeNull();
    }
  });

  it("covers every managed instance id", () => {
    for (const instanceId of MOSS_MANAGED_PROVIDER_INSTANCE_IDS) {
      expect(readActiveMossAccessLane({ [instanceId]: { config: { realm: "global" } } })).toBe(
        "global",
      );
    }
  });
});

describe("resolveMossDownloadChannel", () => {
  it("sends phone and enterprise accounts to the mirror wherever the machine is", () => {
    expect(resolveMossDownloadChannel({ lane: "cn", timeZone: "America/New_York" })).toBe(
      "cn-mirror",
    );
    expect(resolveMossDownloadChannel({ lane: "enterprise", timeZone: "Europe/Paris" })).toBe(
      "cn-mirror",
    );
  });

  it("keeps Google accounts on official sources even from mainland China", () => {
    expect(resolveMossDownloadChannel({ lane: "global", timeZone: "Asia/Shanghai" })).toBe(
      "official",
    );
  });

  it("falls back to the time zone without an account", () => {
    expect(resolveMossDownloadChannel({ lane: null, timeZone: "Asia/Shanghai" })).toBe("cn-mirror");
    expect(resolveMossDownloadChannel({ lane: null, timeZone: "Asia/Singapore" })).toBe("official");
  });
});
