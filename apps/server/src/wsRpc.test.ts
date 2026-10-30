import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  MossEnterpriseKeyState,
  MossCloudAccountId,
  MossCloudAccountState,
  MossNormalizedSessionEvent,
  OrchestrationEvent,
  ProviderSession,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
} from "@synara/contracts";
import {
  CommandId,
  DEVICE_WS_METHODS,
  EventId,
  RuntimeSessionId,
  SidebarSectionId,
  ThreadId,
  TurnId,
  WS_METHODS,
  type MossResourceImportApplyInput,
  type MossResourceImportRollbackInput,
} from "@synara/contracts";
import { Effect, Option, Stream } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ProviderServiceShape } from "./provider/Services/ProviderService.ts";
import {
  type MossEnterpriseKeyAccountShape,
  MossEnterpriseKeyError,
} from "./account/Services/MossEnterpriseKeyAccount.ts";
import type { MossCloudAccountServiceShape } from "./account/Services/MossCloudAccountService.ts";
import { MossCloudAccountServiceError } from "./account/mossCloudAccountErrors.ts";
import type { ProviderDiscoveryServiceShape } from "./provider/Services/ProviderDiscoveryService.ts";
import { makeMossCanonicalFilesystemHelper } from "./provider/mossCanonicalFilesystemHelper.ts";
import { canonicalFilesystemHelperTestArch } from "./provider/mossCanonicalFilesystemHelperTestRuntime.ts";
import { makeMossNativeFilesystemCapability } from "./provider/mossNativeFilesystemCapability.ts";
import {
  WsFeatureAndDeviceRpcGroup,
  makeMossEnterpriseKeyRpcHandlers,
  makeMossCloudAccountRpcHandlers,
  makeMossResourceImportMutationRpcHandlers,
  toMossResourceImportWsRpcError,
  providerAddMarketplaceRpcEffect,
  providerInstallPluginRpcEffect,
  providerListAppsRpcEffect,
  providerListSessionsRpcEffect,
  providerSetPluginEnabledRpcEffect,
  providerSetAppEnabledRpcEffect,
  providerReadAppToolsRpcEffect,
  providerReadAppConnectorRpcEffect,
  providerReadAppConnectorTermsRpcEffect,
  providerStartAppConnectionRpcEffect,
  providerCompleteAppConnectionRpcEffect,
  providerSubscribeNormalizedSessionEventsRpcStream,
  providerUninstallPluginRpcEffect,
  providerRemoveMarketplaceRpcEffect,
  providerUpgradeMarketplaceRpcEffect,
  toThreadUnarchivedShellEvent,
} from "./wsRpc.ts";
import { makeWsDeviceHandlers } from "./device/wsDeviceHandlers.ts";
import { makeMossCanonicalResourceAuthority } from "./provider/mossCanonicalResourceAuthority.ts";
import {
  applyMossResourceImport,
  makeNodeMossOwnershipStore,
  planMossResourceImport,
  rollbackMossResourceImport,
} from "./provider/mossResourceImport.ts";

const execFile = promisify(execFileCallback);
const testHelperPath = join(
  process.cwd(),
  "native/moss-canonical-filesystem-helper/build/moss-canonical-filesystem-helper-ws-rpc-test",
);
const describeWithCanonicalFilesystemHelper =
  canonicalFilesystemHelperTestArch === null ? describe.skip : describe;

beforeAll(async () => {
  if (canonicalFilesystemHelperTestArch === null) return;
  await execFile(
    process.execPath,
    [
      "scripts/build-canonical-filesystem-helper.mjs",
      "--arch",
      canonicalFilesystemHelperTestArch,
      "--test-hooks",
      "--output",
      testHelperPath,
    ],
    { cwd: process.cwd() },
  );
});

afterAll(async () => {
  if (canonicalFilesystemHelperTestArch === null) return;
  await rm(testHelperPath, { force: true });
  await rm(`${testHelperPath}.build.json`, { force: true });
});

function makeTestNativeFilesystemCapability(
  options: Parameters<typeof makeMossNativeFilesystemCapability>[0],
) {
  return makeMossNativeFilesystemCapability({
    ...options,
    filesystemHelper: makeMossCanonicalFilesystemHelper({
      helperPath: testHelperPath,
      timeoutMs: 5_000,
    }),
  });
}

