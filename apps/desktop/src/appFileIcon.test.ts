import { describe, expect, it, vi } from "vitest";

import { isReadableAppIconPath, readAppFileIconDataUrl } from "./appFileIcon";

const NOTEPAD = String.raw`C:\Windows\System32\notepad.exe`;

describe("appFileIcon", () => {
  it("reads only absolute app paths", () => {
    expect(isReadableAppIconPath(NOTEPAD, "win32")).toBe(true);
    expect(isReadableAppIconPath(String.raw`C:\Users\me\secret.txt`, "win32")).toBe(false);
    expect(isReadableAppIconPath("notepad.exe", "win32")).toBe(false);
    expect(isReadableAppIconPath("/Applications/Notes.app", "darwin")).toBe(true);
    expect(isReadableAppIconPath("/etc/passwd", "darwin")).toBe(false);
    expect(isReadableAppIconPath("/usr/bin/app", "linux")).toBe(false);
    expect(isReadableAppIconPath(42, "win32")).toBe(false);
  });

  it("never touches the disk for a refused path, and caches a read icon", async () => {
    const getFileIcon = vi.fn(async () => ({ isEmpty: () => false, toDataURL: () => "data:x" }));
    await expect(
      readAppFileIconDataUrl(String.raw`C:\a.txt`, getFileIcon, "win32"),
    ).resolves.toBeNull();
    expect(getFileIcon).not.toHaveBeenCalled();
    const app = String.raw`C:\Apps\b.exe`;
    await expect(readAppFileIconDataUrl(app, getFileIcon, "win32")).resolves.toBe("data:x");
    await expect(readAppFileIconDataUrl(app, getFileIcon, "win32")).resolves.toBe("data:x");
    expect(getFileIcon).toHaveBeenCalledTimes(1);
  });
});
