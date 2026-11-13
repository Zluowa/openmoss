import http from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AUTH_MANAGEMENT_WS_METHODS, WS_METHODS } from "@moss/contracts";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import WebSocket, { type RawData } from "ws";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makeBoundedNodeHttpServer } from "../nodeHttpServer";
import {
  makeWebsocketRpcRouteLayer,
  WsFeatureAndDeviceRpcGroup,
  wsRequestAdmissionMiddlewareLayer,
} from "../wsRpc";
import { WsConnectionSessions, makeWsConnectionSessions } from "../wsConnectionSessions";
import { makeCurrentWsFeatureCompatibilitySearchParams } from "../wsCompatibility";
import { AuthControlPlaneLive } from "./Layers/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./Layers/BootstrapCredentialService";
import { ServerAuthLive } from "./Layers/ServerAuth";
import { ServerAuthPolicyLive } from "./Layers/ServerAuthPolicy";
import { ServerSecretStoreLive } from "./Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "./Layers/SessionCredentialService";
import { ServerAuth } from "./Services/ServerAuth";
import { makeAuthWsRpcHandlers } from "./wsRpc";

const authMethods = [WS_METHODS.serverGetAuthSession, ...AUTH_MANAGEMENT_WS_METHODS] as const;
type AuthRpc = Extract<
  RpcGroup.Rpcs<typeof WsFeatureAndDeviceRpcGroup>,
  { readonly _tag: (typeof authMethods)[number] }
>;
// These are the real served RPCs, including their admission middleware and schemas.
const AuthGroup = RpcGroup.make(
  ...authMethods.map((method) => {
    const rpc = WsFeatureAndDeviceRpcGroup.requests.get(method);
    if (!rpc) throw new Error(`Missing served auth RPC ${method}`);
    return rpc as AuthRpc;
  }),
);
const metadata = { deviceType: "desktop" as const, label: "Synthetic remote computer" };
const startupToken = "synthetic-startup-owner";

/** The desktop with "Allow phone connections" on: every interface, plain HTTP accepted. */
const PHONE_ACCESS_ON = {
  host: "0.0.0.0",
  allowInsecureRemote: true,
  desktopPhoneAccess: true,
} as const;

async function fixture(
  overrides: Partial<{
    host: string;
    allowInsecureRemote: boolean;
    desktopPhoneAccess: boolean;
  }> = {},
) {
  const configLayer = ServerConfig.layerTest(
    process.cwd(),
    { prefix: "moss-auth-ws-" },
    {
      host: "127.0.0.1",
      authToken: startupToken,
      mode: "desktop",
      ...overrides,
    },
  ).pipe(Layer.provide(NodeServices.layer));
  const sessionLayer = SessionCredentialServiceLive.pipe(Layer.provide(ServerSecretStoreLive));
  const controlLayer = AuthControlPlaneLive.pipe(
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionLayer),
  );
  const authLayer = ServerAuthLive.pipe(
    Layer.provide(ServerAuthPolicyLive),
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionLayer),
    Layer.provide(controlLayer),
  );
  const services = Layer.mergeAll(authLayer, sessionLayer, configLayer, NodeServices.layer).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSecretStoreLive),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const connectionSessions = await Effect.runPromise(makeWsConnectionSessions);
  const handlerLayer = AuthGroup.toLayer(
    Effect.gen(function* () {
      return makeAuthWsRpcHandlers(yield* ServerAuth, yield* ServerConfig);
    }),
  );
  const source = Effect.gen(function* () {
    const handlers = yield* Layer.buildWithScope(
      Layer.merge(handlerLayer, wsRequestAdmissionMiddlewareLayer).pipe(
        Layer.provideMerge(RpcSerialization.layerJson),
      ),
      yield* Effect.scope,
    );
    return yield* RpcServer.toHttpEffectWebsocket(AuthGroup).pipe(Effect.provide(handlers));
  });
  const routeLayer = makeWebsocketRpcRouteLayer(source).pipe(
    Layer.provide(Layer.succeed(WsConnectionSessions, connectionSessions)),
  );
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const context = await Effect.runPromise(Layer.buildWithScope(services, scope));
  let node: http.Server | undefined;
  const auth = await Effect.runPromise(
    Scope.provide(
      Effect.gen(function* () {
        const auth = yield* ServerAuth;
        const server = yield* makeBoundedNodeHttpServer(
          () => {
            node = http.createServer();
            return node;
          },
          { port: 0, host: "127.0.0.1" },
        );
        yield* server.serve(yield* HttpRouter.toHttpEffect(routeLayer));
        return auth;
      }).pipe(Effect.provide(context)),
      scope,
    ),
  );
  const address = (node as http.Server | undefined)?.address();
  if (!address || typeof address !== "object") throw new Error("Missing test listener");
  const origin = `ws://127.0.0.1:${address.port}`;
  const sockets = new Set<WebSocket>();
  const connect = async (headers: Record<string, string>) => {
    const search = makeCurrentWsFeatureCompatibilitySearchParams("auth-test");
    const socket = new WebSocket(`${origin}/ws?${search}`, { headers });
    sockets.add(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        reject(new Error(`Upgrade rejected ${response.statusCode}`));
      });
    });
    return socket;
  };
  const cookieName = (await Effect.runPromise(auth.getDescriptor())).sessionCookieName;
  return {
    auth,
    cookieName,
    connect,
    owner: () => connect({ Authorization: `Bearer ${startupToken}` }),
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

type WireExit = { _tag: string; value?: unknown; cause?: unknown };
let requestId = 0;
function request(
  socket: WebSocket,
  tag: (typeof authMethods)[number],
  payload: unknown = {},
): Promise<WireExit> {
  const id = String(++requestId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`RPC timeout: ${tag}`));
    }, 3000);
    const onMessage = (data: RawData) => {
      const frame = JSON.parse(data.toString()) as {
        _tag: string;
        requestId: string;
        exit: WireExit;
      };
      if (frame._tag !== "Exit" || String(frame.requestId) !== id) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame.exit);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  });
}
async function success(
  socket: WebSocket,
  tag: (typeof authMethods)[number],
  payload: unknown = {},
) {
  const exit = await request(socket, tag, payload);
  expect(exit._tag, JSON.stringify(exit)).toBe("Success");
  return exit.value as Record<string, unknown>;
}

