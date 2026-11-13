import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../../auth/Services/ServerSecretStore";
import { MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY } from "../../provider/mossManagedGatewayTrust";
import { makeMossManagedProviderCoordinator } from "../mossAccountLifecycleLock";
import type { FetchMossGatewayModelIds, MossGatewayModelCatalog } from "../mossGatewayModels";
import {
  MossManagedProvider,
  type MossManagedProviderShape,
} from "../Services/MossManagedProvider";
import { MossEnterpriseKeyError } from "../Services/MossEnterpriseKeyAccount";
import { makeMossServiceEntryRouter, type MossServiceEntryRouter } from "../mossServiceEntries";
import {
  makeMossEnterpriseKeyAccount,
  MOSS_ENTERPRISE_KEY_SECRET_NAME,
  mossEnterpriseKeyAccountId,
} from "./MossEnterpriseKeyAccount";

const CN_GATEWAY = "https://moss.example.cn/functions/v1/moss-model-gateway";
const ENV = { [MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY]: CN_GATEWAY };
const KEY = `moss_sk_${"k".repeat(43)}`;
const ALL_VENDORS = ["gpt-5.6-terra", "deepseek-v4-pro", "claude-sonnet-5"];

const makeSecretStore = () => {
  const values = new Map<string, Uint8Array>();
  const service: ServerSecretStoreShape = {
    get: (name) => Effect.sync(() => values.get(name)?.slice() ?? null),
    set: (name, value) => Effect.sync(() => values.set(name, value.slice())).pipe(Effect.asVoid),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => values.get(name)?.slice() ?? new Uint8Array(bytes)),
    remove: (name) => Effect.sync(() => values.delete(name)).pipe(Effect.asVoid),
  };
  return { values, service };
};

const makeHarness = (
  catalog: MossGatewayModelCatalog = { status: "ready", models: ALL_VENDORS },
  options: {
    readonly byEntry?: Record<string, MossGatewayModelCatalog>;
    readonly modelGatewayEntries?: MossServiceEntryRouter;
  } = {},
) => {
  const secrets = makeSecretStore();
  let activeAccessToken: string | null = null;
  const provision: MossManagedProviderShape["provision"] = vi.fn((input) =>
    Effect.sync(() => {
      activeAccessToken = input.accessToken;
    }),
  );
  const disable: MossManagedProviderShape["disable"] = vi.fn(() =>
    Effect.sync(() => {
      activeAccessToken = null;
    }),
  );
  const managedProvider: MossManagedProviderShape = {
    provision,
    disable,
    needsDisable: () => Effect.sync(() => activeAccessToken !== null),
    getProvisioningState: (input) =>
      Effect.sync(() => (activeAccessToken === input.accessToken ? "ready" : "stale")),
  };
  const fetchGatewayModels: FetchMossGatewayModelIds = vi.fn((input) =>
    Effect.succeed(options.byEntry?.[input.gatewayBaseUrl] ?? catalog),
  );
  const layer = Layer.merge(
    Layer.succeed(ServerSecretStore, secrets.service),
    Layer.succeed(MossManagedProvider, managedProvider),
  );
  const run = <A, E>(
    use: (
      account: Effect.Success<ReturnType<typeof makeMossEnterpriseKeyAccount>>,
    ) => Effect.Effect<A, E>,
  ) =>
    makeMossEnterpriseKeyAccount({
      env: ENV,
      fetchGatewayModels,
      now: () => 1_800_000_000_000,
      ...(options.modelGatewayEntries ? { modelGatewayEntries: options.modelGatewayEntries } : {}),
    }).pipe(Effect.flatMap(use), Effect.provide(layer), Effect.runPromise);
  return {
    secrets,
    provision,
    disable,
    fetchGatewayModels,
    managedProvider,
    run,
    activeAccessToken: () => activeAccessToken,
  };
};

