import { isBetaFeatureEnabled, MCP_CONNECTORS_BETA_FEATURE } from "@moss/shared/betaFeatures";
import { describe, expect, it } from "vitest";

import {
  CODEX_RESOURCE_LEGACY_SECTIONS,
  isSettingsSectionAvailable,
  normalizeSettingsSection,
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
  SETTINGS_SECTION_IDS,
} from "./settingsNavigation";
import { resolveSettingsLocation, settingsLocationFromSearch } from "./settingsLocation";

describe("settings sections", () => {
  it("hides Connectors where its Beta feature is off", () => {
    expect(isSettingsSectionAvailable("connectors", () => false)).toBe(false);
    expect(
      isSettingsSectionAvailable(
        "connectors",
        (feature) => feature === MCP_CONNECTORS_BETA_FEATURE,
      ),
    ).toBe(true);
    expect(isSettingsSectionAvailable("integrations", () => false)).toBe(true);
  });

  it("lists every page once and none of the folded-away ones", () => {
    expect(
      isSettingsSectionAvailable("connectors", (feature) =>
        isBetaFeatureEnabled(feature, "production"),
      ),
    ).toBe(true);
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.toSorted()).toEqual(
      SETTINGS_SECTION_IDS.filter(
        (id) => !(CODEX_RESOURCE_LEGACY_SECTIONS as readonly string[]).includes(id),
      ).toSorted(),
    );
  });

  it("has no System tools page and no separate MCP connections page (#431, reverting #436)", () => {
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id as string);
    expect(ids).not.toContain("advanced");
    expect(ids).not.toContain("integrations");
    expect(ids).not.toContain("connectors");
    expect(ids).not.toContain("skills");
    expect(SETTINGS_NAV_GROUPS.map((group) => group.id)).not.toContain("system");
  });

  it("gives computer use and AppSnap pages of their own beside Plugins", () => {
    const integrations = SETTINGS_NAV_ITEMS.filter((item) => item.group === "integrations").map(
      (item) => item.id,
    );
    expect(integrations).toEqual(["plugins", "computer-use", "appsnap", "history", "connections"]);
  });

  it("sends old links to where their controls live now", () => {
    expect(resolveSettingsLocation({ section: "integrations" })).toEqual({
      section: "plugins",
      pluginTab: "mcp",
    });
    expect(resolveSettingsLocation({ section: "connectors" })).toEqual({
      section: "plugins",
      pluginTab: "mcp",
    });
    expect(resolveSettingsLocation({ section: "skills" })).toEqual({
      section: "plugins",
      pluginTab: "skills",
    });
    expect(resolveSettingsLocation({ section: "advanced" })).toEqual({ section: "general" });
    expect(settingsLocationFromSearch({}, "/settings/plugins-settings")).toEqual({
      section: "plugins",
    });
    expect(
      settingsLocationFromSearch({ section: "providers", target: "provider-installs" }),
    ).toEqual({ section: "providers", target: "provider-installs" });
  });

  it("falls back to General for unknown sections", () => {
    expect(normalizeSettingsSection("nope")).toBe("general");
    expect(normalizeSettingsSection(undefined)).toBe("general");
    expect(resolveSettingsLocation({ section: "nope" })).toEqual({ section: "general" });
  });
});
