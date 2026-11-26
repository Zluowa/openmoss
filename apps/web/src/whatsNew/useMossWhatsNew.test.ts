// FILE: whatsNew/useMossWhatsNew.test.ts
// Purpose: Unit tests for post-update top-right "What's new" visibility & seen-version persistence.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MOSS_WHATS_NEW_HEADER_STORAGE_KEY,
  openMossWhatsNewDialog,
  resetMossWhatsNewHeaderStore,
  setMossWhatsNewDialogOpen,
  shouldShowMossWhatsNewButton,
} from "./useMossWhatsNew";

describe("shouldShowMossWhatsNewButton", () => {
  it("shows for an unseen version that has bundled release notes", () => {
    expect(
      shouldShowMossWhatsNewButton({
        currentVersion: "1.0.18",
        lastSeenVersion: null,
      }),
    ).toBe(true);
    expect(
      shouldShowMossWhatsNewButton({
        currentVersion: "1.0.18",
        lastSeenVersion: "1.0.17",
      }),
    ).toBe(true);
  });

  it("hides once the current version (or a newer one) has been seen", () => {
    expect(
      shouldShowMossWhatsNewButton({
        currentVersion: "1.0.18",
        lastSeenVersion: "1.0.18",
      }),
    ).toBe(false);
    expect(
      shouldShowMossWhatsNewButton({
        currentVersion: "1.0.17",
        lastSeenVersion: "1.0.18",
      }),
    ).toBe(false);
  });

  it("hides when the installed version has no release notes", () => {
    expect(
      shouldShowMossWhatsNewButton({
        currentVersion: "0.0.0",
        lastSeenVersion: null,
      }),
    ).toBe(false);
    expect(
      shouldShowMossWhatsNewButton({
        currentVersion: "1.0.99",
        lastSeenVersion: "1.0.17",
      }),
    ).toBe(false);
  });
});

describe("Moss WhatsNew header store persistence", () => {
  const storage = new Map<string, string>();
  const originalWindow = globalThis.window;

  beforeEach(() => {
    storage.clear();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => {
            storage.set(key, value);
          },
          removeItem: (key: string) => {
            storage.delete(key);
          },
        },
      },
    });
    resetMossWhatsNewHeaderStore();
  });

  afterEach(() => {
    resetMossWhatsNewHeaderStore();
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("marks the running version seen when opened and stays hidden after closing", () => {
    openMossWhatsNewDialog("1.0.17");
    expect(JSON.parse(storage.get(MOSS_WHATS_NEW_HEADER_STORAGE_KEY) ?? "null")).toEqual({
      lastSeenVersion: "1.0.17",
    });
    setMossWhatsNewDialogOpen(false, "1.0.17");
    expect(
      shouldShowMossWhatsNewButton({
        currentVersion: "1.0.17",
        lastSeenVersion: "1.0.17",
      }),
    ).toBe(false);
  });
});