describe("wsRpc legacy Moss account assembly", () => {
  it("keeps device handlers and the served group in parity", () => {
    const deviceMethods = new Set<string>(Object.values(DEVICE_WS_METHODS));
    const deviceHandlerMethods = new Set<string>(Object.keys(makeWsDeviceHandlers(undefined)));
    const servedMethods = new Set<string>(WsFeatureAndDeviceRpcGroup.requests.keys());

    expect(deviceHandlerMethods).toEqual(
      new Set(
        Object.values(DEVICE_WS_METHODS).filter(
          (method) => method !== DEVICE_WS_METHODS.subscribeEvents,
        ),
      ),
    );
    expect([...deviceHandlerMethods].filter((method) => !servedMethods.has(method))).toEqual([]);
    expect([...deviceMethods].filter((method) => !servedMethods.has(method))).toEqual([]);
    expect(
      [...servedMethods].filter(
        (method) => method.startsWith("device.") && !deviceMethods.has(method),
      ),
    ).toEqual([]);
  });

  it("serves no local OTP or API-user procedures beside the regional phone login", () => {
    const methods = [...WsFeatureAndDeviceRpcGroup.requests.keys()];

    expect(methods.filter((method) => /ApiUser|ApiKey/u.test(method))).toEqual([]);
    expect(methods).toContain(WS_METHODS.serverMossAccountSession);
    expect(methods).toContain(WS_METHODS.serverMossAccountStartPhoneLogin);
    expect(methods).toContain(WS_METHODS.serverMossAccountVerifyPhoneLogin);
    expect(methods).toContain(WS_METHODS.serverMossAccountLogout);
    expect(methods).toContain(WS_METHODS.serverMossEnterpriseKeySignIn);
    for (const method of Object.values(DEVICE_WS_METHODS)) {
      expect(methods).toContain(method);
    }
  });
});

describe("wsRpc archive-cohort shell publication", () => {
  it("publishes a fresh sections snapshot when the final root restores a child placement", async () => {
    const rootThreadId = ThreadId.makeUnsafe("thread-inherited-root-shell");
    const childThreadId = ThreadId.makeUnsafe("thread-explicit-child-shell");
    const sectionId = SidebarSectionId.makeUnsafe("section-inherited-root-shell");
    const createdAt = "2026-08-31T00:00:00.000Z";
    const sections = [
      {
        id: sectionId,
        name: "Restored section",
        sortOrder: 0,
        isCollapsed: false,
        items: [
          {
            key: `thread:${childThreadId}`,
            itemType: "thread" as const,
            sortOrder: 0,
            createdAt,
            updatedAt: createdAt,
          },
        ],
        createdAt,
        updatedAt: createdAt,
      },
    ];
    const snapshot = {
      snapshotSequence: 8,
      spaces: [],
      projects: [],
      threads: [],
      sidebarSections: sections,
      updatedAt: createdAt,
    } as unknown as OrchestrationShellSnapshot;
    const restoredThread = {
      id: rootThreadId,
    } as unknown as OrchestrationThreadShell;
    const projectionReadModelQuery = {
      getShellSnapshot: vi.fn(() => Effect.succeed(snapshot)),
      getThreadShellById: vi.fn(() => Effect.succeed(Option.some(restoredThread))),
    };
    const event: Extract<OrchestrationEvent, { type: "thread.unarchived" }> = {
      type: "thread.unarchived",
      sequence: 9,
      eventId: EventId.makeUnsafe("event-inherited-root-shell-restored"),
      aggregateKind: "thread",
      aggregateId: rootThreadId,
      occurredAt: "2026-08-31T00:00:01.000Z",
      commandId: CommandId.makeUnsafe("command-inherited-root-shell-undo"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId: rootThreadId,
        updatedAt: "2026-08-31T00:00:01.000Z",
        restoredSidebarPlacement: null,
        isArchiveCohortFinal: true,
        restoredSidebarPlacements: [
          {
            threadId: childThreadId,
            placement: {
              sectionId,
              sectionCreatedAt: createdAt,
              sortOrder: 0,
            },
          },
        ],
      },
    };

    const result = await Effect.runPromise(
      toThreadUnarchivedShellEvent(projectionReadModelQuery, event),
    );

    expect(result).toEqual(
      Option.some({
        kind: "sidebar-sections-updated",
        sequence: 9,
        sections,
        thread: restoredThread,
      }),
    );
    expect(projectionReadModelQuery.getShellSnapshot).toHaveBeenCalledOnce();
    expect(projectionReadModelQuery.getThreadShellById).toHaveBeenCalledWith(rootThreadId);
  });
});

