import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UnsupportedFilePreview } from "./UnsupportedFilePreview";

describe("UnsupportedFilePreview", () => {
  it("renders an actionable archive download card", () => {
    const markup = renderToStaticMarkup(
      <UnsupportedFilePreview
        filePath="exports/snapshot.zip"
        cwd="/workspace/project"
        cacheKey={2}
      />,
    );

    expect(markup).toContain('data-file-preview="unsupported"');
    expect(markup).toContain("Preview not available");
    expect(markup).toContain("snapshot.zip");
    expect(markup).toContain("This file type can be downloaded");
    expect(markup).toContain('download="snapshot.zip"');
    expect(markup).toContain("/api/local-image?path=exports%2Fsnapshot.zip");
    expect(markup).toContain("download=1");
  });
});
