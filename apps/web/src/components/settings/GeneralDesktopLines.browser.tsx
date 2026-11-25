// FILE: GeneralDesktopLines.browser.tsx
// Purpose: What a person reads on 设置 → 通用 in the desktop app (WALK-13 #922 / #890):
//          desktop tray and autostart switches carry no restating lines (and 关闭时收入托盘 is
//          unambiguous in its label), preview channel keeps its line, and 修复本地数据 keeps only
//          「不会删除对话。」 shown only when the control itself appears.
// Layer: Browser UI test

import "../../index.css";

import type { DesktopBridge, ProjectId } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

vi.hoisted(() => {
  // Set before ~/env is evaluated so `isElectron` is true for PreviewChannelSettingsPanel.
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      desktopBehavior: {
        getState: vi.fn(async () => ({
          closeToTray: true,
          closeToTraySupported: true,
          openAtLogin: false,
          openAtLoginSupported: true,
        })),
        setCloseToTray: vi.fn(),
        setOpenAtLogin: vi.fn(),
        updateTrayStatus: vi.fn(async () => undefined),
      },
      previewChannel: {
        get: vi.fn(async () => ({
          supported: true,
          on: false,
          activeNow: false,
        })),
        set: vi.fn(),
      },
    } as unknown as DesktopBridge,
  });
});

import { MossLocalizationProvider } from "~/localization";
import { installZhCnUiLocalization } from "~/localization/zhCN";
import { useStore } from "~/store";
import { SettingsContent } from "./SettingsContent";

function rowDescriptions(): string[] {
  const general = document.querySelector<HTMLElement>("[data-settings-section=general]");
  if (!general) return [];
  return [...general.querySelectorAll('[data-slot="settings-row"] p')]
    .map((line) => line.textContent?.trim() ?? "")
    .filter((line) => line.length > 0);
}

describe("设置 → 通用 in the desktop app (WALK-13 #922)", () => {
  afterEach(() => {
    useStore.setState({ projects: [], threadsHydrated: false });
  });

  it("drops the restating tray and autostart lines while keeping preview channel and the four core lines", async () => {
    installZhCnUiLocalization();
    const screen = await render(
      <QueryClientProvider client={new QueryClient()}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <SettingsContent location={{ section: "general" }} onNavigate={() => {}} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );
    try {
      await expect.element(page.getByText("关闭时收入托盘并继续运行")).toBeVisible();
      await expect.element(page.getByText("开机自动启动")).toBeVisible();
      await expect.element(page.getByText("预览通道：更快收到更新")).toBeVisible();

      await vi.waitFor(() => {
        expect(rowDescriptions()).toEqual([
          "后台下载新版本，下次启动时使用；启动失败会自动退回。",
          "用灰字预测下一条消息，按 Tab 填入。",
          "归档后移除不再使用的工作树，分支会保留。",
          "Moss 出错时发送报告，不含对话、代码和密钥。",
        ]);
      });

      const text = document.body.textContent ?? "";
      expect(text).not.toContain("点击关闭后留在后台继续运行");
      expect(text).not.toContain("登录系统时自动打开 Moss");
      expect(text).not.toContain("修复本地数据");
      expect(text).not.toContain("不会删除对话。");
    } finally {
      await screen.unmount();
    }
  });

  it("shows only 「不会删除对话。」 under 修复本地数据, and only when the control appears", async () => {
    installZhCnUiLocalization();
    useStore.setState({
      projects: [
        {
          id: "project-1" as ProjectId,
          kind: "project",
          name: "moss",
          remoteName: "moss",
          folderName: "moss",
          localName: null,
          cwd: "/tmp/moss",
          defaultModelSelection: null,
          expanded: true,
          scripts: [],
        },
      ],
      threadsHydrated: true,
    });

    const screen = await render(
      <QueryClientProvider client={new QueryClient()}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <SettingsContent location={{ section: "general" }} onNavigate={() => {}} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );
    try {
      await expect.element(page.getByText("修复本地数据")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "修复", exact: true })).toBeVisible();

      await vi.waitFor(() => {
        expect(rowDescriptions()).toEqual([
          "后台下载新版本，下次启动时使用；启动失败会自动退回。",
          "用灰字预测下一条消息，按 Tab 填入。",
          "归档后移除不再使用的工作树，分支会保留。",
          "Moss 出错时发送报告，不含对话、代码和密钥。",
          "不会删除对话。",
        ]);
      });

      expect(document.body.textContent ?? "").not.toContain("对话不显示时使用");
    } finally {
      await screen.unmount();
    }
  });
});
