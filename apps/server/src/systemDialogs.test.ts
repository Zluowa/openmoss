import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const execProcessFile = vi.hoisted(() =>
  vi.fn(
    (
      _command: string,
      _args: ReadonlyArray<string>,
      _options: { readonly timeout?: number; readonly signal?: AbortSignal },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, "/home/test/moss-app\n", "");
      return {};
    },
  ),
);

vi.mock("@moss/shared/processRuntime", () => ({ execProcessFile }));

import {
  detectFolderPickerSupport,
  FOLDER_PICKER_PROBE_TIMEOUT_MS,
  pickFolderNativeDialog,
  type SystemCommandExecutor,
} from "./systemDialogs";

afterEach(() => {
  execProcessFile.mockClear();
});

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
      expect.arrayContaining(["-STA", "-NoProfile", "-NonInteractive"]),
    );

    const dismissed = executorReturning({ code: 0, stdout: "" });
    await expect(
      Effect.runPromise(pickFolderNativeDialog({ platform: "win32", executor: dismissed })),
    ).resolves.toEqual({ path: null });
  });

  it("uses zenity on Linux and reports the picker unavailable when zenity is not installed", async () => {
    const picked = executorReturning({ code: 0, stdout: "/home/test/moss-app\n" });
    await expect(
      Effect.runPromise(pickFolderNativeDialog({ platform: "linux", executor: picked })),
    ).resolves.toEqual({ path: "/home/test/moss-app" });

    const missing: SystemCommandExecutor = vi.fn(async () => {
      throw ENOENT;
    });
    await expect(
      Effect.runPromise(pickFolderNativeDialog({ platform: "linux", executor: missing })),
    ).resolves.toEqual({ path: null, unavailable: true });
  });

  it("tells a cancelled picker apart from one that failed", async () => {
    const run = (platform: NodeJS.Platform, code: number, stderr = "") =>
      Effect.runPromise(
        pickFolderNativeDialog({ platform, executor: executorReturning({ code, stderr }) }),
      );

    // Cancels: nothing chosen, nothing wrong.
    await expect(run("darwin", 1, "execution error: User canceled. (-128)")).resolves.toEqual({
      path: null,
    });
    await expect(run("linux", 1)).resolves.toEqual({ path: null });
    await expect(run("win32", 0)).resolves.toEqual({ path: null });

    // Failures: the helper ran but could not show a picker.
    await expect(
      run("darwin", 1, "execution error: Not authorized to send Apple events. (-1743)"),
    ).resolves.toEqual({ path: null, unavailable: true });
    await expect(run("linux", 255, "cannot open display")).resolves.toEqual({
      path: null,
      unavailable: true,
    });
    await expect(run("win32", 1, "Exception calling ShowDialog")).resolves.toEqual({
      path: null,
      unavailable: true,
    });
  });

  it("reports unknown platforms as unavailable without spawning anything", async () => {
    const executor = executorReturning({ code: 0, stdout: "/should-not-run" });
    const result = await Effect.runPromise(
      pickFolderNativeDialog({ platform: "freebsd", executor }),
    );
    expect(result).toEqual({ path: null, unavailable: true });
    expect(executor).not.toHaveBeenCalled();
  });

  it("never puts a deadline on an open picker; only cancellation closes it", async () => {
    await expect(Effect.runPromise(pickFolderNativeDialog({ platform: "linux" }))).resolves.toEqual(
      { path: "/home/test/moss-app" },
    );
    expect(execProcessFile).toHaveBeenCalledOnce();
    const [command, , options] = execProcessFile.mock.calls[0]!;
    expect(command).toBe("zenity");
    expect(options.timeout).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
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

  it("bounds only the zenity availability probe", async () => {
    await expect(Effect.runPromise(detectFolderPickerSupport({ platform: "linux" }))).resolves.toBe(
      true,
    );
    expect(execProcessFile).toHaveBeenCalledWith(
      "zenity",
      ["--version"],
      expect.objectContaining({ timeout: FOLDER_PICKER_PROBE_TIMEOUT_MS }),
      expect.any(Function),
    );
  });

  it("is unsupported on unknown platforms", async () => {
    await expect(
      Effect.runPromise(detectFolderPickerSupport({ platform: "freebsd" })),
    ).resolves.toBe(false);
  });
});
