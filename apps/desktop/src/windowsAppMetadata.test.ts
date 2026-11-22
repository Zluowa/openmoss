import { describe, expect, it, vi } from "vitest";

import {
  createWindowsAppMetadataResolver,
  formatWindowsAppDisplayName,
  isGenericWindowsHostExecutable,
} from "./windowsAppMetadata";

describe("isGenericWindowsHostExecutable", () => {
  it("recognizes ApplicationFrameHost across bare, extension, and full-path forms", () => {
    expect(isGenericWindowsHostExecutable("ApplicationFrameHost")).toBe(true);
    expect(isGenericWindowsHostExecutable("applicationframehost.exe")).toBe(true);
    expect(
      isGenericWindowsHostExecutable(String.raw`C:\Windows\System32\ApplicationFrameHost.exe`),
    ).toBe(true);
    expect(isGenericWindowsHostExecutable("chrome.exe")).toBe(false);
    expect(isGenericWindowsHostExecutable(null)).toBe(false);
  });
});

describe("formatWindowsAppDisplayName", () => {
  it("prefers non-generic PE FileDescription over ProductName and raw executable name", () => {
    expect(
      formatWindowsAppDisplayName({
        rawAppName: "chrome.exe",
        fileDescription: "Google Chrome",
        productName: "Chromium",
        executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
      }),
    ).toBe("Google Chrome");
  });

  it("ignores noisy generic Windows or Electron FileVersionInfo strings", () => {
    expect(
      formatWindowsAppDisplayName({
        rawAppName: "explorer.exe",
        fileDescription: null,
        productName: "Microsoft® Windows® Operating System",
        executablePath: String.raw`C:\Windows\explorer.exe`,
      }),
    ).toBe("File Explorer");

    expect(
      formatWindowsAppDisplayName({
        rawAppName: "Moss",
        fileDescription: "Electron",
        productName: "Electron",
      }),
    ).toBe("Moss");
  });

  it("derives the hosted app name from windowTitle for ApplicationFrameHost", () => {
    expect(
      formatWindowsAppDisplayName({
        rawAppName: "ApplicationFrameHost",
        windowTitle: "设置",
        executablePath: String.raw`C:\Windows\System32\ApplicationFrameHost.exe`,
      }),
    ).toBe("设置");

    expect(
      formatWindowsAppDisplayName({
        rawAppName: "ApplicationFrameHost.exe",
        windowTitle: "Notes.md \u200e- OneNote",
      }),
    ).toBe("OneNote");
  });

  it("formats UWP AUMIDs, curated executable stems, and preserves already-clean human names", () => {
    expect(
      formatWindowsAppDisplayName({
        rawAppName: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
      }),
    ).toBe("Windows Terminal");

    expect(
      formatWindowsAppDisplayName({
        rawAppName: "Microsoft.ScreenSketch_8wekyb3d8bbwe!App",
      }),
    ).toBe("Screen Sketch");

    expect(formatWindowsAppDisplayName({ rawAppName: "Antigravity.exe" })).toBe("Antigravity");
    expect(formatWindowsAppDisplayName({ rawAppName: "weixin.exe" })).toBe("微信");
    expect(formatWindowsAppDisplayName({ rawAppName: "Notepad" })).toBe("Notepad");
    expect(formatWindowsAppDisplayName({ rawAppName: "Chrome" })).toBe("Chrome");
    expect(formatWindowsAppDisplayName({ rawAppName: "微信" })).toBe("微信");
  });
});

