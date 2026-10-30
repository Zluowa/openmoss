import { afterEach, describe, expect, it, vi } from "vitest";
import { outboundHttp } from "@synara/shared/outboundHttp";
import { cacheMossCanvasRemoteAsset } from "./mossCanvasStorage";

afterEach(() => vi.restoreAllMocks());

function storage() {
  return {
    request: vi.fn(async () => ({ url: "moss-canvas-asset:fixture.png" })),
    readAsset: vi.fn(),
    readKnowledgeAsset: vi.fn(),
    close: vi.fn(),
  };
}

describe("Canvas imports of existing Moss outputs", () => {
  it("copies account-owned output bytes without another HTTP or supplier request", async () => {
    const store = storage();
    const read = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      asset: { contentType: "image/png" },
    }));
    const network = vi.spyOn(outboundHttp, "request");
    for (const url of [
      "/api/moss/media/assets/moss_existing/0",
      "http://127.0.0.1:12345/api/moss/media/assets/moss_existing/0?token=fixture",
    ]) {
      await cacheMossCanvasRemoteAsset(store, { url }, read);
    }
    expect(read).toHaveBeenNthCalledWith(1, "moss_existing", 0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.request).toHaveBeenCalledWith("workspace.importAssetBytes", {
      bytesBase64: "AQID",
      mimeType: "image/png",
      fileName: "canvas-output",
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("does not retry an unavailable or cross-account output", async () => {
    const store = storage();
    const read = vi.fn(async () => {
      throw new Error("not owned by the current account");
    });
    const network = vi.spyOn(outboundHttp, "request");
    await expect(
      cacheMossCanvasRemoteAsset(store, { url: "/api/moss/media/assets/moss_other/0" }, read),
    ).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    expect(store.request).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS remote URLs without forwarding authentication", async () => {
    const store = storage();
    const network = vi.spyOn(outboundHttp, "request");
    for (const url of [
      "http://external.example/image.png",
      "file:///tmp/image.png",
      "https://user:password@external.example/image.png",
    ]) {
      await expect(cacheMossCanvasRemoteAsset(store, { url })).rejects.toMatchObject({
        code: "canvas_asset_url_invalid",
      });
    }
    expect(network).not.toHaveBeenCalled();
  });
});
