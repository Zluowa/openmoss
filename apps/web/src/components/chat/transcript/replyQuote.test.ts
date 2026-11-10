import { describe, expect, it } from "vitest";

import {
  buildReplyPrompt,
  parseReplyPrompt,
  REPLY_QUOTE_MAX_CHARS,
  stripReplyMarkers,
} from "./replyQuote";

describe("reply prompt format", () => {
  it("matches the desktop chat's wire format", () => {
    expect(buildReplyPrompt("first line\nsecond line", "  why? ")).toBe(
      "<!-- reply -->\n> first line\n> second line\n\nwhy?",
    );
  });

  it("round-trips, including numbered and repeated reply blocks", () => {
    expect(parseReplyPrompt(buildReplyPrompt("a\n\nb", "ok"))).toEqual({
      quotes: ["a\n\nb"],
      body: "ok",
    });
    expect(parseReplyPrompt("<!-- reply 1 -->\n> one\n\n<!-- reply 2 -->\n> two\n\nboth")).toEqual({
      quotes: ["one", "two"],
      body: "both",
    });
    expect(parseReplyPrompt("plain message")).toBeNull();
  });

  it("caps a long quote", () => {
    const prompt = buildReplyPrompt("x".repeat(REPLY_QUOTE_MAX_CHARS + 50), "hm");
    expect(parseReplyPrompt(prompt)?.quotes[0]?.length).toBe(REPLY_QUOTE_MAX_CHARS + 1);
  });
});

describe("stripReplyMarkers", () => {
  it("keeps the quote as Markdown and drops only the markers", () => {
    expect(stripReplyMarkers("<!-- reply -->\n> picked\n\nmy words")).toBe("> picked\n\nmy words");
    expect(stripReplyMarkers("<!-- reply 2 -->\n> one\n\na\n\n\n<!-- reply -->\n> two\n\nb")).toBe(
      "> one\n\na\n\n\n> two\n\nb",
    );
    expect(stripReplyMarkers("no reply here")).toBe("no reply here");
  });
});
