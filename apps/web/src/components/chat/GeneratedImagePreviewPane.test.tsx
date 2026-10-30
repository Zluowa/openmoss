import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  GENERATED_IMAGE_PREVIEW_ICON_PATHS,
  GENERATED_IMAGE_PREVIEW_ICON_VIEW_BOX,
  GeneratedImagePreviewIcon,
} from "./GeneratedImagePreviewIcon";
import {
  resolveGeneratedImagePreviewArrowNavigation,
  resolveGeneratedImagePreviewTitle,
} from "./GeneratedImagePreviewPane";

const pane = {
  imagePreview: {
    images: [
      { id: "image-1", path: "/tmp/one.png", name: "one.png" },
      { id: "image-2", path: "/tmp/two.png", name: "two.png" },
    ],
    activeImageId: "image-1",
    cwd: "/tmp",
    conversationTitle: "A session",
    view: "single" as const,
  },
};

describe("GeneratedImagePreviewPane", () => {
  it("builds the Codex image number title from the active image", () => {
    expect(resolveGeneratedImagePreviewTitle(pane)).toBe("A session - Generated image 1");
    expect(
      resolveGeneratedImagePreviewTitle({
        imagePreview: { ...pane.imagePreview, activeImageId: "image-2" },
      }),
    ).toBe("A session - Generated image 2");
    expect(
      resolveGeneratedImagePreviewTitle(
        { imagePreview: { ...pane.imagePreview, conversationTitle: null } },
        (imageNumber) => `生成的图片 ${imageNumber}`,
      ),
    ).toBe("生成的图片 1");
  });

  it("moves within the snapshot without wrapping or hijacking editable targets", () => {
    const input = { imageIds: ["image-1", "image-2"], activeImageId: "image-1" };
    expect(resolveGeneratedImagePreviewArrowNavigation({ ...input, key: "ArrowDown" })).toBe(
      "image-2",
    );
    expect(resolveGeneratedImagePreviewArrowNavigation({ ...input, key: "ArrowUp" })).toBeNull();
    expect(
      resolveGeneratedImagePreviewArrowNavigation({ ...input, key: "ArrowDown", metaKey: true }),
    ).toBeNull();
    expect(
      resolveGeneratedImagePreviewArrowNavigation({ ...input, key: "ArrowDown", shiftKey: true }),
    ).toBeNull();
    expect(
      resolveGeneratedImagePreviewArrowNavigation({
        ...input,
        key: "ArrowDown",
        isEditableTarget: true,
      }),
    ).toBeNull();
  });
});

describe("GeneratedImagePreviewIcon", () => {
  it("keeps the exact 24px stroked Codex tab geometry", () => {
    const markup = renderToStaticMarkup(<GeneratedImagePreviewIcon />);
    expect(GENERATED_IMAGE_PREVIEW_ICON_VIEW_BOX).toBe("0 0 24 24");
    expect(markup).toContain('width="24"');
    expect(markup).toContain('height="24"');
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('fill="none"');
    for (const path of GENERATED_IMAGE_PREVIEW_ICON_PATHS) {
      expect(markup).toContain(`d="${path}"`);
    }
    expect(markup.match(/stroke="currentColor"/g)).toHaveLength(3);
    expect(markup.match(/stroke-width="2"/g)).toHaveLength(3);
    expect(markup).toContain('stroke-linecap="round"');
    expect(markup).toContain('stroke-linejoin="round"');
  });
});
