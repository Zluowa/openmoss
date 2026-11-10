// The dock's zoom works like a browser's: the page lays out wider when zoomed out and
// still fills the pane. A page in the dock hands its follow-up to its own thread's composer.
import "../../index.css";
import { injectHtmlRenderBootstrap } from "@moss/shared/htmlRender";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const PAGE_URL = URL.createObjectURL(
  new Blob([injectHtmlRenderBootstrap("<h1>Revenue</h1><p>Quarterly revenue by region.</p>")], {
    type: "text/html",
  }),
);
const FOLLOW_UP_URL = URL.createObjectURL(
  new Blob(
    [
      injectHtmlRenderBootstrap(
        `<button type="button" style="display:block;height:40px" onclick="window.mossFollowUp('Compare the two plans')">Compare</button>`,
      ),
    ],
    { type: "text/html" },
  ),
);

vi.mock("~/lib/htmlRenderFrameUrl", () => ({
  resolveHtmlRenderFrameUrl: async (attachmentId: string) =>
    attachmentId === "attachment-follow-up" ? FOLLOW_UP_URL : PAGE_URL,
}));

import { useComposerDraftStore } from "~/composerDraftStore";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";

import { HtmlRenderPreviewPane } from "./HtmlRenderPreviewPane";

it("puts a follow-up from a page in the side panel in that page's thread composer", async () => {
  const client = new QueryClient();
  client.setQueryData(serverConfigQueryOptions().queryKey, { keybindings: [] } as never);
  const screen = await render(
    <QueryClientProvider client={client}>
      <div style={{ position: "fixed", top: 0, left: 0, width: 360, height: 480, display: "flex" }}>
        <HtmlRenderPreviewPane
          threadId="thread-panel"
          document={{
            kind: "html-render",
            attachmentId: "attachment-follow-up",
            title: "Plans",
          }}
        />
      </div>
    </QueryClientProvider>,
  );
  try {
    const iframe = await vi.waitFor(() => {
      const frame = document.querySelector("iframe");
      expect(frame).not.toBeNull();
      return frame!;
    });
    // A visual reply in the dock may go fullscreen like the one in the thread.
    expect(iframe.getAttribute("allow")).toBe("fullscreen");
    await page
      .frameLocator(page.elementLocator(iframe))
      .getByRole("button", { name: "Compare" })
      .click();
    await vi.waitFor(() =>
      expect(
        useComposerDraftStore.getState().draftsByThreadId["thread-panel" as never]?.prompt,
      ).toBe("Compare the two plans"),
    );
  } finally {
    await screen.unmount();
    client.clear();
  }
});

const stage = () => document.querySelector<HTMLElement>("[data-html-render-zoom]")!;
const frameBox = () => document.querySelector("iframe")!.getBoundingClientRect();

it("zooms the page between 50% and 200% while it keeps filling the pane", async () => {
  const client = new QueryClient();
  client.setQueryData(serverConfigQueryOptions().queryKey, { keybindings: [] } as never);
  const screen = await render(
    <QueryClientProvider client={client}>
      <div style={{ position: "fixed", top: 0, left: 0, width: 360, height: 480, display: "flex" }}>
        <HtmlRenderPreviewPane
          threadId="thread-1"
          document={{ kind: "html-render", attachmentId: "attachment-1", title: "Revenue chart" }}
        />
      </div>
    </QueryClientProvider>,
  );
  try {
    const zoomOut = page.getByRole("button", { name: "Zoom out" });
    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    const reset = page.getByRole("button", { name: "Reset zoom" });
    await expect.element(reset).toHaveTextContent("100%");
    const paneWidth = stage().getBoundingClientRect().width;

    await zoomOut.click();
    await zoomOut.click();
    await expect.element(reset).toHaveTextContent("50%");
    await expect.element(zoomOut).toBeDisabled();
    // The page lays out twice as wide and is scaled back down to the pane.
    expect(document.querySelector("iframe")!.offsetWidth).toBeCloseTo(paneWidth * 2, 0);
    expect(frameBox().width).toBeCloseTo(paneWidth, 0);

    for (let step = 0; step < 6; step += 1) await zoomIn.click();
    await expect.element(reset).toHaveTextContent("200%");
    await expect.element(zoomIn).toBeDisabled();
    expect(frameBox().width).toBeCloseTo(paneWidth, 0);

    await reset.click();
    await expect.element(reset).toHaveTextContent("100%");
    expect(stage().dataset.htmlRenderZoom).toBe("1");
  } finally {
    await screen.unmount();
    client.clear();
  }
});
