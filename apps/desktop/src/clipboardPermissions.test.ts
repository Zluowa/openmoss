import { describe, expect, it, vi } from "vitest";
import {
  MOSS_BETA_DESKTOP_ORIGIN,
  MOSS_CANARY_DESKTOP_ORIGIN,
  MOSS_CUA_DESKTOP_ORIGIN,
  MOSS_DESKTOP_ORIGIN,
} from "@moss/shared/desktopIdentity";

import { isClipboardWritePermission, writeMainWindowThreadId } from "./clipboardPermissions";

describe("native thread ID copy", () => {
  const entry = MOSS_DESKTOP_ORIGIN + "/index.html";
  function invoke(
    options: {
      url?: string;
      entry?: string;
      foreign?: boolean;
      subframe?: boolean;
      destroyed?: boolean;
      id?: unknown;
    } = {},
  ) {
    const frame = { url: options.url ?? (options.entry ?? entry) + "#/thread/another" };
    const main = { isDestroyed: () => !!options.destroyed, mainFrame: frame };
    const event = {
      sender: options.foreign ? {} : main,
      senderFrame: options.subframe ? { ...frame } : frame,
    };
    const write = vi.fn();
    return {
      write,
      run: () =>
        writeMainWindowThreadId(
          event as never,
          main as never,
          options.entry ?? entry,
          options.id ?? "selected-thread",
          write,
        ),
    };
  }
  it("copies the selected ID exactly from the live main shell after the menu closes", () => {
    const check = invoke();
    check.run();
    expect(check.write.mock.calls).toEqual([["selected-thread"]]);
  });
  it.each([
    { foreign: true },
    { subframe: true },
    { destroyed: true },
    { url: "https://example.com/index.html" },
    { entry: "https://example.com/index.html" },
    { url: "moss://other/index.html" },
    { url: MOSS_DESKTOP_ORIGIN + "/guest.html" },
    { url: "about:blank" },
    { id: "codex://threads/selected-thread" },
    { id: "first\nsecond" },
    { id: "x".repeat(1025) },
  ])("denies an invalid source or value before touching the system clipboard", (options) => {
    const check = invoke(options);
    expect(check.run).toThrow();
    expect(check.write).not.toHaveBeenCalled();
  });
});

const requester = (url = "https://example.com/page", focused = true, destroyed = false) => ({
  getURL: () => url,
  isFocused: () => focused,
  isDestroyed: () => destroyed,
});
describe("clipboard permissions", () => {
  it.each([
    "https://example.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("allows foreground copy buttons on %s", (url) => {
    expect(
      isClipboardWritePermission(
        requester(url),
        "clipboard-sanitized-write",
        { isMainFrame: true, requestingUrl: url, embeddingOrigin: new URL(url).origin },
        url,
      ),
    ).toBe(true);
  });
  it.each([
    MOSS_DESKTOP_ORIGIN,
    MOSS_CANARY_DESKTOP_ORIGIN,
    MOSS_CUA_DESKTOP_ORIGIN,
    MOSS_BETA_DESKTOP_ORIGIN,
  ])("allows foreground copy buttons on the %s desktop origin", (origin) => {
    const url = `${origin}/index.html`;
    expect(
      isClipboardWritePermission(
        requester(url),
        "clipboard-sanitized-write",
        { isMainFrame: true, requestingUrl: url, embeddingOrigin: origin },
        origin,
      ),
    ).toBe(true);
  });
  it.each(["clipboard-read", "deprecated-sync-clipboard-read", "media", "unknown"])(
    "does not grant %s",
    (permission) => {
      expect(isClipboardWritePermission(requester(), permission, {})).toBe(false);
    },
  );
  it("leaves document focus to Chromium but rejects destroyed, insecure and foreign-frame requests", () => {
    for (const source of [
      null,
      requester(undefined, true, true),
      requester("http://example.com"),
      requester("file:///tmp/page.html"),
      requester("bad-url"),
    ])
      expect(isClipboardWritePermission(source, "clipboard-sanitized-write", {})).toBe(false);
    for (const details of [
      { isMainFrame: false },
      { embeddingOrigin: "https://other.test" },
      { requestingUrl: "https://other.test" },
      { requestingUrl: "invalid" },
    ])
      expect(isClipboardWritePermission(requester(), "clipboard-sanitized-write", details)).toBe(
        false,
      );
    expect(
      isClipboardWritePermission(
        requester(),
        "clipboard-sanitized-write",
        {},
        "https://other.test",
      ),
    ).toBe(false);
    expect(isClipboardWritePermission(requester(), "clipboard-sanitized-write", {})).toBe(true);
    expect(
      isClipboardWritePermission(requester(undefined, false), "clipboard-sanitized-write", {}),
    ).toBe(true);
  });
});
