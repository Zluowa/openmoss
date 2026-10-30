import { describe, expect, it } from "vitest";

import { codexPreviewKind, shouldEmbedCodexHtml } from "./codexPreviewClassifier";

describe("codexPreviewKind", () => {
  it.each([
    ["photo.PNG", undefined, "image"],
    ["report.pdf", "application/pdf", "pdf"],
    ["index.html", "text/html; charset=utf-8", "html"],
    ["README.md", undefined, "markdown"],
    ["data.csv", "text/csv", "artifact"],
    ["notes.docx", undefined, "artifact"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "artifact"],
    ["main.ts", undefined, "text"],
    ["archive.zip", "application/zip", "unsupported"],
  ])("classifies %s as %s", (name, mime, expected) => {
    expect(codexPreviewKind(name, mime)).toBe(expected);
  });

  it("uses the Codex five megabyte HTML gate at the renderer boundary", () => {
    expect(codexPreviewKind("page.html", "text/html")).toBe("html");
    expect(shouldEmbedCodexHtml(5_000_000)).toBe(true);
    expect(shouldEmbedCodexHtml(5_000_001)).toBe(false);
  });
});
