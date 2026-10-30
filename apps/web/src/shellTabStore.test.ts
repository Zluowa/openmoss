import { beforeEach, describe, expect, it, vi } from "vitest";

import { isMultiTabStrip, shouldShowShellTabStrip, useShellTabStripStore } from "./shellTabStore";

function installLocalStorageStub(): void {
  const backing = new Map<string, string>();
  const localStorageStub = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, String(value)),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  };
  vi.stubGlobal("window", { localStorage: localStorageStub });
  vi.stubGlobal("localStorage", localStorageStub);
}

describe("shellTabStripStore", () => {
  beforeEach(() => {
    installLocalStorageStub();
    window.localStorage.clear();
    useShellTabStripStore.setState({
      conversation: null,
      extraTabs: [],
      stripCollapsed: false,
    });
  });

  it("tracks the conversation tab and persists it", () => {
    useShellTabStripStore.getState().setConversation({ id: "t1", title: "Unlabeled request 1" });
    expect(useShellTabStripStore.getState().conversation).toEqual({
      id: "t1",
      title: "Unlabeled request 1",
    });
    const persisted = JSON.parse(window.localStorage.getItem("moss:shell-tabs:v1") ?? "{}");
    expect(persisted.conversation).toEqual({ id: "t1", title: "Unlabeled request 1" });
  });

  it("opens draft tabs once and closes them", () => {
    const store = useShellTabStripStore.getState();
    store.openExtraTab({ id: "d1", kind: "draft", title: "新标签页" });
    useShellTabStripStore.getState().openExtraTab({ id: "d1", kind: "draft", title: "新标签页" });
    expect(useShellTabStripStore.getState().extraTabs).toHaveLength(1);
    useShellTabStripStore.getState().closeExtraTab("d1");
    expect(useShellTabStripStore.getState().extraTabs).toHaveLength(0);
  });

  it("removes converted drafts in bulk", () => {
    const store = useShellTabStripStore.getState();
    store.openExtraTab({ id: "d1", kind: "draft", title: "新标签页" });
    useShellTabStripStore.getState().openExtraTab({ id: "d2", kind: "draft", title: "新标签页" });
    useShellTabStripStore.getState().removeExtraTabs(new Set(["d1"]));
    expect(useShellTabStripStore.getState().extraTabs.map((tab) => tab.id)).toEqual(["d2"]);
  });

  it("toggles the collapsed strip and persists it", () => {
    useShellTabStripStore.getState().toggleStripCollapsed();
    expect(useShellTabStripStore.getState().stripCollapsed).toBe(true);
    expect(
      JSON.parse(window.localStorage.getItem("moss:shell-tabs:v1") ?? "{}").stripCollapsed,
    ).toBe(true);
  });
});

describe("strip visibility rules", () => {
  it("stays bare only for the clean new-chat state", () => {
    expect(shouldShowShellTabStrip({ hasConversationTab: false, extraTabCount: 0 })).toBe(false);
    expect(shouldShowShellTabStrip({ hasConversationTab: true, extraTabCount: 0 })).toBe(true);
    expect(shouldShowShellTabStrip({ hasConversationTab: false, extraTabCount: 1 })).toBe(true);
  });

  it("is multi-tab from two tabs onward", () => {
    expect(isMultiTabStrip({ hasConversationTab: true, extraTabCount: 0 })).toBe(false);
    expect(isMultiTabStrip({ hasConversationTab: true, extraTabCount: 1 })).toBe(true);
    expect(isMultiTabStrip({ hasConversationTab: false, extraTabCount: 2 })).toBe(true);
  });
});
