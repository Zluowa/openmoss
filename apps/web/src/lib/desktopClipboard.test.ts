// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { copyPngBlobToDesktopClipboard } from "./desktopClipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.desktopBridge;
});
it("rechecks the owner after FileReader finishes and before writing the native clipboard", async () => {
  const write = vi.fn(async () => true);
  let active = true;
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      clipboard: { writeImagePngDataUrl: write },
    },
  });
  class DelayedFileReader {
    result = "data:image/png;base64,c3ludGhldGlj";
    onload?: () => void;
    readAsDataURL() {
      queueMicrotask(() => {
        active = false;
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("FileReader", DelayedFileReader);
  expect(
    await copyPngBlobToDesktopClipboard(
      new Blob(["synthetic"], { type: "image/png" }),
      () => active,
    ),
  ).toBe(false);
  expect(write).not.toHaveBeenCalled();
});
it("returns the actual native acknowledgement for an unchanged owner", async () => {
  const write = vi.fn(async () => true);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      clipboard: { writeImagePngDataUrl: write },
    },
  });
  expect(await copyPngBlobToDesktopClipboard(new Blob(["synthetic"], { type: "image/png" }))).toBe(
    true,
  );
  expect(write).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/u));
});
