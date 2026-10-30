import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deferred } from "../test/deferred";

const harness = vi.hoisted(() => ({
  clicked: null as string | null,
  copyPng: vi.fn(),
  download: vi.fn(),
  fetch: vi.fn(),
  showContextMenu: vi.fn(),
  showInFolder: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    contextMenu: { show: harness.showContextMenu },
  }),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

vi.mock("~/lib/desktopClipboard", () => ({
  copyPngBlobToDesktopClipboard: harness.copyPng,
}));

vi.mock("~/lib/browserDownload", () => ({
  downloadUrlAsBlob: harness.download,
}));

import {
  GENERATED_IMAGE_CONTEXT_ACTION_IDS,
  GENERATED_IMAGE_CONTEXT_MAX_IMPORT_BYTES,
  isGeneratedImageContextCopyEligible,
  isGeneratedImageFinderEligible,
  registerGeneratedImageContextMenuOwner,
  resolveGeneratedImageContextMenuItems,
  resolveGeneratedImageContextMenuOwner,
  showGeneratedImageContextMenu,
  type GeneratedImageContextLabels,
} from "./generatedImageContextMenu";

const labels: GeneratedImageContextLabels = {
  addToChat: "Add to chat",
  copyImage: "Copy image",
  showInFileManager: "Show in Finder",
  downloadCopy: "Download a copy",
  addToChatError: "Could not add generated image to chat",
  copyError: "Could not copy generated image",
  showInFileManagerError: "Could not show generated image in the file manager",
  downloadError: "Could not download generated image",
};

const image = {
  src: "/tmp/generated/output.png",
  cwd: "/tmp/project",
  name: "output.png",
};

function imageResponse(
  input: {
    readonly body?: BodyInit;
    readonly contentType?: string;
    readonly status?: number;
  } = {},
): Response {
  return new Response(input.body ?? new Blob(["png"], { type: input.contentType ?? "image/png" }), {
    status: input.status ?? 200,
    headers: { "content-type": input.contentType ?? "image/png" },
  });
}

async function realDesktopPngHelper(writer: (dataUrl: string) => Promise<boolean>) {
  const actual = await vi.importActual<typeof import("./desktopClipboard")>("./desktopClipboard");
  harness.copyPng.mockImplementation(actual.copyPngBlobToDesktopClipboard);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ width: 2, height: 2, close: vi.fn() }),
  );
  vi.stubGlobal("document", {
    createElement: vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(["png"], { type: "image/png" }))),
    })),
  });
  vi.stubGlobal("window", {
    desktopBridge: {
      getWsUrl: () => "ws://localhost:4321",
      clipboard: { writeImagePngDataUrl: writer },
    },
  });
  const started = deferred<void>();
  let finishRead: (() => void) | undefined;
  vi.stubGlobal(
    "FileReader",
    class {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL(blob: Blob) {
        expect(blob.type).toBe("image/png");
        finishRead = () => {
          this.result = "data:image/png;base64,cG5n";
          this.onload?.();
        };
        started.resolve();
      }
    },
  );
  return {
    started: started.promise,
    finishRead: () => {
      expect(finishRead).toBeTypeOf("function");
      finishRead!();
    },
  };
}

