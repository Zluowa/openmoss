import { assert, it } from "@effect/vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { vi } from "vitest";

import { AuthError } from "./auth/Services/ServerAuth";
import { WsRpcError } from "@synara/contracts";
import {
  authenticateRpcWebSocketUpgrade,
  authorizeDeviceFrameWebSocketUpgrade,
  authorizeMossResourceImportMutation,
  canManageExternalMcp,
  failClosedMossCanonicalResourceMutationError,
  failClosedMossResourceImportAuthorityError,
  MossCanonicalResourceMutationService,
  resolveMossResourceImportServerBinding,
  resolveMossResourceImportStateDir,
  resolveMossResourceImportWorkspace,
  toMossResourceImportWsRpcError,
} from "./wsRpc";
import type { WorkspaceAuthorizationRegistry } from "./wsRpc";

const registeredWorkspaceRoot = resolve("/tmp/moss-workspace");

const allowWorkspace: WorkspaceAuthorizationRegistry = {
  authorize: () => true,
};

it("reserves external MCP management for owner sessions", () => {
  assert.isTrue(canManageExternalMcp("owner"));
  assert.isFalse(canManageExternalMcp("client"));
});

it("derives resource-import authority under the prepared server state root", () => {
  assert.equal(
    resolveMossResourceImportStateDir({ stateDir: "/var/lib/moss/userdata" }),
    resolve("/var/lib/moss/userdata", "resource-import"),
  );
  assert.throws(
    () => resolveMossResourceImportStateDir({ stateDir: "" } as never),
    /prepared server state directory is required/,
  );
});

it("binds resource-import plans to the server connection session", () => {
  assert.deepEqual(resolveMossResourceImportServerBinding("authenticated-session-11"), {
    issuer: "moss-server",
    sessionId: "authenticated-session-11",
  });
  assert.notEqual(
    resolveMossResourceImportServerBinding("authenticated-session-11").sessionId,
    resolveMossResourceImportServerBinding("authenticated-session-12").sessionId,
  );
  assert.notMatch(
    resolveMossResourceImportServerBinding("authenticated-session-11").sessionId,
    /^ws-client-/,
  );
});

it("keeps legacy canonical resource mutation typed fail-closed without native capability", () => {
  const error = failClosedMossCanonicalResourceMutationError();
  assert.equal(error.code, "durability-unsupported");
  assert.equal(
    error.message,
    "Canonical resource mutation requires a native filesystem capability.",
  );
});

it("does not invoke a legacy canonical writer when the capability service is absent", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* MossCanonicalResourceMutationService;
      return yield* service.create(
        { cwd: "/untrusted", planId: "plan-invalid", operationId: "operation-invalid" },
        {
          cwd: "/untrusted",
          ownerId: "owner-1",
          projectId: "project-1",
          workspaceId: "project-1",
          principalId: "session-1",
          sessionId: "session-1",
          issuer: "moss-server",
        },
      );
    }),
  ).then(
    () => null,
    (cause) => cause,
  );
  assert.instanceOf(error, WsRpcError);
  assert.equal((error as WsRpcError).code, "durability-unsupported");
});

it("keeps production import mutations fail-closed and excludes test-only legacy ports", async () => {
  const source = await readFile(join(import.meta.dirname, "wsRpc.ts"), "utf8");
  assert.isFalse(source.includes("yield* MossResourceImportAuthorityProviderTestOnly"));
  const legacyOwnershipStore = { acquireLock: vi.fn() };
  const legacyFilesystemCapability = {
    create: vi.fn(),
    publish: vi.fn(),
    replace: vi.fn(),
    remove: vi.fn(),
  };
  const error = failClosedMossResourceImportAuthorityError();
  assert.equal(error.code, "durability-unsupported");
  assert.equal(legacyOwnershipStore.acquireLock.mock.calls.length, 0);
  assert.equal(legacyFilesystemCapability.create.mock.calls.length, 0);
  assert.equal(legacyFilesystemCapability.publish.mock.calls.length, 0);
  assert.equal(legacyFilesystemCapability.replace.mock.calls.length, 0);
  assert.equal(legacyFilesystemCapability.remove.mock.calls.length, 0);
});

