// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { formatMossTranslation } from "~/localization";
import { describeLocalizedError, LocalizedError, localizedMessage } from "./localizedError";

const en = (
  key: Parameters<typeof formatMossTranslation>[1],
  values: Record<string, string | number>,
) => formatMossTranslation("en", key, values);

describe("LocalizedError", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-moss-locale");
  });

  it("reads in the UI language the app publishes", () => {
    document.documentElement.dataset.mossLocale = "zh-CN";
    const error = new LocalizedError("library.error.copyUnsupported");
    expect(error.message).toBe("当前环境无法复制图片，请使用下载。");
    expect(error.key).toBe("library.error.copyUnsupported");

    document.documentElement.dataset.mossLocale = "en";
    expect(new LocalizedError("library.error.copyUnsupported").message).toBe(
      "Images can't be copied here. Download the image instead.",
    );
    expect(localizedMessage("library.switchingAccount")).toBe("Switching account…");
  });

  it("falls back to English before the app has published a language", () => {
    expect(new LocalizedError("newThread.error.chooseFolder").message).toBe(
      "Choose a working folder for this chat first.",
    );
  });

  it("lets a surface show the helper's reason in its own language, or its fallback", () => {
    document.documentElement.dataset.mossLocale = "zh-CN";
    const error = new LocalizedError("library.error.shareOneImage");
    expect(describeLocalizedError(error, en, "library.notice.shareFailed")).toBe(
      "Select exactly one image to share.",
    );
    expect(describeLocalizedError(new Error("raw"), en, "library.notice.shareFailed")).toBe(
      "Couldn't share the image. Try again, or download it.",
    );
  });
});