describe("MossEnterpriseKeyAccount", () => {
  it("signs in with a verified key and selects the all-vendor managed surface", async () => {
    const harness = makeHarness();

    const state = await harness.run((account) => account.signIn({ apiKey: `  ${KEY}  ` }));

    expect(state).toMatchObject({
      configured: true,
      authenticated: true,
      active: true,
      keyPrefix: "moss_sk_kkkk",
      modelCount: ALL_VENDORS.length,
      modelGatewayStatus: "ready",
    });
    expect(harness.fetchGatewayModels).toHaveBeenCalledWith({
      gatewayBaseUrl: CN_GATEWAY,
      accessToken: KEY,
    });
    expect(harness.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: "moss-enterprise-key",
        accessToken: KEY,
        gatewayBaseUrl: CN_GATEWAY,
        models: ALL_VENDORS,
        selectionPolicy: "select",
      }),
    );
    expect(harness.activeAccessToken()).toBe(KEY);
    expect(JSON.stringify(state)).not.toContain(KEY);
  });

  it("rejects a malformed key before contacting the gateway", async () => {
    const harness = makeHarness();

    const error = await harness.run((account) =>
      account.signIn({ apiKey: "sk-or-v1-not-a-moss-key" }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(MossEnterpriseKeyError);
    expect(error.code).toBe("invalid_key");
    expect(harness.fetchGatewayModels).not.toHaveBeenCalled();
    expect(harness.secrets.values.size).toBe(0);
  });

  it("saves nothing when the gateway rejects the key", async () => {
    const harness = makeHarness({ status: "auth-denied", models: [] });

    const error = await harness.run((account) => account.signIn({ apiKey: KEY }).pipe(Effect.flip));

    expect(error.code).toBe("key_rejected");
    expect(harness.provision).not.toHaveBeenCalled();
    expect(harness.secrets.values.has(MOSS_ENTERPRISE_KEY_SECRET_NAME)).toBe(false);
  });

  it("refuses to sign in when this build has no trusted mainland gateway", async () => {
    const harness = makeHarness();

    const error = await makeMossEnterpriseKeyAccount({
      env: {},
      fetchGatewayModels: harness.fetchGatewayModels,
    }).pipe(
      Effect.flatMap((account) => account.signIn({ apiKey: KEY })),
      Effect.flip,
      Effect.provide(
        Layer.merge(
          Layer.succeed(ServerSecretStore, harness.secrets.service),
          Layer.succeed(MossManagedProvider, harness.managedProvider),
        ),
      ),
      Effect.runPromise,
    );

    expect(error.code).toBe("not_configured");
  });

  it("signs out by releasing the managed surface and forgetting the key", async () => {
    const harness = makeHarness();

    const state = await harness.run((account) =>
      account.signIn({ apiKey: KEY }).pipe(Effect.andThen(account.signOut())),
    );

    expect(state).toMatchObject({ authenticated: false, active: false, keyPrefix: null });
    expect(harness.activeAccessToken()).toBeNull();
    expect(harness.secrets.values.has(MOSS_ENTERPRISE_KEY_SECRET_NAME)).toBe(false);
  });

  it("keeps a phone or Google account's surface on restore and reactivates on request", async () => {
    const harness = makeHarness();
    await harness.run((account) => account.signIn({ apiKey: KEY }));
    // A later explicit phone sign-in takes the shared managed surface.
    await makeMossManagedProviderCoordinator(harness.secrets.service, harness.managedProvider)
      .provision({
        authority: "memfire-phone",
        accessToken: "phone-session-token",
        gatewayBaseUrl: CN_GATEWAY,
        selectionPolicy: "select",
      })
      .pipe(Effect.runPromise);
    vi.mocked(harness.provision).mockClear();

    const restored = await harness.run((account) =>
      account.restore().pipe(Effect.andThen(account.getState())),
    );
    expect(harness.provision).not.toHaveBeenCalled();
    expect(restored).toMatchObject({ authenticated: true, active: false });

    const activated = await harness.run((account) => account.activate());
    expect(activated).toMatchObject({ authenticated: true, active: true });
    expect(harness.activeAccessToken()).toBe(KEY);
  });

  it("lends its credential to voice and media only while it owns the managed surface", async () => {
    const harness = makeHarness();
    expect(await harness.run((account) => account.getActiveAuthorityCredential())).toBeNull();

    const active = await harness.run((account) =>
      account.signIn({ apiKey: KEY }).pipe(Effect.andThen(account.getActiveAuthorityCredential())),
    );
    expect(active).toMatchObject({
      realm: "moss-enterprise-key",
      accessToken: KEY,
      gatewayBaseUrl: CN_GATEWAY,
      accountId: mossEnterpriseKeyAccountId(KEY),
    });
    expect(active?.accountId).not.toContain(KEY.slice(8));

    await makeMossManagedProviderCoordinator(harness.secrets.service, harness.managedProvider)
      .provision({
        authority: "memfire-phone",
        accessToken: "phone-session-token",
        gatewayBaseUrl: CN_GATEWAY,
        selectionPolicy: "select",
      })
      .pipe(Effect.runPromise);
    expect(await harness.run((account) => account.getActiveAuthorityCredential())).toBeNull();
  });

  it("drops a revoked key on restore instead of keeping its credential surface", async () => {
    const harness = makeHarness();
    await harness.run((account) => account.signIn({ apiKey: KEY }));
    // The provider surface went stale, so restore has to re-verify the key.
    await harness.managedProvider.disable().pipe(Effect.runPromise);
    vi.mocked(harness.fetchGatewayModels).mockImplementation(() =>
      Effect.succeed({ status: "auth-denied", models: [] }),
    );

    const state = await harness.run((account) =>
      account.restore().pipe(Effect.andThen(account.getState())),
    );

    expect(state).toMatchObject({ authenticated: false, active: false });
    expect(harness.secrets.values.has(MOSS_ENTERPRISE_KEY_SECRET_NAME)).toBe(false);
  });

  it("shows a key revoked since the last launch without deleting what may be its only copy", async () => {
    const harness = makeHarness();
    await harness.run((account) => account.signIn({ apiKey: KEY }));
    vi.mocked(harness.fetchGatewayModels).mockImplementation(() =>
      Effect.succeed({ status: "auth-denied", models: [] }),
    );

    const state = await harness.run((account) =>
      account.restore().pipe(Effect.andThen(account.getState())),
    );

    expect(state).toMatchObject({ authenticated: true, modelGatewayStatus: "auth-denied" });
    expect(harness.secrets.values.has(MOSS_ENTERPRISE_KEY_SECRET_NAME)).toBe(true);
  });

  describe("when an entry resets the connection", () => {
    const CN_FALLBACK = "https://moss-cn-models.example.com/functions/v1/moss-model-gateway";
    const RESET: MossGatewayModelCatalog = {
      status: "transport-degraded",
      models: [],
      connectionFailed: true,
    };
    const twoEntries = () =>
      makeMossServiceEntryRouter({
        service: "CN model gateway",
        entries: [CN_GATEWAY, CN_FALLBACK],
        healthUrl: (entry) => `${new URL(entry).origin}/healthz`,
        probe: async () => true,
      });
    const askedEntries = (harness: ReturnType<typeof makeHarness>) =>
      vi.mocked(harness.fetchGatewayModels).mock.calls.map(([input]) => input.gatewayBaseUrl);

    it("rejects the key only on the HTTP 401 of the entry that answered", async () => {
      const harness = makeHarness(undefined, {
        byEntry: { [CN_GATEWAY]: RESET, [CN_FALLBACK]: { status: "auth-denied", models: [] } },
        modelGatewayEntries: twoEntries(),
      });

      const error = await harness.run((account) =>
        account.signIn({ apiKey: KEY }).pipe(Effect.flip),
      );

      expect(error.code).toBe("key_rejected");
      expect(askedEntries(harness)).toEqual([CN_GATEWAY, CN_FALLBACK]);
      expect(harness.secrets.values.has(MOSS_ENTERPRISE_KEY_SECRET_NAME)).toBe(false);
    });

    it("signs in on the next entry and provisions the lanes with it", async () => {
      const harness = makeHarness(undefined, {
        byEntry: { [CN_GATEWAY]: RESET, [CN_FALLBACK]: { status: "ready", models: ALL_VENDORS } },
        modelGatewayEntries: twoEntries(),
      });

      const state = await harness.run((account) => account.signIn({ apiKey: KEY }));

      expect(state).toMatchObject({
        authenticated: true,
        active: true,
        modelGatewayStatus: "ready",
      });
      expect(askedEntries(harness)).toEqual([CN_GATEWAY, CN_FALLBACK]);
      expect(harness.provision).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayBaseUrl: CN_FALLBACK, accessToken: KEY }),
      );
    });

    it("activates on the next entry too", async () => {
      const router = twoEntries();
      const harness = makeHarness(undefined, { modelGatewayEntries: router });
      await harness.run((account) => account.signIn({ apiKey: KEY }));
      vi.mocked(harness.provision).mockClear();
      vi.mocked(harness.fetchGatewayModels).mockImplementation((input) =>
        Effect.succeed(
          input.gatewayBaseUrl === CN_GATEWAY ? RESET : { status: "ready", models: ALL_VENDORS },
        ),
      );

      const state = await harness.run((account) => account.activate());

      expect(state).toMatchObject({ authenticated: true, active: true });
      expect(harness.provision).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayBaseUrl: CN_FALLBACK }),
      );
      expect(router.current()).toBe(CN_FALLBACK);
    });

    it("reports the gateway unavailable when no entry answers", async () => {
      const harness = makeHarness(undefined, {
        byEntry: { [CN_GATEWAY]: RESET, [CN_FALLBACK]: RESET },
        modelGatewayEntries: twoEntries(),
      });

      const error = await harness.run((account) =>
        account.signIn({ apiKey: KEY }).pipe(Effect.flip),
      );

      expect(error.code).toBe("gateway_unavailable");
      expect(askedEntries(harness)).toEqual([CN_GATEWAY, CN_FALLBACK]);
      expect(harness.provision).not.toHaveBeenCalled();
    });
  });
});
