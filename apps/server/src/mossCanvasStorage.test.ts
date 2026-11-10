import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outboundHttp } from "@moss/shared/outboundHttp";
import { cacheMossCanvasRemoteAsset, mossCanvasStorageFor } from "./mossCanvasStorage";

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
  it.runIf(process.platform === "win32")(
    "opens the Canvas SQLite store inside a long Windows chat path",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "moss-long-chat-"));
      const bundle = join(root, "bundle");
      const module = join(bundle, "apps/codex-canvas/server");
      const cwd = join(
        root,
        "long-profile".repeat(5),
        "Documents/Moss/2026-11-06",
        "long-thread".repeat(4),
      );
      try {
        await mkdir(module, { recursive: true });
        await mkdir(cwd, { recursive: true });
        await writeFile(
          join(module, "hosted-storage.mjs"),
          `
        import { DatabaseSync } from "node:sqlite";
        import { join } from "node:path";
        export function createMossCanvasHostedStorage({ stateDirectory }) {
          const db = new DatabaseSync(join(stateDirectory, "canvas.sqlite"));
          db.exec("create table canvas (id integer)");
          return { close: () => db.close() };
        }`,
        );
        vi.stubEnv("MOSS_CANVAS_BUNDLE_DIR", bundle);
        const store = await mossCanvasStorageFor(
          root,
          {
            account: { id: "owner", realm: "memfire-phone" },
            realm: "memfire-phone",
            gatewayBaseUrl: "https://models.example/v1",
          },
          { cwd, threadId: "original-thread", title: "Canvas" },
        );
        store.close();
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
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
