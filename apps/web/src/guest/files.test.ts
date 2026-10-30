import { describe, expect, it } from "vitest";

import { formatFileSize, guestFilesProblem } from "./files";

const file = (type: string, size = 1) => ({ type, size });

describe("guestFilesProblem", () => {
  it("takes up to four files and 10 MB, with images in the types the owner's agent takes", () => {
    expect(guestFilesProblem([])).toBeNull();
    expect(guestFilesProblem([file("image/png"), file("application/pdf"), file("")])).toBeNull();
    expect(
      guestFilesProblem([file("image/JPEG"), file("image/webp"), file("image/gif")]),
    ).toBeNull();
    expect(guestFilesProblem([1, 2, 3, 4, 5].map(() => file("image/png")))).toBe("too_many_files");
    expect(guestFilesProblem([file("image/png", 10 * 1024 * 1024 + 1)])).toBe("too_large");
    expect(
      guestFilesProblem([file("text/plain", 6 * 1024 * 1024), file("text/plain", 5 * 1024 * 1024)]),
    ).toBe("too_large");
    expect(guestFilesProblem([file("image/svg+xml")])).toBe("unsupported_file");
    expect(guestFilesProblem([file("image/heic")])).toBe("unsupported_file");
    expect(guestFilesProblem([file("text/plain", 0)])).toBe("unsupported_file");
  });

  it("reports the count problem before the size one", () => {
    expect(guestFilesProblem([1, 2, 3, 4, 5].map(() => file("image/png", 3 * 1024 * 1024)))).toBe(
      "too_many_files",
    );
  });
});

describe("formatFileSize", () => {
  it("rounds to a readable unit", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(182_400)).toBe("178 KB");
    expect(formatFileSize(1.25 * 1024 * 1024)).toBe("1.3 MB");
    expect(formatFileSize(10 * 1024 * 1024)).toBe("10 MB");
  });
});
