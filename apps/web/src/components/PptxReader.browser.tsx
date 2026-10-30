import "../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import fixtureUrl from "../lib/preview/__fixtures__/presentation-original.pptx?url";
import reorderedUrl from "../lib/preview/__fixtures__/presentation-reordered.pptx?url";
import { PptxReader } from "./PptxReader";

vi.mock("./chat/OpenInPicker", () => ({ OpenInPicker: () => null }));

afterEach(() => {
  vi.restoreAllMocks();
});

async function mockPresentation(url = fixtureUrl) {
  const bytes = await (await fetch(url)).arrayBuffer();
  const realFetch = globalThis.fetch.bind(globalThis);
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (String(input).includes("/api/local-image")) return Promise.resolve(new Response(bytes));
    return realFetch(input, init);
  });
}

it("renders real SVG slide images, thumbnails and notes, then navigates and zooms", async () => {
  await page.viewport(1200, 1000);
  await mockPresentation();
  const ready = vi.fn();
  const error = vi.fn();
  await render(
    <div style={{ width: 1144, height: 900, display: "flex" }}>
      <PptxReader
        filePath="deck.pptx"
        cwd="/workspace"
        onPreviewReady={ready}
        onPreviewError={error}
      />
    </div>,
  );
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  const image = document.querySelector<HTMLImageElement>(".presentation-main-slide img")!;
  expect(image.complete).toBe(true);
  expect(image.naturalWidth / image.naturalHeight).toBeCloseTo(4 / 3);
  expect(
    document.querySelector("[data-presentation-layout]")?.getAttribute("data-presentation-layout"),
  ).toBe("desktop");
  expect(document.querySelectorAll(".presentation-thumbnail")).toHaveLength(3);
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="Speaker notes"]')?.value,
  ).toContain("First-slide speaker notes");
  const svg = await (await fetch(image.src)).text();
  expect(svg).toContain("Revenue chart");
  expect(svg).toContain("North");
  expect(svg).toContain("MASTER STAMP");
  await page.getByRole("button", { name: /^Slide 2:/ }).click();
  await vi.waitFor(() =>
    expect(
      document.querySelector<HTMLTextAreaElement>('[aria-label="Speaker notes"]')?.value,
    ).toContain("green ellipse"),
  );
  await userEvent.keyboard("{ArrowRight}");
  await vi.waitFor(() =>
    expect(
      document.querySelector<HTMLTextAreaElement>('[aria-label="Speaker notes"]')?.value,
    ).toContain("Third-slide"),
  );
  await page.getByRole("button", { name: "Zoom", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "200%", exact: true }).click();
  expect(document.querySelector<HTMLElement>(".presentation-main-slide")?.style.width).toBe(
    "1920px",
  );
  await page.getByRole("button", { name: "Zoom", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Fit", exact: true }).click();
  expect(
    Number.parseFloat(document.querySelector<HTMLElement>(".presentation-main-slide")!.style.width),
  ).toBeLessThan(1144);
  expect(error).not.toHaveBeenCalled();
});

it("shows full stacked pages in a narrow pane and preserves the PPTX relationship order", async () => {
  await page.viewport(700, 900);
  await mockPresentation(reorderedUrl);
  const ready = vi.fn();
  await render(
    <div style={{ width: 620, height: 800, display: "flex" }}>
      <PptxReader filePath="deck.pptx" cwd="/workspace" onPreviewReady={ready} />
    </div>,
  );
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  expect(document.querySelectorAll(".presentation-stacked-page")).toHaveLength(3);
  expect(document.querySelector('[aria-label="Zoom"]')).toBeNull();
  const first = document.querySelector<HTMLImageElement>(".presentation-stacked-page img")!;
  expect(await (await fetch(first.src)).text()).toContain("THIRD SLIDE");
});

it("delivers a slide-anchored annotation to the chat callback", async () => {
  await page.viewport(1200, 1000);
  await mockPresentation();
  const ready = vi.fn();
  const annotate = vi.fn();
  await render(
    <div style={{ width: 1000, height: 800, display: "flex" }}>
      <PptxReader
        filePath="deck.pptx"
        cwd="/workspace"
        onPreviewReady={ready}
        onAnnotate={annotate}
      />
    </div>,
  );
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  await page.getByRole("button", { name: "Annotate slide" }).click();
  const surface = document.querySelector<HTMLElement>(".presentation-main-slide")!;
  const rect = surface.getBoundingClientRect();
  surface.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  );
  await page
    .getByRole("textbox", { name: "Annotation", exact: true })
    .fill("Make this chart larger");
  await page.getByRole("button", { name: "Add to chat" }).click();
  expect(annotate).toHaveBeenCalledWith({
    kind: "presentation",
    slideNumber: 1,
    text: "Make this chart larger",
    anchor: { x: 0.5, y: 0.5 },
  });
});

it("reports a failed import and recovers after reloading a valid file", async () => {
  await page.viewport(1200, 1000);
  const bytes = await (await fetch(fixtureUrl)).arrayBuffer();
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input).includes("/api/local-image")
      ? Promise.resolve(new Response(String(input).includes("v=2") ? bytes : "not a pptx"))
      : realFetch(input, init),
  );
  const ready = vi.fn();
  const error = vi.fn();
  const screen = await render(
    <div style={{ width: 1000, height: 800, display: "flex" }}>
      <PptxReader
        filePath="deck.pptx"
        cwd="/workspace"
        cacheKey={1}
        onPreviewReady={ready}
        onPreviewError={error}
      />
    </div>,
  );
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  expect(ready).not.toHaveBeenCalled();
  await screen.rerender(
    <div style={{ width: 1000, height: 800, display: "flex" }}>
      <PptxReader
        filePath="deck.pptx"
        cwd="/workspace"
        cacheKey={2}
        onPreviewReady={ready}
        onPreviewError={error}
      />
    </div>,
  );
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
});
