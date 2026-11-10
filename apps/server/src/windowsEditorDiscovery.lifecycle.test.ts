// Background editor discovery must never keep the server process alive: no timer outlives a
// settled read, and stopping kills a registry read in flight (regression: #395 held the
// backend open ~10 s after its shutdown request).
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: readonly string[],
      options: { readonly signal?: AbortSignal },
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      // A read that only ends when it is aborted, like a slow PowerShell run.
      options.signal?.addEventListener("abort", () => callback(new Error("aborted"), ""));
      return {};
    },
  ),
);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

const discovery = await import("./windowsEditorDiscovery");

afterEach(() => {
  discovery.stopWindowsInstalledAppsDiscovery();
  vi.useRealTimers();
  execFileMock.mockClear();
});

describe("Windows editor discovery lifecycle", () => {
  it("stopping kills the registry read in flight and settles every waiter", async () => {
    const env = { USERPROFILE: "C:\\Users\\ada" } as NodeJS.ProcessEnv;
    const background = discovery.refreshWindowsInstalledApps({ env, platform: "win32" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const signal = execFileMock.mock.calls[0]![2].signal!;
    expect(signal.aborted).toBe(false);

    discovery.stopWindowsInstalledAppsDiscovery();

    expect(signal.aborted).toBe(true);
    await expect(background).resolves.toBeUndefined();
  });

  it("a bounded wait leaves no timer behind once the read settles", async () => {
    vi.useFakeTimers();
    const env = { USERPROFILE: "C:\\Users\\ada" } as NodeJS.ProcessEnv;
    const waiting = discovery.refreshWindowsInstalledApps({
      env,
      platform: "win32",
      waitMs: 1_500,
    });
    expect(vi.getTimerCount()).toBe(1);
    discovery.stopWindowsInstalledAppsDiscovery();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starting the read in the background sets no timer at all", () => {
    vi.useFakeTimers();
    const env = { USERPROFILE: "C:\\Users\\ada" } as NodeJS.ProcessEnv;
    void discovery.refreshWindowsInstalledApps({ env, platform: "win32" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
