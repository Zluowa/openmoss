import { describe, expect, it } from "vitest";

import {
  shouldOpenGeneratedImageInCanvas,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";

function generatedPreview(initialView?: "playground"): ExpandedImagePreview {
  return {
    images: [{ src: "http://127.0.0.1:1/api/local-image?path=a.png", name: "a.png" }],
    index: 0,
    generated: {
      kind: "generated-image",
      groupId: "group-1",
      createdAt: null,
      images: [{ id: "image-1", path: "a.png", name: "a.png" }],
      activeImageId: "image-1",
      index: 0,
      cwd: undefined,
      ...(initialView ? { initialView } : {}),
    },
  };
}

describe("shouldOpenGeneratedImageInCanvas", () => {
  it("zooms a clicked generated image in the lightbox", () => {
    expect(shouldOpenGeneratedImageInCanvas(generatedPreview())).toBe(false);
  });

  it("opens the Canvas only from the 画布 chip", () => {
    expect(shouldOpenGeneratedImageInCanvas(generatedPreview("playground"))).toBe(true);
  });

  it("keeps ordinary images in the lightbox", () => {
    expect(
      shouldOpenGeneratedImageInCanvas({ images: [{ src: "x.png", name: "x.png" }], index: 0 }),
    ).toBe(false);
  });
});
