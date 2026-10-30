import "../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { DocxPreviewPanel } from "../DocxPreviewPanel";
import { createDocxPreviewFixture } from "./docxFixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

function createTestHost() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["server", "config"], { keybindings: [], availableEditors: [] });
  return {
    client,
    wrap: (children: ReactNode) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

it("renders real DOCX pages, switches revisions without moving the viewport, zooms and submits a selected passage", async () => {
  const bytes = await createDocxPreviewFixture();
  const nativeFetch = window.fetch.bind(window);
  vi.spyOn(window, "fetch").mockImplementation((input, init) =>
    String(input).includes("local-image")
      ? Promise.resolve(new Response(bytes))
      : nativeFetch(input, init),
  );
  const onPreviewReady = vi.fn();
  const onPreviewError = vi.fn();
  const onAnnotate = vi.fn();
  const host = createTestHost();
  // The 620px host is wider than the default 414px viewport, and the app root clips horizontal
  // overflow, so a control past the right edge cannot be scrolled into view and a click misses it.
  await page.viewport(1280, 900);
  const screen = await render(
    host.wrap(
      <div style={{ width: 620, height: 480 }}>
        <DocxPreviewPanel
          filePath="fixture.docx"
          cwd="/workspace"
          onPreviewReady={onPreviewReady}
          onPreviewError={onPreviewError}
          onAnnotate={onAnnotate}
        />
      </div>,
    ),
  );
  const active = () => document.querySelector<HTMLElement>('[data-testid="docx-preview-panel"]')!;
  await expect.poll(() => onPreviewReady.mock.calls.length).toBe(1);
  expect(onPreviewError).not.toHaveBeenCalled();
  expect(active().querySelectorAll("section.moss-docx-preview")).toHaveLength(2);
  await expect
    .poll(() => active().querySelector("section")!.getBoundingClientRect().width)
    .toBeLessThan(580);
  const pages = active().querySelectorAll("section");
  expect(
    pages[1]!.getBoundingClientRect().top - pages[0]!.getBoundingClientRect().bottom,
  ).toBeCloseTo(14, 0);
  expect(active().textContent).toContain("Deleted wording");
  expect(active().querySelector('a[href^="javascript:"]')).toBeNull();
  expect(
    active().querySelector('a[href="https://example.com/document"]')?.getAttribute("rel"),
  ).toBe("noopener noreferrer");
  active().scrollTop = 240;
  await page.getByRole("button", { name: "Show redlines", exact: true }).click();
  await expect.poll(() => active().textContent?.includes("Deleted wording")).toBe(false);
  expect(active().scrollTop).toBe(240);
  await page.getByTestId("docx-preview-zoom-trigger").click();
  await page.getByRole("menuitem", { name: "100%", exact: true }).click();
  await expect.element(page.getByTestId("docx-preview-zoom-trigger")).toHaveTextContent("100%");
  const viewport = active().parentElement!;
  viewport.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 10 }),
  );
  await expect.element(page.getByTestId("docx-preview-zoom-trigger")).toHaveTextContent("90%");
  active().scrollTop = 0;
  const paragraph = active().querySelector("p")!;
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await expect.element(page.getByRole("button", { name: "Ask for change" })).toBeVisible();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true, cancelable: true }),
  );
  await expect.element(page.getByRole("textbox", { name: "Requested change" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Ask for change" }).click();
  await page.getByRole("textbox", { name: "Requested change" }).fill("Clarify this title");
  await page.getByRole("button", { name: "Add to chat" }).click();
  await expect.poll(() => onAnnotate.mock.calls.length).toBe(1);
  expect(onAnnotate).toHaveBeenCalledWith(
    expect.objectContaining({
      filePath: "fixture.docx",
      pageNumber: 1,
      pageCount: 2,
      selectedText: "Document preview fixture",
      body: "Clarify this title",
    }),
  );
  await screen.unmount();
  host.client.clear();
});

it("reports corrupt DOCX once and recovers after a source reload", async () => {
  const bytes = await createDocxPreviewFixture();
  const nativeFetch = window.fetch.bind(window);
  vi.spyOn(window, "fetch").mockImplementation((input, init) => {
    if (!String(input).includes("local-image")) return nativeFetch(input, init);
    return Promise.resolve(new Response(String(input).includes("v=2") ? bytes : "corrupt zip"));
  });
  const ready = vi.fn();
  const error = vi.fn();
  const host = createTestHost();
  const screen = await render(
    host.wrap(
      <DocxPreviewPanel
        filePath="fixture.docx"
        cwd="/workspace"
        cacheKey={1}
        onPreviewReady={ready}
        onPreviewError={error}
      />,
    ),
  );
  await expect.poll(() => error.mock.calls.length).toBe(1);
  await expect.element(page.getByText("Unable to render fixture.docx.")).toBeVisible();
  await screen.rerender(
    host.wrap(
      <DocxPreviewPanel
        filePath="fixture.docx"
        cwd="/workspace"
        cacheKey={2}
        onPreviewReady={ready}
        onPreviewError={error}
      />,
    ),
  );
  await expect.poll(() => ready.mock.calls.length).toBe(1);
  expect(error).toHaveBeenCalledTimes(1);
  await screen.unmount();
  host.client.clear();
});
