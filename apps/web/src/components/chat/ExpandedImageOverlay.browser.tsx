import "../../index.css";

import { useState } from "react";

import { commands, page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { NATIVE_SURFACE_OCCLUSION_SYNC_EVENT } from "~/lib/nativeSurfaceOcclusion";
import { downloadUrlAsBlob } from "~/lib/browserDownload";
import { MossLocaleScope } from "~/localization";
import { ExpandedImageOverlay } from "./ExpandedImageOverlay";
import { useExpandedImagePreview } from "./useExpandedImagePreview";
import { UserImageAttachmentThumbnail } from "./UserImageAttachmentThumbnail";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

vi.mock("~/lib/browserDownload", () => ({ downloadUrlAsBlob: vi.fn(async () => undefined) }));

const imageUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="coral"/></svg>')}`;

const pointerCommands = commands as unknown as {
  beginPointerPickup: (selector: string, activationOffsetPx?: number) => Promise<unknown>;
  releasePointer: () => Promise<void>;
};

describe("ExpandedImageOverlay", () => {
  it("consumes Escape for the image before dismissing its owning draft dialog", async () => {
    function DraftDialog() {
      const [open, setOpen] = useState(true);
      const preview = useExpandedImagePreview();
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPopup>
            <DialogTitle>New task</DialogTitle>
            <input aria-label="Task draft" defaultValue="Keep my draft" />
            <button
              type="button"
              onClick={() =>
                preview.setExpandedImage({
                  images: [{ src: imageUrl, name: "Attachment" }],
                  index: 0,
                })
              }
            >
              Preview attachment
            </button>
            <ExpandedImageOverlay
              expandedImage={preview.expandedImage}
              onClose={preview.closeExpandedImage}
              onNavigate={preview.navigateExpandedImage}
            />
          </DialogPopup>
        </Dialog>
      );
    }
    const screen = await render(<DraftDialog />);
    try {
      await page.getByRole("button", { name: "Preview attachment" }).click();
      await expect
        .element(page.getByRole("dialog", { name: "Expanded image preview" }))
        .toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("dialog", { name: "Expanded image preview" }))
        .not.toBeInTheDocument();
      await expect.element(page.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
      await expect
        .element(page.getByRole("textbox", { name: "Task draft" }))
        .toHaveValue("Keep my draft");
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("dialog", { name: "New task" })).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the selected image and dispatches previous, next, and close", async () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const screen = await render(
      <ExpandedImageOverlay
        expandedImage={{
          images: [
            { src: imageUrl, name: "First image" },
            { src: imageUrl, name: "Second image" },
            { src: imageUrl, name: "Third image" },
          ],
          index: 1,
        }}
        onClose={onClose}
        onNavigate={onNavigate}
      />,
    );

    try {
      await expect.element(page.getByRole("img", { name: "Second image" })).toBeInTheDocument();
      await expect.element(page.getByText("Second image", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("2 / 3", { exact: true })).toBeInTheDocument();

      await page.getByRole("button", { name: "Previous image" }).click();
      await page.getByRole("button", { name: "Next image" }).click();
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close image preview"]')
        ?.click();

      expect(onNavigate).toHaveBeenNthCalledWith(1, -1);
      expect(onNavigate).toHaveBeenNthCalledWith(2, 1);
      expect(onClose).toHaveBeenCalledOnce();
      onClose.mockClear();
      await page.getByRole("img", { name: "Second image" }).click();
      expect(onClose).not.toHaveBeenCalled();
      document
        .querySelector('[data-testid="image-lightbox-viewport"]')
        ?.firstElementChild?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("signals native surfaces when the overlay opens and closes", async () => {
    const onOcclusionChange = vi.fn();
    window.addEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, onOcclusionChange);
    const screen = await render(
      <ExpandedImageOverlay expandedImage={null} onClose={vi.fn()} onNavigate={vi.fn()} />,
    );

    try {
      expect(onOcclusionChange).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("dialog", { name: "Expanded image preview" }))
        .not.toBeInTheDocument();

      await screen.rerender(
        <ExpandedImageOverlay
          expandedImage={{
            images: [{ src: imageUrl, name: "Preview image" }],
            index: 0,
          }}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      expect(onOcclusionChange).toHaveBeenCalledTimes(1);

      await screen.rerender(
        <ExpandedImageOverlay expandedImage={null} onClose={vi.fn()} onNavigate={vi.fn()} />,
      );
      expect(onOcclusionChange).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, onOcclusionChange);
      await screen.unmount();
    }
  });

  it.each([
    { width: 1200, height: 760 },
    { width: 390, height: 760 },
  ])(
    "fills a $width px window outside clipping ancestors, fits, zooms, and downloads",
    async ({ width, height }) => {
      await page.viewport(width, height);
      vi.mocked(downloadUrlAsBlob).mockClear();
      const screen = await render(
        <div style={{ transform: "translateZ(0)", width: 120, height: 80, overflow: "hidden" }}>
          <ExpandedImageOverlay
            expandedImage={{ images: [{ src: imageUrl, name: "Landscape.svg" }], index: 0 }}
            onClose={vi.fn()}
            onNavigate={vi.fn()}
          />
        </div>,
      );
      try {
        const viewport = document.querySelector<HTMLElement>(
          '[data-testid="image-lightbox-viewport"]',
        )!;
        await expect
          .element(page.getByRole("button", { name: "Zoom in", exact: true }))
          .toBeEnabled();
        await vi.waitFor(() => {
          const dialog = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
          const image = document
            .querySelector<HTMLImageElement>('[role="dialog"] img')!
            .getBoundingClientRect();
          expect(dialog.x).toBe(0);
          expect(dialog.y).toBe(0);
          expect(dialog.width).toBe(window.innerWidth);
          expect(dialog.height).toBe(window.innerHeight);
          expect(image.width).toBeLessThanOrEqual(viewport.clientWidth + 1);
          expect(image.height).toBeLessThanOrEqual(viewport.clientHeight + 1);
          expect(image.width / image.height).toBeCloseTo(1.5);
        });
        const fitZoom = Number(viewport.dataset.zoomPercent);
        const initialRect = document
          .querySelector<HTMLImageElement>('[role="dialog"] img')!
          .getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        const center = {
          x: viewportRect.left + viewport.clientWidth / 2,
          y: viewportRect.top + viewport.clientHeight / 2,
        };
        const centerRatio = {
          x: (center.x - initialRect.left) / initialRect.width,
          y: (center.y - initialRect.top) / initialRect.height,
        };
        await page.getByRole("button", { name: "Zoom in", exact: true }).click();
        expect(viewport.dataset.zoomMode).toBe("manual");
        expect(Number(viewport.dataset.zoomPercent)).toBeGreaterThan(fitZoom);
        const toolbarZoomRect = document
          .querySelector<HTMLImageElement>('[role="dialog"] img')!
          .getBoundingClientRect();
        expect(
          Math.abs(toolbarZoomRect.left + toolbarZoomRect.width * centerRatio.x - center.x),
        ).toBeLessThanOrEqual(1.5);
        expect(
          Math.abs(toolbarZoomRect.top + toolbarZoomRect.height * centerRatio.y - center.y),
        ).toBeLessThanOrEqual(1.5);
        await page.getByRole("button", { name: "Fit image to window" }).click();
        expect(viewport.dataset.zoomMode).toBe("fit");
        await page.getByRole("img", { name: "Landscape.svg" }).dblClick();
        await vi.waitFor(() => expect(viewport.dataset.zoomPercent).toBe("100"));
        expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
        const scrollLeft = viewport.scrollLeft;
        try {
          await pointerCommands.beginPointerPickup('[role="dialog"] img', 40);
          expect(viewport.scrollLeft).toBeLessThan(scrollLeft);
        } finally {
          await pointerCommands.releasePointer();
        }
        const beforeWheel = document
          .querySelector<HTMLImageElement>('[role="dialog"] img')!
          .getBoundingClientRect();
        const point = {
          clientX: viewportRect.left + viewport.clientWidth * 0.25,
          clientY: viewportRect.top + viewport.clientHeight * 0.35,
        };
        const pointRatio = {
          x: (point.clientX - beforeWheel.left) / beforeWheel.width,
          y: (point.clientY - beforeWheel.top) / beforeWheel.height,
        };
        const wheel = new WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: -20,
          cancelable: true,
          ...point,
        });
        viewport.dispatchEvent(wheel);
        expect(wheel.defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(Number(viewport.dataset.zoomPercent)).toBeGreaterThan(100));
        const afterWheel = document
          .querySelector<HTMLImageElement>('[role="dialog"] img')!
          .getBoundingClientRect();
        expect(
          Math.abs(afterWheel.left + afterWheel.width * pointRatio.x - point.clientX),
        ).toBeLessThanOrEqual(1.5);
        expect(
          Math.abs(afterWheel.top + afterWheel.height * pointRatio.y - point.clientY),
        ).toBeLessThanOrEqual(1.5);
        await page.getByRole("button", { name: "Fit image to window" }).click();
        await page.getByRole("button", { name: "Download image" }).click();
        await vi.waitFor(() =>
          expect(downloadUrlAsBlob).toHaveBeenCalledWith({
            url: imageUrl,
            filename: "Landscape.svg",
          }),
        );
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      } finally {
        await screen.unmount();
        await page.viewport(1200, 760);
      }
    },
  );

  it.each([
    {
      locale: "en",
      title: "Expanded image preview",
      download: "Download image",
      close: "Close image preview",
      closeHint: "Close (Escape)",
      previous: "Previous image",
      next: "Next image",
      zoomOut: "Zoom out",
      zoomIn: "Zoom in",
      fit: "Fit image to window",
    },
    {
      locale: "zh-CN",
      title: "放大图片预览",
      download: "下载图片",
      close: "关闭图片预览",
      closeHint: "关闭（Escape）",
      previous: "上一张图片",
      next: "下一张图片",
      zoomOut: "缩小",
      zoomIn: "放大",
      fit: "图片适应窗口",
    },
  ] as const)("localizes lightbox controls in $locale", async (labels) => {
    const screen = await render(
      <MossLocaleScope locale={labels.locale}>
        <ExpandedImageOverlay
          expandedImage={{
            images: [
              { src: imageUrl, name: "First.svg" },
              { src: imageUrl, name: "Second.svg" },
            ],
            index: 0,
          }}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
        />
      </MossLocaleScope>,
    );
    try {
      await expect.element(page.getByRole("dialog", { name: labels.title })).toBeVisible();
      for (const label of [labels.download, labels.zoomIn, labels.zoomOut, labels.fit]) {
        await expect
          .element(page.getByRole("button", { name: label, exact: true }))
          .toHaveAttribute("title", label);
      }
      await expect
        .element(page.getByRole("button", { name: labels.close }))
        .toHaveAttribute("title", labels.closeHint);
      await expect.element(page.getByRole("button", { name: labels.previous })).toBeVisible();
      await expect.element(page.getByRole("button", { name: labels.next })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps controls and navigation focus mounted while resetting zoom and failed images", async () => {
    const portraitUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="2400"><rect width="800" height="2400" fill="coral"/></svg>')}`;
    const images = [
      { src: imageUrl, name: "Landscape.svg" },
      { src: "data:image/png;base64,invalid", name: "Missing.png" },
      { src: portraitUrl, name: "Portrait.svg" },
    ];
    function Gallery() {
      const [index, setIndex] = useState(0);
      return (
        <ExpandedImageOverlay
          expandedImage={{ images, index }}
          onClose={vi.fn()}
          onNavigate={(direction) => setIndex((current) => current + direction)}
        />
      );
    }
    const screen = await render(<Gallery />);
    try {
      await expect
        .element(page.getByRole("button", { name: "Zoom in", exact: true }))
        .toBeEnabled();
      const controls = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
      );
      const next = document.querySelector<HTMLButtonElement>('button[aria-label="Next image"]')!;
      const viewport = document.querySelector<HTMLElement>(
        '[data-testid="image-lightbox-viewport"]',
      )!;
      await page.getByRole("img", { name: "Landscape.svg" }).dblClick();
      await vi.waitFor(() => expect(viewport.dataset.zoomPercent).toBe("100"));
      next.focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByText("Image unavailable")).toBeVisible();
      expect(viewport.dataset.zoomMode).toBe("fit");
      expect(document.activeElement).toBe(next);
      controls.forEach((control, index) => {
        expect(document.querySelectorAll('[role="dialog"] button')[index]).toBe(control);
      });
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByRole("button", { name: "Zoom in", exact: true }))
        .toBeEnabled();
      await expect.element(page.getByText("Image unavailable")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(next);
      controls.forEach((control, index) => {
        expect(document.querySelectorAll('[role="dialog"] button')[index]).toBe(control);
      });
      expect(viewport.dataset.zoomMode).toBe("fit");
      expect(viewport.scrollLeft).toBe(0);
      expect(viewport.scrollTop).toBe(0);
      const portrait = document.querySelector<HTMLImageElement>('[role="dialog"] img')!;
      expect(
        portrait.getBoundingClientRect().height / portrait.getBoundingClientRect().width,
      ).toBeCloseTo(3);
      vi.mocked(downloadUrlAsBlob).mockClear();
      await page.getByRole("button", { name: "Download image" }).click();
      await vi.waitFor(() =>
        expect(downloadUrlAsBlob).toHaveBeenCalledWith({
          url: portraitUrl,
          filename: "Portrait.svg",
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("opens attachments, traps focus, navigates with arrows, and restores focus and transcript position", async () => {
    function Transcript() {
      const preview = useExpandedImagePreview();
      const images = ["First.svg", "Second.svg"].map((name) => ({
        type: "image" as const,
        id: name,
        name,
        previewUrl: imageUrl,
        mimeType: "image/svg+xml",
        sizeBytes: 200,
      }));
      return (
        <>
          <div data-testid="transcript" style={{ height: 200, overflow: "auto" }}>
            <div style={{ height: 400 }} />
            {images.map((image) => (
              <UserImageAttachmentThumbnail
                key={image.id}
                image={image}
                userImages={images}
                onImageExpand={preview.setExpandedImage}
                resolvedTheme="dark"
              />
            ))}
            <div style={{ height: 400 }} />
          </div>
          <ExpandedImageOverlay
            expandedImage={preview.expandedImage}
            onClose={preview.closeExpandedImage}
            onNavigate={preview.navigateExpandedImage}
          />
        </>
      );
    }
    const screen = await render(<Transcript />);
    try {
      const transcript = document.querySelector<HTMLElement>('[data-testid="transcript"]')!;
      transcript.scrollTop = 350;
      await page.getByRole("button", { name: "Preview Second.svg" }).click();
      const scrollTop = transcript.scrollTop;
      await expect
        .element(page.getByRole("img", { name: "Second.svg", exact: true }))
        .toBeVisible();
      for (let i = 0; i < 10; i++) {
        await userEvent.keyboard("{Tab}");
        expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(
          true,
        );
      }
      await userEvent.keyboard("{ArrowLeft}");
      await expect
        .element(page.getByRole("dialog").getByRole("img", { name: "First.svg", exact: true }))
        .toBeVisible();
      await userEvent.keyboard("{ArrowLeft}");
      await expect
        .element(page.getByRole("dialog").getByRole("img", { name: "Second.svg", exact: true }))
        .toBeVisible();
      await userEvent.keyboard("{ArrowRight}");
      await expect
        .element(page.getByRole("dialog").getByRole("img", { name: "First.svg", exact: true }))
        .toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute("aria-label")).toBe("Preview Second.svg"),
      );
      expect(transcript.scrollTop).toBe(scrollTop);
    } finally {
      await screen.unmount();
    }
  });

  it("shows an unavailable state for a failed image and no modal for an invalid selection", async () => {
    const screen = await render(
      <ExpandedImageOverlay
        expandedImage={{
          images: [{ src: "data:image/png;base64,invalid", name: "Missing" }],
          index: 0,
        }}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    try {
      await expect.element(page.getByText("Image unavailable")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Zoom in", exact: true }))
        .toBeDisabled();
      await screen.rerender(
        <ExpandedImageOverlay
          expandedImage={{ images: [], index: 0 }}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
