// Drives a published page's bootstrap in a real sandboxed frame: the height it reports, and
// the links, images and app shortcuts it hands to Moss after the reader clicks into it.
import "../../index.css";
import { injectHtmlRenderBootstrap } from "@synara/shared/htmlRender";
import { compileKeybindingRule } from "@synara/shared/keybindingRules";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { serverConfigQueryOptions } from "~/lib/serverReactQuery";

import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { SandboxedHtmlDocument } from "./SandboxedHtmlDocument";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const PAGE = `<!doctype html><html><head><title>Probe</title></head><body>
  <a id="docs" href="https://example.com/docs" style="display:block;height:40px">Docs</a>
  <img id="dot" alt="Dot" src="${PIXEL}" width="40" height="40" style="display:block">
  <div style="height:300px"></div>
</body></html>`;

afterEach(() => vi.unstubAllGlobals());

async function renderPage(
  onImageExpand?: (preview: ExpandedImagePreview) => void,
  html: string = PAGE,
) {
  const src = URL.createObjectURL(
    new Blob([injectHtmlRenderBootstrap(html)], { type: "text/html" }),
  );
  const client = new QueryClient();
  const keybindings = [
    compileKeybindingRule({ key: "mod+b", command: "sidebar.toggle" }),
    compileKeybindingRule({ key: "mod+k", command: "thread.archive" }),
  ];
  client.setQueryData(serverConfigQueryOptions().queryKey, { keybindings } as never);
  const heights: number[] = [];
  const screen = await render(
    <QueryClientProvider client={client}>
      {/* Pinned, so frames from earlier tests never push this one below the fold. */}
      <div style={{ position: "fixed", top: 0, left: 0, width: 360, height: 600 }}>
        <SandboxedHtmlDocument
          src={src}
          title="Probe"
          className="block size-full"
          onContentHeight={(height) => heights.push(height)}
          {...(onImageExpand ? { onImageExpand } : {})}
        />
      </div>
    </QueryClientProvider>,
  );
  const iframe = document.querySelector("iframe")!;
  const frame = page.frameLocator(page.elementLocator(iframe));
  // The bootstrap reports the height once the page has loaded and its shortcuts arrived.
  await vi.waitFor(() => expect(heights.length).toBeGreaterThan(0));
  return {
    iframe,
    frame,
    heights,
    [Symbol.asyncDispose]: async () => {
      await screen.unmount();
      client.clear();
      URL.revokeObjectURL(src);
    },
  };
}

it("reports the page height including the overridable gutter for focus rings", async () => {
  let withGutter: number;
  {
    await using view = await renderPage();
    withGutter = view.heights.at(-1)!;
  }
  await using view = await renderPage(
    undefined,
    PAGE.replace("<title>Probe</title>", "<title>Probe</title><style>html{padding:0}</style>"),
  );
  expect(withGutter - view.heights.at(-1)!).toBe(16);
});

it("shows a clicked page image in the app's image viewer", async () => {
  const onImageExpand = vi.fn();
  await using view = await renderPage(onImageExpand);
  await view.frame.getByRole("img", { name: "Dot" }).click();
  await vi.waitFor(() =>
    expect(onImageExpand).toHaveBeenCalledWith({ images: [{ src: PIXEL, name: "Dot" }], index: 0 }),
  );
  // Keys reach the app again, so the viewer's Escape works.
  expect(document.activeElement).not.toBe(view.iframe);
});

it("opens a clicked page link outside the thread", async () => {
  const open = vi.fn(() => null);
  vi.stubGlobal("open", open);
  await using view = await renderPage();
  await view.frame.getByRole("link", { name: "Docs" }).click();
  await vi.waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("https://example.com/docs"),
      "_blank",
      "noopener,noreferrer",
    ),
  );
});

it("hands allowed app shortcuts back to Moss and keeps the rest in the page", async () => {
  await using view = await renderPage();
  const forwarded: KeyboardEvent[] = [];
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target === view.iframe) forwarded.push(event);
  };
  window.addEventListener("keydown", onKeyDown);
  try {
    // A keyboard reader moves focus into the frame; the key press is the activation.
    view.iframe.focus();
    const mod = navigator.platform.startsWith("Mac") ? "Meta" : "Control";
    // thread.archive is bound to mod+k, so the page keeps it.
    await userEvent.keyboard(`{${mod}>}k{/${mod}}`);
    await userEvent.keyboard(`{${mod}>}b{/${mod}}`);
    await vi.waitFor(() => expect(forwarded).toHaveLength(1));
    expect(forwarded[0]).toMatchObject({ key: "b", code: "KeyB", isTrusted: false });
  } finally {
    window.removeEventListener("keydown", onKeyDown);
  }
});
