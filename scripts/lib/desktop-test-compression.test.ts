import { describe, expect, it } from "vitest";

import { TEST_COMPRESSION_ENV, testCompressionFor } from "./desktop-test-compression.ts";

describe("testCompressionFor", () => {
  it("keeps electron-builder's default unless a build-only run asks for a level", () => {
    expect(testCompressionFor("build-only", {})).toBeUndefined();
    expect(testCompressionFor("publish", {})).toBeUndefined();
    expect(testCompressionFor("build-only", { [TEST_COMPRESSION_ENV]: " store " })).toBe("store");
    expect(testCompressionFor("build-only", { [TEST_COMPRESSION_ENV]: "maximum" })).toBe("maximum");
  });

  it("refuses a level for a publish build and an unknown level", () => {
    expect(() => testCompressionFor("publish", { [TEST_COMPRESSION_ENV]: "store" })).toThrow(
      "build-only test builds",
    );
    expect(() => testCompressionFor("build-only", { [TEST_COMPRESSION_ENV]: "fast" })).toThrow(
      "must be one of store, normal, maximum",
    );
  });
});