describe("network pairing over the authenticated WebSocket", () => {
  it("uses the admitted startup owner while HTTP auth remains strict, and cannot mint an owner pairing", async () => {
    const f = await fixture();
    try {
      expect(
        (
          await Effect.runPromise(
            f.auth.getSessionState({
              headers: { authorization: `Bearer ${startupToken}` },
              cookies: {},
            }),
          )
        ).authenticated,
      ).toBe(false);
      const socket = await f.owner();
      const state = await success(socket, WS_METHODS.serverGetAuthSession);
      expect(state).toMatchObject({
        authenticated: true,
        role: "owner",
        auth: { policy: "desktop-managed-local" },
      });
      expect(state).not.toHaveProperty("sessionMethod");
      expect(JSON.stringify(state)).not.toContain(startupToken);
      const pairing = await success(socket, WS_METHODS.serverCreateAuthPairingToken, {
        label: "Phone",
        role: "owner",
        sessionId: "forged-owner",
      });
      const links = (await success(
        socket,
        WS_METHODS.serverListAuthPairingLinks,
      )) as unknown as Array<{ id: string; role: string }>;
      expect(links.find((entry) => entry.id === pairing.id)?.role).toBe("client");
      const paired = await Effect.runPromise(
        f.auth.exchangeBootstrapCredentialForBearerSession(String(pairing.credential), metadata),
      );
      expect(paired.role).toBe("client");
      const repeat = await Effect.runPromise(
        Effect.flip(
          f.auth.exchangeBootstrapCredentialForBearerSession(String(pairing.credential), metadata),
        ),
      );
      expect(repeat.status).toBe(401);
      const unused = await success(socket, WS_METHODS.serverCreateAuthPairingToken);
      expect(
        await success(socket, WS_METHODS.serverRevokeAuthPairingLink, { id: unused.id }),
      ).toEqual({ revoked: true });
      expect(
        (
          (await success(socket, WS_METHODS.serverListAuthPairingLinks)) as unknown as Array<{
            id: string;
          }>
        ).some((entry) => entry.id === unused.id),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("lets a paired client read only its own role and rejects every owner-only management RPC", async () => {
    const f = await fixture();
    try {
      const pairing = await Effect.runPromise(f.auth.issuePairingCredential());
      const session = await Effect.runPromise(
        f.auth.exchangeBootstrapCredentialForBearerSession(pairing.credential, metadata),
      );
      const socket = await f.connect({ Authorization: `Bearer ${session.sessionToken}` });
      const state = await success(socket, WS_METHODS.serverGetAuthSession, { role: "owner" });
      expect(state).toMatchObject({
        authenticated: true,
        role: "client",
        sessionMethod: "bearer-session-token",
      });
      expect(JSON.stringify(state)).not.toContain(session.sessionToken);
      const payloads = [
        { label: "forged", role: "owner" },
        {},
        { id: "owner-link" },
        {},
        { sessionId: "other-owner" },
        {},
      ];
      for (const [index, method] of AUTH_MANAGEMENT_WS_METHODS.entries()) {
        const denied = await request(socket, method, payloads[index]);
        expect(denied._tag).toBe("Failure");
        expect(JSON.stringify(denied)).toContain("OWNER_REQUIRED");
        expect(JSON.stringify(denied)).not.toContain(session.sessionToken);
      }
      expect(
        (await Effect.runPromise(f.auth.listPairingLinks())).every(
          (entry) => entry.label !== "forged",
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("keeps the real browser owner's current marker while startup revocation preserves both owners", async () => {
    const f = await fixture();
    try {
      const ownerSession = async () => {
        const url = await Effect.runPromise(f.auth.issueStartupPairingUrl("http://127.0.0.1:3773"));
        const credential = new URLSearchParams(new URL(url).hash.slice(1)).get("token")!;
        const exchanged = await Effect.runPromise(
          f.auth.exchangeBootstrapCredential(credential, metadata),
        );
        return {
          exchanged,
          identity: await Effect.runPromise(
            f.auth.authenticateHttpRequest({
              headers: {},
              cookies: { [f.cookieName]: exchanged.sessionToken },
            }),
          ),
        };
      };
      const first = await ownerSession(),
        other = await ownerSession();
      const browser = await f.connect({
        Cookie: `${f.cookieName}=${first.exchanged.sessionToken}`,
      });
      expect(await success(browser, WS_METHODS.serverGetAuthSession)).toMatchObject({
        role: "owner",
        sessionMethod: "browser-session-cookie",
      });
      const browserClients = (await success(
        browser,
        WS_METHODS.serverListAuthClients,
      )) as unknown as Array<{ sessionId: string; current: boolean }>;
      expect(browserClients.find((entry) => entry.current)?.sessionId).toBe(
        first.identity.sessionId,
      );
      const socket = await f.owner();
      const initial = (await success(
        socket,
        WS_METHODS.serverListAuthClients,
      )) as unknown as Array<{ current: boolean }>;
      expect(initial.every((entry) => !entry.current)).toBe(true);
      const rejected = await request(socket, WS_METHODS.serverRevokeAuthClient, {
        sessionId: other.identity.sessionId,
      });
      expect(rejected._tag).toBe("Failure");
      expect(JSON.stringify(rejected)).toContain("AUTH_FORBIDDEN");
      const pairing = await Effect.runPromise(f.auth.issuePairingCredential());
      const client = await Effect.runPromise(
        f.auth.exchangeBootstrapCredentialForBearerSession(pairing.credential, metadata),
      );
      expect(await success(socket, WS_METHODS.serverRevokeOtherAuthClients)).toEqual({
        revokedCount: 1,
      });
      const remaining = await Effect.runPromise(f.auth.listClientSessions());
      expect(remaining.map((entry) => entry.sessionId).sort()).toEqual(
        [first.identity.sessionId, other.identity.sessionId].sort(),
      );
      expect(
        (
          await Effect.runPromise(
            f.auth.getSessionState({
              headers: { authorization: `Bearer ${client.sessionToken}` },
              cookies: {},
            }),
          )
        ).authenticated,
      ).toBe(false);
      expect(await success(browser, WS_METHODS.serverGetAuthSession)).toMatchObject({
        authenticated: true,
        role: "owner",
      });
    } finally {
      await f.close();
    }
  });

  it("refuses to make a phone pairing code while Allow phone connections is off", async () => {
    const f = await fixture();
    try {
      const socket = await f.owner();
      const denied = await request(socket, WS_METHODS.serverCreateAuthPairingToken, {
        label: "Phone",
        access: "ownerDevice",
      });
      expect(denied._tag).toBe("Failure");
      expect(JSON.stringify(denied)).toContain("AUTH_FORBIDDEN");
      expect(
        (await Effect.runPromise(f.auth.listPairingLinks())).some(
          (entry) => entry.subject === "owner-device",
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("lets only this computer make phone codes, never a phone that is already paired", async () => {
    const f = await fixture(PHONE_ACCESS_ON);
    try {
      const desktop = await f.owner();
      const code = await success(desktop, WS_METHODS.serverCreateAuthPairingToken, {
        label: "Phone",
        access: "ownerDevice",
      });
      const links = (await success(
        desktop,
        WS_METHODS.serverListAuthPairingLinks,
      )) as unknown as Array<{ id: string; role: string; subject: string }>;
      expect(links.find((entry) => entry.id === code.id)).toMatchObject({
        role: "owner",
        subject: "owner-device",
      });
      const phone = await Effect.runPromise(
        f.auth.exchangeBootstrapCredentialForBearerSession(String(code.credential), {
          deviceType: "mobile",
          label: "Phone",
        }),
      );
      expect(phone.role).toBe("owner");

      // The phone is an owner, so it may list and revoke, but it may not mint another phone.
      const fromPhone = await f.connect({ Authorization: `Bearer ${phone.sessionToken}` });
      expect(await success(fromPhone, WS_METHODS.serverGetAuthSession)).toMatchObject({
        role: "owner",
      });
      const denied = await request(fromPhone, WS_METHODS.serverCreateAuthPairingToken, {
        access: "ownerDevice",
      });
      expect(denied._tag).toBe("Failure");
      expect(JSON.stringify(denied)).toContain("AUTH_FORBIDDEN");

      // Relayed by a proxy on this computer, the same phone is still not this computer.
      const relayed = await f.connect({
        Authorization: `Bearer ${phone.sessionToken}`,
        "X-Forwarded-For": "192.168.1.23",
      });
      const relayedDenied = await request(relayed, WS_METHODS.serverCreateAuthPairingToken, {
        access: "ownerDevice",
      });
      expect(JSON.stringify(relayedDenied)).toContain("AUTH_FORBIDDEN");
      // And the desktop's startup token is worth nothing once relayed from elsewhere.
      await expect(
        f.connect({ Authorization: `Bearer ${startupToken}`, "X-Forwarded-For": "192.168.1.23" }),
      ).rejects.toThrow(/Upgrade rejected/);
    } finally {
      await f.close();
    }
  });
});