describeWithCanonicalFilesystemHelper("wsRpc resource-import mutation callers", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("uses the authenticated connection for apply and rollback around a private plan", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-ws-rpc-import-workspace-"));
    const homeDir = await mkdtemp(join(tmpdir(), "moss-ws-rpc-import-home-"));
    const stateParent = await mkdtemp(join(tmpdir(), "moss-ws-rpc-import-state-"));
    roots.push(workspace, homeDir, stateParent);
    await mkdir(join(homeDir, ".claude", "skills", "rpc-caller"), { recursive: true });
    await writeFile(join(homeDir, ".claude", "skills", "rpc-caller", "SKILL.md"), "RPC caller.");

    const stateDir = join(stateParent, "resource-import");
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const authority = makeMossCanonicalResourceAuthority({
      stateDir,
      ownershipStore,
      filesystemCapability: makeTestNativeFilesystemCapability({
        ownershipStore,
        readStage: async (stage) => ownershipStore.readPrivateStage!({ stage }),
      }),
    });
    const plan = await planMossResourceImport({
      cwd: workspace,
      homeDir,
      stateDir: authority.stateDir,
      ownershipStore: authority.ownershipStore,
      ownerId: "owner-a",
      principalId: "owner-a",
      issuer: "moss-server",
      sessionId: "connection-a",
      projectId: "workspace-a",
      workspaceId: "workspace-a",
    });
    const authOptions = (connectionId: string) => ({
      homeDir,
      stateDir: authority.stateDir,
      ownershipStore: authority.ownershipStore,
      filesystemCapability: authority.filesystemCapability,
      ownerId: "owner-a",
      principalId: "owner-a",
      issuer: "moss-server",
      sessionId: connectionId,
      projectId: "workspace-a",
      workspaceId: "workspace-a",
      requireOwner: true,
      authorizedWorkspace: true,
    });
    const handlers = makeMossResourceImportMutationRpcHandlers({
      apply: (input: MossResourceImportApplyInput, connectionId: string) =>
        Effect.tryPromise({
          try: () =>
            applyMossResourceImport({
              cwd: input.cwd,
              plan: input.plan,
              ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
              ...(input.selectionTicket !== undefined
                ? { selectionTicket: input.selectionTicket }
                : {}),
              ...authOptions(connectionId),
            }),
          catch: toMossResourceImportWsRpcError,
        }),
      rollback: (input: MossResourceImportRollbackInput, connectionId: string) =>
        Effect.tryPromise({
          try: () =>
            rollbackMossResourceImport({
              cwd: input.cwd,
              transactionId: input.transactionId,
              ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
              ...authOptions(connectionId),
            }),
          catch: toMossResourceImportWsRpcError,
        }),
    });
    const applyInput = {
      cwd: workspace,
      plan: plan.plan,
      workspaceId: "workspace-a",
    } satisfies MossResourceImportApplyInput;
    const applied = await Effect.runPromise(
      handlers[WS_METHODS.providerResourceImportApply](applyInput, { clientId: "connection-a" }),
    );
    expect(applied.status).toBe("committed");
    const remainingMutationStages = await readdir(
      join(stateDir, "stage", applied.transactionId),
    ).catch((cause: unknown) => {
      expect(cause).toMatchObject({ code: "ENOENT" });
      return [];
    });
    expect(remainingMutationStages).toEqual([]);

    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.providerResourceImportApply](applyInput, {
          clientId: "connection-b",
        }),
      ),
    ).rejects.toMatchObject({ code: "authorization-required" });

    const rollbackInput = {
      cwd: workspace,
      transactionId: applied.transactionId,
      workspaceId: "workspace-a",
    } satisfies MossResourceImportRollbackInput;
    const foreignRollback = await Effect.runPromise(
      handlers[WS_METHODS.providerResourceImportRollback](rollbackInput, {
        clientId: "connection-b",
      }),
    );
    expect(foreignRollback.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "authorization-required" })]),
    );
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.providerResourceImportRollback](rollbackInput, {
          clientId: "connection-a",
        }),
      ),
    ).resolves.toMatchObject({ status: "rolled-back", issues: [] });
  });
});

const signedOutEnterpriseKeyState: MossEnterpriseKeyState = {
  configured: true,
  authenticated: false,
  keyPrefix: null,
  verifiedAt: null,
  modelCount: 0,
  active: false,
};