describe("createWindowsAppMetadataResolver", () => {
  it("resolves PE names and cached icons, skips ApplicationFrameHost icons, and survives lookup errors", async () => {
    let clockMs = 1_000;
    const chromeIcon = "data:image/png;base64,Y2hyb21l";
    const mossIcon = "data:image/png;base64,bW9zcw==";

    let processQueryCalls = 0;
    const queryProcessMetadata = vi.fn(async (pids: readonly number[]) => {
      processQueryCalls += 1;
      const map = new Map<
        number,
        {
          executablePath: string | null;
          fileDescription: string | null;
          productName: string | null;
        }
      >();
      for (const pid of pids) {
        if (pid === 101 && processQueryCalls >= 2) {
          map.set(pid, {
            executablePath: String.raw`E:\Antigravity\Antigravity.exe`,
            fileDescription: "Antigravity",
            productName: "Antigravity",
          });
        } else if (pid === 101) {
          map.set(pid, {
            executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
            fileDescription: "Google Chrome",
            productName: "Google Chrome",
          });
        } else if (pid === 202) {
          // Simulates second Chrome process sharing the same exe path.
          map.set(pid, {
            executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
            fileDescription: "Google Chrome",
            productName: "Google Chrome",
          });
        } else if (pid === 303) {
          // Simulates process where MainModule threw AccessDenied so listApps provides launchPath.
          map.set(pid, {
            executablePath: null,
            fileDescription: null,
            productName: null,
          });
        }
      }
      return map;
    });

    const listApps = vi.fn(async () => [
      { pid: 303, name: "Moss", launchPath: String.raw`C:\Apps\Moss\Moss.exe` },
    ]);

    const getFileIcon = vi.fn(async (exePath: string) => {
      if (exePath.toLowerCase().endsWith("chrome.exe")) return chromeIcon;
      if (exePath.toLowerCase().endsWith("moss.exe")) return mossIcon;
      return null;
    });

    const resolver = createWindowsAppMetadataResolver({
      listApps,
      queryProcessMetadata,
      getFileIcon,
      now: () => clockMs,
    });

    const first = await resolver([
      {
        pid: 101,
        appName: "chrome.exe",
        bundleIdentifier: "chrome.exe",
        windowTitle: "New Tab",
      },
      {
        pid: 202,
        appName: "chrome.exe",
        bundleIdentifier: "chrome.exe",
        windowTitle: "Docs",
      },
      {
        pid: 303,
        appName: "Moss.exe",
        bundleIdentifier: null,
        windowTitle: "Moss",
      },
      {
        pid: 404,
        appName: "ApplicationFrameHost",
        bundleIdentifier: "ApplicationFrameHost.exe",
        windowTitle: "计算器",
      },
    ]);

    expect(first.get(101)).toEqual({
      displayName: "Google Chrome",
      iconDataUrl: chromeIcon,
      executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    });
    expect(first.get(202)?.iconDataUrl).toBe(chromeIcon);
    expect(first.get(303)).toEqual({
      displayName: "Moss",
      iconDataUrl: mossIcon,
      executablePath: String.raw`C:\Apps\Moss\Moss.exe`,
    });
    expect(first.get(404)).toEqual({
      displayName: "计算器",
      iconDataUrl: null,
    });

    // Chrome icon extracted only once even across pids 101 and 202; ApplicationFrameHost never icon-probed.
    expect(getFileIcon).toHaveBeenCalledTimes(2);
    expect(queryProcessMetadata).toHaveBeenCalledTimes(1);

    // Within 30s TTL: second call hits cache with zero extra lookups.
    clockMs += 5_000;
    const second = await resolver([
      {
        pid: 101,
        appName: "chrome.exe",
        bundleIdentifier: "chrome.exe",
        windowTitle: "Still Chrome",
      },
    ]);
    expect(second.get(101)?.displayName).toBe("Google Chrome");
    expect(queryProcessMetadata).toHaveBeenCalledTimes(1);
    expect(getFileIcon).toHaveBeenCalledTimes(2);

    // If PID is reused by another appName within TTL, cache invalidates immediately.
    const reused = await resolver([
      {
        pid: 101,
        appName: "antigravity.exe",
        bundleIdentifier: null,
        windowTitle: "Antigravity",
      },
    ]);
    expect(queryProcessMetadata).toHaveBeenCalledTimes(2);
    expect(reused.get(101)?.displayName).toBe("Antigravity");

    // Failing resolvers still yield clean curated names without throwing.
    const failingResolver = createWindowsAppMetadataResolver({
      listApps: async () => {
        throw new Error("listApps down");
      },
      queryProcessMetadata: async () => {
        throw new Error("ps failed");
      },
      getFileIcon: async () => {
        throw new Error("icon failed");
      },
    });
    const fallback = await failingResolver([
      {
        pid: 999,
        appName: "chrome.exe",
        bundleIdentifier: "chrome.exe",
        windowTitle: "Docs",
      },
    ]);
    expect(fallback.get(999)).toEqual({
      displayName: "Google Chrome",
      iconDataUrl: null,
    });
  });
});
