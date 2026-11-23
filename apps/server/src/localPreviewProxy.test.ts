import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { DateTime, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { AuthError, ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import {
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultGroupsWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "./config";
import { staticAndDevEffectRouteLayer } from "./http";
import {
  clearLocalPreviewProxySessions,
  localPreviewProxyEffectRouteLayer,
  rewritePreviewHtml,
  stripFrameAncestorsFromCsp,
  validateLocalPreviewTargetUrl,
} from "./localPreviewProxy";
import { makeBoundedNodeHttpServer } from "./nodeHttpServer";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  clearLocalPreviewProxySessions();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function makeServerConfig(overrides: Partial<ServerConfigShape> = {}): ServerConfigShape {
  const baseDir = os.tmpdir();
  return {
    mode: "web",
    port: 3773,
    host: "127.0.0.1",
    cwd: baseDir,
    homeDir: os.homedir(),
    chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir: os.homedir() }),
    studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir: os.homedir() }),
    groupsWorkspaceRoot: resolveDefaultGroupsWorkspaceRoot({ homeDir: os.homedir() }),
    baseDir,
    keybindingsConfigPath: path.join(baseDir, "keybindings.json"),
    serverRuntimeStatePath: path.join(baseDir, "runtime.json"),
    serverSettingsPath: path.join(baseDir, "settings.json"),
    attachmentsDir: path.join(baseDir, "attachments"),
    sqlitePath: path.join(baseDir, "state.sqlite"),
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
    ...overrides,
  } as ServerConfigShape;
}

function makeServerAuth(allow: boolean): ServerAuthShape {
  const expiresAt = Effect.runSync(DateTime.now);
  return {
    authenticateHttpRequest: () =>
      allow
        ? Effect.succeed({
            sessionId: "session-id" as never,
            subject: "owner",
            method: "bearer-session-token" as const,
            role: "owner" as const,
            expiresAt,
            credentialSource: "bearer" as const,
          })
        : Effect.fail(new AuthError({ message: "Authentication required.", status: 401 })),
    authenticateWebSocketUpgrade: () =>
      Effect.fail(new AuthError({ message: "Unauthorized WS", status: 401 })),
  } as unknown as ServerAuthShape;
}

async function startUpstreamServer(
  handler: http.RequestListener,
  options: { readonly withWebSocket?: boolean } = {},
): Promise<{ readonly port: number; readonly wss: WebSocketServer | null }> {
  const server = http.createServer(handler);
  let wss: WebSocketServer | null = null;
  if (options.withWebSocket) {
    wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      wss!.handleUpgrade(req, socket, head, (ws) => {
        wss!.emit("connection", ws, req);
      });
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Expected upstream port");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        if (wss) {
          for (const c of wss.clients) c.terminate();
          wss.close();
        }
        server.close(() => resolve());
      }),
  );
  return { port: address.port, wss };
}

async function startMossProxyServer(
  config: ServerConfigShape,
  allowAuth: boolean,
  options: { readonly includeStaticFallback?: boolean } = {},
): Promise<string> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  const routes = options.includeStaticFallback
    ? Layer.mergeAll(localPreviewProxyEffectRouteLayer, staticAndDevEffectRouteLayer)
    : localPreviewProxyEffectRouteLayer;
  const services = Layer.mergeAll(
    Layer.succeed(ServerConfig, config),
    Layer.succeed(ServerAuth, makeServerAuth(allowAuth)),
    NodeHttpServer.layerHttpServices,
  );
  await Effect.runPromise(
    Scope.provide(
      Effect.gen(function* () {
        const httpServer = yield* makeBoundedNodeHttpServer(
          () => {
            nodeServer = http.createServer();
            return nodeServer;
          },
          { port: 0, host: "127.0.0.1" },
        );
        yield* httpServer.serve(yield* HttpRouter.toHttpEffect(routes));
      }).pipe(Effect.provide(services)),
      scope,
    ),
  );
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const address = (nodeServer as http.Server | null)?.address();
  if (!address || typeof address !== "object") throw new Error("Expected Moss proxy port");
  return `http://127.0.0.1:${address.port}`;
}

