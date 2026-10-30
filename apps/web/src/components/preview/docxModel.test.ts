import { describe, expect, it } from "vitest";
import {
  clampDocxZoom,
  docxHasInvalidSymbols,
  docxHasRedlines,
  pinchDocxZoom,
  wheelDocxZoom,
} from "./docxModel";
import { formatAudioTime, mediaDuration } from "./audioTime";

describe("document and audio preview boundaries", () => {
  it("recognizes revisions nested in footnotes as well as document content", () => {
    expect(docxHasRedlines({ parts: [{ notes: [{ children: [{ type: "deletedText" }] }] }] })).toBe(
      true,
    );
    expect(
      docxHasRedlines({ parts: [{ body: { children: [{ type: "text", text: "deleted" }] } }] }),
    ).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.parts = [cyclic];
    expect(docxHasRedlines(cyclic)).toBe(false);
  });
  it("keeps the desktop zoom limits under wheel and pinch input", () => {
    expect(wheelDocxZoom(100, 10)).toBe(90);
    expect(wheelDocxZoom(100, -1000)).toBe(400);
    expect(wheelDocxZoom(100, 1000)).toBe(10);
    expect(pinchDocxZoom(75, 100, 200)).toBe(150);
    expect(pinchDocxZoom(75, 0, 200)).toBe(75);
    expect(clampDocxZoom(Number.NaN)).toBe(75);
  });
  it("rejects malformed Unicode symbols before the renderer constructs DOM nodes", () => {
    const documentWithSymbol = (char: string) => ({
      parts: [{ body: { children: [{ type: "symbol", char }] } }],
    });
    expect(docxHasInvalidSymbols(documentWithSymbol("D800"))).toBe(true);
    expect(docxHasInvalidSymbols(documentWithSymbol("110000"))).toBe(true);
    expect(docxHasInvalidSymbols(documentWithSymbol("1F600"))).toBe(false);
    expect(docxHasInvalidSymbols(documentWithSymbol("xyz"))).toBe(true);
  });
  it("formats long tracks without wrapping minutes and rejects indefinite metadata", () => {
    expect(formatAudioTime(3661.9)).toBe("61:01");
    expect(formatAudioTime(-1)).toBe("0:00");
    expect(mediaDuration(Infinity)).toBe(0);
    expect(mediaDuration(Number.NaN)).toBe(0);
  });
});
