// End to end in a real sandboxed frame: an itinerary map page and a stop photo page as the
// server publishes them (bootstrap, map helper, map libraries and pin animator inlined, no
// script CDN, no key), with the app answering the page's map request for the account.
import "../../index.css";
import type { HtmlRenderMapConfig } from "@moss/contracts";
import { injectHtmlRenderBootstrap } from "@moss/shared/htmlRender";
import { htmlRenderMapLibraries } from "@moss/shared/htmlRenderMaps";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const mapConfig = vi.hoisted(() => ({ current: null as HtmlRenderMapConfig | null }));
vi.mock("~/lib/htmlRenderMapConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/htmlRenderMapConfig")>()),
  readHtmlRenderMapConfig: async () => mapConfig.current,
}));

import { serverConfigQueryOptions } from "~/lib/serverReactQuery";

import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { SandboxedHtmlDocument } from "./SandboxedHtmlDocument";

// The itinerary as visual_guide teaches it: mossMaps.create, a growing line, the animator.
const MAP_PAGE = `<!doctype html><html><head><title>Shanghai day</title>
<style>#map{height:300px;position:relative}</style>
</head><body>
<div id="map"></div>
<p id="status" role="status">Loading map</p>
<p id="tour" role="status"></p>
<script>
(async () => {
  const report = (data) => window.parent.postMessage({ testMap: data }, "*");
  const map = await window.mossMaps.create(document.getElementById("map"), {
    points: [
      { lat: 31.2397, lng: 121.4998, title: "The Bund" },
      { lat: 31.2304, lng: 121.4737, title: "People's Square" },
    ],
    line: true,
    onError: (message) => report({ error: message }),
  });
  document.getElementById("status").textContent = map.provider;
  // Only this test page reports out: the opaque frame is otherwise unreadable.
  report({ provider: map.provider });
  map.setLineCount(0);
  window.createTripAnimator({
    stopCount: map.pins.length,
    durationMs: 1000,
    pinElements: map.pins,
    onFrame: (frame) => { map.setLineCount(frame.pinIndex + 1); map.setActive(frame.activeStop); },
    onState: (state) => { document.getElementById("tour").textContent = state; },
  }).play();
})().catch((error) => window.parent.postMessage({ testMap: { failed: String(error) } }, "*"));
</script></body></html>`;

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// A stop card as visual_guide asks for it: place_photos' image with its credit linked.
const PHOTO_PAGE = `<!doctype html><html><head><title>Stops</title></head><body>
<article style="width:200px">
  <img alt="The Bund" src="${PIXEL}" width="200" height="110" style="display:block;object-fit:cover">
  <h3>1 · The Bund</h3>
  <p>Photo: <a href="https://commons.wikimedia.org/wiki/File:The_Bund.jpg">Ann &amp; Bo, CC BY-SA 4.0</a></p>
</article>
</body></html>`;

async function renderPublished(
  html: string,
  title: string,
  onImageExpand?: (preview: ExpandedImagePreview) => void,
) {
  // The same preparation HtmlRender.publish applies before it stores the page.
  const published = injectHtmlRenderBootstrap(html, { libraries: htmlRenderMapLibraries });
  // Moss serves pages from an http URL. A blob: URL would not do here: MapLibre reads
  // its referrer from the parent of a blob: document, which an opaque frame may not.
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(new Blob([published], { type: "text/html" }));
  });
  const client = new QueryClient();
  client.setQueryData(serverConfigQueryOptions().queryKey, { keybindings: [] } as never);
  const heights: number[] = [];
  const screen = await render(
    <QueryClientProvider client={client}>
      <div style={{ position: "fixed", top: 0, left: 0, width: 420, height: 640 }}>
        <SandboxedHtmlDocument
          src={src}
          title={title}
          className="block size-full"
          htmlRender
          onContentHeight={(height) => heights.push(height)}
          {...(onImageExpand ? { onImageExpand } : {})}
        />
      </div>
    </QueryClientProvider>,
  );
  const iframe = document.querySelector("iframe")!;
  // The bootstrap reports the height once the page has loaded.
  await vi.waitFor(() => expect(heights.length).toBeGreaterThan(0), { timeout: 20_000 });
  return {
    published,
    frame: page.frameLocator(page.elementLocator(iframe)),
    [Symbol.asyncDispose]: async () => {
      await screen.unmount();
      client.clear();
    },
  };
}

async function renderMapFor(config: HtmlRenderMapConfig) {
  mapConfig.current = config;
  const reports: Array<Record<string, unknown>> = [];
  const onMessage = (event: MessageEvent) => {
    const data = (event.data as { testMap?: Record<string, unknown> } | null)?.testMap;
    if (data) reports.push(data);
  };
  window.addEventListener("message", onMessage);
  const view = await renderPublished(MAP_PAGE, "Shanghai day");
  await vi.waitFor(() => expect(reports.some((report) => "provider" in report)).toBe(true), {
    timeout: 30_000,
  });
  return {
    view,
    reports,
    provider: reports.find((report) => "provider" in report)?.provider,
    [Symbol.asyncDispose]: async () => {
      window.removeEventListener("message", onMessage);
      await view[Symbol.asyncDispose]();
    },
  };
}

// The frame has an opaque origin, so the test reaches its content only through the
// browser driver: a click on an element is the proof that it is there and visible.
it("draws a Global account's itinerary on the OpenFreeMap world map without a key", async () => {
  const open = vi.fn(() => null);
  vi.stubGlobal("open", open);
  try {
    await using map = await renderMapFor({ lane: "global", provider: "openfreemap" });
    // Stored without a script CDN and without any key.
    expect(map.view.published).not.toMatch(/<script[^>]+src=/u);
    expect(map.provider).toBe("openfreemap");
    // The pins drop and the tour finishes.
    await map.view.frame.getByText("complete", { exact: true }).click();
    await map.view.frame.getByLabelText("2. People's Square").click();
    // Leaflet shows the OpenFreeMap credit, and its links open outside the thread.
    await map.view.frame.getByRole("link", { name: "OpenFreeMap" }).click();
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        expect.stringContaining("https://openfreemap.org"),
        "_blank",
        "noopener,noreferrer",
      ),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("draws a mainland China account's stops and route on a plain background with a note", async () => {
  await using map = await renderMapFor({ lane: "cn", provider: "plain" });
  expect(map.provider).toBe("plain");
  await map.view.frame.getByText("complete", { exact: true }).click();
  await map.view.frame.getByLabelText("1. The Bund").click();
  // The app's note, in the reader's language, says what turns the basemap on.
  await map.view.frame.getByRole("note").click();
  await map.view.frame.getByText(/Amap/u).click();
  expect(map.reports.filter((report) => "failed" in report)).toEqual([]);
});

it("shows a stop photo with its credit and opens it in the app's viewer", async () => {
  const onImageExpand = vi.fn();
  const open = vi.fn(() => null);
  vi.stubGlobal("open", open);
  try {
    await using view = await renderPublished(PHOTO_PAGE, "Stops", onImageExpand);
    // A page without a map never carries the map libraries.
    expect(view.published).not.toContain("maplibregl");
    await view.frame.getByRole("link", { name: "Ann & Bo, CC BY-SA 4.0" }).click();
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        expect.stringContaining("https://commons.wikimedia.org/wiki/File:The_Bund.jpg"),
        "_blank",
        "noopener,noreferrer",
      ),
    );
    await view.frame.getByRole("img", { name: "The Bund" }).click();
    await vi.waitFor(() =>
      expect(onImageExpand).toHaveBeenCalledWith({
        images: [{ src: PIXEL, name: "The Bund" }],
        index: 0,
      }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
