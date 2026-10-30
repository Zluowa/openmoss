import { describe, expect, it } from "vitest";

import { APP_DISPLAY_NAME } from "./branding";
import { resolveBootstrapLocale, translateBootstrap } from "./bootstrapLocalization";
import type { LocaleStorage } from "./uiLocale";

function storageFor(localeOverride: "en" | "zh-CN" | null): LocaleStorage {
  return {
    getItem: () => JSON.stringify({ localeOverride }),
  };
}

describe("bootstrap localization copy", () => {
  it("ships complete English and Simplified Chinese copy", () => {
    expect(translateBootstrap("en", "signedOut.title")).toBe(
      `This browser no longer controls ${APP_DISPLAY_NAME}.`,
    );
    expect(translateBootstrap("zh-CN", "signedOut.title")).toBe(
      `此浏览器已不再控制 ${APP_DISPLAY_NAME}。`,
    );
    expect(translateBootstrap("en", "pairingFailure.title")).toBe(
      "This pairing link could not be used.",
    );
    expect(translateBootstrap("zh-CN", "pairingFailure.title")).toBe("此配对链接无法使用。");
  });

  it("uses the same default, explicit override, and browser auto-detect contract as React", () => {
    expect(resolveBootstrapLocale(undefined, ["en-US"])).toBe("zh-CN");
    expect(resolveBootstrapLocale(storageFor("en"), ["zh-CN"])).toBe("en");
    expect(resolveBootstrapLocale(storageFor("zh-CN"), ["en-US"])).toBe("zh-CN");
    expect(resolveBootstrapLocale(storageFor(null), ["en-US"])).toBe("en");
    expect(resolveBootstrapLocale(storageFor(null), ["zh-CN"])).toBe("zh-CN");
  });
});
