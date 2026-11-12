import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { outboundHttp } from "@moss/shared/outboundHttp";
import {
  cacheMossCanvasRemoteAsset,
  legacyMossCanvasDirectory,
  mossCanvasStorageDirectory,
  mossCanvasStorageExists,
  mossCanvasStorageFor,
} from "./mossCanvasStorage";

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

describe("where a conversation's Canvas lives", () => {
  const identity = {
    account: { id: "owner", realm: "memfire-phone" as const },
    realm: "memfire-phone" as const,
    gatewayBaseUrl: "https://models.example/v1",
  };
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "moss-canvas-home-"));
    const bundle = join(root, "bundle");
    await mkdir(join(bundle, "apps/codex-canvas/server"), { recursive: true });
    // The fake Canvas store reports which folder it was given. Callers reach a store only
    // through its methods (the pool opens and closes the real one underneath), so it answers
    // through request().
    await writeFile(
      join(bundle, "apps/codex-canvas/server/hosted-storage.mjs"),
      `export function createMossCanvasHostedStorage({ stateDirectory }) {
         return {
           request: async (method) => (method === "test.stateDirectory" ? stateDirectory : {}),
           close() {},
         };
       }`,
    );
    vi.stubEnv("MOSS_CANVAS_BUNDLE_DIR", bundle);
    const state = join(root, "state");
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    return { root, state, cwd };
  }
  const opened = async (state: string, cwd: string, threadId: string) => {
    const store = await mossCanvasStorageFor(state, identity, {
      cwd,
      threadId,
      title: "Canvas",
    });
    return { stateDirectory: (await store.request("test.stateDirectory")) as string };
  };
  afterEach(() => vi.unstubAllEnvs());

  it("keeps it in Moss's own state, never inside the project", async () => {
    const { root, state, cwd } = await setup();
    try {
      const store = await opened(state, cwd, "thread-new");
      expect(store.stateDirectory).toContain(join("state", "moss-canvas-threads"));
      expect(store.stateDirectory).toBe(
        toNamespacedPath(
          mossCanvasStorageDirectory(state, identity, { cwd, threadId: "thread-new", title: "" }),
        ),
      );
      expect(existsSync(join(cwd, ".moss"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("moves a Canvas made inside the project once, with its files, and clears the emptied folders", async () => {
    const { root, state, cwd } = await setup();
    try {
      const legacy = legacyMossCanvasDirectory(identity, {
        cwd,
        threadId: "thread-old",
        title: "",
      });
      await mkdir(join(legacy, "workspace/.hoola/assets"), { recursive: true });
      await writeFile(join(legacy, "workspace/.hoola/assets/a.png"), "png");
      await writeFile(join(cwd, "notes.md"), "mine");
      const store = await opened(state, cwd, "thread-old");
      const moved = mossCanvasStorageDirectory(state, identity, {
        cwd,
        threadId: "thread-old",
        title: "",
      });
      expect(store.stateDirectory).toBe(toNamespacedPath(moved));
      expect(readFileSync(join(moved, "workspace/.hoola/assets/a.png"), "utf8")).toBe("png");
      expect(existsSync(legacy)).toBe(false);
      expect(existsSync(join(cwd, ".moss"))).toBe(false);
      // The person's own files stay where they were.
      expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("mine");
      expect(
        await mossCanvasStorageExists(state, identity, { cwd, threadId: "thread-old", title: "" }),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds a Canvas still in the project without creating anything", async () => {
    const { root, state, cwd } = await setup();
    try {
      const workspace = { cwd, threadId: "thread-waiting", title: "" };
      expect(await mossCanvasStorageExists(state, identity, workspace)).toBe(false);
      await mkdir(legacyMossCanvasDirectory(identity, workspace), { recursive: true });
      expect(await mossCanvasStorageExists(state, identity, workspace)).toBe(true);
      expect(existsSync(join(state, "moss-canvas-threads"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never follows a link out of the project, and leaves what it points at alone", async () => {
    const { root, state, cwd } = await setup();
    try {
      const outside = join(root, "outside");
      const workspace = { cwd, threadId: "thread-linked", title: "" };
      const target = join(
        outside,
        legacyMossCanvasDirectory(identity, workspace).slice(join(cwd, ".moss").length + 1),
      );
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "secret.txt"), "keep");
      await symlink(outside, join(cwd, ".moss"), "junction");
      const store = await opened(state, cwd, "thread-linked");
      expect(store.stateDirectory).toBe(
        toNamespacedPath(mossCanvasStorageDirectory(state, identity, workspace)),
      );
      expect(readFileSync(join(target, "secret.txt"), "utf8")).toBe("keep");
    } finally {
      await rm(join(root, "project", ".moss"), { force: true }).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
