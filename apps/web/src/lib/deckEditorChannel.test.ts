import { describe, expect, it } from "vitest";

import { parseDeckEditorEvent } from "./deckEditorChannel";

describe("deck editor events", () => {
  it("reads the download options and the slide link request", () => {
    expect(
      parseDeckEditorEvent({
        event: "request-export",
        format: "html",
        slideIds: ["s1"],
        quality: "better",
      }),
    ).toEqual({ event: "request-export", format: "html", slideIds: ["s1"], quality: "better" });
    expect(
      parseDeckEditorEvent({ event: "request-export", format: "pptx", fonts: "basic" }),
    ).toEqual({
      event: "request-export",
      format: "pptx",
      fonts: "basic",
    });
    expect(
      parseDeckEditorEvent({
        event: "request-export",
        format: "pdf",
        quality: "huge",
        fonts: "comic",
      }),
    ).toEqual({ event: "request-export", format: "pdf" });
    expect(parseDeckEditorEvent({ event: "request-export", format: "exe" })).toBeNull();
    expect(
      parseDeckEditorEvent({ event: "copy-slide-link", slideId: "s1", slideNumber: 3 }),
    ).toEqual({
      event: "copy-slide-link",
      slideId: "s1",
      slideNumber: 3,
    });
    expect(
      parseDeckEditorEvent({ event: "copy-slide-link", slideId: "s1", slideNumber: 0 }),
    ).toBeNull();
  });
});