it("binds resource import mutation to an owner and a registered workspace", () => {
  const authorized = authorizeMossResourceImportMutation({
    role: "owner",
    ownerId: "session-owner",
    cwd: registeredWorkspaceRoot,
    workspaceId: "project-1",
    projects: [
      {
        id: "project-1",
        kind: "project",
        workspaceRoot: registeredWorkspaceRoot,
        deletedAt: null,
      },
    ],
    authorizationRegistry: allowWorkspace,
  });
  assert.deepEqual(authorized, { ownerId: "session-owner", workspaceId: "project-1" });
});

it("rejects a client role and forged workspace without touching a filesystem", () => {
  assert.throws(
    () =>
      authorizeMossResourceImportMutation({
        role: "client",
        ownerId: "session-client",
        cwd: registeredWorkspaceRoot,
        workspaceId: "project-1",
        projects: [
          {
            id: "project-1",
            kind: "project",
            workspaceRoot: registeredWorkspaceRoot,
            deletedAt: null,
          },
        ],
      }),
    /Owner authorization is required/,
  );
  assert.throws(
    () =>
      authorizeMossResourceImportMutation({
        role: "owner",
        ownerId: "session-owner",
        cwd: "/tmp/other-workspace",
        workspaceId: "project-1",
        projects: [
          {
            id: "project-1",
            kind: "project",
            workspaceRoot: registeredWorkspaceRoot,
            deletedAt: null,
          },
        ],
      }),
    /workspace path does not match its registration/,
  );
});

it("derives the scan root from the registered project for all importer RPCs", () => {
  const resolved = resolveMossResourceImportWorkspace({
    role: "client",
    ownerId: "session-client",
    cwd: "/tmp/moss-workspace/./nested/..",
    workspaceId: "project-1",
    mutation: false,
    projects: [
      {
        id: "project-1",
        kind: "project",
        workspaceRoot: registeredWorkspaceRoot,
        deletedAt: null,
      },
    ],
    authorizationRegistry: allowWorkspace,
  });

  assert.deepEqual(resolved, {
    cwd: registeredWorkspaceRoot,
    ownerId: "session-client",
    workspaceId: "project-1",
  });
});

it("rejects mutation through a client session even with a registered project", () => {
  assert.throws(
    () =>
      resolveMossResourceImportWorkspace({
        role: "client",
        ownerId: "session-client",
        cwd: registeredWorkspaceRoot,
        workspaceId: "project-1",
        mutation: true,
        projects: [
          {
            id: "project-1",
            kind: "project",
            workspaceRoot: registeredWorkspaceRoot,
            deletedAt: null,
          },
        ],
      }),
    /Owner authorization is required/,
  );
});

it("requires the workspace registry to match the authenticated principal", () => {
  const projects = [
    {
      id: "project-1",
      kind: "project",
      workspaceRoot: registeredWorkspaceRoot,
      deletedAt: null,
    },
  ];
  assert.throws(
    () =>
      resolveMossResourceImportWorkspace({
        role: "owner",
        ownerId: "session-b",
        cwd: registeredWorkspaceRoot,
        workspaceId: "project-1",
        mutation: true,
        authorizationRegistry: {
          authorize: ({ ownerId }) => ownerId === "session-a",
        },
        projects,
      }),
    /not authorized for this owner/,
  );
  const resolved = resolveMossResourceImportWorkspace({
    role: "owner",
    ownerId: "session-a",
    cwd: registeredWorkspaceRoot,
    workspaceId: "project-1",
    mutation: true,
    authorizationRegistry: {
      authorize: ({ ownerId }) => ownerId === "session-a",
    },
    projects,
  });
  assert.deepEqual(resolved, {
    cwd: registeredWorkspaceRoot,
    ownerId: "session-a",
    workspaceId: "project-1",
  });
});

it("returns only a stable typed resource-import error without a raw cause", () => {
  const error = toMossResourceImportWsRpcError(
    new Error("ENOENT /Users/private/.moss secret=do-not-leak"),
  );
  assert.equal(error.code, "copy-failed");
  assert.equal(error.message, "Resource import request failed.");
  assert.equal("cause" in error, false);

  const authorization = toMossResourceImportWsRpcError(
    new WsRpcError({
      code: "authorization-required",
      message: "internal /private/path detail",
      cause: new Error("must not escape"),
    }),
  );
  assert.equal(authorization.code, "authorization-required");
  assert.equal(authorization.message, "Resource import request was rejected.");
  assert.equal("cause" in authorization, false);
});

