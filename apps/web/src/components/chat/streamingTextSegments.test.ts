import { describe, expect, it } from "vitest";

import { streamingTextSegments } from "./streamingTextSegments";

describe("streamingTextSegments", () => {
  it("keeps spaces and punctuation on the preceding ASCII word", () => {
    expect(streamingTextSegments("  Hello, world!\n42")).toEqual([
      "  ",
      "Hello, ",
      "world!\n",
      "42",
    ]);
    expect(streamingTextSegments("file_name.ts")).toEqual(["file_", "name.", "ts"]);
  });

  it.each([
    "",
    "\n \t",
    "思考中，正在工作。",
    "Hello 👩‍💻 café!",
    "e\u0301 👨‍👩‍👧‍👦",
    "שלום עולם",
    "مرحبا بالعالم",
  ])("preserves text and UTF-16 offsets for %j", (text) => {
    const segments = streamingTextSegments(text);
    expect(segments.join("")).toBe(text);
    expect(segments.every((segment) => segment.length > 0)).toBe(true);
    expect(segments.some((segment) => /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(segment))).toBe(
      false,
    );
  });
});
