// FILE: AppPageFrame.browser.tsx
// Purpose: The 应用页 header clears the window buttons when it is the window's top bar, and its
//          chrome follows the UI language.
// Layer: Web browser tests (frameless Windows window simulated; no desktop)

import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import type { MossLocaleCode } from "~/uiLocale";
import { SidebarProvider } from "../ui/sidebar";
import { AppPageFrame } from "./AppPageFrame";
import { pageAppsClient } from "./pageAppsClient";

vi.mock("~/env", () => ({ isElectron: true }));
// A frameless window: the renderer draws minimise / maximise / close at the top right.
vi.mock("~/hooks/useDesktopCustomTitleBar", () => ({
  useDesktopCustomTitleBarActive: () => true,
}));

// The caption-button cluster: three 46px buttons pinned to the window's top-right corner.
const WINDOW_BUTTONS_WIDTH = 3 * 46;

afterEach(() => vi.restoreAllMocks());

async function renderFrame(
  topBar: boolean,
  { locale = "zh-CN", open }: { locale?: MossLocaleCode; open?: () => Promise<never> } = {},
) {
  // The header is what matters here; by default the frame itself stays loading.
  vi.spyOn(pageAppsClient, "openFrame").mockImplementation(
    open ?? (() => new Promise(() => undefined)),
  );
  return render(
    <MossLocaleScope locale={locale}>
      <SidebarProvider open>
        <div style={{ position: "fixed", inset: 0, display: "flex" }}>
          <AppPageFrame appPageId="app-header-fixture" mode="full" topBar={topBar} />
        </div>
      </SidebarProvider>
    </MossLocaleScope>,
  );
}

const CJK = /[　-鿿＀-￯]/u;

describe("AppPageFrame header", () => {
  it("keeps its buttons clear of the window buttons and drags the window as a top bar", async () => {
    await page.viewport(1280, 800);
    const screen = await renderFrame(true);
    try {
      const reload = page.getByRole("button", { name: "重新加载" });
      await expect.element(reload).toBeVisible();
      const header = reload.element().closest("header")!;
      expect(header.classList.contains("drag-region")).toBe(true);
      for (const name of ["收藏", "权限", "重新加载"]) {
        const right = page.getByRole("button", { name }).element().getBoundingClientRect().right;
        expect(right).toBeLessThanOrEqual(window.innerWidth - WINDOW_BUTTONS_WIDTH);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the plain header when another bar is the top bar", async () => {
    const screen = await renderFrame(false);
    try {
      const reload = page.getByRole("button", { name: "重新加载" });
      await expect.element(reload).toBeVisible();
      expect(reload.element().closest("header")!.classList.contains("drag-region")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("speaks the UI language: English chrome has no Chinese, zh-CN keeps its wording", async () => {
    const english = await renderFrame(true, { locale: "en" });
    try {
      for (const name of ["Favorite", "Permissions", "Reload"]) {
        await expect.element(page.getByRole("button", { name })).toBeVisible();
      }
      await expect.element(page.getByText("Opening app page…")).toBeVisible();
      const header = page.getByRole("button", { name: "Reload" }).element().closest("header")!;
      expect(header.textContent).toContain("AI-generated content");
      expect(document.querySelector('[data-testid="app-page-frame"]')!.textContent).not.toMatch(
        CJK,
      );
    } finally {
      await english.unmount();
    }
    const chinese = await renderFrame(true);
    try {
      await expect.element(page.getByText("正在打开应用页…")).toBeVisible();
      await expect.element(page.getByText("AI 生成的内容，使用前请核对")).toBeVisible();
    } finally {
      await chinese.unmount();
    }
  });

  it("names a failure without its own message in the UI language", async () => {
    // An error without a message, as a dropped connection can produce.
    const english = await renderFrame(true, { locale: "en", open: () => Promise.reject({}) });
    try {
      await expect.element(page.getByText("Couldn’t open this app page.")).toBeVisible();
      await expect.element(page.getByText("App page", { exact: true })).toBeVisible();
    } finally {
      await english.unmount();
    }
    const chinese = await renderFrame(true, { open: () => Promise.reject({}) });
    try {
      await expect.element(page.getByText("无法打开这个应用页。")).toBeVisible();
    } finally {
      await chinese.unmount();
    }
  });
});