describe("localPreviewProxy SSRF & rewriting helpers", () => {
  it("accepts strict loopback URLs and rejects all SSRF bypass variants", () => {
    expect(validateLocalPreviewTargetUrl("http://127.0.0.1:4173/app?x=1", [3773])).toMatchObject({
      port: 4173,
      connectHost: "127.0.0.1",
      originLabel: "127.0.0.1:4173",
    });
    expect(validateLocalPreviewTargetUrl("http://localhost:5173", [3773])).toMatchObject({
      port: 5173,
      connectHost: "127.0.0.1",
      allowIpv6Fallback: true,
      originLabel: "localhost:5173",
    });
    expect(validateLocalPreviewTargetUrl("http://[::1]:8080", [3773])).toMatchObject({
      port: 8080,
      connectHost: "::1",
      originLabel: "[::1]:8080",
    });

    for (const bad of [
      "https://127.0.0.1:4173",
      "file:///etc/passwd",
      "http://sub.localhost:4173",
      "http://0x7f000001:4173",
      "http://0177.0.0.1:4173",
      "http://127.1:4173",
      "http://192.168.1.10:4173",
      "http://10.0.0.1:4173",
      "http://169.254.169.254:4173",
      "http://[::ffff:127.0.0.1]:4173",
      "http://[0:0:0:0:0:0:0:1]:4173",
      "http://user:pass@127.0.0.1:4173",
      "http://127.0.0.1:4173@evil.test",
      "http://127.0.0.1",
      "http://127.0.0.1:80",
      "http://127.0.0.1:1023",
      "http://127.0.0.1:65536",
      "http://127.0.0.1:04173",
      "http://127.0.0.1:3773",
    ]) {
      expect(validateLocalPreviewTargetUrl(bad, [3773]), bad).toBeNull();
    }
  });

  it("rewrites HTML root-absolute references without altering protocol-relative URLs", () => {
    const token = "a".repeat(64);
    const input =
      '<html><head><title>App</title></head><body><script type="module" src="/@vite/client"></script><script type="module">import { x } from "/src/main.tsx";</script><img src="//cdn.example.com/logo.png"><a href="/docs">Docs</a><form action="/submit"></form></body></html>';
    const output = rewritePreviewHtml(input, token);
    expect(output).toContain(`<head><base href="/api/local-preview/${token}/">`);
    expect(output).toContain(`src="/api/local-preview/${token}/@vite/client"`);
    expect(output).toContain(`from "/api/local-preview/${token}/src/main.tsx"`);
    expect(output).toContain(`href="/api/local-preview/${token}/docs"`);
    expect(output).toContain(`action="/api/local-preview/${token}/submit"`);
    expect(output).toContain(`src="//cdn.example.com/logo.png"`);
  });

  it("strips frame-ancestors from proxied CSP while keeping remaining directives", () => {
    expect(
      stripFrameAncestorsFromCsp("default-src 'self'; frame-ancestors 'none'; img-src *"),
    ).toBe("default-src 'self'; img-src *");
    expect(stripFrameAncestorsFromCsp("frame-ancestors 'self'")).toBeNull();
  });
});

