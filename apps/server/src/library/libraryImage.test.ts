import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AuthSessionId, GUEST_MEDIA_MAX_BYTES } from "@moss/contracts";
import { libraryImageIdFromPath } from "@moss/shared/localPreviewFiles";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { LibraryRepositoryLive } from "../persistence/Layers/LibraryRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { LibraryRepository } from "../persistence/Services/LibraryRepository.ts";
import { makeLibraryServiceShape } from "./Layers/LibraryService.ts";
import { libraryImageEffectRouteLayer } from "./libraryImageRoute.ts";
import { resolveLibraryScanRoots } from "./libraryScan.ts";
import { LibraryService } from "./Services/LibraryService.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-library-image-"));
  const homes = {
    mossHome: path.join(root, "moss"),
    codexHome: path.join(root, "codex"),
    claudeHome: path.join(root, "claude"),
  };
  const runtime = ManagedRuntime.make(
    Layer.effect(
      LibraryService,
      makeLibraryServiceShape({
        roots: resolveLibraryScanRoots(homes),
        importRoot: path.join(homes.mossHome, "library"),
      }),
    ).pipe(Layer.provideMerge(LibraryRepositoryLive), Layer.provideMerge(SqlitePersistenceMemory)),
  );
  const library = await runtime.runPromise(Effect.service(LibraryService));
  const repository = await runtime.runPromise(Effect.service(LibraryRepository));
  const auth = Layer.mock(ServerAuth)({
    authenticateHttpRequest: (request) => {
      const token = request.headers.authorization;
      return token === "Bearer owner-fixture" || token === "Bearer client-fixture"
        ? Effect.succeed({
            sessionId: AuthSessionId.makeUnsafe("session-fixture"),
            subject: "fixture",
            method: "bearer-session-token",
            role: token === "Bearer owner-fixture" ? "owner" : "client",
            credentialSource: "bearer",
          })
        : Effect.fail(new AuthError({ message: "Unauthorized", status: 401 }));
    },
  });
  const server = HttpRouter.toWebHandler(
    libraryImageEffectRouteLayer.pipe(
      HttpRouter.provideRequest(Layer.mergeAll(auth, Layer.succeed(LibraryService, library))),
    ),
    { disableLogger: true },
  );
  return {
    root,
    library,
    repository,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    upload: async (bytes = PNG, name = "picture.png") => {
      const result = await runtime.runPromise(
        library.importFiles({ files: [{ name, dataBase64: bytes.toString("base64") }] }),
      );
      return result.items[0]!;
    },
    request: (url: string, token: string | null = "owner-fixture") =>
      server.handler(
        new Request(`http://localhost${url}`, {
          headers: token === null ? {} : { authorization: `Bearer ${token}` },
        }),
      ),
    close: async () => {
      await server.dispose();
      await runtime.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe("library image previews", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f.close();
  });

  it("returns a durable opaque preview on upload and serves the same bytes on later loads", async () => {
    const item = await f.upload();
    expect(item.previewPath).toBe(`/api/library-image/${item.id}`);
    expect(item.previewPath).not.toContain(f.root);
    for (let load = 0; load < 2; load++) {
      const response = await f.request(item.previewPath!);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    }
  });

  it("requires owner authentication and does not accept paths or query credentials", async () => {
    const item = await f.upload();
    expect((await f.request(item.previewPath!, null)).status).toBe(401);
    expect((await f.request(item.previewPath!, "client-fixture")).status).toBe(403);
    expect((await f.request(`${item.previewPath}?path=anything`)).status).toBe(404);
    expect(libraryImageIdFromPath("https://outside.invalid/api/library-image/id")).toBeNull();
    expect(libraryImageIdFromPath("/api/library-image/..%2fsecret")).toBeNull();
  });

  it("checks current trash state and missing files for every load", async () => {
    const item = await f.upload();
    await f.run(f.library.trash({ ids: [item.id] }));
    expect((await f.request(item.previewPath!)).status).toBe(404);
    await f.run(f.library.restore({ ids: [item.id] }));
    expect((await f.request(item.previewPath!)).status).toBe(200);
    await fs.unlink(item.path!);
    expect((await f.request(item.previewPath!)).status).toBe(404);
  });

  it("sniffs bytes and refuses disguised HTML and SVG", async () => {
    const html = await f.upload(Buffer.from("<html><script>alert(1)</script></html>"));
    const svg = await f.upload(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      "image.svg",
    );
    for (const item of [html, svg]) {
      expect(item.previewPath).toBeUndefined();
      expect(await f.run(f.library.readImage(item.id))).toBeNull();
    }
    const png = await f.upload(PNG, "image.bin");
    expect((await f.request(png.previewPath!)).headers.get("content-type")).toBe("image/png");
  });

  it("refuses an indexed file outside its configured root", async () => {
    const item = await f.upload();
    const outside = path.join(f.root, "outside.png");
    await fs.writeFile(outside, PNG);
    await f.run(f.repository.upsertItem({ ...item, path: outside }));
    expect((await f.request(item.previewPath!)).status).toBe(404);
  });

  it("refuses oversized images without reading their body", async () => {
    const item = await f.upload();
    await fs.truncate(item.path!, GUEST_MEDIA_MAX_BYTES + 1);
    expect((await f.request(item.previewPath!)).status).toBe(404);
  });

  it("refuses hard links and directory aliases even when their target is an image", async () => {
    const item = await f.upload();
    const alias = path.join(f.root, "alias.png");
    await fs.link(item.path!, alias);
    expect((await f.request(item.previewPath!)).status).toBe(404);
    await fs.unlink(alias);
    const junction = path.join(path.dirname(item.path!), "alias");
    await fs.symlink(
      path.dirname(item.path!),
      junction,
      process.platform === "win32" ? "junction" : "dir",
    );
    await f.run(
      f.repository.upsertItem({ ...item, path: path.join(junction, path.basename(item.path!)) }),
    );
    expect((await f.request(item.previewPath!)).status).toBe(404);
  });
});
