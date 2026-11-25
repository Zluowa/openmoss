import "../index.css";

import type { DesktopBridge, DesktopQuitConfirmationRequest } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useRunningImportsStore } from "~/lib/runningImportsStore";
import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "~/localization/zhCN";
import { useStore } from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";

import { RunningChatsQuitCoordinator } from "./RunningChatsQuitCoordinator";

vi.mock("~/lib/wsHttpUrl", async (original) => ({
  ...(await original<typeof import("../lib/wsHttpUrl")>()),
  resolveWsHttpUrl: () => "",
}));

const originalBridge = window.desktopBridge;
const originalState = useStore.getState();
const originalTerminalState = useTerminalStateStore.getState();

afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  useStore.setState(originalState, true);
  useTerminalStateStore.setState(originalTerminalState, true);
  useRunningImportsStore.setState({ importsById: {} });
});

async function mountCoordinator(options?: {
  readonly updateTrayStatus?: (input: { runningTaskCount: number }) => Promise<void>;
}) {
  let request: ((payload: DesktopQuitConfirmationRequest) => void) | undefined;
  const reply = vi.fn();
  window.desktopBridge = {
    onQuitConfirmationRequest: (listener: (payload: DesktopQuitConfirmationRequest) => void) => {
      request = listener;
      return () => {
        request = undefined;
      };
    },
    replyQuitConfirmation: reply,
    ...(options?.updateTrayStatus
      ? {
          desktopBehavior: {
            getState: vi.fn(async () => ({
              closeToTray: true,
              closeToTraySupported: true,
              openAtLogin: false,
              openAtLoginSupported: false,
            })),
            setCloseToTray: vi.fn(),
            setOpenAtLogin: vi.fn(),
            updateTrayStatus: options.updateTrayStatus,
          },
        }
      : {}),
  } as unknown as DesktopBridge;
  useStore.setState({ sidebarThreadSummaryById: {}, threadSessionById: {}, threadShellById: {} });
  useTerminalStateStore.setState({ terminalStateByThreadId: {} });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RunningChatsQuitCoordinator />
    </QueryClientProvider>,
  );
  return {
    screen,
    reply,
    request: (payload: DesktopQuitConfirmationRequest) => request?.(payload),
  };
}

it("lets an idle app quit without showing a dialog", async () => {
  const { screen, reply, request } = await mountCoordinator();
  try {
    request({ requestId: "q1", presentation: "in-app" });
    expect(reply).toHaveBeenCalledWith({
      requestId: "q1",
      phase: "ready",
      runningCount: 0,
      chats: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("says what is still running, supports Escape, and asks again after cancel", async () => {
  const { screen, reply, request } = await mountCoordinator();
  useRunningImportsStore.getState().setRunning("panel", "");
  try {
    request({ requestId: "q1", presentation: "in-app", updateDownloading: true });
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(reply).toHaveBeenCalledWith({
      requestId: "q1",
      phase: "ready",
      runningCount: 2,
      chats: [],
    });
    await expect.element(page.getByText("Work is still running")).toBeVisible();
    await expect.element(page.getByText("Importing conversations")).toBeVisible();
    await expect.element(page.getByText("Downloading an app update")).toBeVisible();
    // No chats, so there is nothing to resume.
    await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(reply).toHaveBeenCalledWith({ requestId: "q1", phase: "decision", allow: false });

    request({ requestId: "q2", presentation: "in-app", updateDownloading: true });
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Quit", exact: true }).click();
    expect(reply).toHaveBeenCalledWith({ requestId: "q2", phase: "decision", allow: true });
  } finally {
    await screen.unmount();
  }
});

it("syncs tray running task count only when the total changes", async () => {
  const updateTrayStatus = vi.fn(async () => undefined);
  const { screen } = await mountCoordinator({ updateTrayStatus });
  try {
    expect(updateTrayStatus).toHaveBeenCalledTimes(1);
    expect(updateTrayStatus).toHaveBeenLastCalledWith({ runningTaskCount: 0 });

    // Unchanged count (empty store write) should not emit a duplicate IPC call.
    useRunningImportsStore.setState({ importsById: {} });
    expect(updateTrayStatus).toHaveBeenCalledTimes(1);

    useRunningImportsStore.getState().setRunning("panel", "");
    expect(updateTrayStatus).toHaveBeenCalledTimes(2);
    expect(updateTrayStatus).toHaveBeenLastCalledWith({ runningTaskCount: 1 });

    useRunningImportsStore.setState({ importsById: {} });
    expect(updateTrayStatus).toHaveBeenCalledTimes(3);
    expect(updateTrayStatus).toHaveBeenLastCalledWith({ runningTaskCount: 0 });
  } finally {
    await screen.unmount();
  }
});

it("WALK-13 N13-9: a single waiting chat says 「有一个对话在等你批准」, matches 「拒绝 Esc」, and has no scrollbar", async () => {
  document.documentElement.lang = "zh-CN";
  document.documentElement.dataset.mossLocale = "zh-CN";
  installZhCnUiLocalization();
  const { screen, request } = await mountCoordinator();
  useStore.setState({
    sidebarThreadSummaryById: {
      "thread-waiting": {
        id: "thread-waiting",
        title: "看看这个项目 WALK:FULL",
        hasPendingApprovals: true,
        session: { status: "running" },
      },
    } as never,
    threadSessionById: {
      "thread-waiting": { status: "running" },
    } as never,
  });
  try {
    request({ requestId: "q-wait", presentation: "in-app" });
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByText("有一个对话在等你批准", { exact: true })).toBeVisible();
    expect(dialog.element().textContent).not.toContain("Esc 键");

    const cancelButton = page.getByRole("button", { name: "取消", exact: true }).element();
    expect(cancelButton.querySelector("kbd")?.textContent?.trim()).toBe("Esc");
    const quitButton = page.getByRole("button", { name: "退出", exact: true }).element();
    expect(quitButton.querySelector("kbd")?.textContent?.trim()).toBe("↵");

    const list = dialog.element().querySelector<HTMLUListElement>("ul")!;
    expect(list).not.toBeNull();
    expect(getComputedStyle(list).overflowY).not.toBe("auto");
    expect(list.scrollHeight).toBeLessThanOrEqual(list.clientHeight);
  } finally {
    await screen.unmount();
    uninstallZhCnUiLocalization();
    document.documentElement.lang = "en";
    delete document.documentElement.dataset.mossLocale;
  }
});

it("WALK-13 N13-9: a single running chat says 「有一个对话正在运行」 and has no scrollbar", async () => {
  document.documentElement.lang = "zh-CN";
  document.documentElement.dataset.mossLocale = "zh-CN";
  installZhCnUiLocalization();
  const { screen, request } = await mountCoordinator();
  useStore.setState({
    sidebarThreadSummaryById: {
      "thread-running": {
        id: "thread-running",
        title: "Running task",
        hasPendingApprovals: false,
        session: { status: "running" },
      },
    } as never,
    threadSessionById: {
      "thread-running": { status: "running" },
    } as never,
  });
  try {
    request({ requestId: "q-run", presentation: "in-app" });
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByText("有一个对话正在运行", { exact: true })).toBeVisible();

    const list = dialog.element().querySelector<HTMLUListElement>("ul")!;
    expect(list).not.toBeNull();
    expect(getComputedStyle(list).overflowY).not.toBe("auto");
    expect(list.scrollHeight).toBeLessThanOrEqual(list.clientHeight);
  } finally {
    await screen.unmount();
    uninstallZhCnUiLocalization();
    document.documentElement.lang = "en";
    delete document.documentElement.dataset.mossLocale;
  }
});
