// The composer's attachment preview: an image opens at a comfortable size over the dim with
// close and Mark up beside its top edge; Mark up uses the shared markup bar (no Select), and
// Save hands back one PNG that really carries the marks; a file opens as a card; Escape
// closes and focus goes back to the thumbnail; light and dark; sizes from 860 to 1600 wide.
import "../../index.css";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { MARKUP_COLORS } from "../markup/markup.logic";
import { ComposerReferenceAttachments } from "./ComposerReferenceAttachments";

async function pictureFile(name: string, width: number, height: number): Promise<File> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f4f3ee";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#1f1e1d";
  ctx.font = `600 ${Math.max(12, Math.round(width / 24))}px sans-serif`;
  ctx.fillText("GitHub CLI", width * 0.3, height * 0.45);
  ctx.fillRect(width * 0.4, height * 0.55, width * 0.2, height * 0.06);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new File([blob], name, { type: "image/png" });
}

function imageAttachment(id: string, file: File): ComposerImageAttachment {
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  };
}

const PDF: ComposerFileAttachment = {
  type: "file",
  id: "file-1",
  name: "Moss-1.0.4-发版清单.pdf",
  mimeType: "application/pdf",
  sizeBytes: 248_320,
  file: new File(["%PDF"], "Moss-1.0.4-发版清单.pdf", { type: "application/pdf" }),
};

function Harness(props: {
  readonly initialImages: readonly ComposerImageAttachment[];
  readonly onReplaced: (imageId: string, file: File) => void;
}) {
  const [images, setImages] = useState<readonly ComposerImageAttachment[]>(props.initialImages);
  return (
    <div className="fixed inset-x-0 bottom-0 flex justify-center bg-background p-6">
      <div className="w-[min(46rem,100%)] rounded-[20px] border border-border bg-[var(--composer-surface)] px-4 pt-4 pb-12">
        <ComposerReferenceAttachments
          assistantSelections={[]}
          fileComments={[]}
          files={[PDF]}
          images={images}
          nonPersistedImageIdSet={new Set()}
          onRemoveAssistantSelections={() => {}}
          onRemoveFileComments={() => {}}
          onRemoveFile={() => {}}
          onRemoveImage={(id) => setImages((current) => current.filter((image) => image.id !== id))}
          onReplaceImage={(id, file) => {
            props.onReplaced(id, file);
            setImages((current) => [
              ...current.filter((image) => image.id !== id),
              imageAttachment(`${id}-marked`, file),
            ]);
          }}
        />
      </div>
    </div>
  );
}

function setTheme(mode: "light" | "dark") {
  document.documentElement.classList.toggle("dark", mode === "dark");
}

async function shot(name: string) {
  // Kept beside the test (git-ignored) for review against Claude's preview.
  await page.screenshot({ path: `__screenshots__/composer-attachment-preview/${name}.png` });
}

