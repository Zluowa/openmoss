import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserPanelPreferenceStore, normalizeAllowedSiteOrigin } from "./browserPanelPreferences";

const directories: string[] = [];

function tempDir(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-browser-prefs-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("normalizeAllowedSiteOrigin", () => {
  it("keeps only a web origin", () => {
    expect(normalizeAllowedSiteOrigin("example.com")).toBe("https://example.com");
    expect(normalizeAllowedSiteOrigin("http://localhost:5173/path?q")).toBe(
      "http://localhost:5173",
    );
    expect(normalizeAllowedSiteOrigin("https://user:pw@example.com")).toBeNull();
    expect(normalizeAllowedSiteOrigin("file:///C:/x.html")).toBeNull();
    expect(normalizeAllowedSiteOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeAllowedSiteOrigin("   ")).toBeNull();
  });
});

describe("BrowserPanelPreferenceStore", () => {
  it("keeps allowed sites and cookie retention across restarts", () => {
    const directory = tempDir();
    const store = new BrowserPanelPreferenceStore(directory);
    expect(store.get()).toEqual({ allowedSites: [], cookieRetention: "keep" });
    store.addAllowedSite("cdn.example.com");
    store.addAllowedSite("https://cdn.example.com/lib.js");
    store.setCookieRetention("untilQuit");

    const reopened = new BrowserPanelPreferenceStore(directory);
    expect(reopened.get()).toEqual({
      allowedSites: ["https://cdn.example.com"],
      cookieRetention: "untilQuit",
    });
    expect(reopened.isAllowedSite("https://cdn.example.com/other")).toBe(true);
    reopened.removeAllowedSite("https://cdn.example.com");
    expect(new BrowserPanelPreferenceStore(directory).get().allowedSites).toEqual([]);
  });

  it("refuses an address that is not a web site", () => {
    const store = new BrowserPanelPreferenceStore(tempDir());
    expect(() => store.addAllowedSite("file:///etc/passwd")).toThrow();
  });

  it("reads a damaged file as defaults", () => {
    const directory = tempDir();
    FS.writeFileSync(Path.join(directory, "browser-panel-preferences.json"), "{not json");
    expect(new BrowserPanelPreferenceStore(directory).get()).toEqual({
      allowedSites: [],
      cookieRetention: "keep",
    });
  });
});
