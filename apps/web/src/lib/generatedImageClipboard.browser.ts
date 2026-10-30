import { afterEach, expect, it, vi } from "vitest";
import type { NativeApi } from "@synara/contracts";

const harness = vi.hoisted(() => ({
  showContextMenu: vi.fn(async () => "copy-image"),
  toast: vi.fn(),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

import { showGeneratedImageContextMenu } from "./generatedImageContextMenu";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  harness.toast.mockClear();
});

it("copies exact PNG pixels without waiting for renderer canvas idle encoding", async () => {
  vi.stubGlobal("nativeApi", {
    contextMenu: { show: harness.showContextMenu },
  } as unknown as NativeApi);
  vi.stubGlobal("desktopBridge", undefined);
  const source = document.createElement("canvas");
  source.width = 2;
  source.height = 2;
  const sourceContext = source.getContext("2d")!;
  sourceContext.putImageData(
    new ImageData(
      new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 0, 0, 255, 255, 255, 255]),
      2,
      2,
    ),
    0,
    0,
  );
  const expectedPixels = [...sourceContext.getImageData(0, 0, 2, 2).data];
  const sourceUrl = source.toDataURL("image/png");
  const copied: ClipboardItem[] = [];
  vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
    copied.push(...items);
  });

  // Reproduce a renderer that never gets an idle encoding slot. Fetch,
  // decoding, the worker, PNG encoding and the ClipboardItem stay real.
  let pendingRendererEncode: BlobCallback | undefined;
  const rendererEncode = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback) => {
      pendingRendererEncode = callback;
    });
  const copy = showGeneratedImageContextMenu({
    image: { src: "/generated/transparent.png" },
    resolveImageUrl: () => sourceUrl,
    position: { x: 0, y: 0 },
    allowBrowserClipboard: true,
    labels: {
      addToChat: "Add to chat",
      copyImage: "Copy image",
      showInFileManager: "Show in folder",
      downloadCopy: "Download a copy",
      addToChatError: "Could not add image",
      copyError: "Could not copy image",
      showInFileManagerError: "Could not show image",
      downloadError: "Could not download image",
    },
  });
  try {
    await vi.waitFor(() => expect(copied).toHaveLength(1));
    await copy;
    expect(rendererEncode).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
    const png = await copied[0]!.getType("image/png");
    expect(png.type).toBe("image/png");
    const bitmap = await createImageBitmap(png);
    try {
      expect([bitmap.width, bitmap.height]).toEqual([2, 2]);
      sourceContext.clearRect(0, 0, 2, 2);
      sourceContext.drawImage(bitmap, 0, 0);
      expect([...sourceContext.getImageData(0, 0, 2, 2).data]).toEqual(expectedPixels);
    } finally {
      bitmap.close();
    }
  } finally {
    pendingRendererEncode?.(null);
    await copy;
    source.width = 0;
    source.height = 0;
  }
});
