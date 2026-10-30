// FILE: pluginLibraryHistoryState.test.ts
// Purpose: Locks validation of serializable plugin route history snapshots.
// Layer: Web routing state test

import { describe, expect, it } from "vitest";

import {
  readPluginLibraryEntrySnapshot,
  readPluginLibraryFocusAnchor,
  readPluginLibraryManageSnapshot,
  shouldReturnToPreviousPluginLibraryHistoryEntry,
} from "./pluginLibraryHistoryState";

function entrySnapshot(sourcePath: string) {
  return {
    pluginLibraryEntrySnapshot: {
      sourcePath,
      initialHostId: "codex",
      initialTab: "plugins",
      activeBucket: "moss",
      selectedSectionId: null,
      search: { plugins: "Git", mcp: "", skills: "" },
      scrollTop: 37,
      focusAnchor: { kind: "key", value: "header:manage" },
    },
  };
}

describe("plugin library history state", () => {
  it("accepts canonical browse, detail, manage, and settings sources", () => {
    for (const sourcePath of [
      "/skills",
      "/skills/manage",
      "/skills/plugins/github%40openai-curated",
      "/skills/manage/plugins/github%40openai-curated",
      "/settings/plugins-settings",
    ]) {
      expect(readPluginLibraryEntrySnapshot(entrySnapshot(sourcePath))?.sourcePath).toBe(
        sourcePath,
      );
    }
  });

  it("rejects forged, non-canonical, and query-bearing source paths", () => {
    for (const sourcePath of [
      "https://attacker.test/skills",
      "//attacker.test/skills",
      "/skills?next=https://attacker.test",
      "/skills/",
      "/plugins",
      "/skills/plugins/a%2Fb",
      "/settings/plugins-settings/extra",
    ]) {
      expect(readPluginLibraryEntrySnapshot(entrySnapshot(sourcePath))).toBeNull();
    }
  });

  it("rejects extra keys in entry, search, and focus-anchor snapshots", () => {
    const canonical = entrySnapshot("/skills").pluginLibraryEntrySnapshot;
    expect(
      readPluginLibraryEntrySnapshot({
        pluginLibraryEntrySnapshot: { ...canonical, forged: true },
      }),
    ).toBeNull();
    expect(
      readPluginLibraryEntrySnapshot({
        pluginLibraryEntrySnapshot: {
          ...canonical,
          search: { ...canonical.search, forged: true },
        },
      }),
    ).toBeNull();
    expect(
      readPluginLibraryEntrySnapshot({
        pluginLibraryEntrySnapshot: {
          ...canonical,
          focusAnchor: { ...canonical.focusAnchor, forged: true },
        },
      }),
    ).toBeNull();
    expect(
      readPluginLibraryFocusAnchor({
        pluginLibraryFocusAnchor: {
          kind: "key",
          value: "header:manage",
          forged: true,
        },
      }),
    ).toBeNull();
  });

  it("accepts an exact manage snapshot and rejects nested extra keys", () => {
    const canonical = {
      initialTab: "plugins",
      search: "Git",
      scrollTop: 37,
      focusAnchor: { kind: "key", value: "manage:plugins" },
    } as const;
    expect(readPluginLibraryManageSnapshot({ pluginLibraryManageSnapshot: canonical })).toEqual(
      canonical,
    );
    expect(
      readPluginLibraryManageSnapshot({
        pluginLibraryManageSnapshot: { ...canonical, forged: true },
      }),
    ).toBeNull();
    expect(
      readPluginLibraryManageSnapshot({
        pluginLibraryManageSnapshot: {
          ...canonical,
          focusAnchor: { ...canonical.focusAnchor, forged: true },
        },
      }),
    ).toBeNull();
  });

  it("keeps Codex's five manage tabs and rejects unknown ones from history state", () => {
    expect(
      readPluginLibraryManageSnapshot({
        pluginLibraryManageSnapshot: {
          initialTab: "skills",
          search: "",
          scrollTop: 0,
          focusAnchor: null,
        },
      })?.initialTab,
    ).toBe("skills");
    for (const initialTab of ["marketplace", "connectors"]) {
      expect(
        readPluginLibraryManageSnapshot({
          pluginLibraryManageSnapshot: {
            initialTab,
            search: "",
            scrollTop: 0,
            focusAnchor: null,
          },
        }),
      ).toBeNull();
    }
  });

  it("allows Back only when the return flag is paired with an exact canonical entry", () => {
    const canonical = entrySnapshot("/skills");
    expect(
      shouldReturnToPreviousPluginLibraryHistoryEntry({
        ...canonical,
        pluginLibraryReturnToPreviousHistoryEntry: true,
      }),
    ).toBe(true);
    expect(
      shouldReturnToPreviousPluginLibraryHistoryEntry({
        pluginLibraryEntrySnapshot: {
          ...canonical.pluginLibraryEntrySnapshot,
          forged: true,
        },
        pluginLibraryReturnToPreviousHistoryEntry: true,
      }),
    ).toBe(false);
    expect(
      shouldReturnToPreviousPluginLibraryHistoryEntry({
        ...entrySnapshot("/plugins"),
        pluginLibraryReturnToPreviousHistoryEntry: true,
      }),
    ).toBe(false);
  });
});
