// Annotation mode in the browser panel: the bar under the page, drawing on a still of the
// page with the pen, shapes and text, undo, and adding the marked page to chat as one PNG
// that really carries the marks.
import "../../index.css";
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useTheme } from "~/hooks/useTheme";
import { DEFAULT_THEME_STATE } from "~/theme/theme.logic";

import { BrowserAnnotationButton } from "../BrowserPanel";
import { MarkupCanvas } from "../markup/MarkupCanvas";
import { MarkupToolbar } from "../markup/MarkupToolbar";
import { useBrowserSketch } from "./useBrowserSketch";
import { MARKUP_COLORS } from "../markup/markup.logic";

const WIDTH = 900;
const PAGE_HEIGHT = 560;
// Chromium encodes a canvas PNG (toBlob, convertToBlob) in an idle period, and this
// headless page gets one only after a frame. On a page that has stopped changing no frame
// comes, so the encode waits for Chromium's 1000 ms fallback timer: as long as a default
// wait. Waits on an encode (the page still, the marked page) allow for that.
const PNG_ENCODE_TIMEOUT_MS = 5_000;

async function stillOfPage(): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(WIDTH, PAGE_HEIGHT);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f6f5f1";
  ctx.fillRect(0, 0, WIDTH, PAGE_HEIGHT);
  ctx.fillStyle = "#1f1e1d";
  ctx.font = "600 32px sans-serif";
  ctx.fillText("Import projects", 60, 90);
  ctx.font = "16px sans-serif";
  ctx.fillText("Bring your Claude Code and Codex projects into Moss.", 60, 130);
  ctx.fillStyle = "#1f1e1d";
  ctx.fillRect(60, 170, 140, 40);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

