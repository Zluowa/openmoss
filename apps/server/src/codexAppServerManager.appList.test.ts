// FILE: codexAppServerManager.appList.test.ts
// Purpose: `app/list` is account-wide. It must never name a Moss thread to Codex and never run
//          in a chat's session. Settings › Plugins › Apps showed "app/list failed: thread not
//          found: <id>" for the Mossbot chat (owner feedback 2026-11-10), whose stream was also
//          at capacity; a busy or stuck chat must not break the Apps tab.

import { ThreadId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerManager } from "./codexAppServerManager";

type Internals = {
  resolveContextForDiscovery: (...args: unknown[]) => Promise<unknown>;
  getOrCreateDiscoverySession: (...args: unknown[]) => Promise<unknown>;
  sendRequest: (...args: unknown[]) => Promise<unknown>;
  authFingerprintForOptions: (...args: unknown[]) => Promise<string>;
  assertDiscoveryAuthMatchesRequest: (...args: unknown[]) => void;
  assertDiscoveryRequestAuthCurrent: (...args: unknown[]) => void;
  isContextInitializedAndRoutable: (context: unknown) => boolean;
  sessions: Map<ThreadId, unknown>;
};

const EMPTY_PAGE = { data: [], nextCursor: null };

function fakeContext(name: string, cwd: string) {
  return {
    name,
    session: {
      provider: "codex",
      status: "ready",
      threadId: "moss-thread",
      runtimeMode: "full-access",
      cwd,
      resumeCursor: { threadId: "codex-thread-7" },
    },
  };
}

function setup() {
  const manager = new CodexAppServerManager();
  const internal = manager as unknown as Internals;
  vi.spyOn(internal, "authFingerprintForOptions").mockResolvedValue("auth");
  vi.spyOn(internal, "assertDiscoveryAuthMatchesRequest").mockImplementation(() => undefined);
  vi.spyOn(internal, "assertDiscoveryRequestAuthCurrent").mockImplementation(() => undefined);
  vi.spyOn(internal, "isContextInitializedAndRoutable").mockReturnValue(true);
  const discovery = fakeContext("discovery", "/repo");
  const getDiscovery = vi
    .spyOn(internal, "getOrCreateDiscoverySession")
    .mockResolvedValue(discovery);
  const sendRequest = vi.spyOn(internal, "sendRequest").mockResolvedValue(EMPTY_PAGE);
  return { manager, internal, discovery, getDiscovery, sendRequest };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CodexAppServerManager.listApps", () => {
  it("never sends a thread id and runs in a dedicated discovery session", async () => {
    const { manager, internal, discovery, getDiscovery, sendRequest } = setup();
    // The focused chat has a live session in the same folder: app/list must not use it.
    const chat = fakeContext("chat", "/repo");
    internal.sessions.set(ThreadId.makeUnsafe("fe08f1c9-009f-4012-986b-e3e5c6b63ab3"), chat);

    await expect(
      manager.listApps({
        threadId: "fe08f1c9-009f-4012-986b-e3e5c6b63ab3",
        cwd: "/repo",
        limit: 1_000,
      }),
    ).resolves.toEqual(EMPTY_PAGE);

    expect(getDiscovery).toHaveBeenCalledWith("/repo", undefined, "auth");
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledWith(discovery, "app/list", { limit: 1_000 });
    expect(sendRequest.mock.calls.some(([context]) => context === chat)).toBe(false);
  });

  it("lists the same apps for every chat from one cache entry", async () => {
    const { manager, sendRequest } = setup();
    await manager.listApps({ threadId: "thread-a", cwd: "/repo", limit: 1_000 });
    await manager.listApps({ threadId: "thread-b", cwd: "/repo", limit: 1_000 });
    await manager.listApps({ cwd: "/repo", limit: 1_000 });
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it("still surfaces app/list failures", async () => {
    const { manager, sendRequest } = setup();
    sendRequest.mockRejectedValue(new Error("app/list failed: unauthorized"));
    await expect(manager.listApps({ threadId: "moss-thread", cwd: "/repo" })).rejects.toThrow(
      "unauthorized",
    );
  });
});