const makeMossEnterpriseKeyAccount = (
  overrides: Partial<MossEnterpriseKeyAccountShape> = {},
): MossEnterpriseKeyAccountShape => ({
  getState: () => Effect.succeed(signedOutEnterpriseKeyState),
  getActiveAuthorityCredential: () => Effect.succeed(null),
  signIn: () => Effect.succeed(signedOutEnterpriseKeyState),
  activate: () => Effect.succeed(signedOutEnterpriseKeyState),
  signOut: () => Effect.succeed(signedOutEnterpriseKeyState),
  restore: () => Effect.void,
  ...overrides,
});

const signedOutMossCloudState: MossCloudAccountState = {
  configured: true,
  authenticated: false,
  account: null,
  session: null,
  emailVerificationRequired: false,
  modelGatewayConfigured: true,
  authProvider: "supabase_google",
};

const makeMossCloudAccountService = (
  overrides: Partial<MossCloudAccountServiceShape> = {},
): MossCloudAccountServiceShape => ({
  restore: () => Effect.void,
  getState: () => Effect.succeed(signedOutMossCloudState),
  getLocalAuthority: () => Effect.succeed({ identity: null }),
  listAccounts: () => Effect.succeed({ accounts: [] }),
  selectAccount: () => Effect.succeed(signedOutMossCloudState),
  removeAccount: () => Effect.succeed({ state: signedOutMossCloudState, accounts: [] }),
  signUp: () => Effect.succeed({ state: signedOutMossCloudState, verificationRequired: true }),
  signIn: () => Effect.succeed(signedOutMossCloudState),
  startGoogleOAuth: () =>
    Effect.succeed({
      authorizationUrl: "https://moss-test.supabase.co/auth/v1/authorize?provider=google" as never,
      flowId: "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890" as never,
      expiresAt: "2026-08-14T00:00:00.000Z",
    }),
  exchangeGoogleOAuthCode: () => Effect.succeed(signedOutMossCloudState),
  refresh: () => Effect.succeed(signedOutMossCloudState),
  requestPasswordReset: () => Effect.succeed({ ok: true }),
  exchangeCode: () => Effect.succeed(signedOutMossCloudState),
  updatePassword: () => Effect.succeed({ ok: true }),
  logout: () => Effect.succeed({ revoked: true }),
  getAccessToken: () => Effect.succeed("server-only-token"),
  getAuthorityCredential: () =>
    Effect.succeed({
      realm: "supabase-google",
      issuer: "https://moss-test.supabase.co/auth/v1",
      accessToken: "server-only-token",
      gatewayBaseUrl: "https://moss-test.supabase.co/functions/v1/moss-model-gateway",
      realtimeRelayUrl: "https://moss-test.supabase.co/functions/v1/moss-realtime-relay",
    }),
  getGatewayAccessToken: () => Effect.succeed("server-only-token"),
  ...overrides,
});

function makeProviderService(sessions: ReadonlyArray<ProviderSession>) {
  return {
    listSessions: vi.fn(() => Effect.succeed(sessions)),
  } satisfies Pick<ProviderServiceShape, "listSessions">;
}

function makeProviderNormalizedStreamService(events: ReadonlyArray<MossNormalizedSessionEvent>) {
  return {
    streamNormalizedEventsWithReplay: vi.fn((input) =>
      Stream.fromIterable(events.filter((event) => event.threadId === input.threadId)),
    ),
  } satisfies Pick<ProviderServiceShape, "streamNormalizedEventsWithReplay">;
}

function normalizedTextEvent(input: {
  readonly eventId: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly rawSource?: string | undefined;
}): MossNormalizedSessionEvent {
  return {
    eventId: EventId.makeUnsafe(input.eventId),
    type: "text",
    provider: "codex",
    sessionId: RuntimeSessionId.makeUnsafe(input.sessionId),
    threadId: ThreadId.makeUnsafe(input.threadId),
    createdAt: "2026-07-01T00:00:00.000Z",
    rawEventId: EventId.makeUnsafe(`${input.eventId}-raw`),
    payload: {
      text: input.text,
      streamKind: "assistant_text",
      ...(input.rawSource ? { rawSource: input.rawSource } : {}),
    },
  };
}

