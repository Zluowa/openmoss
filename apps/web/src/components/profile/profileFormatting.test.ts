// FILE: profileFormatting.test.ts
// Purpose: Pins the heatmap tooltip date to the server's calendar-day key in any viewer time zone.
// Layer: web profile feature tests.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { homeFolderGreetingName } from "./profileFormatting";

describe("homeFolderGreetingName", () => {
  it("makes a display name from a home folder that reads like a name", () => {
    expect(homeFolderGreetingName("/Users/dilip.reddy")).toBe("Dilip Reddy");
    expect(homeFolderGreetingName("C:\\Users\\dilipreddy\\")).toBe("Dilipreddy");
    expect(homeFolderGreetingName("C:\\Users\\张三")).toBe("张三");
  });

  it("has no name for folders that don't name a person", () => {
    expect(homeFolderGreetingName(null)).toBe("");
    expect(homeFolderGreetingName("/")).toBe("");
    expect(homeFolderGreetingName("C:\\Users\\60948")).toBe("");
    expect(homeFolderGreetingName("C:\\Users\\Administrator")).toBe("");
    expect(homeFolderGreetingName("/root")).toBe("");
    expect(homeFolderGreetingName("D:\\walk\\profile")).toBe("");
  });
});

// Day keys arrive as the user's local calendar day ("2026-04-03"); the label
// must name that same day whether the viewer sits west or east of UTC.
describe.each(["America/Los_Angeles", "Pacific/Kiritimati"])(
  "formatShortDate in %s",
  (timeZone) => {
    beforeAll(() => {
      vi.stubEnv("TZ", timeZone);
      vi.resetModules();
    });
    afterAll(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("labels a heatmap day key with that same calendar day", async () => {
      const { formatShortDate } = await import("./profileFormatting");
      const expected = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(new Date(2026, 3, 3));

      expect(formatShortDate("2026-04-03")).toBe(expected);
    });
  },
);
