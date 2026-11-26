// FILE: AppPageFrame.browser.tsx
// Purpose: The 应用页 header clears the window buttons when it is the window's top bar,
//          uses the unified title pill + overflow menu, and follows the UI language.
// Layer: Web browser tests (frameless Windows window simulated; no desktop)

import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
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
  it("keeps its title pill and overflow button clear of the window buttons and drags as a top bar", async () => {
    await page.viewport(1280, 800);
    const screen = await renderFrame(true);
    try {
      const titleTrigger = page.getByTestId("page-app-title-menu-trigger");
      const moreTrigger = page.getByTestId("page-app-more-menu-trigger");
      await expect.element(titleTrigger).toBeVisible();
      await expect.element(moreTrigger).toBeVisible();
      const header = moreTrigger.element().closest("header")!;
      expect(header.classList.contains("drag-region")).toBe(true);
      for (const el of [titleTrigger.element(), moreTrigger.element()]) {
        expect(el.getAttribute("title")).toBeNull();
        expect(el.getBoundingClientRect().height).toBe(28);
        expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(
          window.innerWidth - WINDOW_BUTTONS_WIDTH,
        );
      }
      // Title trigger matches Claude's clean borderless ghost style without a leading icon.
      expect(titleTrigger.element().querySelector("svg")).toBeNull();
      const actions = page.getByTestId("page-app-header-actions").element();
      expect(actions.querySelectorAll("button").length).toBe(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the plain header when another bar is the top bar", async () => {
    const screen = await renderFrame(false);
    try {
      const moreTrigger = page.getByTestId("page-app-more-menu-trigger");
      await expect.element(moreTrigger).toBeVisible();
      expect(moreTrigger.element().closest("header")!.classList.contains("drag-region")).toBe(
        false,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("speaks the UI language without explanatory top-bar copy: English has no Chinese, zh-CN keeps its wording", async () => {
    const english = await renderFrame(true, { locale: "en" });
    try {
      const moreTrigger = page.getByRole("button", { name: "More actions" });
      await expect.element(moreTrigger).toBeVisible();
      await expect.element(page.getByText("Opening app page…")).toBeVisible();
      const header = moreTrigger.element().closest("header")!;
      expect(header.textContent).not.toContain("AI-generated content");
      expect(document.querySelector('[data-testid="app-page-frame"]')!.textContent).not.toMatch(
        CJK,
      );
      await userEvent.click(page.getByTestId("page-app-title-menu-trigger"));
      await expect.element(page.getByRole("menuitem", { name: "Favorite" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "Capabilities" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "Reload" })).toBeVisible();
    } finally {
      await english.unmount();
    }
    const chinese = await renderFrame(true);
    try {
      await expect.element(page.getByText("正在打开应用页…")).toBeVisible();
      const header = page.getByTestId("page-app-more-menu-trigger").element().closest("header")!;
      expect(header.textContent).not.toContain("AI 生成的内容");
      await userEvent.click(page.getByTestId("page-app-more-menu-trigger"));
      await expect.element(page.getByRole("menuitem", { name: "收藏" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "能力权限" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "重新加载" })).toBeVisible();
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
