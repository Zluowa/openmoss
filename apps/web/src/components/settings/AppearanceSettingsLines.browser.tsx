// FILE: AppearanceSettingsLines.browser.tsx
// Purpose: What a person reads on 设置 → 外观 (WALK-12 #892, WALK-13):
//          - App icon (应用图标) has no restating / Mac-specific dock description;
//          - Typography & time settings have no restating lines;
//          - Kept Rule-1 disclosures remain: theme font override note when default UI font is on,
//            and the CSS editor keyboard-escape hint.
// Layer: Browser UI test

import "../../index.css";

import type { DesktopBridge } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

vi.hoisted(() => {
  // Set before ~/env is evaluated so `isElectron` is true and the App section renders.
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {} as DesktopBridge,
  });
});

import { MossLocalizationProvider } from "~/localization";
import { installZhCnUiLocalization } from "~/localization/zhCN";
import { SettingsContent } from "./SettingsContent";

describe("设置 → 外观", () => {
  it("drops the restating App icon and typography lines while keeping required Rule-1 disclosures", async () => {
    installZhCnUiLocalization();
    const screen = await render(
      <QueryClientProvider client={new QueryClient()}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <SettingsContent location={{ section: "appearance" }} onNavigate={() => {}} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );
    try {
      await expect.element(page.getByText("应用图标")).toBeVisible();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const appSection = [...document.querySelectorAll("section")].find(
        (section) => section.querySelector("h2")?.textContent?.trim() === "应用",
      );
      expect(appSection).toBeTruthy();
      const appIconRow = [...appSection!.querySelectorAll('[data-slot="settings-row"]')].find(
        (row) => row.textContent?.includes("应用图标"),
      );
      expect(appIconRow).toBeTruthy();
      expect(
        [...appIconRow!.querySelectorAll("p")].map((p) => p.textContent?.trim()).filter(Boolean),
      ).toEqual([]);

      const bodyText = document.body.textContent ?? "";
      expect(bodyText).not.toContain("程序坞或任务栏中的图标。");
      expect(bodyText).not.toContain("The icon in the dock or taskbar.");
      // Kept under Rule 1: explains why theme UI font is overridden when default UI font is on,
      // and how keyboard users leave the CSS editor when Tab indents.
      expect(bodyText).toContain("已开启使用默认界面字体，主题字体不会生效。");
      expect(bodyText).toContain("Tab 缩进，Shift+Tab 取消缩进。先按 Esc，再按 Tab 可离开编辑框。");

      const lines = document.body.innerText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      expect(lines.slice(lines.indexOf("字体排版与间距"))).toEqual([
        "字体排版与间距",
        "使用默认界面字体",
        "界面密度",
        "紧凑",
        "舒适",
        "宽松",
        "对话宽度",
        "标准",
        "宽",
        "全宽",
        "基础字号",
        "px",
        "终端字号",
        "px",
        "终端字体",
        "时间与阅读",
        "时间格式",
        "跟随系统",
      ]);
    } finally {
      await screen.unmount();
    }
  });
});
