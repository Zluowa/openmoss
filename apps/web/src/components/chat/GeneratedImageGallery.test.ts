import { describe, expect, it } from "vitest";

import { generatedImageDisplayName, generatedImageTimedName } from "./generatedImageGallery.logic";
import {
  deriveGeneratedImageGalleryLayout,
  GENERATED_IMAGE_PENDING_DOT_OPACITY_AMPLITUDE,
  GENERATED_IMAGE_PENDING_DOT_RADIUS,
  GENERATED_IMAGE_PENDING_DOT_SPACING_PX,
  resolveGeneratedImageGalleryGroup,
} from "./GeneratedImageGallery";
import {
  CODEX_GENERATED_IMAGE_CHEVRON_PATH,
  CODEX_GENERATED_IMAGE_CHEVRON_VIEW_BOX,
  CODEX_GENERATED_IMAGE_STACK_PATHS,
  CODEX_GENERATED_IMAGE_STACK_VIEW_BOX,
} from "./GeneratedImageGalleryIcons";

describe("generated image gallery geometry", () => {
  it("assigns one stable safe group to generated gallery previews", () => {
    expect(
      resolveGeneratedImageGalleryGroup({
        turnId: "turn-1" as never,
        createdAt: "2026-08-28T12:34:56.000Z",
        images: [{ id: "image-1", path: "/tmp/image-1.png" }],
      }),
    ).toEqual({ groupId: "turn-1", createdAt: "2026-08-28T12:34:56.000Z" });
    expect(
      resolveGeneratedImageGalleryGroup({
        turnId: null,
        createdAt: "2026-08-28T12:34:56.000Z",
        images: [{ id: "image-2", path: "/tmp/image-2.png" }],
      }).groupId,
    ).toBe("generated-image-gallery:image-2");
  });

  it("keeps the frozen null-width first frame empty until ResizeObserver measures it", () => {
    expect(
      deriveGeneratedImageGalleryLayout({
        containerWidthPx: null,
        imageAspectRatios: [1],
      }),
    ).toEqual({
      heightPx: 0,
      aspectRatio: "natural",
      maxStartIndex: 0,
      overflowCount: 0,
      visibleCount: 1,
      itemWidthsPx: [0],
    });
  });

  it("uses a natural single-image frame and square slots after overflow", () => {
    expect(
      deriveGeneratedImageGalleryLayout({
        containerWidthPx: 400,
        imageAspectRatios: [2],
      }),
    ).toMatchObject({
      heightPx: 200,
      aspectRatio: "natural",
      visibleCount: 1,
      overflowCount: 0,
    });
    const overflow = deriveGeneratedImageGalleryLayout({
      containerWidthPx: 390,
      imageAspectRatios: [1, 1, 1, 1, 1],
    });
    expect(overflow).toMatchObject({
      heightPx: 91.5,
      aspectRatio: "square",
      maxStartIndex: 1,
      overflowCount: 1,
      visibleCount: 4,
    });
    expect(overflow.itemWidthsPx).toEqual([91.5, 91.5, 91.5, 91.5, 91.5]);
  });

  it("keeps pending dot-field constants from the frozen loading canvas", () => {
    expect(GENERATED_IMAGE_PENDING_DOT_SPACING_PX).toBe(12);
    expect(GENERATED_IMAGE_PENDING_DOT_OPACITY_AMPLITUDE).toBe(0.16);
    expect(GENERATED_IMAGE_PENDING_DOT_RADIUS).toBe(0.55);
  });
});

describe("generated image gallery SVG assets", () => {
  it("keeps the frozen stack and chevron view boxes and literal paths", () => {
    expect(CODEX_GENERATED_IMAGE_STACK_VIEW_BOX).toBe("0 0 21 21");
    expect(CODEX_GENERATED_IMAGE_STACK_PATHS).toEqual([
      "M8.1 9.9a1.15 1.15 0 1 1-2.3 0a1.15 1.15 0 1 1 2.3 0Z",
      "M3 9a2.25 2.25 0 0 1 2.25-2.25h7A2.25 2.25 0 0 1 14.5 9v7.25a2.25 2.25 0 0 1-2.25 2.25h-7A2.25 2.25 0 0 1 3 16.25ZM3.25 15.5l3-2.75 2.25 1.9 2.25-2.15 3.5 3.25",
      "M6.75 4.5a2 2 0 0 1 2-1.75h7.25A2.25 2.25 0 0 1 18.25 5v7.5a2 2 0 0 1-1.75 2",
    ]);
    expect(CODEX_GENERATED_IMAGE_CHEVRON_VIEW_BOX).toBe("0 0 20 21");
    expect(CODEX_GENERATED_IMAGE_CHEVRON_PATH).toBe("M4.75 8l5.25 5.25L15.25 8");
  });
});

const timedNameFormat = (time: string) => `图片 ${time}`;

describe("generated image names", () => {
  const format = timedNameFormat;
  it("names an image by its turn's time, numbered when the turn made several", () => {
    const createdAt = new Date(2026, 10, 11, 12, 44, 5).toISOString();
    expect(
      generatedImageTimedName({ createdAt, index: 0, count: 1, locale: "zh-CN", format }),
    ).toBe("图片 12:44");
    expect(
      generatedImageTimedName({ createdAt, index: 1, count: 3, locale: "zh-CN", format }),
    ).toBe("图片 12:44 (2)");
  });
  it("has no name without a usable time, so the caller falls back", () => {
    expect(
      generatedImageTimedName({ createdAt: "", index: 0, count: 1, locale: "zh-CN", format }),
    ).toBeNull();
    expect(
      generatedImageTimedName({
        createdAt: "not a date",
        index: 0,
        count: 1,
        locale: "zh-CN",
        format,
      }),
    ).toBeNull();
  });
});

describe("generated image display names", () => {
  const createdAt = new Date(2026, 10, 11, 12, 44, 5).toISOString();
  const base = {
    createdAt,
    index: 0,
    count: 1,
    locale: "zh-CN",
    format: timedNameFormat,
    fallback: "生成的图片",
  };
  it("keeps a real file name", () => {
    expect(generatedImageDisplayName({ ...base, path: "/tmp/out/generated-preview-one.png" })).toBe(
      "generated-preview-one.png",
    );
  });
  it("names a Moss media address by its time, never by the address", () => {
    expect(
      generatedImageDisplayName({
        ...base,
        path: `/api/moss/media/assets/moss_abc/0?accountScope=${"a".repeat(64)}`,
      }),
    ).toBe("图片 12:44");
  });
});
