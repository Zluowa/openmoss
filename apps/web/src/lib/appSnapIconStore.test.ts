import { afterEach, describe, expect, it } from "vitest";

import {
  clearAppSnapIconMemoryCacheForTests,
  peekCachedAppSnapIcon,
  persistAppSnapIcon,
  readAppSnapIcon,
  selectAppSnapIconEvictionKeys,
} from "./appSnapIconStore";

afterEach(() => {
  clearAppSnapIconMemoryCacheForTests();
});

describe("AppSnap icon cache guards", () => {
  it("evicts the oldest icons once the cache exceeds its cap", () => {
    const entries = Array.from({ length: 102 }, (_, index) => ({
      bundleIdentifier: `dev.moss.test-${index}`,
      updatedAt: index,
    }));

    expect(selectAppSnapIconEvictionKeys(entries)).toEqual(["dev.moss.test-0", "dev.moss.test-1"]);
  });

  it("ignores invalid cache inputs before opening IndexedDB", async () => {
    await expect(
      persistAppSnapIcon({
        bundleIdentifier: "",
        dataUrl: "https://example.com/icon.png",
      }),
    ).resolves.toBeUndefined();
    await expect(readAppSnapIcon("")).resolves.toBeNull();
    expect(peekCachedAppSnapIcon("")).toBeUndefined();
  });

  it("populates the in-memory icon cache on persist so subsequent reads avoid IndexedDB", async () => {
    const iconDataUrl = "data:image/png;base64,iVBORw0KGgo=";
    // In Node without IndexedDB, persistAppSnapIcon rejects after caching in memory;
    // verify the memory cache is populated synchronously before DB I/O completes.
    await persistAppSnapIcon({
      bundleIdentifier: "chrome.exe",
      dataUrl: iconDataUrl,
    }).catch(() => undefined);

    expect(peekCachedAppSnapIcon("chrome.exe")).toBe(iconDataUrl);
    await expect(readAppSnapIcon("chrome.exe")).resolves.toBe(iconDataUrl);
  });
});