it("uses an injected workspace registry instead of a project owner field", () => {
  const registry: WorkspaceAuthorizationRegistry = {
    authorize: ({ ownerId, workspaceId, workspaceRoot }) =>
      ownerId === "principal-a" &&
      workspaceId === "project-1" &&
      workspaceRoot === registeredWorkspaceRoot,
  };
  const resolved = resolveMossResourceImportWorkspace({
    role: "owner",
    ownerId: "principal-a",
    cwd: registeredWorkspaceRoot,
    workspaceId: "project-1",
    mutation: true,
    authorizationRegistry: registry,
    projects: [
      {
        id: "project-1",
        kind: "project",
        workspaceRoot: registeredWorkspaceRoot,
        deletedAt: null,
      },
    ],
  });
  assert.deepEqual(resolved, {
    cwd: registeredWorkspaceRoot,
    ownerId: "principal-a",
    workspaceId: "project-1",
  });
});

it.effect("rejects an unauthorized websocket upgrade on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      ),
    );

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "0.0.0.0", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: null,
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://192.168.1.50:3773/ws"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    }).pipe(Effect.flip);

    assert.equal(error.status, 401);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("does not accept a legacy query token on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      ),
    );

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "192.168.1.50", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: "remote-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://192.168.1.50:3773/ws?token=remote-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    }).pipe(Effect.flip);

    assert.equal(error.status, 401);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("accepts an authenticated session on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticatedSession = {
      sessionId: "remote-session" as never,
      subject: "owner-bootstrap",
      method: "browser-session-cookie" as const,
      role: "owner" as const,
    };
    const authenticateWebSocketUpgrade = vi.fn(() => Effect.succeed(authenticatedSession));

    const session = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "0.0.0.0", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: "remote-secret",
      request: {
        headers: {},
        cookies: { "moss-session": "paired-session-credential" },
        url: new URL("http://192.168.1.50:3773/ws?token=remote-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.equal(session, authenticatedSession);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("preserves the legacy query token for loopback desktop sessions", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(new AuthError({ message: "Unexpected authentication call.", status: 500 })),
    );

    const session = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "127.0.0.1", authToken: "desktop-secret", publicUrl: undefined },
      legacyToken: "desktop-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://127.0.0.1:3773/ws?token=desktop-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.equal(session, null);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 0);
  }),
);

it.effect("preserves the legacy loopback token on the device frame socket", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(new AuthError({ message: "Unexpected authentication call.", status: 500 })),
    );

    const authorized = yield* authorizeDeviceFrameWebSocketUpgrade({
      config: { host: "127.0.0.1", authToken: "desktop-secret", publicUrl: undefined },
      legacyToken: "desktop-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://127.0.0.1:3773/ws/device-frames?token=desktop-secret&udid=device-1"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.isTrue(authorized);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 0);
  }),
);

it.effect("rejects an invalid legacy token on a remotely exposed device frame socket", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(new AuthError({ message: "Authentication required.", status: 401 })),
    );

    const authorized = yield* authorizeDeviceFrameWebSocketUpgrade({
      config: { host: "0.0.0.0", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: "wrong-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://192.168.1.50:3773/ws/device-frames?token=wrong-secret&udid=device-1"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.isFalse(authorized);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect(
  "disables the legacy loopback query token when an HTTPS public origin is configured",
  () =>
    Effect.gen(function* () {
      const authenticatedSession = {
        sessionId: "proxy-session" as never,
        subject: "owner-bootstrap",
        method: "browser-session-cookie" as const,
        role: "owner" as const,
      };
      const authenticateWebSocketUpgrade = vi.fn(() => Effect.succeed(authenticatedSession));

      const session = yield* authenticateRpcWebSocketUpgrade({
        config: {
          host: "127.0.0.1",
          authToken: "proxy-secret",
          publicUrl: new URL("https://moss.example.test/"),
        },
        legacyToken: "proxy-secret",
        request: {
          headers: {},
          cookies: { "moss-session": "paired-session-credential" },
          url: new URL("http://127.0.0.1:3773/ws?token=proxy-secret"),
        },
        serverAuth: { authenticateWebSocketUpgrade },
      });

      assert.equal(session, authenticatedSession);
      assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
    }),
);
