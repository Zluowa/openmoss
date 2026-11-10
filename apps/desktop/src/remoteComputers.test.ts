import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { RemoteComputersManager, remoteComputerOrigin } from "./remoteComputers";
import type { VaultKeyStore } from "./browserAutomation/vaultKeyProtection";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function keyStore(): VaultKeyStore {
  const key = randomBytes(32);
  return {
    available: async () => true,
    encrypt: (value) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    },
    decrypt: (value) => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}
async function fixture(sessionCheckIntervalMs?: number) {
  const rootDir = await mkdtemp(join(tmpdir(), "moss-remote-computers-"));
  cleanups.push(() => rm(rootDir, { recursive: true, force: true }));
  const token = randomBytes(32).toString("hex"),
    credential = randomBytes(24).toString("hex");
  let paired = false,
    revoked = false,
    unauthorized = false,
    outage = false;
  let requests = 0;
  const server: Server = createServer(async (req, res) => {
    requests++;
    res.setHeader("Content-Type", "application/json");
    if (outage && req.url === "/api/auth/session") {
      res.writeHead(503);
      return res.end("{}");
    }
    if (req.url === "/api/auth/bootstrap/bearer") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      if (paired || JSON.parse(Buffer.concat(chunks).toString()).credential !== credential) {
        res.writeHead(401);
        return res.end("{}");
      }
      paired = true;
      return res.end(
        JSON.stringify({
          authenticated: true,
          role: "client",
          sessionMethod: "bearer-session-token",
          sessionToken: token,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      );
    }
    if (unauthorized || revoked || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      return res.end("{}");
    }
    if (req.url === "/api/auth/logout") {
      revoked = true;
      return res.end('{"revoked":true}');
    }
    return res.end('{"authenticated":true,"role":"client"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const opened: Array<{ token: string; origin: string; onClosed: () => void; closed: boolean }> =
    [];
  const keys = keyStore();
  const manager = new RemoteComputersManager({
    rootDir,
    keyStore: keys,
    ...(sessionCheckIntervalMs === undefined ? {} : { sessionCheckIntervalMs }),
    openWorkspace: async (input) => {
      const window = { ...input, closed: false };
      opened.push(window);
      return () => {
        window.closed = true;
      };
    },
  });
  cleanups.push(async () => manager.dispose());
  return {
    rootDir,
    manager,
    opened,
    keys,
    token,
    credential,
    origin,
    id: randomUUID(),
    requests: () => requests,
    revoke: () => {
      unauthorized = true;
    },
    setOutage: (value: boolean) => {
      outage = value;
    },
    server,
  };
}

describe("paired remote computers", () => {
  it("accepts secure origins and loopback test endpoints; rejects credentials, routes, plaintext remote hosts", () => {
    expect(remoteComputerOrigin("https://example.test:8443/")).toBe("https://example.test:8443");
    for (const value of [
      "http://192.0.2.2",
      "https://u:p@example.test",
      "https://example.test/path",
      "https://example.test?token=x",
      "https://example.test#x",
      "file:///tmp/a",
    ])
      expect(() => remoteComputerOrigin(value)).toThrow("invalid-address");
  });
  it("uses one-use pairing, persists encrypted data, reloads without decrypting or networking, and revokes on removal", async () => {
    const f = await fixture();
    const state = await f.manager.pair({
      id: f.id,
      displayName: "Test Mac",
      origin: f.origin,
      credential: f.credential,
    });
    expect(JSON.stringify(state)).not.toContain(f.token);
    const file = await readFile(join(f.rootDir, "connections.json"), "utf8");
    expect(file).not.toContain(f.token);
    expect(file).not.toContain(f.credential);
    const reloaded = new RemoteComputersManager({
      rootDir: f.rootDir,
      keyStore: {
        ...f.keys,
        decrypt: () => {
          throw new Error("must not decrypt for listing");
        },
      },
      openWorkspace: async () => () => undefined,
    });
    expect((await reloaded.list())[0]?.status).toBe("disconnected");
    expect(f.requests()).toBe(1);
    const connected = await f.manager.connect(f.id);
    expect(connected.status).toBe("connected");
    expect(f.opened[0]?.origin).toBe(f.origin);
    expect(f.opened[0]?.token).toBe(f.token);
    expect(await f.manager.remove(f.id)).toEqual({ revoked: true });
    expect(f.opened[0]?.closed).toBe(true);
    expect(await f.manager.list()).toEqual([]);
    await expect(
      f.manager.pair({
        id: randomUUID(),
        displayName: "Again",
        origin: f.origin,
        credential: f.credential,
      }),
    ).rejects.toThrow("needs-pairing");
  });
  it("refuses to exchange a credential when secure storage is unavailable", async () => {
    const f = await fixture();
    const manager = new RemoteComputersManager({
      rootDir: f.rootDir,
      keyStore: { ...f.keys, available: async () => false },
      openWorkspace: async () => () => undefined,
    });
    await expect(
      manager.pair({ id: f.id, displayName: "Test", origin: f.origin, credential: f.credential }),
    ).rejects.toThrow("secure-storage-unavailable");
    expect(f.requests()).toBe(0);
  });
  it("does not open a window for a revoked remote session", async () => {
    const f = await fixture();
    await f.manager.pair({
      id: f.id,
      displayName: "Test",
      origin: f.origin,
      credential: f.credential,
    });
    f.revoke();
    expect((await f.manager.connect(f.id)).status).toBe("needs-pairing");
    expect(f.opened).toHaveLength(0);
  });
  it("closes a connected window when its session is revoked and stops monitoring", async () => {
    const f = await fixture(25);
    await f.manager.pair({
      id: f.id,
      displayName: "Test",
      origin: f.origin,
      credential: f.credential,
    });
    await f.manager.connect(f.id);
    f.revoke();
    await vi.waitFor(
      async () => {
        expect((await f.manager.list())[0]?.status).toBe("needs-pairing");
        expect(f.opened[0]?.closed).toBe(true);
      },
      { timeout: 2000, interval: 25 },
    );
    const requests = f.requests();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.requests()).toBe(requests);
  });
  it("keeps a connected window through a brief outage and keeps checking", async () => {
    const f = await fixture(25);
    await f.manager.pair({
      id: f.id,
      displayName: "Test",
      origin: f.origin,
      credential: f.credential,
    });
    await f.manager.connect(f.id);
    f.setOutage(true);
    const before = f.requests();
    await vi.waitFor(() => expect(f.requests()).toBeGreaterThan(before + 2), {
      timeout: 2000,
      interval: 25,
    });
    expect(f.opened[0]?.closed).toBe(false);
    expect((await f.manager.list())[0]?.status).toBe("connected");
    f.setOutage(false);
    f.revoke();
    await vi.waitFor(
      async () => {
        expect((await f.manager.list())[0]?.status).toBe("needs-pairing");
        expect(f.opened[0]?.closed).toBe(true);
      },
      { timeout: 2000, interval: 25 },
    );
  });
  it("honors cancellation while secure storage is still being checked", async () => {
    const f = await fixture();
    let finish!: (value: boolean) => void, started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const manager = new RemoteComputersManager({
      rootDir: f.rootDir,
      keyStore: {
        ...f.keys,
        available: () => {
          started();
          return new Promise<boolean>((resolve) => {
            finish = resolve;
          });
        },
      },
      openWorkspace: async () => () => undefined,
    });
    const pending = manager.pair({
      id: f.id,
      displayName: "Test",
      origin: f.origin,
      credential: f.credential,
    });
    await ready;
    manager.cancelPairing(f.id);
    finish(true);
    await expect(pending).rejects.toThrow("cancelled");
    expect(f.requests()).toBe(0);
    expect(await manager.list()).toEqual([]);
  });
  it("discards and revokes a late pairing result after cancel", async () => {
    const f = await fixture();
    let finish!: (value: Response) => void, started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cleanupCalls = 0;
    const manager = new RemoteComputersManager({
      rootDir: f.rootDir,
      keyStore: f.keys,
      openWorkspace: async () => () => undefined,
      fetch: (async (url: string | URL | Request) => {
        if (String(url).endsWith("/logout")) {
          cleanupCalls++;
          return Response.json({ revoked: true });
        }
        started();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }) as typeof fetch,
    });
    const pending = manager.pair({
      id: f.id,
      displayName: "Test",
      origin: f.origin,
      credential: f.credential,
    });
    await startedPromise;
    manager.cancelPairing(f.id);
    finish(
      Response.json({
        authenticated: true,
        role: "client",
        sessionMethod: "bearer-session-token",
        sessionToken: f.token,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    await expect(pending).rejects.toThrow("cancelled");
    expect(await manager.list()).toEqual([]);
    expect(cleanupCalls).toBe(1);
  });
  it("keeps an older window close notification from disconnecting a new connection", async () => {
    const f = await fixture();
    await f.manager.pair({
      id: f.id,
      displayName: "Test",
      origin: f.origin,
      credential: f.credential,
    });
    await f.manager.connect(f.id);
    f.manager.disconnect(f.id);
    await f.manager.connect(f.id);
    f.opened[0]!.onClosed();
    expect((await f.manager.list())[0]?.status).toBe("connected");
    f.opened[1]!.onClosed();
    expect((await f.manager.list())[0]?.status).toBe("disconnected");
  });
  it("keeps a replacement pairing when an older cancelled reply arrives", async () => {
    const f = await fixture();
    let finishOld!: (value: Response) => void, started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const newToken = randomBytes(32).toString("hex");
    const revokedTokens: string[] = [];
    let exchanges = 0;
    const response = (token: string) =>
      Response.json({
        authenticated: true,
        role: "client",
        sessionMethod: "bearer-session-token",
        sessionToken: token,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    const manager = new RemoteComputersManager({
      rootDir: f.rootDir,
      keyStore: f.keys,
      openWorkspace: async () => () => undefined,
      fetch: (async (url, options) => {
        if (String(url).endsWith("/logout")) {
          revokedTokens.push(
            (options?.headers as Record<string, string> | undefined)?.Authorization ?? "",
          );
          return Response.json({ revoked: true });
        }
        if (++exchanges === 1) {
          started();
          return new Promise<Response>((resolve) => {
            finishOld = resolve;
          });
        }
        return response(newToken);
      }) as typeof fetch,
    });
    const old = manager.pair({
      id: f.id,
      displayName: "Old",
      origin: f.origin,
      credential: f.credential,
    });
    await ready;
    const replacement = await manager.pair({
      id: f.id,
      displayName: "Replacement",
      origin: f.origin,
      credential: f.credential,
    });
    finishOld(response(f.token));
    await expect(old).rejects.toThrow("cancelled");
    expect((await manager.list())[0]?.connection).toEqual(replacement.connection);
    expect(revokedTokens).toEqual([`Bearer ${f.token}`]);
  });
  it("never forwards the pairing credential through an HTTP redirect", async () => {
    const f = await fixture();
    let visits = 0;
    f.server.removeAllListeners("request");
    f.server.on("request", (req, res) => {
      visits++;
      req.resume();
      res.writeHead(307, { Location: `${f.origin}/credential-trap` });
      res.end();
    });
    await expect(
      f.manager.pair({ id: f.id, displayName: "Test", origin: f.origin, credential: f.credential }),
    ).rejects.toThrow("connection-failed");
    expect(visits).toBe(1);
    expect(await f.manager.list()).toEqual([]);
  });
  it("bounds untrusted response bodies and revokes an accidentally supplied owner session", async () => {
    const f = await fixture();
    let mode: "large" | "owner" = "large",
      revokes = 0;
    const manager = new RemoteComputersManager({
      rootDir: f.rootDir,
      keyStore: f.keys,
      openWorkspace: async () => () => undefined,
      fetch: (async (url) => {
        if (String(url).endsWith("/logout")) {
          revokes++;
          return Response.json({ revoked: true });
        }
        return mode === "large"
          ? new Response("x".repeat(65537))
          : Response.json({
              authenticated: true,
              role: "owner",
              sessionMethod: "bearer-session-token",
              sessionToken: f.token,
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            });
      }) as typeof fetch,
    });
    const input = { id: f.id, displayName: "Test", origin: f.origin, credential: f.credential };
    await expect(manager.pair(input)).rejects.toThrow("invalid-response");
    mode = "owner";
    await expect(manager.pair(input)).rejects.toThrow("invalid-response");
    expect(revokes).toBe(1);
    expect(await manager.list()).toEqual([]);
  });
  it("reports offline local deletion honestly and removes the encrypted profile", async () => {
    const f = await fixture();
    await f.manager.pair({
      id: f.id,
      displayName: "Test",
      origin: f.origin,
      credential: f.credential,
    });
    f.revoke();
    expect(await f.manager.remove(f.id)).toEqual({ revoked: false });
    expect(await f.manager.list()).toEqual([]);
  });
  it("blocks reconnect and duplicate removal while remote revocation is pending", async () => {
    const f = await fixture();
    await f.manager.pair({
      id: f.id,
      displayName: "Test",
      origin: f.origin,
      credential: f.credential,
    });
    let finish!: (value: Response) => void, started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let opened = false;
    const manager = new RemoteComputersManager({
      rootDir: f.rootDir,
      keyStore: f.keys,
      fetch: (async (url, options) => {
        if (String(url).endsWith("/logout")) {
          started();
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return fetch(url, options);
      }) as typeof fetch,
      openWorkspace: async () => {
        opened = true;
        return () => undefined;
      },
    });
    const removal = manager.remove(f.id);
    await ready;
    await expect(manager.connect(f.id)).rejects.toThrow("connection-busy");
    await expect(manager.remove(f.id)).rejects.toThrow("connection-busy");
    finish(Response.json({ revoked: true }));
    expect(await removal).toEqual({ revoked: true });
    expect(opened).toBe(false);
    expect(await manager.list()).toEqual([]);
  });
});
