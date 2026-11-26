import { describe, expect, it } from "vitest";

import { MOSS_RELEASES, mossReleaseForVersion, mossReleasesUpTo } from "./mossReleases";

describe("mossReleasesUpTo", () => {
  it("lists Moss's own versions newest first, never one newer than the running app", () => {
    const shown = mossReleasesUpTo("1.0.9").map((release) => release.version);
    expect(shown[0]).toBe("1.0.9");
    expect(shown).not.toContain("1.0.10");
    expect(shown.at(-1)).toBe("1.0.2");
  });

  it("orders 1.0.10 after 1.0.9 by number, not as text", () => {
    const shown = mossReleasesUpTo("1.0.15").map((release) => release.version);
    expect(shown.slice(0, 6)).toEqual(["1.0.14", "1.0.13", "1.0.12", "1.0.11", "1.0.10", "1.0.9"]);
  });

  it("includes 1.0.18, 1.0.17, and 1.0.16 at the top when running 1.0.18", () => {
    const shown = mossReleasesUpTo("1.0.18").map((release) => release.version);
    expect(shown.slice(0, 4)).toEqual(["1.0.18", "1.0.17", "1.0.16", "1.0.14"]);
    expect(mossReleaseForVersion("1.0.18")?.groups?.length).toBeGreaterThan(0);
    expect(mossReleaseForVersion("1.0.17")?.groups?.length).toBeGreaterThan(0);
    expect(mossReleaseForVersion("1.0.16")?.groups?.length).toBeGreaterThan(0);
    expect(mossReleaseForVersion("9.9.9")).toBeNull();
  });

  it("gives every version a date and at least one line in both languages", () => {
    for (const release of MOSS_RELEASES) {
      expect(release.date.zh.length).toBeGreaterThan(0);
      expect(release.date.en.length).toBeGreaterThan(0);
      expect(release.notes.zh.length).toBeGreaterThan(0);
      expect(release.notes.en.length).toBe(release.notes.zh.length);
      for (const group of release.groups ?? []) {
        expect(group.zh.length).toBeGreaterThan(0);
        expect(group.en.length).toBe(group.zh.length);
      }
    }
  });
});
