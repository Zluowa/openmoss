import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { persistSidebarUiState, readSidebarUiState } from "~/components/Sidebar.uiState";
import { prepareMossPostAuthChatLanding } from "./mossPostAuthLanding";

describe("Moss post-auth chat landing", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("clears only remembered navigation while preserving sidebar history preferences", () => {
    persistSidebarUiState({
      chatSectionExpanded: true,
      chatThreadListExtraPages: 3,
      projectThreadListExtraPagesByCwd: { "/Users/tester/project": 2 },
      dismissedThreadStatusKeyByThreadId: { "thread-old": "Completed:turn-old" },
      lastThreadRoute: { threadId: "thread-old", splitViewId: "split-old" },
      safeMainNavigationTarget: null,
      activityViewEnabled: true,
      activityScope: null,
    });

    prepareMossPostAuthChatLanding();

    expect(readSidebarUiState()).toEqual({
      chatSectionExpanded: true,
      chatThreadListExtraPages: 3,
      projectThreadListExtraPagesByCwd: { "/Users/tester/project": 2 },
      dismissedThreadStatusKeyByThreadId: { "thread-old": "Completed:turn-old" },
      lastThreadRoute: null,
      safeMainNavigationTarget: null,
      activityViewEnabled: true,
      activityScope: null,
    });
  });

  it("does not block login when browser storage is unavailable", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("storage unavailable");
        },
        setItem: () => {
          throw new Error("storage unavailable");
        },
      },
    });

    expect(() => prepareMossPostAuthChatLanding()).not.toThrow();
  });
});
