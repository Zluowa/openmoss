import { describe, expect, it } from "vitest";
import { connectionTabFromSearch, SSH_SETTINGS_TARGET } from "./connectionSettingsNavigation";
import { normalizeSettingsSection, SETTINGS_NAV_ITEMS } from "./settingsNavigation";
import { rankSettingsSearchEntries } from "./settingsSearchIndex";

describe("connection hub navigation", () => {
  it("enters the real local-computer tab by default", () => {
    expect(connectionTabFromSearch({ section: "connections" })).toBe("this");
  });
  it("restores explicit tabs and the selection made earlier in the route", () => {
    expect(connectionTabFromSearch({ connectionTab: "ssh" }, "this")).toBe("ssh");
    expect(connectionTabFromSearch({ connectionTab: "devices" })).toBe("devices");
    expect(connectionTabFromSearch({ connectionTab: "invalid" }, "ssh")).toBe("ssh");
  });
  it("keeps legacy computer deep links on the local tab without a second sidebar page", () => {
    expect(normalizeSettingsSection("computer")).toBe("connections");
    expect(connectionTabFromSearch({ section: "computer", connectionTab: "ssh" })).toBe("this");
    expect(SETTINGS_NAV_ITEMS.filter((item) => item.id === "connections")).toHaveLength(1);
    expect(SETTINGS_NAV_ITEMS.some((item) => item.id === "computer")).toBe(false);
  });
  it("takes SSH search results directly to the SSH workflow", () => {
    const result = rankSettingsSearchEntries("SSH connections", 1)[0]!;
    expect(result.id).toBe("connections:ssh");
    expect(connectionTabFromSearch({ section: result.section, target: result.target })).toBe("ssh");
    expect(connectionTabFromSearch({ target: SSH_SETTINGS_TARGET, connectionTab: "this" })).toBe(
      "this",
    );
  });
});
