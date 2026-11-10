// FILE: PageAppThumbnail.browser.tsx
// Purpose: Real sandbox rendering through the production AppPageFrame caller.
// Layer: Web browser tests (local API fixture; no desktop capture)

import "../../index.css";

import type { PageApp, PageAppsOpenFrameResult } from "@moss/contracts";
import {
  buildPageAppFrameRuntime,
  injectPageAppFrameRuntime,
} from "@moss/shared/pageAppFrameRuntime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { AppPageFrame } from "./AppPageFrame";
import { PageAppThumbnail } from "./PageAppThumbnail";
import { pageAppsClient } from "./pageAppsClient";
import { pageAppContentSecurityPolicy } from "@moss/shared/pageAppContentPolicy";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    beginAppThumbnailRequestProbe: (appTitle?: string, readonlyHost?: boolean) => Promise<void>;
    endAppThumbnailRequestProbe: () => Promise<
      { resourceType: string; local: boolean; appFrame: boolean }[]
    >;
    writeAppThumbnailEvidence: (
      thumbnail: string,
    ) => Promise<{ viewport: number[]; body: number[]; background: string; text: string }>;
  }
}

afterEach(() => vi.restoreAllMocks());

function fixture(extraBody = "", ownOrigin = false) {
  const now = "2026-11-06T00:00:00.000Z";
  let stored: PageApp = {
    id: "app-thumbnail-fixture" as never,
    scopeSpaceId: null,
    spaceId: null,
    title: "Coral tracker",
    description: "",
    revision: 1,
    capabilities: {},
    favorite: false,
    thumbnail: null,
    sourceThreadId: null,
    htmlChars: 200,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  // CSP sandbox and frame-ancestors are response-only; iframe sandbox below enforces the former.
  const csp = pageAppContentSecurityPolicy({
    parentOrigin: window.location.origin,
    opaque: !ownOrigin,
  })
    .split("; ")
    .filter(
      (directive) => !directive.startsWith("sandbox ") && !directive.startsWith("frame-ancestors "),
    )
    .join("; ");
  const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{margin:0;background:#ed765e;color:#1d2939;font:32px sans-serif;padding:24px;box-sizing:border-box}h1{margin:0 0 16px}section{background:white;border-radius:12px;padding:20px;width:70%}</style></head><body><h1>Coral tracker</h1><section>3 tasks complete</section>${extraBody}<script>window.addEventListener("message",function(e){if(e.data&&e.data.protocol==="moss-app-thumbnail/1")parent.postMessage({protocol:"thumbnail-fixture",kind:e.data.kind},${JSON.stringify(window.location.origin)})});</script></body></html>`;
  const url = URL.createObjectURL(
    new Blob(
      [
        injectPageAppFrameRuntime(
          html,
          buildPageAppFrameRuntime({ parentOrigin: window.location.origin }),
        ),
      ],
      { type: "text/html" },
    ),
  );
  vi.spyOn(pageAppsClient, "openFrame").mockImplementation(
    async () =>
      ({
        app: stored,
        revision: stored.revision,
        capabilities: {},
        frameUrl: url,
        frameOrigin: ownOrigin ? window.location.origin : "null",
        ownOrigin,
        expiresAt: now,
        viewer: { id: "owner", name: "Owner", level: "owner", isOwner: true },
        consent: {},
      }) satisfies PageAppsOpenFrameResult,
  );
  const mutate = vi.spyOn(pageAppsClient, "mutate").mockImplementation(async (input) => {
    if (input.op !== "set-thumbnail" || input.expectedRevision !== stored.revision)
      throw new Error("Unexpected mutation");
    stored = { ...stored, thumbnail: input.thumbnail };
    return { app: stored };
  });
  return { url, mutate, stored: () => stored };
}

describe("app thumbnail rendering", () => {
  it("captures the actual opaque app DOM, saves once and restores the card on reopen", async () => {
    await commands.beginAppThumbnailRequestProbe();
    const test = fixture();
    const stages: object[] = [];
    const observe = (event: MessageEvent) => {
      if (
        ["moss-app/1", "moss-app-thumbnail/1", "thumbnail-fixture"].includes(event.data?.protocol)
      )
        stages.push({
          kind: event.data.kind,
          origin: event.origin,
          thumbnailLength: event.data.thumbnail?.length ?? null,
          error: event.data.error,
        });
    };
    window.addEventListener("message", observe);
    const mounted = await render(
      <div style={{ width: 720, height: 440 }}>
        <AppPageFrame appPageId="app-thumbnail-fixture" mode="full" />
      </div>,
    );
    let frameUnmounted = false;
    try {
      await vi.waitFor(() => expect(test.mutate, JSON.stringify(stages)).toHaveBeenCalledOnce(), {
        timeout: 10_000,
      });
      const thumbnail = test.stored().thumbnail!;
      expect(thumbnail).toMatch(/^data:image\/jpeg;base64,\/9j\//u);
      const decoded = new Image();
      decoded.src = thumbnail;
      await decoded.decode();
      expect([decoded.naturalWidth, decoded.naturalHeight]).toEqual([480, 300]);
      console.info(
        "thumbnail dimensions",
        JSON.stringify(await commands.writeAppThumbnailEvidence(thumbnail)),
      );
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 300;
      const context = canvas.getContext("2d")!;
      context.drawImage(decoded, 0, 0);
      const pixel = context.getImageData(470, 290, 1, 1).data;
      expect(pixel[0]).toBeGreaterThan(220);
      expect(pixel[1]).toBeLessThan(140);
      expect(pixel[2]).toBeLessThan(115);
      await mounted.unmount();
      frameUnmounted = true;
      const card = await render(
        <div style={{ width: 480 }}>
          <PageAppThumbnail app={test.stored()} />
        </div>,
      );
      try {
        const image = document.querySelector(`img[src="${thumbnail}"]`) as HTMLImageElement;
        await vi.waitFor(() => expect(image.naturalWidth).toBe(480));
        await page.screenshot({ path: "node_modules/.cache/page-app-thumbnail-restored.png" });
      } finally {
        await card.unmount();
      }
      expect(test.mutate).toHaveBeenCalledOnce();
      expect(test.stored().revision).toBe(1);
      expect(await commands.endAppThumbnailRequestProbe()).toEqual([]);
    } finally {
      window.removeEventListener("message", observe);
      if (!frameUnmounted) await mounted.unmount();
      URL.revokeObjectURL(test.url);
      console.info(
        "thumbnail network",
        JSON.stringify(await commands.endAppThumbnailRequestProbe()),
      );
    }
  }, 15_000);

  it("restores a placeholder when a stored image cannot be decoded", async () => {
    const mounted = await render(
      <PageAppThumbnail
        app={{ id: "broken" as never, title: "Broken", thumbnail: "data:image/jpeg;base64,AAAA" }}
      />,
    );
    try {
      await vi.waitFor(() =>
        expect(document.querySelector('img[src="data:image/jpeg;base64,AAAA"]')).toBeNull(),
      );
    } finally {
      await mounted.unmount();
    }
  });

  it.each(["image", "srcset", "css"] as const)(
    "does not reload %s resources while capturing an own-origin app",
    async (kind) => {
      await commands.beginAppThumbnailRequestProbe();
      const resource = `${window.location.origin}/__moss_thumbnail_probe__/${kind}.png`;
      const extra =
        kind === "image"
          ? `<img src="${resource}">`
          : kind === "srcset"
            ? `<img src="data:image/png;base64,AA==" srcset="${resource} 1x">`
            : `<div style="height:20px;background-image:url('${resource}')"></div>`;
      // The blob fixture uses the production own-origin sandbox only for resource loading;
      // origin separation itself is covered by the opaque test and server host policy tests.
      const test = fixture(extra, true);
      let result: { thumbnail: unknown } | undefined;
      const observe = (event: MessageEvent) => {
        if (event.data?.protocol === "moss-app-thumbnail/1" && event.data.kind === "result")
          result = event.data;
      };
      window.addEventListener("message", observe);
      const mounted = await render(
        <div style={{ width: 720, height: 440 }}>
          <AppPageFrame appPageId="app-thumbnail-fixture" mode="full" />
        </div>,
      );
      try {
        await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 3_000 });
        expect(result?.thumbnail).toBeNull();
        expect(test.mutate).not.toHaveBeenCalled();
        // The original app load requests once (intercepted, never sent). Capture adds none.
        expect(await commands.endAppThumbnailRequestProbe()).toEqual([
          { resourceType: "image", local: true, appFrame: true },
        ]);
      } finally {
        window.removeEventListener("message", observe);
        await mounted.unmount();
        URL.revokeObjectURL(test.url);
        console.info(
          "thumbnail network",
          JSON.stringify(await commands.endAppThumbnailRequestProbe()),
        );
      }
    },
  );
});
