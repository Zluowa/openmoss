import type { BrowserTabState } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  BROWSER_VIEWPORT_PRESETS,
  browserAddressDisplay,
  browserAddressEditValue,
  findBrowserViewportPreset,
  planBrowserOpen,
  resolveBrowserViewportFrame,
} from "./browserPanelChrome.logic";

function tab(id: string, url: string, overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    id,
    url,
    title: "",
    status: "live",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: url,
    lastError: null,
    ...overrides,
  };
}

describe("browserAddressDisplay", () => {
  it("shows a web page as host then the rest of its address", () => {
    expect(browserAddressDisplay("http://localhost:5934/1806245b-4a04?tab=2#x")).toEqual({
      primary: "localhost:5934",
      secondary: "/1806245b-4a04?tab=2#x",
      kind: "web",
    });
    expect(browserAddressDisplay("https://example.com/")).toEqual({
      primary: "example.com",
      secondary: "",
      kind: "web",
    });
  });

  it("shows a local page as its name, never the folder chain above the project", () => {
    const url = "file:///D:/ceshi/simple-page/index.html";
    expect(browserAddressDisplay(url, "D:\\ceshi")).toEqual({
      primary: "index.html",
      secondary: "simple-page/",
      kind: "file",
    });
    expect(browserAddressDisplay(url, null)).toEqual({
      primary: "index.html",
      secondary: "",
      kind: "file",
    });
    expect(browserAddressEditValue(url, "D:\\ceshi")).toBe("simple-page/index.html");
  });

  it("reads a blank tab as empty", () => {
    expect(browserAddressDisplay("about:blank").kind).toBe("blank");
    expect(browserAddressEditValue("about:blank")).toBe("");
  });
});

describe("resolveBrowserViewportFrame", () => {
  const mobile = findBrowserViewportPreset("mobile");

  it("is null for Responsive", () => {
    expect(resolveBrowserViewportFrame({ width: 800, height: 600 }, null)).toBeNull();
  });

  it("centres a preset that fits at its own size", () => {
    expect(resolveBrowserViewportFrame({ width: 1000, height: 1000 }, mobile)).toEqual({
      x: 313,
      y: 94,
      width: 375,
      height: 812,
      scale: 1,
    });
  });

  it("scales a preset that does not fit down as a whole", () => {
    const frame = resolveBrowserViewportFrame(
      { width: 600, height: 500 },
      findBrowserViewportPreset("laptop"),
    );
    expect(frame?.scale).toBeCloseTo(576 / 1280);
    expect(frame?.width).toBe(576);
    expect(frame?.height).toBe(360);
  });

  it("offers the four device sizes", () => {
    expect(BROWSER_VIEWPORT_PRESETS.map((preset) => [preset.width, preset.height])).toEqual([
      [1280, 800],
      [1024, 768],
      [375, 812],
      [768, 1024],
    ]);
  });
});

describe("planBrowserOpen", () => {
  it("reloads the tab already showing a local page", () => {
    const tabs = [tab("a", "https://example.com/"), tab("b", "file:///D:/site/index.html")];
    expect(planBrowserOpen({ tabs, activeTabId: "a", url: "file:///D:/site/index.html" })).toEqual({
      kind: "select",
      tabId: "b",
      reload: true,
    });
  });

  it("returns to a server's tab without resetting the page reached on it", () => {
    const tabs = [tab("a", "http://localhost:5173/settings/profile")];
    expect(planBrowserOpen({ tabs, activeTabId: "a", url: "http://localhost:5173/" })).toEqual({
      kind: "select",
      tabId: "a",
      reload: false,
    });
  });

  it("fills a blank active tab, otherwise opens a new one", () => {
    expect(
      planBrowserOpen({
        tabs: [tab("a", "about:blank", { lastCommittedUrl: null })],
        activeTabId: "a",
        url: "https://example.com/",
      }),
    ).toEqual({ kind: "navigate", tabId: "a" });
    expect(
      planBrowserOpen({
        tabs: [tab("a", "https://docs.example.com/")],
        activeTabId: "a",
        url: "https://example.com/",
      }),
    ).toEqual({ kind: "newTab" });
  });
});
