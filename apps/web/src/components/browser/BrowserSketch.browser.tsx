// Annotation mode in the browser panel: the bar under the page, drawing on a still of the
// page with the pen, shapes and text, undo, and adding the marked page to chat as one PNG
// that really carries the marks.
import "../../index.css";
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { BrowserAnnotationButton } from "../BrowserPanel";
import { MarkupCanvas } from "../markup/MarkupCanvas";
import { MarkupToolbar } from "../markup/MarkupToolbar";
import { useBrowserSketch } from "./useBrowserSketch";
import { MARKUP_COLORS } from "../markup/markup.logic";

const WIDTH = 900;
const PAGE_HEIGHT = 560;

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

function Harness(props: { readonly onAttach: (file: File) => void }) {
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
      style={{ position: "fixed", inset: 0, width: WIDTH, height: 640 }}
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
        <div className="flex h-12 shrink-0 items-center justify-center border-border/70 border-t bg-background px-3">
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

// Nothing here runs the app's theme store, so the root's dark class is set directly.
function switchAppTheme(mode: "light" | "dark") {
  document.documentElement.classList.toggle("dark", mode === "dark");
}

async function shot(name: string) {
  // Kept beside the test (git-ignored) for side-by-side review against the reference.
  await page.screenshot({ path: `__screenshots__/annotate-and-comment/${name}.png` });
}

afterEach(() => switchAppTheme("light"));

for (const theme of ["light", "dark"] as const) {
  it(`marks up the page and adds it to chat (${theme})`, async () => {
    await page.viewport(WIDTH, 640);
    const attached: File[] = [];
    const screen = await render(<Harness onAttach={(file) => attached.push(file)} />);
    switchAppTheme(theme);
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
      // taken a moment after the bar opens, and a test frame in the background runs its
      // timers late, so this waits longer than the default second.
      const overlay = await vi.waitFor(
        () => {
          const element = document.querySelector("[data-markup-canvas] img");
          expect(element).not.toBeNull();
          return document.querySelector("[data-markup-canvas]")!;
        },
        { timeout: 5_000 },
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
      await vi.waitFor(() => expect(attached).toHaveLength(1));

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
        { timeout: 5_000 },
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
