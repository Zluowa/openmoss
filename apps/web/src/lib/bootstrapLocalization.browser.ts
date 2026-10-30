// FILE: bootstrapLocalization.browser.ts
// Purpose: Verifies the pre-React failure screens render in the resolved UI locale.
// Layer: Browser localization test

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderSignedOutScreen } from "../authSignedOut";
import { APP_DISPLAY_NAME } from "../branding";
import { resolveBootstrapLocale } from "../bootstrapLocalization";
import { renderPairingFailure } from "../pairingBootstrap";
import { APP_SETTINGS_STORAGE_KEY } from "../uiLocale";

let previousSettings: string | null;

function root(): HTMLDivElement {
  const existing = document.getElementById("root");
  if (existing) {
    existing.remove();
  }
  const next = document.createElement("div");
  next.id = "root";
  document.body.append(next);
  return next;
}

describe("localized bootstrap screens", () => {
  beforeEach(() => {
    previousSettings = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
    root();
  });

  afterEach(() => {
    document.getElementById("root")?.remove();
    if (previousSettings === null) {
      localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
    } else {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, previousSettings);
    }
    document.documentElement.lang = "en";
    document.documentElement.removeAttribute("data-moss-locale");
    document.title = "";
  });

  it("renders the signed-out page in Simplified Chinese by default", () => {
    // 全局 browserLocaleSetup 会在 storage 边界合并 localeOverride:"en"；
    // 用未污染的 storage 探针验证产品默认解析仍为 zh-CN。
    const locale = resolveBootstrapLocale({ getItem: () => null }, []);
    renderSignedOutScreen(locale);

    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.dataset.mossLocale).toBe("zh-CN");
    expect(document.title).toBe(`已退出登录 · ${APP_DISPLAY_NAME}`);
    expect(document.querySelector("h1")?.textContent).toBe(
      `此浏览器已不再控制 ${APP_DISPLAY_NAME}。`,
    );
    expect(document.body.textContent).toContain("会话已关闭");
    expect(document.body.textContent).toContain("当前会话及其所有实时连接均已撤销");
    expect(document.activeElement).toBe(document.querySelector("h1"));
    expect(
      (document.getElementById("root")?.textContent ?? "").replaceAll(APP_DISPLAY_NAME, ""),
    ).not.toMatch(/[A-Za-z]/);
  });

  it("honors an explicit English override on the pairing failure page", () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "en" }));

    renderPairingFailure();

    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dataset.mossLocale).toBe("en");
    expect(document.title).toBe(`Pairing failed · ${APP_DISPLAY_NAME}`);
    expect(document.querySelector("h1")?.textContent).toBe("This pairing link could not be used.");
    expect(document.body.textContent).toContain("Secure pairing interrupted");
  });

  it("renders browser-detected English only when auto-detect is selected", () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: null }));
    const locale = resolveBootstrapLocale(localStorage, ["en-GB", "zh-CN"]);

    renderPairingFailure(locale);

    expect(locale).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.querySelector("h1")?.textContent).toBe("This pairing link could not be used.");
  });
});
