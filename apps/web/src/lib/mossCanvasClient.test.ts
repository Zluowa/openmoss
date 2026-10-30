// @vitest-environment happy-dom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  importMossCanvasLocalImages,
  loadMossCanvasBinding,
  type MossCanvasBinding,
  type MossCanvasImageImportCache,
} from "./mossCanvasClient";

const mocks = vi.hoisted(() => ({
  read: vi.fn<
    (input: {
      image: { src: string; name?: string };
      resolveImageUrl?: () => string;
      fetchCredentials?: string;
    }) => Promise<File>
  >(),
  json: vi.fn<(path: string, init: RequestInit) => Promise<unknown>>(),
}));
vi.mock("./generatedImageContextMenu", () => ({ readGeneratedImageContextFile: mocks.read }));
vi.mock("./mossImagesClient", () => ({ readMossImagesJson: mocks.json }));
vi.mock("./wsHttpUrl", () => ({ resolveWsHttpUrl: (path: string) => `https://moss.test${path}` }));
const binding: MossCanvasBinding = {
  expectedAccount: { id: "account-a", realm: "memfire-phone" },
  expectedWorkspace: { threadId: "thread-a", fingerprint: "a".repeat(64) },
};
const assetId = `moss-canvas-asset:${"b".repeat(64)}.png`;
const image = (id: string) => ({ id, path: `/workspace/${id}.png`, name: `${id}.png` });
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  mocks.read
    .mockReset()
    .mockImplementation(
      async (input) =>
        new File(["image-bytes"], input.image.name || "image.png", { type: "image/png" }),
    );
  mocks.json.mockReset().mockResolvedValue({ result: { url: assetId } });
});
afterEach(() => vi.unstubAllGlobals());

