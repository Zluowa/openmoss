// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MossLibraryItem } from "~/components/MossLibrarySurface.logic";

const calls = vi.hoisted(() => ({ grant: vi.fn(), normalize: vi.fn(), copy: vi.fn() }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({ projects: { createLocalFilePreviewGrant: calls.grant } }),
}));
vi.mock("./desktopClipboard", () => ({ copyPngBlobToDesktopClipboard: calls.copy }));
vi.mock("./generatedImageContextMenu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./generatedImageContextMenu")>()),
  normalizeImageToPng: calls.normalize,
}));
import { downloadMossLibraryItem, shareMossLibraryImage } from "./mossLibraryAssetActions";

const item: MossLibraryItem = {
  id: "owned-image",
  title: "original.jpg",
  kind: "image",
  sourceCli: "moss",
  path: "D:/synthetic-library/original.jpg",
  updatedAt: 1,
  favorite: false,
  sectionIds: ["images"],
  subtitleZh: "图片",
  thumbnailUrl: "https://thumbnail.invalid/resized-64px.jpg",
};
const current = () => true;
let saved: Blob[];
let filenames: string[];
let click: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  saved = [];
  filenames = [];
  calls.grant.mockResolvedValue({ grant: "synthetic-preview-grant" });
  calls.normalize.mockResolvedValue(new Blob(["normalized png"], { type: "image/png" }));
  calls.copy.mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Uint8Array([1, 3, 7, 9]), {
          headers: { "content-type": "image/jpeg" },
        }),
    ),
  );
  vi.stubGlobal("ClipboardItem", undefined);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      getWsUrl: () => "ws://127.0.0.1:43210",
      clipboard: { writeImagePngDataUrl: vi.fn() },
    },
  });
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    saved.push(blob as Blob);
    return "blob:synthetic-original";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      filenames.push(this.download);
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.desktopBridge;
});

describe("Library original asset actions", () => {
  it("downloads unchanged original bytes through a fresh grant, ignoring a smaller remote thumbnail", async () => {
    await downloadMossLibraryItem(item, current);
    expect(calls.grant).toHaveBeenCalledExactlyOnceWith({ path: item.path });
    const url = new URL(vi.mocked(fetch).mock.calls[0]![0] as string);
    expect(url.origin).toBe("http://127.0.0.1:43210");
    expect(url.pathname).toBe("/api/local-image");
    expect(url.searchParams.get("path")).toBe(item.path);
    expect(url.searchParams.get("grant")).toBe("synthetic-preview-grant");
    expect(url.searchParams.get("download")).toBe("1");
    expect([...new Uint8Array(await saved[0]!.arrayBuffer())]).toEqual([1, 3, 7, 9]);
    expect(filenames).toEqual(["original.jpg"]);
    expect(click).toHaveBeenCalledTimes(1);
  });
  it("reads owned media bytes without a local-file grant or a thumbnail request", async () => {
    await downloadMossLibraryItem(
      { ...item, mediaJobId: "moss_synthetic", mediaImageIndex: 2 },
      current,
    );
    expect(new URL(vi.mocked(fetch).mock.calls[0]![0] as string).pathname).toBe(
      "/api/moss/media/assets/moss_synthetic/2",
    );
    expect(calls.grant).not.toHaveBeenCalled();
  });
  it("downloads renamed generated media under its Chinese Library title instead of the asset hash", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(new Uint8Array([1, 3, 7, 9]), {
        headers: {
          "content-type": "image/png",
          "Content-Disposition": 'attachment; filename="asset-hash.png"',
        },
      }),
    );
    await downloadMossLibraryItem(
      { ...item, title: "夜景终稿.png", mediaJobId: "moss_synthetic", mediaImageIndex: 2 },
      current,
    );
    expect(filenames).toEqual(["夜景终稿.png"]);
    expect([...new Uint8Array(await saved[0]!.arrayBuffer())]).toEqual([1, 3, 7, 9]);
    expect(calls.normalize).not.toHaveBeenCalled();
    expect(calls.grant).not.toHaveBeenCalled();
  });
  it("downloads a display-renamed scanned file without changing its original path or bytes", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("# Original document", {
        headers: {
          "content-type": "text/markdown",
          "Content-Disposition": 'attachment; filename="original.md"',
        },
      }),
    );
    await downloadMossLibraryItem(
      { ...item, kind: "document", path: "D:/synthetic-library/original.md", title: "设计审阅.md" },
      current,
    );
    expect(calls.grant).toHaveBeenCalledExactlyOnceWith({
      path: "D:/synthetic-library/original.md",
    });
    const url = new URL(vi.mocked(fetch).mock.calls[0]![0] as string);
    expect(url.searchParams.get("path")).toBe("D:/synthetic-library/original.md");
    expect(filenames).toEqual(["设计审阅.md"]);
    expect(await saved[0]!.text()).toBe("# Original document");
    expect(calls.normalize).not.toHaveBeenCalled();
  });
  it("retains the renamed extension when the original response has no filename header", async () => {
    await downloadMossLibraryItem({ ...item, title: "评审图片.jpg" }, current);
    expect(filenames).toEqual(["评审图片.jpg"]);
    expect([...new Uint8Array(await saved[0]!.arrayBuffer())]).toEqual([1, 3, 7, 9]);
  });
  it("normalizes the real image and waits for native PNG clipboard acknowledgement", async () => {
    await shareMossLibraryImage([item], current);
    expect([
      ...new Uint8Array(await (calls.normalize.mock.calls[0]![0] as Blob).arrayBuffer()),
    ]).toEqual([1, 3, 7, 9]);
    expect(calls.copy).toHaveBeenCalledWith(await calls.normalize.mock.results[0]!.value, current);
  });
  it("writes an actual PNG ClipboardItem when no native writer is available", async () => {
    delete window.desktopBridge;
    const write = vi.fn(async (_items: readonly unknown[]) => undefined);
    vi.stubGlobal("navigator", { clipboard: { write } });
    class TestClipboardItem {
      constructor(readonly values: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    await shareMossLibraryImage([item], current);
    expect(write.mock.calls[0]?.[0]).toEqual([
      new TestClipboardItem({
        "image/png": await calls.normalize.mock.results[0]!.value,
      }),
    ]);
    expect(calls.copy).not.toHaveBeenCalled();
  });
  it("does not claim a rejected clipboard write or failed asset read succeeded", async () => {
    calls.copy.mockResolvedValue(false);
    await expect(shareMossLibraryImage([item], current)).rejects.toThrow("未能复制");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(downloadMossLibraryItem(item, current)).rejects.toThrow("503");
    expect(click).not.toHaveBeenCalled();
  });
  it("rejects multiple images and non-images before reading any bytes", async () => {
    await expect(shareMossLibraryImage([item, item], current)).rejects.toThrow("一张图片");
    await expect(shareMossLibraryImage([{ ...item, kind: "document" }], current)).rejects.toThrow(
      "一张图片",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("stops after an account change during grant loading, before file read or clipboard IPC", async () => {
    let active = true;
    calls.grant.mockImplementationOnce(async () => {
      active = false;
      return { grant: "old" };
    });
    await expect(shareMossLibraryImage([item], () => active)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(calls.copy).not.toHaveBeenCalled();
  });
});
