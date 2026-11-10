import "../index.css";

import type { DesktopBridge, DesktopQuitConfirmationRequest } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useRunningImportsStore } from "~/lib/runningImportsStore";
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

async function mountCoordinator() {
  let request: ((payload: DesktopQuitConfirmationRequest) => void) | undefined;
  const reply = vi.fn();
  window.desktopBridge = {
    onQuitConfirmationRequest: (listener) => {
      request = listener;
      return () => {
        request = undefined;
      };
    },
    replyQuitConfirmation: reply,
  } as Pick<DesktopBridge, "onQuitConfirmationRequest" | "replyQuitConfirmation"> as DesktopBridge;
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