beforeEach(() => {
  harness.clicked = null;
  harness.copyPng.mockReset();
  harness.download.mockReset();
  harness.fetch.mockReset();
  harness.showContextMenu.mockReset();
  harness.showInFolder.mockReset();
  harness.toast.mockReset();
  harness.showContextMenu.mockImplementation(async () => harness.clicked);
  harness.copyPng.mockResolvedValue(true);
  harness.download.mockResolvedValue(undefined);
  harness.showInFolder.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", harness.fetch);
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("window", {
    desktopBridge: {
      getWsUrl: () => "ws://localhost:4321",
      shell: { showInFolder: harness.showInFolder },
      clipboard: { writeImagePngDataUrl: vi.fn() },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generated image context menu eligibility", () => {
  it("resolves and releases the exact owning-thread composer callback", () => {
    const handler = vi.fn();
    const release = registerGeneratedImageContextMenuOwner("thread-owner", handler);
    expect(resolveGeneratedImageContextMenuOwner("thread-owner")).toBe(handler);
    release();
    expect(resolveGeneratedImageContextMenuOwner("thread-owner")).toBeUndefined();
  });

  it("keeps the action order and hides desktop-only actions in a browser", () => {
    vi.stubGlobal("window", {});

    expect(resolveGeneratedImageContextMenuItems({ image, labels })).toEqual([
      { id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.addToChat, label: "Add to chat" },
      { id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.downloadCopy, label: "Download a copy" },
    ]);
    expect(isGeneratedImageContextCopyEligible()).toBe(false);
  });

  it("offers copy and Finder only for their narrow desktop capabilities", () => {
    expect(resolveGeneratedImageContextMenuItems({ image, labels })).toEqual([
      { id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.addToChat, label: "Add to chat" },
      { id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.copyImage, label: "Copy image" },
      { id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.showInFileManager, label: "Show in Finder" },
      { id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.downloadCopy, label: "Download a copy" },
    ]);
    expect(isGeneratedImageContextCopyEligible()).toBe(true);
    expect(isGeneratedImageFinderEligible("/tmp/generated/output.png")).toBe(true);
    expect(isGeneratedImageFinderEligible("./generated/output.png")).toBe(false);
  });

  it("hides Finder for a remote desktop backend even when the source is absolute", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getWsUrl: () => "wss://remote.example/ws?token=remote-token",
        shell: { showInFolder: harness.showInFolder },
        clipboard: { writeImagePngDataUrl: vi.fn() },
      },
    });

    expect(isGeneratedImageFinderEligible(image)).toBe(false);
    expect(resolveGeneratedImageContextMenuItems({ image, labels })).toEqual([
      { id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.addToChat, label: "Add to chat" },
      { id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.copyImage, label: "Copy image" },
      { id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.downloadCopy, label: "Download a copy" },
    ]);
  });

  it("fails closed for a malformed desktop backend URL", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getWsUrl: () => "not a websocket URL",
        shell: { showInFolder: harness.showInFolder },
        clipboard: { writeImagePngDataUrl: vi.fn() },
      },
    });

    expect(isGeneratedImageFinderEligible(image)).toBe(false);
  });

  it.each([
    "file:///tmp/generated/output.png",
    "https://remote.example/generated/output.png",
    "not a path",
    "//remote/share/generated/output.png",
  ])("fails closed for non-local generated image source %s", (src) => {
    expect(isGeneratedImageFinderEligible({ src, cwd: image.cwd })).toBe(false);
  });
});

