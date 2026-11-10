import { describe, expect, it } from "vitest";

import { HTML_RENDER_MAP_CONFIG_METHOD, injectHtmlRenderBootstrap } from "./htmlRender";
import {
  HTML_RENDER_MAP_ATTRIBUTION,
  HTML_RENDER_MAP_STYLE_URL,
  htmlRenderMapLibraries,
  htmlUsesMossMaps,
  MOSS_MAPS_SCRIPT_SOURCE,
  resolveGuestHtmlRenderMapConfig,
  resolveHtmlRenderMapConfig,
} from "./htmlRenderMaps";
import {
  HTML_RENDER_MAP_LIBRARY_VERSIONS,
  LEAFLET_JS,
  MAPLIBRE_GL_JS,
  MAPLIBRE_GL_LEAFLET_JS,
} from "./htmlRenderMapAssets.generated";

const MAP_PAGE =
  "<!doctype html><html><head></head><body><div id=m></div><script>window.mossMaps.create(m,{points:[{lat:1,lng:2}]})</script></body></html>";
const PLAIN_PAGE = "<!doctype html><html><head></head><body><svg></svg></body></html>";

const OWN = {
  MOSS_GOOGLE_MAPS_API_KEY: "own-google",
  MOSS_AMAP_JS_KEY: "own-amap",
  MOSS_AMAP_SECURITY_CODE: "own-code",
};
const SHIPPED = {
  MOSS_PUBLIC_MAPS_GOOGLE_API_KEY: "moss-google",
  MOSS_PUBLIC_MAPS_AMAP_KEY: "moss-amap",
  MOSS_PUBLIC_MAPS_AMAP_SECURITY_CODE: "moss-code",
};

describe("resolveHtmlRenderMapConfig", () => {
  it("uses Amap for a mainland China account and Google for everyone else", () => {
    expect(resolveHtmlRenderMapConfig({ env: SHIPPED, lane: "cn" })).toEqual({
      lane: "cn",
      provider: "amap",
      amap: { key: "moss-amap", securityJsCode: "moss-code" },
    });
    expect(resolveHtmlRenderMapConfig({ env: SHIPPED, lane: "global" })).toEqual({
      lane: "global",
      provider: "google",
      google: { apiKey: "moss-google" },
    });
  });

  it("lets the person's own keys win, each with its own security code", () => {
    expect(resolveHtmlRenderMapConfig({ env: { ...SHIPPED, ...OWN }, lane: "cn" })).toEqual({
      lane: "cn",
      provider: "amap",
      amap: { key: "own-amap", securityJsCode: "own-code" },
    });
    expect(
      resolveHtmlRenderMapConfig({ env: { ...SHIPPED, MOSS_AMAP_JS_KEY: "own-amap" }, lane: "cn" }),
    ).toEqual({ lane: "cn", provider: "amap", amap: { key: "own-amap" } });
    expect(resolveHtmlRenderMapConfig({ env: { ...SHIPPED, ...OWN }, lane: "global" })).toEqual({
      lane: "global",
      provider: "google",
      google: { apiKey: "own-google" },
    });
  });

  it("falls back without the lane's key: OpenFreeMap for Global, a plain map for China", () => {
    const empty = { MOSS_PUBLIC_MAPS_GOOGLE_API_KEY: "", MOSS_PUBLIC_MAPS_AMAP_KEY: "  " };
    expect(resolveHtmlRenderMapConfig({ env: empty, lane: "global" })).toEqual({
      lane: "global",
      provider: "openfreemap",
    });
    expect(resolveHtmlRenderMapConfig({ env: empty, lane: "cn" })).toEqual({
      lane: "cn",
      provider: "plain",
    });
    // A Google key never draws a map for a mainland China account, nor Amap's for Global.
    expect(
      resolveHtmlRenderMapConfig({ env: { MOSS_GOOGLE_MAPS_API_KEY: "g" }, lane: "cn" }).provider,
    ).toBe("plain");
    expect(
      resolveHtmlRenderMapConfig({ env: { MOSS_AMAP_JS_KEY: "a" }, lane: "global" }).provider,
    ).toBe("openfreemap");
  });
});

describe("resolveGuestHtmlRenderMapConfig", () => {
  it("gives a shared conversation's guest Moss's keys, never the person's own", () => {
    expect(resolveGuestHtmlRenderMapConfig({ env: { ...SHIPPED, ...OWN }, lane: "cn" })).toEqual({
      lane: "cn",
      provider: "amap",
      amap: { key: "moss-amap", securityJsCode: "moss-code" },
    });
    expect(
      resolveGuestHtmlRenderMapConfig({ env: { ...SHIPPED, ...OWN }, lane: "global" }),
    ).toEqual({ lane: "global", provider: "google", google: { apiKey: "moss-google" } });
    // Only the person's own keys: the lane's keyless map.
    expect(resolveGuestHtmlRenderMapConfig({ env: OWN, lane: "global" })).toEqual({
      lane: "global",
      provider: "openfreemap",
    });
    expect(resolveGuestHtmlRenderMapConfig({ env: OWN, lane: "cn" })).toEqual({
      lane: "cn",
      provider: "plain",
    });
  });
});

