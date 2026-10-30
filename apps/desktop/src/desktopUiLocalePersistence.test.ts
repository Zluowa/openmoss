// FILE: desktopUiLocalePersistence.test.ts
// Purpose: Locks ordered locale persistence and retry behavior.

import { describe, expect, it, vi } from "vitest";

import { DesktopUiLocalePersistenceCoordinator } from "./desktopUiLocalePersistence";

function deferred(): {
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
} {
  let reject!: (error: Error) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("DesktopUiLocalePersistenceCoordinator", () => {
  it("serializes rapid locale writes so the last request wins", async () => {
    const englishWrite = deferred();
    const persistedLocales: string[] = [];
    const persistLocale = vi.fn(async (locale: "en" | "zh-CN") => {
      if (locale === "en") await englishWrite.promise;
      persistedLocales.push(locale);
    });
    const onDisplayLocaleChange = vi.fn();
    const coordinator = new DesktopUiLocalePersistenceCoordinator({
      initialLocale: "zh-CN",
      onDisplayLocaleChange,
      persistLocale,
    });

    const persistEnglish = coordinator.update("en");
    const persistChinese = coordinator.update("zh-CN");
    await Promise.resolve();

    expect(persistLocale).toHaveBeenCalledTimes(1);
    expect(persistLocale).toHaveBeenLastCalledWith("en");
    expect(onDisplayLocaleChange.mock.calls).toEqual([["en"], ["zh-CN"]]);

    englishWrite.resolve();
    await Promise.all([persistEnglish, persistChinese]);

    expect(persistLocale.mock.calls).toEqual([["en"], ["zh-CN"]]);
    expect(persistedLocales).toEqual(["en", "zh-CN"]);
  });

  it("retries persistence after failure without rebuilding an unchanged menu", async () => {
    const persistenceError = new Error("disk unavailable");
    const persistLocale = vi
      .fn<(locale: "en" | "zh-CN") => Promise<void>>()
      .mockRejectedValueOnce(persistenceError)
      .mockResolvedValue(undefined);
    const onDisplayLocaleChange = vi.fn();
    const coordinator = new DesktopUiLocalePersistenceCoordinator({
      initialLocale: "zh-CN",
      onDisplayLocaleChange,
      persistLocale,
    });

    await expect(coordinator.update("zh-CN")).rejects.toBe(persistenceError);
    await expect(coordinator.update("zh-CN")).resolves.toBeUndefined();

    expect(persistLocale.mock.calls).toEqual([["zh-CN"], ["zh-CN"]]);
    expect(onDisplayLocaleChange).not.toHaveBeenCalled();
  });

  it("continues queued writes after a failed request and rebuilds only on display changes", async () => {
    const firstWrite = deferred();
    const persistLocale = vi
      .fn<(locale: "en" | "zh-CN") => Promise<void>>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(undefined);
    const onDisplayLocaleChange = vi.fn();
    const coordinator = new DesktopUiLocalePersistenceCoordinator({
      initialLocale: "zh-CN",
      onDisplayLocaleChange,
      persistLocale,
    });

    const failedEnglishWrite = coordinator.update("en");
    const successfulChineseWrite = coordinator.update("zh-CN");
    firstWrite.reject(new Error("write failed"));

    await expect(failedEnglishWrite).rejects.toThrow("write failed");
    await expect(successfulChineseWrite).resolves.toBeUndefined();

    expect(persistLocale.mock.calls).toEqual([["en"], ["zh-CN"]]);
    expect(onDisplayLocaleChange.mock.calls).toEqual([["en"], ["zh-CN"]]);
  });
});