function Harness(props: { readonly onAttach: (file: File) => void; readonly width?: number }) {
  // The app's theme store paints the theme's tokens (accent, popup glass) on the root.
  useTheme();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [pickerActive, setPickerActive] = useState(false);
  const sketch = useBrowserSketch({
    enabled: true,
    activeTabId: "tab-1",
    pageUrl: "http://localhost:5934/",
    pageTitle: "Moss",
    elementPicker: {
      active: pickerActive,
      starting: false,
      toggle: () => setPickerActive((active) => !active),
    },
    capturePage: async () => {
      const bytes = await stillOfPage();
      return { name: "page.png", mimeType: "image/png", sizeBytes: bytes.byteLength, bytes };
    },
    readPageWidth: () => viewportRef.current?.clientWidth ?? 0,
    attachImage: async (file) => props.onAttach(file),
    onError: () => {},
  });
  return (
    <div
      style={{ position: "fixed", inset: 0, width: props.width ?? WIDTH, height: 640 }}
      className="flex flex-col bg-background"
    >
      <div className="flex h-10 shrink-0 items-center justify-end border-border border-b px-2">
        <BrowserAnnotationButton
          controller={{ active: sketch.open, starting: false, toggle: sketch.toggle }}
          disabled={false}
        />
      </div>
      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 bg-[#f6f5f1]"
        data-picker-active={pickerActive ? "" : undefined}
      >
        {sketch.coversPage ? (
          <MarkupCanvas
            pageImageUrl={sketch.pageImageUrl}
            tool={sketch.tool}
            style={sketch.style}
            marks={sketch.marks}
            onAddMark={sketch.addMark}
          />
        ) : null}
      </div>
      {sketch.open ? (
        // The browser panel's strip under the page (BrowserPanel's data-browser-sketch-strip).
        <div
          data-browser-sketch-strip=""
          className="flex h-12 shrink-0 items-center justify-center bg-[color-mix(in_srgb,var(--foreground)_3%,var(--background))] px-3"
        >
          <MarkupToolbar
            tool={sketch.tool}
            onToolChange={sketch.setTool}
            selectAvailable
            canUndo={sketch.canUndo}
            canRedo={sketch.canRedo}
            hasMarks={sketch.marks.length > 0}
            expanded={sketch.expanded}
            style={sketch.style}
            onStyleChange={sketch.setStyle}
            action={{
              label: "Add to chat",
              busyLabel: "Adding…",
              busy: sketch.adding,
              onClick: sketch.addToChat,
            }}
            confirmingDiscard={sketch.confirmingDiscard}
            onUndo={sketch.undo}
            onRedo={sketch.redo}
            onClear={sketch.clear}
            onRequestClose={sketch.requestClose}
            onCancelDiscard={sketch.cancelDiscard}
            onDiscard={sketch.close}
          />
        </div>
      ) : null}
    </div>
  );
}

function drag(target: Element, points: ReadonlyArray<readonly [number, number]>) {
  const box = target.getBoundingClientRect();
  const at = ([x, y]: readonly [number, number]) => ({
    clientX: box.left + x,
    clientY: box.top + y,
    pointerId: 1,
    button: 0,
    bubbles: true,
  });
  target.dispatchEvent(new PointerEvent("pointerdown", at(points[0]!)));
  for (const point of points.slice(1))
    target.dispatchEvent(new PointerEvent("pointermove", at(point)));
  target.dispatchEvent(new PointerEvent("pointerup", at(points.at(-1)!)));
}

// The harness runs the app's theme store; switch it the way another window would.
async function switchAppTheme(mode: "light" | "dark") {
  localStorage.setItem("moss:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode }));
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  await vi.waitFor(() =>
    expect(document.documentElement.classList.contains("dark")).toBe(mode === "dark"),
  );
}

async function shot(name: string) {
  // Kept beside the test (git-ignored) for side-by-side review against the reference.
  await page.screenshot({ path: `__screenshots__/annotate-and-comment/${name}.png` });
}

afterEach(() => {
  localStorage.removeItem("moss:theme");
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
});

for (const theme of ["light", "dark"] as const) {
  it(`marks up the page and adds it to chat (${theme})`, async () => {
    await page.viewport(WIDTH, 640);
    const attached: File[] = [];
    const screen = await render(<Harness onAttach={(file) => attached.push(file)} />);
    await switchAppTheme(theme);
    try {
      await page.getByRole("button", { name: "Annotate page" }).click();
      const toolbar = page.getByRole("toolbar", { name: "Annotation tools" });
      await expect.element(toolbar).toBeVisible();
      // Annotation starts in Select element, on the live page.
      await expect
        .element(page.getByRole("button", { name: "Select element" }))
        .toHaveAttribute("aria-pressed", "true");
      await vi.waitFor(() => expect(document.querySelector("[data-picker-active]")).not.toBeNull());
      // It starts compact: select, pen, shapes, text and close only.
      await expect.element(toolbar).toHaveAttribute("data-layout", "compact");
      await expect
        .element(page.getByRole("button", { name: "Add to chat" }))
        .not.toBeInTheDocument();
      await shot(`sketch-bar-${theme}`);

      // The shape menu opens upwards with the five shapes, in their order.
      await page.getByRole("button", { name: "Shapes" }).click();
      for (const shape of ["Line", "Arrow", "Rectangle", "Ellipse", "Step"]) {
        await expect.element(page.getByRole("menuitem", { name: shape })).toBeVisible();
      }
      await shot(`sketch-shapes-menu-${theme}`);
      await page.getByRole("menuitem", { name: "Rectangle" }).click();
      // A drawing tool opens the bar out: colours, widths and Add to chat (not yet usable).
      await expect.element(toolbar).toHaveAttribute("data-layout", "full");
      await expect.element(page.getByRole("button", { name: "Add to chat" })).toBeDisabled();

      // Drawing freezes the page on its still and leaves the element picker. The still is
      // taken a moment after the bar opens, and encoded as a PNG.
      const overlay = await vi.waitFor(
        () => {
          const element = document.querySelector("[data-markup-canvas] img");
          expect(element).not.toBeNull();
          return document.querySelector("[data-markup-canvas]")!;
        },
        { timeout: PNG_ENCODE_TIMEOUT_MS },
      );
      expect(document.querySelector("[data-picker-active]")).toBeNull();
      drag(overlay, [
        [50, 60],
        [400, 110],
      ]);
      // Blue, extra thick ink for the pen.
      await page.getByRole("button", { name: "Color" }).click();
      await page.getByRole("menuitem", { name: "Blue" }).click();
      await page.getByRole("button", { name: "Stroke width" }).click();
      await page.getByRole("menuitem", { name: "Extra thick" }).click();
      await page.getByRole("button", { name: "Pen" }).click();
      drag(overlay, [
        [70, 240],
        [120, 260],
        [180, 250],
        [240, 280],
      ]);
      await page.getByRole("button", { name: "Text" }).click();
      overlay.dispatchEvent(
        new PointerEvent("pointerdown", {
          clientX: overlay.getBoundingClientRect().left + 260,
          clientY: overlay.getBoundingClientRect().top + 190,
          button: 0,
          bubbles: true,
        }),
      );
      const text = page.getByRole("textbox", { name: "Annotation text" });
      await expect.element(text).toBeVisible();
      await userEvent.type(text, "Make this button coral{Enter}");
      await expect.element(page.getByRole("button", { name: "Add to chat" })).toBeVisible();
      await shot(`sketch-marked-${theme}`);

      // Undo takes the text back off; redo puts it back; undo again.
      await page.getByRole("button", { name: "Undo" }).click();
      await page.getByRole("button", { name: "Redo" }).click();
      await page.getByRole("button", { name: "Undo" }).click();
      await expect.element(page.getByRole("button", { name: "Redo" })).toBeEnabled();
      const drawnWidth = overlay.clientWidth;
      await page.getByRole("button", { name: "Add to chat" }).click();
      await vi.waitFor(() => expect(attached).toHaveLength(1), {
        timeout: PNG_ENCODE_TIMEOUT_MS,
      });

      const file = attached[0]!;
      expect(file.type).toBe("image/png");
      expect(file.name).toMatch(/^Moss marked \d{14}\.png$/);
      // The rectangle's top edge, painted in the default red over the page still.
      const bitmap = await createImageBitmap(file);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / drawnWidth;
      const [r, g, b] = ctx.getImageData(
        Math.round(200 * scale),
        Math.round(60 * scale),
        1,
        1,
      ).data;
      const ink = MARKUP_COLORS.red.replace("#", "");
      expect([r, g, b]).toEqual([
        Number.parseInt(ink.slice(0, 2), 16),
        Number.parseInt(ink.slice(2, 4), 16),
        Number.parseInt(ink.slice(4, 6), 16),
      ]);

      // Marks went to chat: back to the live page in Select element, and the bar closes
      // without asking.
      await expect
        .element(page.getByRole("button", { name: "Select element" }))
        .toHaveAttribute("aria-pressed", "true");
      expect(document.querySelector("[data-markup-canvas]")).toBeNull();
      await expect.element(page.getByRole("button", { name: "Add to chat" })).toBeDisabled();
      await page.getByRole("button", { name: "Pen" }).click();
      // The still is taken a moment after the bar opens (see above).
      await vi.waitFor(
        () => expect(document.querySelector("[data-markup-canvas] img")).not.toBeNull(),
        { timeout: PNG_ENCODE_TIMEOUT_MS },
      );
      drag(document.querySelector("[data-markup-canvas]")!, [
        [80, 300],
        [300, 330],
      ]);
      // Every way out asks before dropping marks: the header button, Escape, the bar's ×.
      await page.getByRole("button", { name: "Close annotation", exact: true }).first().click();
      await expect
        .element(page.getByRole("alertdialog", { name: "Discard your marks?" }))
        .toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("alertdialog", { name: "Discard your marks?" }))
        .not.toBeInTheDocument();
      await expect.element(toolbar).toBeVisible();
      await toolbar.getByRole("button", { name: "Close annotation" }).click();
      await expect
        .element(page.getByRole("alertdialog", { name: "Discard your marks?" }))
        .toBeVisible();
      await shot(`sketch-discard-${theme}`);
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await expect.element(toolbar).not.toBeInTheDocument();
      expect(document.querySelector("[data-markup-canvas]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
}

function expectInside(inner: Element, outer: Element) {
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  expect(a.width).toBeGreaterThan(0);
  expect(a.left).toBeGreaterThanOrEqual(b.left - 0.5);
  expect(a.right).toBeLessThanOrEqual(b.right + 0.5);
}

// A browser panel can be as narrow as about 360px. The armed bar folds its colour, width
// and history controls into one More menu when the strip has no room for them; Select,
// the drawing tools, Add to chat and close stay on the bar at every width.
for (const [panelWidth, theme] of [
  [360, "light"],
  [420, "dark"],
  [560, "light"],
  [900, "light"],
] as const) {
  it(`fits the armed bar in a ${panelWidth}px browser panel (${theme})`, async () => {
    await page.viewport(panelWidth, 640);
    const attached: File[] = [];
    const screen = await render(
      <Harness width={panelWidth} onAttach={(file) => attached.push(file)} />,
    );
    await switchAppTheme(theme);
    try {
      await page.getByRole("button", { name: "Annotate page" }).click();
      const toolbar = page.getByRole("toolbar", { name: "Annotation tools" });
      await page.getByRole("button", { name: "Pen" }).click();
      await expect.element(toolbar).toHaveAttribute("data-layout", "full");
      const overlay = await vi.waitFor(
        () => {
          expect(document.querySelector("[data-markup-canvas] img")).not.toBeNull();
          return document.querySelector("[data-markup-canvas]")!;
        },
        { timeout: PNG_ENCODE_TIMEOUT_MS },
      );
      drag(overlay, [
        [40, 60],
        [220, 120],
      ]);
      await expect.element(page.getByRole("button", { name: "Add to chat" })).toBeEnabled();
      await shot(`sketch-fit-${panelWidth}-${theme}`);

      const strip = document.querySelector("[data-browser-sketch-strip]")!;
      const bar = toolbar.element();
      expectInside(bar, strip);
      for (const name of ["Select element", "Pen", "Shapes", "Text", "Add to chat"]) {
        expectInside(page.getByRole("button", { name, exact: true }).element(), strip);
      }
      expectInside(toolbar.getByRole("button", { name: "Close annotation" }).element(), strip);

      const folds = panelWidth < 560;
      await expect.element(toolbar).toHaveAttribute("data-fit", folds ? "folded" : "inline");
      if (!folds) {
        await expect
          .element(page.getByRole("button", { name: "More annotation tools" }))
          .not.toBeInTheDocument();
        await expect.element(page.getByRole("button", { name: "Color" })).toBeVisible();
        await expect.element(page.getByRole("button", { name: "Undo" })).toBeEnabled();
        return;
      }

      // Folded: no inline colour, width or history buttons; they live in More.
      for (const name of ["Color", "Stroke width", "Undo", "Redo", "Clear all marks"]) {
        await expect.element(page.getByRole("button", { name })).not.toBeInTheDocument();
      }
      const more = page.getByRole("button", { name: "More annotation tools" });
      expectInside(more.element(), strip);
      await more.click();
      for (const name of ["Red", "Blue", "Green", "Black", "White"]) {
        await expect.element(page.getByRole("menuitemradio", { name, exact: true })).toBeVisible();
      }
      for (const name of ["Thin", "Medium", "Thick", "Extra thick"]) {
        await expect.element(page.getByRole("menuitemradio", { name, exact: true })).toBeVisible();
      }
      await expect
        .element(page.getByRole("menuitemradio", { name: "Red" }))
        .toHaveAttribute("aria-checked", "true");
      // A colour and a width can be picked in one go: the menu stays open.
      await page.getByRole("menuitemradio", { name: "Blue" }).click();
      await page.getByRole("menuitemradio", { name: "Extra thick" }).click();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Blue" }))
        .toHaveAttribute("aria-checked", "true");
      await expect
        .element(page.getByRole("menuitemradio", { name: "Extra thick" }))
        .toHaveAttribute("aria-checked", "true");
      await expect.element(page.getByRole("menuitem", { name: "Redo" })).toBeDisabled();
      // The menu fits in the panel too.
      expectInside(document.querySelector("[data-markup-more-menu]")!, document.body);
      await shot(`sketch-fit-${panelWidth}-${theme}-more`);
      await page.getByRole("menuitem", { name: "Undo" }).click();
      await expect.element(page.getByRole("button", { name: "Add to chat" })).toBeDisabled();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("menuitem", { name: "Undo" })).not.toBeInTheDocument();
      // The new ink is the one the next mark takes, and Add to chat sends it.
      drag(overlay, [
        [40, 200],
        [260, 200],
      ]);
      const drawnWidth = overlay.clientWidth;
      await page.getByRole("button", { name: "Add to chat" }).click();
      // The bar is still here (a closed menu, its tooltip gone), so the encode often waits
      // for the fallback timer (see PNG_ENCODE_TIMEOUT_MS).
      await vi.waitFor(() => expect(attached).toHaveLength(1), {
        timeout: PNG_ENCODE_TIMEOUT_MS,
      });
      const bitmap = await createImageBitmap(attached[0]!);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / drawnWidth;
      const [r, g, b] = ctx.getImageData(
        Math.round(150 * scale),
        Math.round(200 * scale),
        1,
        1,
      ).data;
      const ink = MARKUP_COLORS.blue.replace("#", "");
      expect([r, g, b]).toEqual([
        Number.parseInt(ink.slice(0, 2), 16),
        Number.parseInt(ink.slice(2, 4), 16),
        Number.parseInt(ink.slice(4, 6), 16),
      ]);
    } finally {
      await screen.unmount();
    }
  });
}
