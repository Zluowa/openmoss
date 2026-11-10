import { isBetaFeatureEnabled, MCP_CONNECTORS_BETA_FEATURE } from "@moss/shared/betaFeatures";
import { describe, expect, it } from "vitest";

import {
  CODEX_RESOURCE_LEGACY_SECTIONS,
  isSettingsSectionAvailable,
  normalizeSettingsSection,
  SETTINGS_NAV_ITEMS,
  SETTINGS_SECTION_IDS,
} from "./settingsNavigation";

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

  it("keeps the legacy resource sections out of navigation", () => {
    expect(
      isSettingsSectionAvailable("connectors", (feature) =>
        isBetaFeatureEnabled(feature, "production"),
      ),
    ).toBe(true);
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.toSorted()).toEqual(
      SETTINGS_SECTION_IDS.filter((id) => !["connectors", "skills"].includes(id)).toSorted(),
    );
    expect(SETTINGS_NAV_ITEMS.some((item) => item.id === "connectors")).toBe(false);
    expect(SETTINGS_NAV_ITEMS.some((item) => item.id === "skills")).toBe(false);
    expect(normalizeSettingsSection("connectors")).toBe("connectors");
  });

  it("keeps MCP connections and System tools reachable, since the library has neither", () => {
    expect(CODEX_RESOURCE_LEGACY_SECTIONS).not.toContain("integrations");
    expect(CODEX_RESOURCE_LEGACY_SECTIONS).not.toContain("advanced");
    expect(SETTINGS_NAV_ITEMS.find((item) => item.id === "integrations")?.group).toBe(
      "integrations",
    );
    expect(SETTINGS_NAV_ITEMS.find((item) => item.id === "advanced")?.group).toBe("system");
  });

  it("falls back to General for unknown sections", () => {
    expect(normalizeSettingsSection("nope")).toBe("general");
    expect(normalizeSettingsSection(undefined)).toBe("general");
  });
});
