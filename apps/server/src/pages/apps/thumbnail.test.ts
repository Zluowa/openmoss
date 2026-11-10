// FILE: thumbnail.test.ts
// Purpose: Reject disguised documents and excessive thumbnail sizes.
// Layer: Server tests

import { describe, expect, it } from "vitest";

import { validPageAppThumbnail } from "./thumbnail";

// Same real 1x1 JPEG used by FakeComputerBackend, independent of platform codecs.
const thumbnailFixture =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKwA//9k=";

describe("app thumbnail bytes", () => {
  it("accepts a bounded JPEG", () => expect(validPageAppThumbnail(thumbnailFixture)).toBe(true));
  it.each(["<svg xmlns='http://www.w3.org/2000/svg'></svg>", "<html>not a picture</html>"])(
    "rejects disguised executable content",
    (content) => {
      expect(
        validPageAppThumbnail(`data:image/jpeg;base64,${Buffer.from(content).toString("base64")}`),
      ).toBe(false);
    },
  );
  it("rejects oversized pixels even when the encoded bytes are small", () => {
    const bytes = Buffer.from(thumbnailFixture.slice(23), "base64");
    const start = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    bytes.writeUInt16BE(40_000, start + 5);
    expect(validPageAppThumbnail(`data:image/jpeg;base64,${bytes.toString("base64")}`)).toBe(false);
  });
  it("rejects oversized and truncated data", () => {
    expect(validPageAppThumbnail(`data:image/jpeg;base64,${"A".repeat(200_004)}`)).toBe(false);
    expect(validPageAppThumbnail(thumbnailFixture.slice(0, -8))).toBe(false);
  });
});
