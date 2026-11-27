import { ThreadId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getActiveCompanionDockSnapshot,
  publishActiveCompanionDock,
  resetActiveCompanionDockForTests,
  subscribeActiveCompanionDock,
} from "./activeCompanionDock";

afterEach(() => {
  resetActiveCompanionDockForTests();
});

describe("activeCompanionDock", () => {
  it("tracks the live host dock state and clears cleanly on unmount", () => {
    const hostA = Symbol("host-a");
    const thread1 = ThreadId.makeUnsafe("thread-1");
    publishActiveCompanionDock(hostA, {
      artifactKind: "app",
      itemId: "app-1",
      artifactKey: "default:local:app:app-1",
      threadId: thread1,
      dockState: "pip",
      launcherMode: "compact",
      busy: true,
      hasUnread: false,
    });
    expect(getActiveCompanionDockSnapshot()).toEqual({
      artifactKind: "app",
      itemId: "app-1",
      artifactKey: "default:local:app:app-1",
      threadId: thread1,
      dockState: "pip",
      launcherMode: "compact",
      busy: true,
      hasUnread: false,
    });

    publishActiveCompanionDock(hostA, null);
    expect(getActiveCompanionDockSnapshot()).toBeNull();
  });

  it("ignores idempotent updates without notifying listeners", () => {
    const host = Symbol("host");
    const spy = vi.fn();
    const state = {
      artifactKind: "app" as const,
      itemId: "app-1",
      artifactKey: "default:local:app:app-1",
      threadId: ThreadId.makeUnsafe("thread-1"),
      dockState: "collapsed" as const,
      launcherMode: "compact" as const,
      busy: false,
      hasUnread: false,
    };
    publishActiveCompanionDock(host, state);
    expect(getActiveCompanionDockSnapshot()).toEqual(state);
    const unsub = subscribeActiveCompanionDock(spy);
    publishActiveCompanionDock(host, { ...state });
    expect(spy).not.toHaveBeenCalled();
    publishActiveCompanionDock(host, { ...state, busy: true });
    expect(spy).toHaveBeenCalledTimes(1);
    unsub();
  });
});