describe("conversation Canvas local image imports", () => {
  it("imports histories larger than one frame batch and caches by binding, identity and path", async () => {
    const cache: MossCanvasImageImportCache = new Map();
    const images = Array.from({ length: 35 }, (_, index) => image(`image-${index}`));
    const input = { images, activeImageId: images[34]!.id, binding, cache, isCurrent: () => true };
    const first = await importMossCanvasLocalImages(input);
    expect(first.items).toHaveLength(35);
    expect(first.unavailable).toEqual([]);
    expect(mocks.read).toHaveBeenCalledTimes(35);
    expect(mocks.json).toHaveBeenCalledTimes(35);
    await importMossCanvasLocalImages(input);
    expect(mocks.read).toHaveBeenCalledTimes(35);
    await importMossCanvasLocalImages({ ...input, images: [...images, image("new")] });
    expect(mocks.read).toHaveBeenCalledTimes(36);
    await importMossCanvasLocalImages({
      ...input,
      images: [image("image-0")],
      activeImageId: "image-0",
      binding: { ...binding, expectedAccount: { ...binding.expectedAccount, id: "account-b" } },
    });
    expect(mocks.read).toHaveBeenCalledTimes(37);
    await importMossCanvasLocalImages({
      ...input,
      images: [{ ...image("image-0"), path: "/workspace/replaced.png" }],
      activeImageId: "image-0",
    });
    expect(mocks.read).toHaveBeenCalledTimes(38);
    for (const [path, request] of mocks.json.mock.calls) {
      expect(path).toContain("/canvas/storage?");
      expect(JSON.parse(String(request.body))).toMatchObject({
        method: "workspace.importAssetBytes",
      });
      expect(path).not.toContain("generate");
    }
  });

  it("isolates unavailable history but rejects an unreadable selected image", async () => {
    const cache: MossCanvasImageImportCache = new Map();
    mocks.read.mockImplementation(async ({ image: value }) => {
      if (value.src.includes("missing")) throw new Error("file missing");
      return new File(["bytes"], "image.png", { type: "image/png" });
    });
    const input = {
      images: [image("selected"), image("missing")],
      activeImageId: "selected",
      binding,
      cache,
      isCurrent: () => true,
    };
    const result = await importMossCanvasLocalImages(input);
    expect(result.items.map((item) => item.sourceId)).toEqual(["selected"]);
    expect(result.unavailable).toEqual(["missing"]);
    await importMossCanvasLocalImages(input);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await expect(
      importMossCanvasLocalImages({ ...input, activeImageId: "missing" }),
    ).rejects.toThrow("当前选中的图片无法读取");
    expect(mocks.read).toHaveBeenCalledTimes(3);
    expect(mocks.json).toHaveBeenCalledTimes(1);
  });

  it("does not hide storage or owner failures as missing historical files", async () => {
    mocks.json.mockRejectedValue(new Error("account changed"));
    await expect(
      importMossCanvasLocalImages({
        images: [image("old"), image("selected")],
        activeImageId: "selected",
        binding,
        isCurrent: () => true,
      }),
    ).rejects.toThrow("account changed");
    expect(mocks.json).toHaveBeenCalledTimes(1);
  });

  it("discards a file read after cancellation before any storage mutation", async () => {
    let current = true;
    mocks.read.mockImplementation(async () => {
      current = false;
      return new File(["bytes"], "image.png", { type: "image/png" });
    });
    await expect(
      importMossCanvasLocalImages({
        images: [image("selected")],
        activeImageId: "selected",
        binding,
        isCurrent: () => current,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.json).not.toHaveBeenCalled();
  });

  it("reuses a validated owned variant without uploading it again", async () => {
    const variant = { id: `canvas:${assetId}`, path: "", name: "edited.png", assetId };
    const result = await importMossCanvasLocalImages({
      images: [variant],
      activeImageId: variant.id,
      binding,
      isCurrent: () => true,
    });
    expect(result.items[0]).toMatchObject({ sourceId: variant.id, assetId, title: "edited.png" });
    expect(mocks.json).not.toHaveBeenCalled();
    const request = mocks.read.mock.calls[0]![0];
    expect(request.fetchCredentials).toBe("include");
    expect(request.resolveImageUrl?.()).toContain("canvasAccount=account-a");
    expect(request.resolveImageUrl?.()).toContain("canvasWorkspace=" + "a".repeat(64));
    await expect(
      importMossCanvasLocalImages({
        images: [{ ...variant, assetId: "https://untrusted.test/image.png" }],
        binding,
        isCurrent: () => true,
      }),
    ).rejects.toThrow("画布图片引用无效");
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("does not cache an upload result after its owner changes", async () => {
    const cache: MossCanvasImageImportCache = new Map();
    let current = true;
    mocks.json.mockImplementation(async () => {
      current = false;
      return { result: { url: assetId } };
    });
    await expect(
      importMossCanvasLocalImages({
        images: [image("selected")],
        activeImageId: "selected",
        binding,
        cache,
        isCurrent: () => current,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.size).toBe(0);
    expect(mocks.json).toHaveBeenCalledTimes(1);
  });

  it("rejects a binding for another conversation", async () => {
    mocks.json.mockResolvedValue({
      authenticated: true,
      user: { id: "account-a" },
      realm: "memfire-phone",
      workspace: { threadId: "wrong", fingerprint: "a".repeat(64) },
    });
    await expect(loadMossCanvasBinding("thread-a")).rejects.toThrow("会话或账号已变化");
  });

  it("accepts only a bounded authenticated owner and forwards cancellation to the binding reader", async () => {
    const response = {
      authenticated: true,
      user: { id: "account-a" },
      realm: "memfire-phone",
      workspace: { threadId: "thread-a", fingerprint: "a".repeat(64) },
    };
    const controller = new AbortController();
    mocks.json.mockResolvedValue(response);
    expect(await loadMossCanvasBinding("thread-a", controller.signal)).toEqual(binding);
    expect(mocks.json).toHaveBeenLastCalledWith(
      "/api/moss/media/canvas/account?canvasThread=thread-a",
      { method: "GET", signal: controller.signal },
    );
    for (const patch of [
      { authenticated: false },
      { user: { id: "" } },
      { user: { id: "a".repeat(257) } },
      { realm: "" },
      { realm: "a".repeat(129) },
      { workspace: { ...response.workspace, fingerprint: "invalid" } },
    ]) {
      mocks.json.mockResolvedValue({ ...response, ...patch });
      await expect(loadMossCanvasBinding("thread-a")).rejects.toThrow("会话或账号已变化");
    }
  });
});