describe("showGeneratedImageContextMenu", () => {
  it("uses the owning asset route and rejects an account change while its bytes load", async () => {
    harness.clicked = GENERATED_IMAGE_CONTEXT_ACTION_IDS.addToChat;
    let current = true;
    harness.fetch.mockImplementation(async () => {
      current = false;
      return imageResponse();
    });
    const add = vi.fn();
    await showGeneratedImageContextMenu({
      image,
      labels,
      position: { x: 0, y: 0 },
      resolveImageUrl: () => "https://moss.example/api/moss/media/assets/moss_a/0",
      isCurrent: () => current,
      onAddToChat: add,
    });
    expect(harness.fetch).toHaveBeenCalledWith(
      "https://moss.example/api/moss/media/assets/moss_a/0",
    );
    expect(add).not.toHaveBeenCalled();
  });

  it("does not run a workspace action after its owning tab is replaced", async () => {
    const open = vi.fn();
    let current = true;
    harness.showContextMenu.mockImplementation(async () => {
      current = false;
      return "open-images";
    });
    await showGeneratedImageContextMenu({
      image,
      labels,
      position: { x: 0, y: 0 },
      isCurrent: () => current,
      additionalActions: [
        { id: "open-images", label: "Open", errorLabel: "Failed", onSelect: open },
      ],
    });
    expect(open).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
  });
  it("fetches Add to chat through a bounded File and focuses the owning composer", async () => {
    harness.clicked = GENERATED_IMAGE_CONTEXT_ACTION_IDS.addToChat;
    harness.fetch.mockResolvedValue(imageResponse());
    const added: File[] = [];
    const focus = vi.fn();

    await showGeneratedImageContextMenu({
      image,
      labels,
      position: { x: 10, y: 20 },
      onAddToChat: (file) => {
        added.push(file);
      },
      onFocusComposer: focus,
    });

    expect(harness.fetch).toHaveBeenCalledWith(
      "http://localhost:4321/api/local-image?path=%2Ftmp%2Fgenerated%2Foutput.png&cwd=%2Ftmp%2Fproject",
    );
    expect(added).toHaveLength(1);
    expect(added[0]?.name).toBe("output.png");
    expect(added[0]?.type).toBe("image/png");
    expect(added[0]?.size).toBe(3);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("fails closed when the authenticated image response exceeds the import bound", async () => {
    harness.clicked = GENERATED_IMAGE_CONTEXT_ACTION_IDS.addToChat;
    const oversized = new Blob([new Uint8Array(GENERATED_IMAGE_CONTEXT_MAX_IMPORT_BYTES + 1)], {
      type: "image/png",
    });
    harness.fetch.mockResolvedValue(imageResponse({ body: oversized, contentType: "image/png" }));

    await showGeneratedImageContextMenu({
      image,
      labels,
      position: { x: 0, y: 0 },
      onAddToChat: vi.fn(),
    });

    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: labels.addToChatError }),
    );
  });

  it("normalizes Copy image through the renderer and the desktop PNG bridge", async () => {
    harness.clicked = GENERATED_IMAGE_CONTEXT_ACTION_IDS.copyImage;
    harness.fetch.mockResolvedValue(imageResponse({ contentType: "image/jpeg" }));
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 2, height: 2, close }));
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: vi.fn(() => ({ drawImage: vi.fn() })),
        toBlob: vi.fn((callback: BlobCallback) =>
          callback(new Blob(["png"], { type: "image/png" })),
        ),
      })),
    });

    await showGeneratedImageContextMenu({ image, labels, position: { x: 0, y: 0 } });

    expect(harness.copyPng).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image/png" }),
      expect.any(Function),
    );
    expect(harness.copyPng.mock.lastCall?.[1]()).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "guards the real deferred PNG read before the desktop write (owner invalidated=%s)",
    async (invalidate) => {
      harness.clicked = GENERATED_IMAGE_CONTEXT_ACTION_IDS.copyImage;
      harness.fetch.mockResolvedValue(imageResponse());
      const writer = vi.fn().mockResolvedValue(true);
      const read = await realDesktopPngHelper(writer);
      let current = true;
      const action = showGeneratedImageContextMenu({
        image,
        labels,
        position: { x: 0, y: 0 },
        isCurrent: () => current,
      });
      await read.started;
      expect(writer).not.toHaveBeenCalled();
      if (invalidate) current = false;
      read.finishRead();
      await action;
      if (invalidate) expect(writer).not.toHaveBeenCalled();
      else expect(writer).toHaveBeenCalledExactlyOnceWith("data:image/png;base64,cG5n");
      expect(harness.toast).not.toHaveBeenCalled();
    },
  );

  it.each([
    [false, "false"],
    [true, "false"],
    [false, "throw"],
    [true, "throw"],
  ] as const)(
    "handles a deferred real-helper writer failure (stale=%s, outcome=%s)",
    async (invalidate, outcome) => {
      harness.clicked = GENERATED_IMAGE_CONTEXT_ACTION_IDS.copyImage;
      harness.fetch.mockResolvedValue(imageResponse());
      const entered = deferred<void>();
      const completed = deferred<boolean>();
      const writer = vi.fn(() => {
        entered.resolve();
        return completed.promise;
      });
      const read = await realDesktopPngHelper(writer);
      let current = true;
      const action = showGeneratedImageContextMenu({
        image,
        labels,
        position: { x: 0, y: 0 },
        isCurrent: () => current,
      });
      await read.started;
      read.finishRead();
      await entered.promise;
      expect(writer).toHaveBeenCalledExactlyOnceWith("data:image/png;base64,cG5n");
      if (invalidate) current = false;
      if (outcome === "throw") completed.reject(new Error("deferred writer failure"));
      else completed.resolve(false);
      await action;
      if (invalidate) expect(harness.toast).not.toHaveBeenCalled();
      else
        expect(harness.toast).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ type: "error", title: labels.copyError }),
        );
    },
  );

  it("reports a localized error when the desktop PNG bridge rejects Copy image", async () => {
    harness.clicked = GENERATED_IMAGE_CONTEXT_ACTION_IDS.copyImage;
    harness.fetch.mockResolvedValue(imageResponse({ contentType: "image/jpeg" }));
    harness.copyPng.mockResolvedValue(false);
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 2, height: 2, close }));
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: vi.fn(() => ({ drawImage: vi.fn() })),
        toBlob: vi.fn((callback: BlobCallback) =>
          callback(new Blob(["png"], { type: "image/png" })),
        ),
      })),
    });

    await showGeneratedImageContextMenu({ image, labels, position: { x: 0, y: 0 } });

    expect(harness.copyPng).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: labels.copyError }),
    );
  });

  it("reports Finder bridge failures and never calls the browser shell fallback", async () => {
    harness.clicked = GENERATED_IMAGE_CONTEXT_ACTION_IDS.showInFileManager;
    harness.showInFolder.mockRejectedValue(new Error("Folder not found"));

    await showGeneratedImageContextMenu({ image, labels, position: { x: 0, y: 0 } });

    expect(harness.showInFolder).toHaveBeenCalledWith(image.src);
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: labels.showInFileManagerError }),
    );
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it("keeps failed downloads inside the app and reports the localized error", async () => {
    harness.clicked = GENERATED_IMAGE_CONTEXT_ACTION_IDS.downloadCopy;
    harness.download.mockRejectedValue(new Error("HTTP 404"));

    await showGeneratedImageContextMenu({ image, labels, position: { x: 30, y: 40 } });

    expect(harness.download).toHaveBeenCalledWith({
      url: "http://localhost:4321/api/local-image?path=%2Ftmp%2Fgenerated%2Foutput.png&cwd=%2Ftmp%2Fproject&download=1",
      filename: "output.png",
    });
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: labels.downloadError }),
    );
  });
});
