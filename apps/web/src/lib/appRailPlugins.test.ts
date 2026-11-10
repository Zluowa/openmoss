// FILE: appRailPlugins.test.ts
// Purpose: Common plugins follow real account discovery, recency, and saved offline pins.
// Layer: Web model tests
import type { ProviderListPluginsResult } from "@moss/contracts";
import { describe, expect, it } from "vitest";
import { commonAppRailPlugins } from "./appRailPlugins";

describe("common rail plugins", () => {
  const saved = { id: "figma@test", name: "Figma", description: "Design" };
  it("does not invent usable plugin links before the account lists any plugins", () => {
    expect(commonAppRailPlugins({ pinned: [], recent: [] })).toEqual([]);
  });
  it("retains a pinned plugin through a temporary discovery failure", () => {
    expect(commonAppRailPlugins({ pinned: [saved], recent: [saved.id] })).toEqual([saved]);
  });
  it("uses current names, removes duplicates, and orders recently opened installed plugins first", () => {
    const result = {
      marketplaces: [
        {
          plugins: [
            { id: saved.id, name: "Figma new", installed: true, interface: null },
            { id: "notion@test", name: "Notion", installed: true, interface: null },
            { id: "unavailable@test", name: "Other", installed: false, interface: null },
          ],
        },
      ],
      featuredPluginIds: [],
    } as unknown as ProviderListPluginsResult;
    const plugins = commonAppRailPlugins({
      result,
      pinned: [saved],
      recent: ["missing", "notion@test"],
    });
    expect(plugins.map(({ name }) => name)).toEqual(["Notion", "Figma new"]);
  });
});