describe("htmlRenderMapLibraries", () => {
  it("stores a map page with Moss's own libraries and the helper, before the page's scripts", () => {
    const published = injectHtmlRenderBootstrap(MAP_PAGE, { libraries: htmlRenderMapLibraries });
    const pageScriptAt = published.indexOf("window.mossMaps.create(m");
    expect(published.indexOf("Leaflet 1.9.4")).toBeGreaterThan(0);
    expect(published.indexOf("Leaflet 1.9.4")).toBeLessThan(pageScriptAt);
    expect(published.indexOf("window.mossMaps={")).toBeLessThan(pageScriptAt);
    expect(published).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet/u);
    expect(HTML_RENDER_MAP_LIBRARY_VERSIONS).toEqual({
      leaflet: "1.9.4",
      "maplibre-gl": "5.24.0",
      "@maplibre/maplibre-gl-leaflet": "0.1.4",
    });
  });

  it("never stores a key, whatever the server environment holds", () => {
    const before = { ...process.env };
    Object.assign(process.env, OWN, SHIPPED);
    try {
      const published = injectHtmlRenderBootstrap(MAP_PAGE, { libraries: htmlRenderMapLibraries });
      for (const key of [...Object.values(OWN), ...Object.values(SHIPPED)]) {
        expect(published).not.toContain(key);
      }
      expect(published).not.toContain("__mossMapConfig");
    } finally {
      for (const name of [...Object.keys(OWN), ...Object.keys(SHIPPED)]) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
  });

  it("leaves every other page without the libraries", () => {
    expect(htmlUsesMossMaps(MAP_PAGE)).toBe(true);
    expect(htmlUsesMossMaps(PLAIN_PAGE)).toBe(false);
    expect(htmlRenderMapLibraries(PLAIN_PAGE)).toBe("");
    expect(injectHtmlRenderBootstrap(PLAIN_PAGE, { libraries: htmlRenderMapLibraries })).toBe(
      injectHtmlRenderBootstrap(PLAIN_PAGE),
    );
  });

  it("keeps each library inside its own script element", () => {
    for (const source of [
      LEAFLET_JS,
      MAPLIBRE_GL_JS,
      MAPLIBRE_GL_LEAFLET_JS,
      MOSS_MAPS_SCRIPT_SOURCE,
    ]) {
      expect(source).not.toMatch(/<\/script/iu);
      expect(source).not.toContain("sourceMappingURL");
    }
  });
});

interface MossMapsApi {
  toGcj02(lat: number, lng: number): { lat: number; lng: number };
  create(container: unknown, options: unknown): Promise<{ provider: string }>;
}

/** The helper in a fake window: no Leaflet, and a parent that answers as the app would. */
type MessageListener = (event: { source: unknown; data: unknown }) => void;

function loadHelper(answer: ((message: unknown) => unknown) | null) {
  const listeners = new Set<MessageListener>();
  const posted: unknown[] = [];
  const parent = {
    postMessage(message: { id: string }) {
      posted.push(message);
      if (answer === null) return;
      const result = answer(message);
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({ source: parent, data: { jsonrpc: "2.0", id: message.id, result } });
        }
      });
    },
  };
  const win: Record<string, unknown> = {
    parent,
    addEventListener: (_type: string, listener: MessageListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: MessageListener) => listeners.delete(listener),
  };
  const doc = {
    head: { appendChild: () => undefined },
    getElementById: () => ({}),
    createElement: () => ({}),
    documentElement: {},
  };
  new Function("window", "document", MOSS_MAPS_SCRIPT_SOURCE)(win, doc);
  return { maps: win.mossMaps as MossMapsApi, posted };
}

describe("mossMaps helper", () => {
  it("parses as plain script and has no setup error path", () => {
    expect(() => new Function(MOSS_MAPS_SCRIPT_SOURCE)).not.toThrow();
    expect(MOSS_MAPS_SCRIPT_SOURCE).not.toContain("No map provider is set up");
    expect(MOSS_MAPS_SCRIPT_SOURCE).toContain(JSON.stringify(HTML_RENDER_MAP_STYLE_URL));
    expect(MOSS_MAPS_SCRIPT_SOURCE).toContain(JSON.stringify(HTML_RENDER_MAP_ATTRIBUTION));
  });

  it("asks the app for the map when the page opens, then draws the keyless map", async () => {
    const { maps, posted } = loadHelper(() => ({ lane: "cn", provider: "plain", note: "n" }));
    // No Leaflet in this fake window, so drawing fails after the app answered.
    await expect(
      maps.create({ appendChild: () => undefined }, { points: [{ lat: 31.2, lng: 121.5 }] }),
    ).rejects.toThrow("The map library did not load.");
    expect(posted).toEqual([
      expect.objectContaining({ jsonrpc: "2.0", method: HTML_RENDER_MAP_CONFIG_METHOD }),
    ]);
  });

  it("still validates points before asking", async () => {
    const { maps, posted } = loadHelper(() => ({}));
    await expect(maps.create({ appendChild: () => undefined }, { points: [] })).rejects.toThrow(
      "A map needs 1-30 points.",
    );
    expect(posted).toEqual([]);
  });

  it("converts WGS-84 to GCJ-02 inside China only", () => {
    const { maps } = loadHelper(null);
    // Tiananmen: Amap shows it at about 39.908821, 116.397469.
    const beijing = maps.toGcj02(39.907433, 116.391254);
    expect(beijing.lat).toBeCloseTo(39.90883, 4);
    expect(beijing.lng).toBeCloseTo(116.3975, 3);
    expect(maps.toGcj02(48.85, 2.35)).toEqual({ lat: 48.85, lng: 2.35 });
  });
});
