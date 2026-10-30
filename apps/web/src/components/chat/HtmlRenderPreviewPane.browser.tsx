// The dock's zoom works like a browser's: the page lays out wider when zoomed out and
// still fills the pane.
import "../../index.css";
import { injectHtmlRenderBootstrap } from "@synara/shared/htmlRender";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const PAGE_URL = URL.createObjectURL(
  new Blob([injectHtmlRenderBootstrap("<h1>Revenue</h1><p>Quarterly revenue by region.</p>")], {
    type: "text/html",
  }),
);

vi.mock("~/lib/htmlRenderFrameUrl", () => ({
  resolveHtmlRenderFrameUrl: async () => PAGE_URL,
}));

import { serverConfigQueryOptions } from "~/lib/serverReactQuery";

import { HtmlRenderPreviewPane } from "./HtmlRenderPreviewPane";

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
