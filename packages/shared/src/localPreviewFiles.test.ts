import { describe, expect, it } from "vitest";

import {
  isSupportedLocalArchivePath,
  isSupportedLocalPreviewFilePath,
  isSupportedLocalImagePath,
  isSupportedLocalTextPath,
  isSupportedLocalArtifactPath,
} from "./localPreviewFiles";

describe("local preview file allowlists", () => {
  it.each(["sample.zip", "bundle.tar.gz", "snapshot.tgz", "backup.rar", "data.7z"])(
    "recognizes %s as an archive download",
    (filePath) => {
      expect(isSupportedLocalArchivePath(filePath)).toBe(true);
      expect(isSupportedLocalPreviewFilePath(filePath)).toBe(true);
    },
  );

  it.each(["notes.md", "audio.mp3", "page.html", "unknown.bin"])(
    "does not classify %s as an archive",
    (filePath) => {
      expect(isSupportedLocalArchivePath(filePath)).toBe(false);
    },
  );

  it("keeps the image allowlist image-only", () => {
    expect(isSupportedLocalImagePath("image.png")).toBe(true);
    expect(isSupportedLocalImagePath("archive.zip")).toBe(false);
  });

  it("recognizes markdown as an authenticated local preview target", () => {
    expect(isSupportedLocalTextPath("sample.md")).toBe(true);
    expect(isSupportedLocalPreviewFilePath("sample.md")).toBe(true);
  });

  it.each(["sample.docx", "sample.xlsx", "sample.pptx", "sample.csv", "sample.tsv"])(
    "recognizes %s as an authenticated artifact target",
    (filePath) => {
      expect(isSupportedLocalArtifactPath(filePath)).toBe(true);
      expect(isSupportedLocalPreviewFilePath(filePath)).toBe(true);
    },
  );
});
