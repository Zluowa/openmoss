import { describe, expect, it } from "vitest";

import { localPreviewDownloadDisposition, resolveLocalPreviewByteRange } from "./localPreviewRange";

describe("local preview response metadata", () => {
  it("clamps large end/suffix values without losing integer precision", () => {
    expect(resolveLocalPreviewByteRange("bytes=2-999999999999999999999999", 8)).toEqual({
      kind: "partial",
      offset: 2,
      length: 6,
    });
    expect(resolveLocalPreviewByteRange("bytes=-999999999999999999999999", 8)).toEqual({
      kind: "partial",
      offset: 0,
      length: 8,
    });
    expect(resolveLocalPreviewByteRange("bytes=999999999999999999999999-", 8)).toEqual({
      kind: "unsatisfiable",
    });
  });

  it("does not put Unicode, quotes or control characters in the ASCII filename", () => {
    const header = localPreviewDownloadDisposition('季度 "report"\r\nX-Injected: yes\\.xlsx');
    expect(header).not.toMatch(/[\r\n]/u);
    expect(header).toMatch(
      /^attachment; filename="[\x20-\x21\x23-\x5b\x5d-\x7e]+"; filename\*=UTF-8''/u,
    );
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe(
      '季度 "report"\r\nX-Injected: yes\\.xlsx',
    );
  });
});
