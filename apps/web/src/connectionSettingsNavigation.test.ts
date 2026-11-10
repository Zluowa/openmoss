import { describe, expect, it } from "vitest";
import { connectionTabFromSearch, SSH_SETTINGS_TARGET } from "./connectionSettingsNavigation";
import { normalizeSettingsSection, SETTINGS_NAV_ITEMS } from "./settingsNavigation";
import { rankSettingsSearchEntries } from "./settingsSearchIndex";
import { resolveSettingsLocation } from "./settingsLocation";

describe("connections navigation", () => {
  it("opens on other devices: Connections holds connections only", () => {
    expect(connectionTabFromSearch({ section: "connections" })).toBe("devices");
  });
  it("restores explicit tabs and the selection made earlier", () => {
    expect(connectionTabFromSearch({ connectionTab: "ssh" }, "devices")).toBe("ssh");
    expect(connectionTabFromSearch({ connectionTab: "pairing" })).toBe("pairing");
    expect(connectionTabFromSearch({ connectionTab: "invalid" }, "ssh")).toBe("ssh");
    // The old "this computer" tab is no longer a Connections tab.
    expect(connectionTabFromSearch({ connectionTab: "this" }, "this")).toBe("devices");
  });
  it("sends legacy computer links to the computer-use page, not to Connections", () => {
    expect(normalizeSettingsSection("computer")).toBe("computer-use");
    expect(resolveSettingsLocation({ section: "computer" }).section).toBe("computer-use");
    expect(resolveSettingsLocation({ section: "connections", connectionTab: "this" }).section).toBe(
      "computer-use",
    );
    expect(SETTINGS_NAV_ITEMS.filter((item) => item.id === "connections")).toHaveLength(1);
    expect(SETTINGS_NAV_ITEMS.filter((item) => item.id === "computer-use")).toHaveLength(1);
    expect(SETTINGS_NAV_ITEMS.some((item) => item.id === "computer")).toBe(false);
  });
  it("takes SSH search results directly to the SSH workflow", () => {
    const result = rankSettingsSearchEntries("SSH connections", 1)[0]!;
    expect(result.id).toBe("connections:ssh");
    expect(connectionTabFromSearch({ section: result.section, target: result.target })).toBe("ssh");
    expect(connectionTabFromSearch({ target: SSH_SETTINGS_TARGET, connectionTab: "pairing" })).toBe(
      "pairing",
    );
  });
});
