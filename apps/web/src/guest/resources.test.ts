import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveHtmlRenderFrameUrl } from "~/lib/htmlRenderFrameUrl";
import { readHtmlRenderMapConfig } from "~/lib/htmlRenderMapConfig";
import { resolveInlineVisualizationFrameUrl } from "~/lib/inlineVisualizationFrameUrl";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import { resolveAttachmentPreviewUrl } from "~/lib/wsHttpUrl";

import {
  installGuestResourceResolvers,
  ownerServes,
  resetGuestResourcesForTests,
  setGuestOwnerRoutes,
} from "./resources";
import { createHttpGuestTransport } from "./transport";

const SHARE = "k3J9xQ2mT8vL5nR1pW7yZa";
const PAGE = "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e";

afterEach(() => {
  resetGuestResourcesForTests();
  vi.unstubAllGlobals();
});

describe("guest resources", () => {
  it("loads the transcript's files, pages and pictures through the share", async () => {
    installGuestResourceResolvers(createHttpGuestTransport(SHARE));
    setGuestOwnerRoutes(["render", "media"]);
    expect(resolveAttachmentPreviewUrl("att 1")).toBe(
      `/v1/shares/${SHARE}/guest/attachment?id=att%201`,
    );
    expect(await resolveHtmlRenderFrameUrl(PAGE)).toBe(
      `/v1/shares/${SHARE}/guest/render?id=${PAGE}`,
    );
    // The owner's folder and grants never reach the URL; only the source as written.
    expect(buildLocalImageUrl({ src: " ./out/dog.png ", cwd: "C:/work", grant: "g" })).toBe(
      `/v1/shares/${SHARE}/guest/media?src=.%2Fout%2Fdog.png`,
    );
  });

  it("waits for the owner's hello and shows no page an older owner cannot serve", async () => {
    installGuestResourceResolvers(createHttpGuestTransport(SHARE));
    const pending = resolveHtmlRenderFrameUrl(PAGE);
    setGuestOwnerRoutes(undefined);
    expect(await pending).toBeNull();
    expect(await ownerServes("media")).toBe(false);
    // A page id that is not one never asks.
    expect(await resolveHtmlRenderFrameUrl("../x")).toBeNull();
  });

  it("loads visualizations and a page's map through the share's file and render routes", async () => {
    installGuestResourceResolvers(createHttpGuestTransport(SHARE));
    setGuestOwnerRoutes(["render", "media", "file"]);
    expect(
      await resolveInlineVisualizationFrameUrl({ threadId: "t", path: "visualizations/a.html" }),
    ).toBe(`/v1/shares/${SHARE}/guest/render?visualization=visualizations%2Fa.html`);
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ lane: "global", provider: "openfreemap" }));
      }),
    );
    expect(await readHtmlRenderMapConfig(Date.now() + 60_000)).toEqual({
      lane: "global",
      provider: "openfreemap",
    });
    expect(requests).toEqual([`/v1/shares/${SHARE}/guest/file?map=1`]);
  });

  it("keeps the plain map when the owner's answer is not a map configuration", async () => {
    installGuestResourceResolvers(createHttpGuestTransport(SHARE));
    setGuestOwnerRoutes(["render", "media", "file"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ provider: "evil", script: "x" }))),
    );
    expect(await readHtmlRenderMapConfig(Date.now() + 120_000)).toBeNull();
  });
});
