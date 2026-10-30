import {
  closeSync,
  constants,
  fsyncSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isMacAppBundlePath,
  sameFileIdentity,
  supportsPosixPermissions,
  syncDirectoryEntry,
  syncDirectoryEntrySync,
  syncRegularFile,
} from "./filesystemPlatform";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
  };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

let root: string;

beforeEach(() => {
  vi.mocked(openSync).mockReset().mockImplementation(actualFs.openSync);
  vi.mocked(fsyncSync).mockReset().mockImplementation(actualFs.fsyncSync);
  vi.mocked(closeSync).mockReset().mockImplementation(actualFs.closeSync);
  root = mkdtempSync(path.join(tmpdir(), "moss-filesystem-platform-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("filesystemPlatform", () => {
  it("keeps POSIX permission behavior out of Windows", () => {
    expect(supportsPosixPermissions("win32")).toBe(false);
    expect(supportsPosixPermissions("linux")).toBe(true);
    expect(supportsPosixPermissions("darwin")).toBe(true);
  });

  it("treats directory fsync as unsupported on Windows", async () => {
    await expect(syncDirectoryEntry(path.join(root, "missing"), "win32")).resolves.toBeUndefined();
    expect(() => syncDirectoryEntrySync(path.join(root, "missing"), "win32")).not.toThrow();
    expect(openSync).not.toHaveBeenCalled();
  });

  it("flushes POSIX directory entries without following a symlink", () => {
    vi.mocked(openSync).mockReturnValueOnce(123);
    vi.mocked(fsyncSync).mockImplementationOnce(() => {});
    vi.mocked(closeSync).mockImplementationOnce(() => {});

    syncDirectoryEntrySync(root, "linux");

    expect(openSync).toHaveBeenCalledWith(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    expect(fsyncSync).toHaveBeenCalledWith(123);
    expect(closeSync).toHaveBeenCalledWith(123);
  });

  it.each(["EINVAL", "ENOTSUP", "EBADF"])(
    "accepts the same unsupported POSIX directory flush error as the async helper: %s",
    (code) => {
      vi.mocked(openSync).mockReturnValueOnce(123);
      vi.mocked(fsyncSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("unsupported directory flush"), { code });
      });
      vi.mocked(closeSync).mockImplementationOnce(() => {});

      expect(() => syncDirectoryEntrySync(root, "linux")).not.toThrow();
      expect(closeSync).toHaveBeenCalledWith(123);
    },
  );

  it.each(["EIO", "EPERM", "EACCES"])(
    "preserves a real POSIX directory flush failure and closes its descriptor: %s",
    (code) => {
      const error = Object.assign(new Error("directory flush failed"), { code });
      vi.mocked(openSync).mockReturnValueOnce(123);
      vi.mocked(fsyncSync).mockImplementationOnce(() => {
        throw error;
      });
      vi.mocked(closeSync).mockImplementationOnce(() => {});

      expect(() => syncDirectoryEntrySync(root, "linux")).toThrow(error);
      expect(closeSync).toHaveBeenCalledWith(123);
    },
  );

  it("does not suppress a directory open failure on POSIX", () => {
    const error = Object.assign(new Error("directory open failed"), { code: "EPERM" });
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw error;
    });
    expect(() => syncDirectoryEntrySync(root, "linux")).toThrow(error);
    expect(closeSync).not.toHaveBeenCalled();
  });

  it("flushes an app-created regular file through a writable handle", async () => {
    const filePath = path.join(root, "state.sqlite.partial");
    writeFileSync(filePath, "snapshot");

    await expect(syncRegularFile(filePath, process.platform)).resolves.toBeUndefined();
  });

  it("recognizes macOS app bundles without catching dotted folders", () => {
    expect(isMacAppBundlePath("/Users/me/Fake Report.app", "darwin")).toBe(true);
    expect(isMacAppBundlePath("/Users/me/Old Build.APP", "darwin")).toBe(true);
    expect(isMacAppBundlePath("/Users/me/code/next.js", "darwin")).toBe(false);
    expect(isMacAppBundlePath("/home/me/Fake Report.app", "linux")).toBe(false);
  });

  it("uses inode identity on POSIX and the documented Windows path-guard fallback", () => {
    const leftPath = path.join(root, "left");
    const rightPath = path.join(root, "right");
    writeFileSync(leftPath, "left");
    writeFileSync(rightPath, "right");
    const left = statSync(leftPath);
    const same = statSync(leftPath);
    const right = statSync(rightPath);

    expect(sameFileIdentity(left, same, "linux")).toBe(true);
    expect(sameFileIdentity(left, right, "linux")).toBe(false);
    expect(sameFileIdentity(left, right, "win32")).toBe(true);
  });
});
