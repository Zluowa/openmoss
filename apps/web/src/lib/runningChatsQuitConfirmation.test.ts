import { describe, expect, it } from "vitest";

import {
  isRunningChatForQuit,
  listRunningChatsFromDesktopStore,
  listRunningWorkForQuit,
  runningChatsQuitCopy,
  stopRunningChatsForQuit,
} from "./runningChatsQuitConfirmation";

describe("running chats quit confirmation", () => {
  it("treats running, connecting, and live-tail chats as in progress", () => {
    expect(isRunningChatForQuit({ session: { status: "running" } })).toBe(true);
    expect(isRunningChatForQuit({ session: { status: "connecting" } })).toBe(true);
    expect(isRunningChatForQuit({ hasLiveTailWork: true, session: { status: "ready" } })).toBe(
      true,
    );
    expect(isRunningChatForQuit({ session: { status: "ready" } })).toBe(false);
    expect(isRunningChatForQuit({ session: null })).toBe(false);
  });

  it("lists sidebar and session-only running chats without duplicates", () => {
    const chats = listRunningChatsFromDesktopStore({
      sidebarThreadSummaryById: {
        a: { id: "a", title: "Sidebar running", session: { status: "running" } },
        idle: { id: "idle", title: "Idle", session: { status: "ready" } },
      },
      threadSessionById: {
        a: { status: "running" },
        b: { status: "connecting" },
        idle: { status: "ready" },
      },
      threadShellById: {
        b: { title: "Session-only connecting" },
      },
    });

    expect(chats).toEqual([
      { id: "b", title: "Session-only connecting" },
      { id: "a", title: "Sidebar running" },
    ]);
  });

  it("interrupts running chats without waiting for them to settle", async () => {
    const interrupted: string[] = [];
    let settleInterrupt: (() => void) | undefined;
    const hanging = new Promise<void>((resolve) => {
      settleInterrupt = resolve;
    });

    const stopping = stopRunningChatsForQuit({
      chats: [{ id: "a" }, { id: "b" }],
      dispatchInterrupt: async (threadId) => {
        interrupted.push(threadId);
        if (threadId === "b") {
          await hanging;
        }
      },
    });

    expect(interrupted).toEqual(["a", "b"]);
    settleInterrupt?.();
    await stopping;
  });

  it("still returns if interrupt dispatch fails", async () => {
    await expect(
      stopRunningChatsForQuit({
        chats: [{ id: "a" }],
        dispatchInterrupt: async () => {
          throw new Error("rpc failed");
        },
      }),
    ).resolves.toEqual({ resumeRecorded: false });
  });

  it("lets the server record and interrupt when resume is requested", async () => {
    const prepared: ReadonlyArray<string>[] = [];
    const interrupted: string[] = [];

    await expect(
      stopRunningChatsForQuit({
        chats: [{ id: "a" }, { id: "b" }],
        dispatchInterrupt: (threadId) => {
          interrupted.push(threadId);
        },
        resume: {
          prepare: async (threadIds) => {
            prepared.push(threadIds);
          },
        },
      }),
    ).resolves.toEqual({ resumeRecorded: true });

    expect(prepared).toEqual([["a", "b"]]);
    expect(interrupted).toEqual([]);
  });

  it("falls back to plain interrupts when recording fails", async () => {
    const interrupted: string[] = [];

    await expect(
      stopRunningChatsForQuit({
        chats: [{ id: "a" }],
        dispatchInterrupt: (threadId) => {
          interrupted.push(threadId);
        },
        resume: {
          prepare: async () => {
            throw new Error("rpc failed");
          },
        },
      }),
    ).resolves.toEqual({ resumeRecorded: false });

    expect(interrupted).toEqual(["a"]);
  });

  it("falls back to plain interrupts when recording does not ack in time, without waiting on them", async () => {
    const interrupted: string[] = [];

    await expect(
      stopRunningChatsForQuit({
        chats: [{ id: "a" }],
        dispatchInterrupt: (threadId) => {
          interrupted.push(threadId);
          // A hanging interrupt (unresponsive server) must not hold the quit.
          return new Promise(() => {});
        },
        resume: {
          prepare: () => new Promise(() => {}),
          timeoutMs: 5,
        },
      }),
    ).resolves.toEqual({ resumeRecorded: false });

    expect(interrupted).toEqual(["a"]);
  });

  it("survives an interrupt dispatcher that throws synchronously", async () => {
    await expect(
      stopRunningChatsForQuit({
        chats: [{ id: "a" }],
        dispatchInterrupt: () => {
          throw new Error("sync failure");
        },
      }),
    ).resolves.toEqual({ resumeRecorded: false });
  });

  it("skips recording entirely when there is nothing running", async () => {
    let prepared = false;
    await expect(
      stopRunningChatsForQuit({
        chats: [],
        dispatchInterrupt: () => {},
        resume: {
          prepare: async () => {
            prepared = true;
          },
        },
      }),
    ).resolves.toEqual({ resumeRecorded: false });
    expect(prepared).toBe(false);
  });

  it("lists running terminal commands, dev servers, imports and an update download", () => {
    const idle = {
      terminalStateByThreadId: {},
      threadTitleById: () => null,
      devServers: [],
      projectNameById: () => null,
      imports: [],
      updateDownloading: false,
    };
    expect(listRunningWorkForQuit(idle)).toEqual([]);
    expect(
      listRunningWorkForQuit({
        ...idle,
        terminalStateByThreadId: {
          t1: { runningTerminalIds: ["default", "default"] },
          t2: { runningTerminalIds: [] },
        },
        threadTitleById: (id) => (id === "t1" ? "Fix the tray" : null),
        devServers: [
          { projectId: "p1", command: "bun run dev", status: "running" },
          { projectId: "p2", command: "vite", status: "stopped" },
        ],
        projectNameById: (id) => (id === "p1" ? "Moss" : null),
        imports: [{ id: "panel", label: "" }],
        updateDownloading: true,
      }),
    ).toEqual([
      { id: "terminal:t1:default", kind: "terminal", detail: "Fix the tray" },
      { id: "devServer:p1", kind: "devServer", detail: "Moss · bun run dev" },
      { id: "import:panel", kind: "import", detail: "" },
      { id: "updateDownload", kind: "updateDownload", detail: "" },
    ]);
  });

  it("names chats in the title only when chats are all that is running", () => {
    expect(runningChatsQuitCopy([{ id: "a", title: "A" }]).title).toBe("A chat is still running");
    expect(
      runningChatsQuitCopy([
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ]).title,
    ).toBe("Chats are still running");
    expect(
      runningChatsQuitCopy([{ id: "a", title: "A" }], "Moss", [
        { id: "updateDownload", kind: "updateDownload", detail: "" },
      ]).title,
    ).toBe("Work is still running");
    expect(runningChatsQuitCopy([], "Moss").description).toBe(
      "Work in progress will stop when Moss is closed.",
    );
  });
});
