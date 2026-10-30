import { describe, expect, it } from "vitest";

import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_LOCALE_OVERRIDE,
  normalizeLocaleOverride,
  readStoredLocaleOverride,
  resolveStoredMossLocale,
  resolveMossLocale,
  type LocaleStorage,
} from "./uiLocale";

function storageWith(value: string | null): LocaleStorage {
  return {
    getItem(key) {
      expect(key).toBe(APP_SETTINGS_STORAGE_KEY);
      return value;
    },
  };
}

describe("UI locale resolution", () => {
  it("defaults new and invalid settings to Simplified Chinese", () => {
    expect(readStoredLocaleOverride(storageWith(null))).toBe(DEFAULT_LOCALE_OVERRIDE);
    expect(readStoredLocaleOverride(storageWith("not-json"))).toBe(DEFAULT_LOCALE_OVERRIDE);
    expect(readStoredLocaleOverride(storageWith(JSON.stringify({})))).toBe(DEFAULT_LOCALE_OVERRIDE);
    expect(normalizeLocaleOverride("fr-FR")).toBe(DEFAULT_LOCALE_OVERRIDE);
  });

  it("honors explicit English and Chinese before browser languages", () => {
    expect(
      resolveStoredMossLocale(storageWith(JSON.stringify({ localeOverride: "en" })), ["zh-CN"]),
    ).toBe("en");
    expect(
      resolveStoredMossLocale(storageWith(JSON.stringify({ localeOverride: "zh-CN" })), ["en-US"]),
    ).toBe("zh-CN");
  });

  it("uses browser language only when auto-detect is explicitly selected", () => {
    const auto = storageWith(JSON.stringify({ localeOverride: null }));

    expect(resolveStoredMossLocale(auto, ["en-GB", "zh-CN"])).toBe("en");
    expect(resolveStoredMossLocale(auto, ["zh-Hant-TW", "en-US"])).toBe("zh-CN");
    expect(resolveStoredMossLocale(auto, ["fr-FR"])).toBe(DEFAULT_LOCALE_OVERRIDE);
    expect(resolveMossLocale(null, [])).toBe(DEFAULT_LOCALE_OVERRIDE);
  });

  it("falls back safely when storage access throws", () => {
    const storage: LocaleStorage = {
      getItem() {
        throw new DOMException("blocked", "SecurityError");
      },
    };

    expect(readStoredLocaleOverride(storage)).toBe(DEFAULT_LOCALE_OVERRIDE);
  });
});