describe("localPreviewProxy HTTP and WebSocket integration", () => {
  it("enforces auth on session creation, caps sessions at 32 with sliding TTL, and proxies HTTP cleanly", async () => {
    const seenRequests: Array<{
      readonly url: string;
      readonly method: string;
      readonly headers: http.IncomingHttpHeaders;
      readonly body: string;
    }> = [];
    const upstream = await startUpstreamServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seenRequests.push({
          url: req.url ?? "",
          method: req.method ?? "GET",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (req.url === "/redirect") {
          res.writeHead(302, {
            Location: `http://127.0.0.1:${upstream.port}/app/home`,
          });
          res.end();
          return;
        }
        if (req.url === "/rel-redirect") {
          res.writeHead(302, { Location: "/dashboard" });
          res.end();
          return;
        }
        if (req.url === "/assets/app.js") {
          res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
          res.end("export const ok = true;");
          return;
        }
        if (req.url === "/api/echo" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ echoed: Buffer.concat(chunks).toString("utf8") }));
          return;
        }
        const html = zlib.gzipSync(
          '<!doctype html><html><head></head><body><script type="module" src="/assets/app.js"></script></body></html>',
        );
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Encoding": "gzip",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
          "Set-Cookie": ["app_sid=xyz; Path=/; Domain=127.0.0.1; HttpOnly"],
        });
        res.end(html);
      });
    });

    const unauthOrigin = await startMossProxyServer(makeServerConfig(), false);
    const denied = await fetch(`${unauthOrigin}/api/local-preview/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${upstream.port}` }),
    });
    expect(denied.status).toBe(401);

    const origin = await startMossProxyServer(makeServerConfig(), true, {
      includeStaticFallback: true,
    });

    // Reject self-port.
    const mossPort = Number(new URL(origin).port);
    const selfRes = await fetch(`${origin}/api/local-preview/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${mossPort}` }),
    });
    expect(selfRes.status).toBe(400);

    const sessionRes = await fetch(`${origin}/api/local-preview/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${upstream.port}/?tab=dev` }),
    });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as {
      token: string;
      previewPath: string;
      originLabel: string;
      expiresAt: string;
    };
    expect(session.token).toMatch(/^[a-f0-9]{64}$/u);
    expect(session.previewPath).toBe(`/api/local-preview/${session.token}/?tab=dev`);
    expect(session.originLabel).toBe(`127.0.0.1:${upstream.port}`);

    // Fetch HTML through proxy without any Authorization header; pass Moss auth/cookies to verify stripping.
    const htmlRes = await fetch(`${origin}${session.previewPath}`, {
      headers: {
        Authorization: "Bearer moss-secret",
        Cookie: "moss_session=secret-cookie; custom_app=keepme",
      },
    });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("x-frame-options")).toBeNull();
    expect(htmlRes.headers.get("content-security-policy")).toBe("default-src 'self'");
    const setCookies = htmlRes.headers.getSetCookie();
    expect(
      setCookies.some((c) => c.includes(`app_sid=xyz; Path=/api/local-preview/${session.token}/`)),
    ).toBe(true);
    expect(setCookies.some((c) => c.includes("Domain="))).toBe(false);
    expect(setCookies.some((c) => c.includes(`moss_preview_token=${session.token}`))).toBe(true);

    const htmlBody = await htmlRes.text();
    expect(htmlBody).toContain(`<base href="/api/local-preview/${session.token}/">`);
    expect(htmlBody).toContain(`src="/api/local-preview/${session.token}/assets/app.js"`);

    const upstreamReq = seenRequests.at(-1)!;
    expect(upstreamReq.url).toBe("/?tab=dev");
    expect(upstreamReq.headers.authorization).toBeUndefined();
    expect(upstreamReq.headers.cookie).toBe("custom_app=keepme");
    expect(upstreamReq.headers.host).toBe(`127.0.0.1:${upstream.port}`);

    // Redirect rewriting.
    const redir1 = await fetch(`${origin}/api/local-preview/${session.token}/redirect`, {
      redirect: "manual",
    });
    expect(redir1.status).toBe(302);
    expect(redir1.headers.get("location")).toBe(`/api/local-preview/${session.token}/app/home`);

    const redir2 = await fetch(`${origin}/api/local-preview/${session.token}/rel-redirect`, {
      redirect: "manual",
    });
    expect(redir2.headers.get("location")).toBe(`/api/local-preview/${session.token}/dashboard`);

    // POST body forwarding.
    const postRes = await fetch(`${origin}/api/local-preview/${session.token}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello-proxy",
    });
    expect(postRes.status).toBe(200);
    await expect(postRes.json()).resolves.toEqual({ echoed: "hello-proxy" });

    // Subresource fallback via cookie and via ?token= when prefix is omitted.
    const cookieFallbackRes = await fetch(`${origin}/api/local-preview/assets/app.js`, {
      headers: { Cookie: `moss_preview_token=${session.token}` },
    });
    expect(cookieFallbackRes.status).toBe(200);
    expect(await cookieFallbackRes.text()).toBe("export const ok = true;");

    const rootFallbackRes = await fetch(`${origin}/assets/app.js`, {
      headers: { Cookie: `moss_preview_token=${session.token}` },
    });
    expect(rootFallbackRes.status).toBe(200);
    expect(await rootFallbackRes.text()).toBe("export const ok = true;");

    const queryFallbackRes = await fetch(
      `${origin}/api/local-preview/assets/app.js?token=${session.token}`,
    );
    expect(queryFallbackRes.status).toBe(200);

    // Bounded 32-session cap evicts the oldest session.
    const tokens: string[] = [session.token];
    for (let i = 0; i < 32; i += 1) {
      const r = await fetch(`${origin}/api/local-preview/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${upstream.port}` }),
      });
      const json = (await r.json()) as { token: string };
      tokens.push(json.token);
    }
    const evicted = await fetch(`${origin}/api/local-preview/${tokens[0]}/assets/app.js`);
    expect(evicted.status).toBe(404);
    const newest = await fetch(`${origin}/api/local-preview/${tokens.at(-1)}/assets/app.js`);
    expect(newest.status).toBe(200);
  });

  it("expires sessions after 1h sliding TTL", async () => {
    const upstream = await startUpstreamServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("alive");
    });
    const origin = await startMossProxyServer(makeServerConfig(), true);
    const startMs = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(startMs);

    const createRes = await fetch(`${origin}/api/local-preview/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${upstream.port}` }),
    });
    const { token } = (await createRes.json()) as { token: string };

    // Touch at 50m -> renews TTL for another 60m.
    vi.spyOn(Date, "now").mockReturnValue(startMs + 50 * 60 * 1000);
    expect((await fetch(`${origin}/api/local-preview/${token}/`)).status).toBe(200);

    // Still alive at 105m.
    vi.spyOn(Date, "now").mockReturnValue(startMs + 105 * 60 * 1000);
    expect((await fetch(`${origin}/api/local-preview/${token}/`)).status).toBe(200);

    // Expires 61m after last access.
    vi.spyOn(Date, "now").mockReturnValue(startMs + 166 * 60 * 1000);
    expect((await fetch(`${origin}/api/local-preview/${token}/`)).status).toBe(404);
  });

  it("tunnels WebSocket upgrades with subprotocols before Moss auth rejection and closes cleanly", async () => {
    const upstreamHeadersSeen: Array<http.IncomingHttpHeaders> = [];
    const upstream = await startUpstreamServer(
      (_req, res) => {
        res.writeHead(404);
        res.end();
      },
      { withWebSocket: true },
    );
    upstream.wss!.on("connection", (ws, req) => {
      upstreamHeadersSeen.push(req.headers);
      ws.on("message", (data) => {
        ws.send(`echo:${data.toString()}`);
      });
    });

    // Notice ServerAuth rejects WS upgrade, proving /api/local-preview/* runs BEFORE auth rejection.
    const origin = await startMossProxyServer(makeServerConfig(), true);
    const sessionRes = await fetch(`${origin}/api/local-preview/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${upstream.port}` }),
    });
    const { token } = (await sessionRes.json()) as { token: string };

    const wsOrigin = origin.replace(/^http:/u, "ws:");
    const client = new WebSocket(`${wsOrigin}/api/local-preview/${token}/hmr?v=1`, ["vite-hmr"], {
      headers: {
        Authorization: "Bearer moss-should-be-stripped",
        Cookie: "moss_session=strip; dev_cookie=keep",
      },
    });

    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    expect(client.protocol).toBe("vite-hmr");
    expect(upstreamHeadersSeen[0]?.authorization).toBeUndefined();
    expect(upstreamHeadersSeen[0]?.cookie).toBe("dev_cookie=keep");

    const reply = await new Promise<string>((resolve) => {
      client.once("message", (data) => resolve(data.toString()));
      client.send("ping-hmr");
    });
    expect(reply).toBe("echo:ping-hmr");

    const closeCode = await new Promise<number>((resolve) => {
      client.once("close", (code) => resolve(code));
      client.close(1000, "done");
    });
    expect(closeCode).toBe(1000);
    expect(closeCode).not.toBe(1005);
    expect(closeCode).not.toBe(1006);

    // Invalid token upgrade closes cleanly with HTTP 404.
    const badClient = new WebSocket(`${wsOrigin}/api/local-preview/invalid-token/hmr`);
    const badError = await new Promise<Error>((resolve) => {
      badClient.once("error", resolve);
    });
    expect(badError.message).toMatch(/404|Unexpected server response/u);
  });
});
