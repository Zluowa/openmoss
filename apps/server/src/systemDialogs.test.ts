import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  detectFolderPickerSupport,
  pickFolderNativeDialog,
  type SystemCommandExecutor,
} from "./systemDialogs";

function executorReturning(result: {
  code: number;
  stdout?: string;
  stderr?: string;
}): SystemCommandExecutor {
  return vi.fn(async () => ({
    code: result.code,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }));
}

const ENOENT = Object.assign(new Error("spawn zenity ENOENT"), { code: "ENOENT" });

describe("pickFolderNativeDialog", () => {
  it("returns the picked folder on macOS, stripping the trailing slash and newline", async () => {
    const executor = executorReturning({ code: 0, stdout: "/Users/test/Developer/moss-app/\n" });
    const result = await Effect.runPromise(
      pickFolderNativeDialog({ platform: "darwin", executor }),
    );
    expect(result).toEqual({ path: "/Users/test/Developer/moss-app" });
    expect(executor).toHaveBeenCalledWith("osascript", ["-e", "POSIX path of (choose folder)"]);
  });

  it("maps a macOS cancel (exit code 1) to null instead of an error", async () => {
    const executor = executorReturning({ code: 1, stderr: "User canceled. (-128)" });
    const result = await Effect.runPromise(
      pickFolderNativeDialog({ platform: "darwin", executor }),
    );
    expect(result).toEqual({ path: null });
  });

  it("returns the selected path on Windows and null when the dialog is dismissed", async () => {
    const picked = executorReturning({ code: 0, stdout: "C:\\Users\\test\\moss-app" });
    await expect(
      Effect.runPromise(pickFolderNativeDialog({ platform: "win32", executor: picked })),
    ).resolves.toEqual({ path: "C:\\Users\\test\\moss-app" });
    expect(picked).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining(["-NoProfile", "-NonInteractive"]),
    );

    const dismissed = executorReturning({ code: 0, stdout: "" });
    await expect(
      Effect.runPromise(pickFolderNativeDialog({ platform: "win32", executor: dismissed })),
    ).resolves.toEqual({ path: null });
  });

  it("uses zenity on Linux and degrades to null when zenity is not installed", async () => {
    const picked = executorReturning({ code: 0, stdout: "/home/test/moss-app\n" });
    await expect(
      Effect.runPromise(pickFolderNativeDialog({ platform: "linux", executor: picked })),
    ).resolves.toEqual({ path: "/home/test/moss-app" });

    const missing: SystemCommandExecutor = vi.fn(async () => {
      throw ENOENT;
    });
    await expect(
      Effect.runPromise(pickFolderNativeDialog({ platform: "linux", executor: missing })),
    ).resolves.toEqual({ path: null });
  });

  it("returns null on unknown platforms without spawning anything", async () => {
    const executor = executorReturning({ code: 0, stdout: "/should-not-run" });
    const result = await Effect.runPromise(
      pickFolderNativeDialog({ platform: "freebsd", executor }),
    );
    expect(result).toEqual({ path: null });
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("detectFolderPickerSupport", () => {
  it("is supported on macOS and Windows without probing", async () => {
    const executor = executorReturning({ code: 0 });
    await expect(
      Effect.runPromise(detectFolderPickerSupport({ platform: "darwin", executor })),
    ).resolves.toBe(true);
    await expect(
      Effect.runPromise(detectFolderPickerSupport({ platform: "win32", executor })),
    ).resolves.toBe(true);
    expect(executor).not.toHaveBeenCalled();
  });

  it("on Linux depends on zenity being installed", async () => {
    await expect(
      Effect.runPromise(
        detectFolderPickerSupport({ platform: "linux", executor: executorReturning({ code: 0 }) }),
      ),
    ).resolves.toBe(true);

    const missing: SystemCommandExecutor = vi.fn(async () => {
      throw ENOENT;
    });
    await expect(
      Effect.runPromise(detectFolderPickerSupport({ platform: "linux", executor: missing })),
    ).resolves.toBe(false);
  });

  it("is unsupported on unknown platforms", async () => {
    await expect(
      Effect.runPromise(detectFolderPickerSupport({ platform: "freebsd" })),
    ).resolves.toBe(false);
  });
});
