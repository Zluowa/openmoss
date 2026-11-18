import { describe, expect, it } from "vitest";

import {
  MOSS_DOWNLOAD_SOURCES,
  mossDownloadSourceOrder,
  mossDownloadSourceUrls,
} from "./mossDownloadSources";

const COS = "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/";
const R2 = "https://update.mossbotai.com/";

describe("MOSS_DOWNLOAD_SOURCES", () => {
  it("puts COS first for the mainland and R2 first everywhere else, each with the other behind it", () => {
    expect(MOSS_DOWNLOAD_SOURCES).toEqual({ cn: [COS, R2], global: [R2, COS] });
  });

  it("is frozen, base URLs all ending in a slash", () => {
    expect(Object.isFrozen(MOSS_DOWNLOAD_SOURCES)).toBe(true);
    expect(Object.isFrozen(MOSS_DOWNLOAD_SOURCES.cn)).toBe(true);
    expect(Object.isFrozen(MOSS_DOWNLOAD_SOURCES.global)).toBe(true);
    for (const base of [...MOSS_DOWNLOAD_SOURCES.cn, ...MOSS_DOWNLOAD_SOURCES.global]) {
      expect(base).toMatch(/^https:\/\/[^/]+\/$/);
    }
  });
});

describe("mossDownloadSourceOrder", () => {
  it("follows the lane's realm when an account is signed in", () => {
    expect(mossDownloadSourceOrder({ lane: "cn" })).toBe("cn");
    expect(mossDownloadSourceOrder({ lane: "enterprise" })).toBe("cn");
    expect(mossDownloadSourceOrder({ lane: "global" })).toBe("global");
  });

  it("lets the lane win over locale and time zone", () => {
    expect(
      mossDownloadSourceOrder({ lane: "global", locale: "zh-CN", timeZone: "Asia/Shanghai" }),
    ).toBe("global");
    expect(
      mossDownloadSourceOrder({ lane: "cn", locale: "en-US", timeZone: "America/New_York" }),
    ).toBe("cn");
  });

  it("uses a zh-CN locale without an account", () => {
    expect(mossDownloadSourceOrder({ lane: null, locale: "zh-CN", timeZone: "UTC" })).toBe("cn");
    expect(mossDownloadSourceOrder({ lane: null, locale: "zh_CN" })).toBe("cn");
    expect(mossDownloadSourceOrder({ lane: null, locale: "zh-Hans-CN" })).toBe("cn");
  });

  it("uses a mainland time zone without an account", () => {
    for (const timeZone of ["Asia/Shanghai", "Asia/Chongqing", "Asia/Harbin", "Asia/Urumqi"]) {
      expect(mossDownloadSourceOrder({ lane: null, locale: "en-US", timeZone })).toBe("cn");
    }
  });

  it("is global for other places and for missing or broken signals", () => {
    expect(mossDownloadSourceOrder({ lane: null, locale: "zh-TW", timeZone: "Asia/Taipei" })).toBe(
      "global",
    );
    expect(
      mossDownloadSourceOrder({ lane: null, locale: "zh-HK", timeZone: "Asia/Hong_Kong" }),
    ).toBe("global");
    expect(
      mossDownloadSourceOrder({ lane: null, locale: "en-GB", timeZone: "Europe/London" }),
    ).toBe("global");
    expect(mossDownloadSourceOrder({ lane: null })).toBe("global");
    expect(mossDownloadSourceOrder({ lane: null, locale: "not a locale!" })).toBe("global");
  });
});

describe("mossDownloadSourceUrls", () => {
  it("returns the path on every source, in the order's sequence", () => {
    expect(mossDownloadSourceUrls("cn", "desktop/latest.yml")).toEqual([
      `${COS}desktop/latest.yml`,
      `${R2}desktop/latest.yml`,
    ]);
    expect(
      mossDownloadSourceUrls("global", "runtimes/v1/codex/1.2.3/codex-1.2.3-win32-x64.zip"),
    ).toEqual([
      `${R2}runtimes/v1/codex/1.2.3/codex-1.2.3-win32-x64.zip`,
      `${COS}runtimes/v1/codex/1.2.3/codex-1.2.3-win32-x64.zip`,
    ]);
    expect(mossDownloadSourceUrls("cn", "plugin-catalog/v1/")).toEqual([
      `${COS}plugin-catalog/v1/`,
      `${R2}plugin-catalog/v1/`,
    ]);
  });

  it("refuses absolute paths", () => {
    for (const path of [
      "/desktop/latest.yml",
      "\\desktop\\latest.yml",
      "https://elsewhere.example/latest.yml",
      "//elsewhere.example/latest.yml",
      "C:/latest.yml",
    ]) {
      expect(() => mossDownloadSourceUrls("cn", path), path).toThrow();
    }
  });

  it("refuses paths that climb out of the source, also when encoded", () => {
    for (const path of [
      "../latest.yml",
      "desktop/../../x",
      "desktop/%2e%2e/x",
      "./x",
      "a\\..\\b",
    ]) {
      expect(() => mossDownloadSourceUrls("global", path), path).toThrow();
    }
  });

  it("refuses a query or a fragment", () => {
    expect(() => mossDownloadSourceUrls("cn", "desktop/latest.yml?x=1")).toThrow(/query/);
    expect(() => mossDownloadSourceUrls("cn", "desktop/latest.yml#top")).toThrow(/fragment/);
  });
});