function rect(selector: string): DOMRect {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element.getBoundingClientRect();
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

afterEach(() => setTheme("light"));

for (const theme of ["light", "dark"] as const) {
  it(`previews an image, marks it up and saves it in place of the original (${theme})`, async () => {
    await page.viewport(1280, 820);
    setTheme(theme);
    const replaced: { id: string; file: File }[] = [];
    const big = imageAttachment("img-1", await pictureFile("github-cli.png", 1652, 1173));
    const screen = await render(
      <Harness initialImages={[big]} onReplaced={(id, file) => replaced.push({ id, file })} />,
    );
    try {
      const thumbnail = page.getByRole("button", { name: "Preview github-cli.png" });
      await thumbnail.click();
      const dialog = page.getByRole("dialog", { name: "Attachment preview" });
      await expect.element(dialog).toBeVisible();
      // Close has focus first, so Enter or Escape both get out at once.
      await expect.element(page.getByRole("button", { name: "Close preview" })).toHaveFocus();
      await vi.waitFor(() =>
        expect(rect("[data-attachment-preview-image] img").width).toBeCloseTo(640, 0),
      );
      const image = rect("[data-attachment-preview-image] img");
      // Centred, not full screen.
      expect(Math.abs(image.left + image.width / 2 - 640)).toBeLessThan(2);
      // Close and Mark up stacked to the right of the image's top edge.
      const close = rect("[data-attachment-preview-close]");
      const annotate = rect("[data-attachment-preview-annotate]");
      expect(close.left - image.right).toBeGreaterThanOrEqual(4);
      expect(close.left - image.right).toBeLessThanOrEqual(8);
      expect(Math.abs(close.top - image.top)).toBeLessThan(1);
      expect(annotate.top).toBeGreaterThan(close.bottom);
      expect(Math.abs(annotate.left - close.left)).toBeLessThan(1);
      await shot(`image-${theme}`);

      await page.getByRole("button", { name: "Mark up image" }).click();
      const toolbar = page.getByRole("toolbar", { name: "Annotation tools" });
      await expect.element(toolbar).toBeVisible();
      // No element to select on an image: the bar opens on the pen, full, with Save.
      await expect
        .element(page.getByRole("button", { name: "Select element" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Pen" }))
        .toHaveAttribute("aria-pressed", "true");
      await expect.element(toolbar).toHaveAttribute("data-layout", "full");
      await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
      // The bar sits under the image, not over it.
      const bar = rect("[data-markup-toolbar]");
      expect(bar.top).toBeGreaterThanOrEqual(rect("[data-attachment-preview-image] img").bottom);

      const canvas = document.querySelector("[data-markup-canvas]")!;
      await page.getByRole("button", { name: "Shapes" }).click();
      await page.getByRole("menuitem", { name: "Rectangle" }).click();
      drag(canvas, [
        [60, 60],
        [400, 160],
      ]);
      // Pressing the armed tool again keeps it armed (there is no Select to fall back to).
      await page.getByRole("button", { name: "Rectangle" }).click();
      await expect
        .element(page.getByRole("button", { name: "Rectangle" }))
        .toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Color" }).click();
      await page.getByRole("menuitem", { name: "Blue" }).click();
      // Escape in the open menu closes only the menu.
      await page.getByRole("button", { name: "Stroke width" }).click();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("menuitem", { name: "Thick" })).not.toBeInTheDocument();
      await expect.element(toolbar).toBeVisible();
      await page.getByRole("button", { name: "Pen" }).click();
      drag(canvas, [
        [80, 260],
        [140, 280],
        [220, 270],
      ]);
      await page.getByRole("button", { name: "Text" }).click();
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          clientX: canvas.getBoundingClientRect().left + 300,
          clientY: canvas.getBoundingClientRect().top + 220,
          button: 0,
          bubbles: true,
        }),
      );
      const text = page.getByRole("textbox", { name: "Annotation text" });
      await expect.element(text).toBeVisible();
      await userEvent.type(text, "Install fails here{Enter}");
      await shot(`markup-${theme}`);

      // Escape with marks asks first; Escape again keeps editing.
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("alertdialog", { name: "Discard your marks?" }))
        .toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("alertdialog", { name: "Discard your marks?" }))
        .not.toBeInTheDocument();
      await expect.element(dialog).toBeVisible();

      const drawnWidth = canvas.clientWidth;
      await page.getByRole("button", { name: "Save" }).click();
      // Composing a full-size PNG takes a moment in a background test frame.
      await vi.waitFor(() => expect(replaced).toHaveLength(1), { timeout: 10_000 });
      await expect.element(dialog).not.toBeInTheDocument();
      const saved = replaced[0]!;
      expect(saved.id).toBe("img-1");
      expect(saved.file.type).toBe("image/png");
      expect(saved.file.name).toMatch(/^github-cli marked \d{14}\.png$/);
      // Full resolution, and the rectangle's top edge in red over the original.
      const bitmap = await createImageBitmap(saved.file);
      expect([bitmap.width, bitmap.height]).toEqual([1652, 1173]);
      const check = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      check.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / drawnWidth;
      const [r, g, b] = check.getImageData(
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
      // The composer now shows the marked copy instead of the original.
      await expect
        .element(page.getByRole("button", { name: /^Preview github-cli marked/ }))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Preview github-cli.png" }))
        .not.toBeInTheDocument();
      await shot(`saved-${theme}`);
    } finally {
      await screen.unmount();
    }
  });

  it(`previews a file as a card with close only (${theme})`, async () => {
    await page.viewport(1280, 820);
    setTheme(theme);
    const screen = await render(<Harness initialImages={[]} onReplaced={() => {}} />);
    try {
      const card = page.getByRole("button", { name: `Preview ${PDF.name}` });
      await card.click();
      const dialog = page.getByRole("dialog", { name: "Attachment preview" });
      await expect.element(dialog).toBeVisible();
      await expect.element(dialog.getByText(PDF.name)).toBeVisible();
      await expect.element(dialog.getByText("PDF", { exact: true })).toBeVisible();
      await expect.element(dialog.getByText("242.5 KB")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Mark up image" }))
        .not.toBeInTheDocument();
      await shot(`file-${theme}`);
      await userEvent.keyboard("{Escape}");
      await expect.element(dialog).not.toBeInTheDocument();
      await expect.element(card).toHaveFocus();
      // Enter on the focused card opens it again; a click on the dim closes it.
      await userEvent.keyboard("{Enter}");
      await expect.element(dialog).toBeVisible();
      document
        .querySelector<HTMLElement>("[data-attachment-preview]")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await expect.element(dialog).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
}

it("keeps small images at their own size and big ones inside the window, 860 to 1600 wide", async () => {
  const small = imageAttachment("small", await pictureFile("small.png", 180, 120));
  const tall = imageAttachment("tall", await pictureFile("tall.png", 900, 2400));
  const wide = imageAttachment("wide", await pictureFile("wide.png", 3200, 1200));
  const screen = await render(
    <Harness initialImages={[small, tall, wide]} onReplaced={() => {}} />,
  );
  try {
    for (const [width, height] of [
      [860, 640],
      [1280, 820],
      [1600, 1000],
    ] as const) {
      await page.viewport(width, height);
      await page.getByRole("button", { name: "Preview small.png" }).click();
      await vi.waitFor(() => expect(rect("[data-attachment-preview-image] img").width).toBe(180));
      expect(rect("[data-attachment-preview-image] img").height).toBe(120);
      // Arrow keys step through the composer's images.
      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => {
        const image = rect("[data-attachment-preview-image] img");
        // A tall image fits the height, leaving room above and below.
        expect(image.height).toBeLessThanOrEqual(height - 144 + 1);
        expect(image.height).toBeGreaterThan(height - 160);
        expect(image.width).toBeLessThan(640);
      });
      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => {
        const image = rect("[data-attachment-preview-image] img");
        expect(image.width).toBeCloseTo(640, 0);
        expect(image.height).toBeCloseTo(240, 0);
        // Its buttons still fit in the window.
        expect(rect("[data-attachment-preview-close]").right).toBeLessThanOrEqual(width);
      });
      if (width === 860) await shot("wide-860");
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("dialog", { name: "Attachment preview" }))
        .not.toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Preview small.png" })).toHaveFocus();
    }
  } finally {
    await screen.unmount();
  }
});

it("opens an image straight into markup when another surface asks (a Canvas image)", async () => {
  await page.viewport(1280, 820);
  const { requestComposerImagePreview } = await import("~/lib/composerImagePreviewRequest");
  const image = imageAttachment("img-canvas", await pictureFile("canvas-cat.png", 1024, 768));
  const screen = await render(<Harness initialImages={[image]} onReplaced={() => {}} />);
  try {
    // The Canvas asks before its attachment has arrived: the request waits for it.
    requestComposerImagePreview({ imageId: "img-missing", markup: true });
    requestComposerImagePreview({ imageId: "img-canvas", markup: true });
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect
      .poll(() => document.querySelectorAll("[data-sketch-tool]").length)
      .toBeGreaterThan(0);
    expect(document.querySelector('[data-sketch-tool="pen"][aria-pressed="true"]')).not.toBeNull();
  } finally {
    await screen.unmount();
  }
});
