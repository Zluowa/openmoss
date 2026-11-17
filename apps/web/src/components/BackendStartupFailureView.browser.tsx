import "../index.css";

import type {
  DesktopBackendStartupBridge,
  DesktopBackendStartupFailure,
  DesktopBridge,
} from "@moss/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { BackendStartupFailureOverlay } from "./BackendStartupFailureView";

const FAILURE: DesktopBackendStartupFailure = {
  failures: 5,
  details: "Moss 1.0.5 (win32 x64)\n\nLast error:\n[moss-server] fatal error, stopping: boom",
};

function installBridge(initial: DesktopBackendStartupFailure | null) {
  let listener: ((failure: DesktopBackendStartupFailure | null) => void) | null = null;
  const bridge: DesktopBackendStartupBridge = {
    getFailure: vi.fn(async () => initial),
    onFailure: vi.fn((next) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    retry: vi.fn(async () => undefined),
    openLogFolder: vi.fn(async () => undefined),
  };
  window.desktopBridge = { backendStartup: bridge } as unknown as DesktopBridge;
  return {
    bridge,
    push: (failure: DesktopBackendStartupFailure | null) => listener?.(failure),
  };
}

const originalBridge = window.desktopBridge;
afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
});

describe("BackendStartupFailureOverlay", () => {
  it("replaces the window with the failure and its actions when the desktop gives up", async () => {
    const fake = installBridge(null);
    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <div>正在加载项目…</div>
        <BackendStartupFailureOverlay />
      </MossLocaleScope>,
    );
    await vi.waitFor(() => expect(fake.bridge.getFailure).toHaveBeenCalledOnce());
    expect(screen.container.querySelector("[role=alertdialog]")).toBeNull();

    fake.push(FAILURE);
    const dialog = page.getByRole("alertdialog", { name: "Moss 无法启动本地服务" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog)
      .toHaveTextContent("本地服务连续 5 次启动失败。请重试；如果仍然失败，请复制详情发给我们。");
    // The overlay covers the whole window, loading text included.
    const box = dialog.element().getBoundingClientRect();
    expect(box.width).toBe(window.innerWidth);
    expect(box.height).toBe(window.innerHeight);

    await userEvent.click(page.getByRole("button", { name: "打开日志" }));
    expect(fake.bridge.openLogFolder).toHaveBeenCalledOnce();
    await userEvent.click(page.getByRole("button", { name: "重试" }));
    expect(fake.bridge.retry).toHaveBeenCalledOnce();

    fake.push(null);
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows a failure that happened before the window asked, in English too", async () => {
    installBridge(FAILURE);
    await render(
      <MossLocaleScope locale="en">
        <BackendStartupFailureOverlay />
      </MossLocaleScope>,
    );
    await expect
      .element(page.getByRole("alertdialog", { name: "Moss couldn't start its local service" }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy details" })).toBeVisible();
  });

  // 2026-11-17: a database lock stopped startup and the window kept spinning on
  // "正在加载项目…" while the only explanation hid behind it as a native dialog.
  it("tells the person the data is in use, what to do, and where the log is", async () => {
    const fake = installBridge(null);
    await render(
      <MossLocaleScope locale="zh-CN">
        <div>正在加载项目…</div>
        <BackendStartupFailureOverlay />
      </MossLocaleScope>,
    );
    await vi.waitFor(() => expect(fake.bridge.getFailure).toHaveBeenCalledOnce());
    fake.push({
      kind: "database-locked",
      failures: 1,
      ownerPid: 51248,
      logFilePath: "C:\\Users\\me\\.moss\\userdata\\logs\\server-child.log",
      details: "Moss 1.0.7 (win32 x64)\n\nThe local data folder is in use by process 51248.",
    });

    const dialog = page.getByRole("alertdialog", { name: "Moss 无法打开本地数据" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog)
      .toHaveTextContent(
        "另一个 Moss 窗口或进程（进程 51248）正在使用你的本地数据。请关闭其他 Moss 窗口，然后重试。你的数据没有被更改。",
      );
    await expect
      .element(page.getByText("日志文件：C:\\Users\\me\\.moss\\userdata\\logs\\server-child.log"))
      .toBeVisible();
    const box = dialog.element().getBoundingClientRect();
    expect(box.width).toBe(window.innerWidth);
    expect(box.height).toBe(window.innerHeight);

    await userEvent.click(page.getByRole("button", { name: "重试" }));
    expect(fake.bridge.retry).toHaveBeenCalledOnce();
    fake.push(null);
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("says so when the lock's owner is unknown", async () => {
    installBridge({
      kind: "database-locked",
      failures: 1,
      ownerPid: null,
      details: "Moss 1.0.7",
    });
    await render(
      <MossLocaleScope locale="zh-CN">
        <BackendStartupFailureOverlay />
      </MossLocaleScope>,
    );
    await expect
      .element(page.getByRole("alertdialog", { name: "Moss 无法打开本地数据" }))
      .toHaveTextContent("Moss 无法确认是谁在使用你的本地数据");
  });

  it("draws nothing outside the desktop app", async () => {
    delete window.desktopBridge;
    const screen = await render(<BackendStartupFailureOverlay />);
    expect(screen.container.innerHTML).toBe("");
  });
});
