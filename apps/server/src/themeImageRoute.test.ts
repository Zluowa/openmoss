// Integration test for the theme picture routes (`themeImageEffectRouteLayer` in http.ts) through
// a real HTTP listener: GET serves a stored picture by its fixed-shape id with the same
// authentication as /api/local-image; POST stores raw bytes, owner only.
import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { THEME_IMAGE_MAX_BYTES } from "@moss/shared/themeCss";
import { DateTime, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { AuthError, ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import { ServerConfig, type ServerConfigShape } from "./config";
import { themeImageEffectRouteLayer } from "./http";
import { storeThemeImageBytes, themeImagesDir } from "./themeImages";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await FS.rm(dir, { recursive: true, force: true });
});

function pngBytes(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(33 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

async function makeConfig(overrides: Partial<ServerConfigShape> = {}): Promise<ServerConfigShape> {
  const baseDir = await FS.mkdtemp(path.join(os.tmpdir(), "moss-theme-route-"));
  tempDirs.push(baseDir);
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: baseDir,
    baseDir,
    stateDir: path.join(baseDir, "userdata"),
    attachmentsDir: path.join(baseDir, "attachments"),
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    ...overrides,
  } as ServerConfigShape;
}

function makeAuth(role: "owner" | "client" | "reject"): ServerAuthShape {
  const expiresAt = Effect.runSync(DateTime.now);
  return {
    authenticateHttpRequest: () =>
      role === "reject"
        ? Effect.fail(new AuthError({ message: "Authentication required.", status: 401 }))
        : Effect.succeed({
            sessionId: "session-id" as never,
            subject: "owner",
            method: "browser-session-cookie" as const,
            role,
            expiresAt,
            credentialSource: "cookie" as const,
          }),
  } as unknown as ServerAuthShape;
}

async function withServer(
  config: ServerConfigShape,
  auth: ServerAuthShape,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  const services = Layer.mergeAll(
    Layer.succeed(ServerConfig, config),
    Layer.succeed(ServerAuth, auth),
    NodeHttpServer.layerHttpServices,
  );
  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const server = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          yield* server.serve(yield* HttpRouter.toHttpEffect(themeImageEffectRouteLayer));
        }).pipe(Effect.provide(services)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("no address");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("theme picture routes", () => {
  it("serves a stored picture by its id, with its type and no sniffing", async () => {
    const config = await makeConfig();
    const bytes = pngBytes(1024, 1536, 500);
    const stored = await storeThemeImageBytes(themeImagesDir(config.stateDir), bytes);
    await withServer(config, makeAuth("owner"), async (origin) => {
      const response = await fetch(`${origin}/api/theme-images/${stored.id}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    });
  });

  it("finds nothing outside the store or under an id of another shape", async () => {
    const config = await makeConfig();
    const stored = await storeThemeImageBytes(themeImagesDir(config.stateDir), pngBytes(4, 4));
    await FS.writeFile(path.join(config.stateDir, "settings.json"), "{}");
    await withServer(config, makeAuth("owner"), async (origin) => {
      for (const suffix of [
        "..%2Fsettings.json",
        "%2E%2E/settings.json",
        "../settings.json",
        stored.id.toUpperCase(),
        stored.id.replace(".png", ".svg"),
        `${stored.id}?x=1`.replace("?x=1", "%3Fx=1"),
        `${"0".repeat(64)}.png`,
        "",
      ]) {
        const response = await fetch(`${origin}/api/theme-images/${suffix}`);
        expect([400, 404], suffix).toContain(response.status);
        expect(await response.text()).not.toContain("{}");
      }
    });
  });

  it("asks for the same sign-in as other local images, or the desktop startup token", async () => {
    const config = await makeConfig({ authToken: "desktop-secret", host: "127.0.0.1" });
    const stored = await storeThemeImageBytes(themeImagesDir(config.stateDir), pngBytes(4, 4));
    await withServer(config, makeAuth("reject"), async (origin) => {
      expect((await fetch(`${origin}/api/theme-images/${stored.id}`)).status).toBe(401);
      expect((await fetch(`${origin}/api/theme-images/${stored.id}?token=wrong`)).status).toBe(401);
      expect(
        (await fetch(`${origin}/api/theme-images/${stored.id}?token=desktop-secret`)).status,
      ).toBe(200);
    });
  });

  it("stores posted bytes for the owner and answers with the reference", async () => {
    const config = await makeConfig();
    const bytes = pngBytes(640, 480, 10);
    await withServer(config, makeAuth("owner"), async (origin) => {
      const response = await fetch(`${origin}/api/theme-image-upload`, {
        method: "POST",
        headers: { Origin: origin },
        body: bytes,
      });
      expect(response.status).toBe(201);
      const id = `${createHash("sha256").update(bytes).digest("hex")}.png`;
      expect(await response.json()).toEqual({
        id,
        reference: `moss-theme-image:${id}`,
        width: 640,
        height: 480,
        bytes: bytes.length,
      });
      expect((await fetch(`${origin}/api/theme-images/${id}`)).status).toBe(200);
    });
  });

  it("refuses an SVG, a file over 10 MB, a non-owner and another site", async () => {
    const config = await makeConfig();
    await withServer(config, makeAuth("owner"), async (origin) => {
      const svg = await fetch(`${origin}/api/theme-image-upload`, {
        method: "POST",
        headers: { Origin: origin },
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      });
      expect(svg.status).toBe(400);
      expect(((await svg.json()) as { error: string }).error).toContain("SVG is not accepted");
      const large = await fetch(`${origin}/api/theme-image-upload`, {
        method: "POST",
        headers: { Origin: origin },
        body: pngBytes(4, 4, THEME_IMAGE_MAX_BYTES),
      });
      expect(large.status).toBe(413);
      const foreign = await fetch(`${origin}/api/theme-image-upload`, {
        method: "POST",
        headers: { Origin: "https://example.com" },
        body: pngBytes(4, 4),
      });
      expect(foreign.status).toBe(403);
    });
    await withServer(config, makeAuth("client"), async (origin) => {
      const response = await fetch(`${origin}/api/theme-image-upload`, {
        method: "POST",
        headers: { Origin: origin },
        body: pngBytes(4, 4),
      });
      expect(response.status).toBe(403);
    });
    expect(await FS.readdir(themeImagesDir(config.stateDir)).catch(() => [])).toEqual([]);
  });
});