describe("wsRpc provider.listSessions", () => {
  it("returns an empty ProviderService session aggregate", async () => {
    const providerService = makeProviderService([]);

    const result = await Effect.runPromise(providerListSessionsRpcEffect(providerService));

    expect(result).toEqual({ sessions: [] });
    expect(providerService.listSessions).toHaveBeenCalledOnce();
  });

  it("returns populated ProviderService session metadata through the route boundary", async () => {
    const sessions = [
      {
        providerInstanceId: "codex",
        provider: "codex",
        status: "ready",
        runtimeMode: "full-access",
        cwd: "/repo/moss",
        model: "gpt-5.3-codex",
        threadId: ThreadId.makeUnsafe("thread-session-route"),
        activeTurnId: TurnId.makeUnsafe("turn-session-route"),
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:05.000Z",
      },
    ] satisfies ReadonlyArray<ProviderSession>;
    const providerService = makeProviderService(sessions);

    const result = await Effect.runPromise(providerListSessionsRpcEffect(providerService));

    expect(result).toEqual({ sessions });
    expect(result.sessions[0]).toMatchObject({
      provider: "codex",
      status: "ready",
      runtimeMode: "full-access",
      cwd: "/repo/moss",
      model: "gpt-5.3-codex",
      threadId: ThreadId.makeUnsafe("thread-session-route"),
      updatedAt: "2026-07-01T00:00:05.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("rawSource");
    expect(JSON.stringify(result)).not.toContain("events.jsonl");
    expect(providerService.listSessions).toHaveBeenCalledOnce();
  });
});

describe("wsRpc provider.subscribeNormalizedSessionEvents", () => {
  it("streams only normalized events for the requested thread through the route boundary", async () => {
    const activeThreadId = ThreadId.makeUnsafe("thread-normalized-route-active");
    const secondaryThreadId = ThreadId.makeUnsafe("thread-normalized-route-secondary");
    const events = [
      normalizedTextEvent({
        eventId: "moss-route-active-1",
        threadId: activeThreadId,
        sessionId: "runtime-route-active",
        text: "active route text",
        rawSource: "codex.active.raw",
      }),
      normalizedTextEvent({
        eventId: "moss-route-secondary-1",
        threadId: secondaryThreadId,
        sessionId: "runtime-route-secondary",
        text: "secondary route text",
      }),
      normalizedTextEvent({
        eventId: "moss-route-secondary-2",
        threadId: secondaryThreadId,
        sessionId: "runtime-route-secondary",
        text: "secondary route follow-up",
      }),
    ];
    const providerService = makeProviderNormalizedStreamService(events);

    const streamed = await Effect.runPromise(
      providerSubscribeNormalizedSessionEventsRpcStream(providerService, {
        threadId: secondaryThreadId,
      }).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );

    expect(providerService.streamNormalizedEventsWithReplay).toHaveBeenCalledWith({
      threadId: secondaryThreadId,
    });
    expect(streamed.map((event) => event.threadId)).toEqual([secondaryThreadId, secondaryThreadId]);
    expect(streamed.map((event) => event.payload.text)).toEqual([
      "secondary route text",
      "secondary route follow-up",
    ]);
    expect(JSON.stringify(streamed)).not.toContain("active route text");
    expect(JSON.stringify(streamed)).not.toContain("codex.active.raw");
  });
});

describe("wsRpc Moss enterprise key", () => {
  it("wires every enterprise key RPC method to the server-only account service", async () => {
    const signIn = vi.fn(() => Effect.succeed(signedOutEnterpriseKeyState));
    const activate = vi.fn(() => Effect.succeed(signedOutEnterpriseKeyState));
    const signOut = vi.fn(() => Effect.succeed(signedOutEnterpriseKeyState));
    const handlers = makeMossEnterpriseKeyRpcHandlers(
      makeMossEnterpriseKeyAccount({ signIn, activate, signOut }),
    );
    const input = { apiKey: `moss_sk_${"t".repeat(43)}` };

    await Effect.runPromise(handlers[WS_METHODS.serverMossEnterpriseKeyState]());
    await Effect.runPromise(handlers[WS_METHODS.serverMossEnterpriseKeySignIn](input));
    await Effect.runPromise(handlers[WS_METHODS.serverMossEnterpriseKeyActivate]());
    await Effect.runPromise(handlers[WS_METHODS.serverMossEnterpriseKeySignOut]());

    expect(signIn).toHaveBeenCalledWith(input);
    expect(activate).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledOnce();
    expect(Object.keys(handlers).toSorted()).toEqual(
      [
        WS_METHODS.serverMossEnterpriseKeyState,
        WS_METHODS.serverMossEnterpriseKeySignIn,
        WS_METHODS.serverMossEnterpriseKeyActivate,
        WS_METHODS.serverMossEnterpriseKeySignOut,
      ].toSorted(),
    );
  });

  it("returns the typed error message without the submitted key or its cause", async () => {
    const apiKey = `moss_sk_${"s".repeat(43)}`;
    const handlers = makeMossEnterpriseKeyRpcHandlers(
      makeMossEnterpriseKeyAccount({
        signIn: () =>
          Effect.fail(
            new MossEnterpriseKeyError({
              code: "key_rejected",
              message: "这个企业 API Key 无效或已被吊销。",
              cause: new Error(`unsafe gateway detail ${apiKey}`),
            }),
          ),
      }),
    );

    let caught: unknown;
    try {
      await Effect.runPromise(handlers[WS_METHODS.serverMossEnterpriseKeySignIn]({ apiKey }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      message: "这个企业 API Key 无效或已被吊销。",
      code: "key_rejected",
    });
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(apiKey);
    expect(JSON.stringify(caught)).not.toContain("unsafe gateway detail");
  });
});

describe("wsRpc Moss cloud account", () => {
  it("wires the cloud account RPC methods to the server-only service", async () => {
    const signIn = vi.fn(() => Effect.succeed(signedOutMossCloudState));
    const requestPasswordReset = vi.fn(() => Effect.succeed({ ok: true as const }));
    const listAccounts = vi.fn(() => Effect.succeed({ accounts: [] }));
    const selectAccount = vi.fn(() => Effect.succeed(signedOutMossCloudState));
    const removeAccount = vi.fn(() =>
      Effect.succeed({ state: signedOutMossCloudState, accounts: [] }),
    );
    const startGoogleOAuth = vi.fn(() =>
      Effect.succeed({
        authorizationUrl:
          "https://moss-test.supabase.co/auth/v1/authorize?provider=google" as never,
        flowId: "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890" as never,
        expiresAt: "2026-08-14T00:00:00.000Z",
      }),
    );
    const exchangeGoogleOAuthCode = vi.fn(() => Effect.succeed(signedOutMossCloudState));
    const service = makeMossCloudAccountService({
      signIn,
      requestPasswordReset,
      listAccounts,
      selectAccount,
      removeAccount,
      startGoogleOAuth,
      exchangeGoogleOAuthCode,
    });
    const handlers = makeMossCloudAccountRpcHandlers(service);

    await Effect.runPromise(
      handlers[WS_METHODS.serverMossCloudAccountSignIn]({
        email: "person@example.com",
        password: "password-123",
      }),
    );
    await Effect.runPromise(
      handlers[WS_METHODS.serverMossCloudAccountRequestPasswordReset]({
        email: "person@example.com",
      }),
    );
    await Effect.runPromise(handlers[WS_METHODS.serverMossCloudAccountList]());
    await Effect.runPromise(
      handlers[WS_METHODS.serverMossCloudAccountSelect]({
        accountId: "account-2" as MossCloudAccountId,
      }),
    );
    await Effect.runPromise(
      handlers[WS_METHODS.serverMossCloudAccountRemove]({
        accountId: "account-1" as MossCloudAccountId,
      }),
    );
    await Effect.runPromise(handlers[WS_METHODS.serverMossCloudAccountStartGoogleOAuth]());
    await Effect.runPromise(
      handlers[WS_METHODS.serverMossCloudAccountExchangeGoogleOAuthCode]({
        code: "google-code",
        flowId: "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890" as never,
      }),
    );

    expect(signIn).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "password-123",
    });
    expect(requestPasswordReset).toHaveBeenCalledWith({ email: "person@example.com" });
    expect(listAccounts).toHaveBeenCalledOnce();
    expect(selectAccount).toHaveBeenCalledWith({ accountId: "account-2" });
    expect(removeAccount).toHaveBeenCalledWith({ accountId: "account-1" });
    expect(startGoogleOAuth).toHaveBeenCalledOnce();
    expect(exchangeGoogleOAuthCode).toHaveBeenCalledWith({
      code: "google-code",
      flowId: "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890",
    });
    expect(Object.keys(handlers).toSorted()).toEqual(
      [
        WS_METHODS.serverMossCloudAccountState,
        WS_METHODS.serverMossCloudAccountList,
        WS_METHODS.serverMossCloudAccountSelect,
        WS_METHODS.serverMossCloudAccountRemove,
        WS_METHODS.serverMossCloudAccountSignUp,
        WS_METHODS.serverMossCloudAccountSignIn,
        WS_METHODS.serverMossCloudAccountStartGoogleOAuth,
        WS_METHODS.serverMossCloudAccountExchangeGoogleOAuthCode,
        WS_METHODS.serverMossCloudAccountRefresh,
        WS_METHODS.serverMossCloudAccountRequestPasswordReset,
        WS_METHODS.serverMossCloudAccountExchangeCode,
        WS_METHODS.serverMossCloudAccountUpdatePassword,
        WS_METHODS.serverMossCloudAccountLogout,
      ].toSorted(),
    );
  });

  it("returns a sanitized RPC error without credential-bearing causes", async () => {
    const password = "password-must-not-leak";
    const service = makeMossCloudAccountService({
      signIn: () =>
        Effect.fail(
          new MossCloudAccountServiceError({
            code: "invalid_credentials",
            message: "The email or password is incorrect.",
            cause: new Error(`unsafe upstream detail ${password}`),
          }),
        ),
    });
    const handlers = makeMossCloudAccountRpcHandlers(service);

    let caught: unknown;
    try {
      await Effect.runPromise(
        handlers[WS_METHODS.serverMossCloudAccountSignIn]({
          email: "person@example.com",
          password,
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ message: "The email or password is incorrect." });
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(password);
    expect(JSON.stringify(caught)).not.toContain("unsafe upstream detail");
  });
});

describe("wsRpc native plugin and app operations", () => {
  it("routes exact native payloads through ProviderDiscoveryService", async () => {
    const service = {
      addMarketplace: vi.fn(() =>
        Effect.succeed({
          marketplaceName: "openai-plugins",
          installedRoot: "/tmp/openai-plugins",
          alreadyAdded: false,
        }),
      ),
      removeMarketplace: vi.fn(() =>
        Effect.succeed({ marketplaceName: "openai-curated", installedRoot: null }),
      ),
      upgradeMarketplace: vi.fn(() =>
        Effect.succeed({ selectedMarketplaces: [], upgradedRoots: [], errors: [] }),
      ),
      installPlugin: vi.fn(() =>
        Effect.succeed({ authPolicy: "ON_USE" as const, appsNeedingAuth: [] }),
      ),
      uninstallPlugin: vi.fn(() => Effect.succeed({})),
      setPluginEnabled: vi.fn(() => Effect.succeed({ status: "ok" as const })),
      listApps: vi.fn(() => Effect.succeed({ data: [], nextCursor: null })),
      setAppEnabled: vi.fn(() => Effect.succeed({ status: "okOverridden" as const })),
      readAppTools: vi.fn(() => Effect.succeed({ tools: [] })),
      readAppConnector: vi.fn(() =>
        Effect.succeed({
          connector: {
            id: "connector/github",
            name: "GitHub",
            status: "ACTIVE",
            authMode: "OAUTH" as const,
            requiresLinkParameters: false,
          },
        }),
      ),
      readAppConnectorTerms: vi.fn(() =>
        Effect.succeed({
          terms: {
            blurbs: [],
            personalizationDefault: null,
            personalizationToggleBlurb: null,
          },
        }),
      ),
      startAppConnection: vi.fn(() =>
        Effect.succeed({
          kind: "oauthStarted" as const,
          redirectUrl: "https://github.com/login/oauth/authorize",
        }),
      ),
      completeAppConnection: vi.fn(() =>
        Effect.succeed({ appId: "connector/github", appName: "GitHub" }),
      ),
    } satisfies Pick<
      ProviderDiscoveryServiceShape,
      | "addMarketplace"
      | "removeMarketplace"
      | "upgradeMarketplace"
      | "installPlugin"
      | "uninstallPlugin"
      | "setPluginEnabled"
      | "listApps"
      | "setAppEnabled"
      | "readAppTools"
      | "readAppConnector"
      | "readAppConnectorTerms"
      | "startAppConnection"
      | "completeAppConnection"
    >;
    const marketplaceInput = {
      provider: "codex" as const,
      source: "https://github.com/openai/plugins.git",
      refName: null,
      sparsePaths: ["marketplace.json"],
      cwd: "/repo",
    };
    const installInput = {
      provider: "codex" as const,
      remoteMarketplaceName: "openai-curated",
      pluginName: "github",
      cwd: "/repo",
    };
    const removeInput = {
      provider: "codex" as const,
      marketplaceName: "openai-curated",
      cwd: "/repo",
    };
    const upgradeInput = {
      provider: "codex" as const,
      marketplaceName: null,
      cwd: "/repo",
    };
    const uninstallInput = {
      provider: "codex" as const,
      pluginId: "plugin/github",
      cwd: "/repo",
    };
    const enabledInput = {
      provider: "codex" as const,
      pluginId: "plugin/github",
      enabled: false,
      cwd: "/repo",
    };
    const listAppsInput = {
      provider: "codex" as const,
      cursor: null,
      limit: null,
      threadId: null,
      forceRefetch: false,
      cwd: "/repo",
    };
    const appEnabledInput = {
      provider: "codex" as const,
      appId: "github-app",
      enabled: false,
      cwd: "/repo",
    };
    const appConnectorInput = {
      provider: "codex" as const,
      appId: "connector/github",
      cwd: "/repo",
    };
    const startConnectionInput = {
      ...appConnectorInput,
      callbackUrl: "moss://connector/oauth_callback",
      postAuthUrl: "https://chatgpt.com/gpts/editor#settings/Connectors",
      reauthentication: null,
    };
    const completeConnectionInput = {
      provider: "codex" as const,
      cwd: "/repo",
      fullRedirectUrl: "moss://connector/oauth_callback?code=code&state=state",
    };

    await expect(
      Effect.runPromise(providerAddMarketplaceRpcEffect(service, marketplaceInput)),
    ).resolves.toEqual({
      marketplaceName: "openai-plugins",
      installedRoot: "/tmp/openai-plugins",
      alreadyAdded: false,
    });
    await expect(
      Effect.runPromise(providerRemoveMarketplaceRpcEffect(service, removeInput)),
    ).resolves.toEqual({ marketplaceName: "openai-curated", installedRoot: null });
    await expect(
      Effect.runPromise(providerUpgradeMarketplaceRpcEffect(service, upgradeInput)),
    ).resolves.toEqual({ selectedMarketplaces: [], upgradedRoots: [], errors: [] });
    await expect(
      Effect.runPromise(providerInstallPluginRpcEffect(service, installInput)),
    ).resolves.toEqual({ authPolicy: "ON_USE", appsNeedingAuth: [] });
    await expect(
      Effect.runPromise(providerUninstallPluginRpcEffect(service, uninstallInput)),
    ).resolves.toEqual({});
    await expect(
      Effect.runPromise(providerSetPluginEnabledRpcEffect(service, enabledInput)),
    ).resolves.toEqual({ status: "ok" });
    await expect(
      Effect.runPromise(providerListAppsRpcEffect(service, listAppsInput)),
    ).resolves.toEqual({ data: [], nextCursor: null });
    await expect(
      Effect.runPromise(providerSetAppEnabledRpcEffect(service, appEnabledInput)),
    ).resolves.toEqual({ status: "okOverridden" });
    await expect(
      Effect.runPromise(providerReadAppToolsRpcEffect(service, appConnectorInput)),
    ).resolves.toEqual({ tools: [] });
    await expect(
      Effect.runPromise(providerReadAppConnectorRpcEffect(service, appConnectorInput)),
    ).resolves.toMatchObject({ connector: { id: "connector/github", authMode: "OAUTH" } });
    await expect(
      Effect.runPromise(providerReadAppConnectorTermsRpcEffect(service, appConnectorInput)),
    ).resolves.toMatchObject({ terms: { blurbs: [] } });
    await expect(
      Effect.runPromise(providerStartAppConnectionRpcEffect(service, startConnectionInput)),
    ).resolves.toMatchObject({ kind: "oauthStarted" });
    await expect(
      Effect.runPromise(providerCompleteAppConnectionRpcEffect(service, completeConnectionInput)),
    ).resolves.toEqual({ appId: "connector/github", appName: "GitHub" });

    expect(service.addMarketplace).toHaveBeenCalledWith(marketplaceInput);
    expect(service.removeMarketplace).toHaveBeenCalledWith(removeInput);
    expect(service.upgradeMarketplace).toHaveBeenCalledWith(upgradeInput);
    expect(service.installPlugin).toHaveBeenCalledWith(installInput);
    expect(service.uninstallPlugin).toHaveBeenCalledWith(uninstallInput);
    expect(service.setPluginEnabled).toHaveBeenCalledWith(enabledInput);
    expect(service.listApps).toHaveBeenCalledWith(listAppsInput);
    expect(service.setAppEnabled).toHaveBeenCalledWith(appEnabledInput);
    expect(service.readAppTools).toHaveBeenCalledWith(appConnectorInput);
    expect(service.readAppConnector).toHaveBeenCalledWith(appConnectorInput);
    expect(service.readAppConnectorTerms).toHaveBeenCalledWith(appConnectorInput);
    expect(service.startAppConnection).toHaveBeenCalledWith(startConnectionInput);
    expect(service.completeAppConnection).toHaveBeenCalledWith(completeConnectionInput);
  });
});
