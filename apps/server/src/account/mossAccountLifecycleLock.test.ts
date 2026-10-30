import { Deferred, Effect, Fiber } from "effect";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { SecretStoreError, type ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";
import { MossCloudAccountServiceError } from "./mossCloudAccountErrors";
import type { MossManagedProviderShape } from "./Services/MossManagedProvider";
import {
  makeMossManagedProviderCoordinator,
  type MossManagedBinding,
} from "./mossAccountLifecycleLock";

const makeSecretStore = (): ServerSecretStoreShape => ({
  get: () => Effect.succeed(null),
  set: () => Effect.void,
  getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
  remove: () => Effect.void,
});

const makePersistedSecretStore = (values: Map<string, Uint8Array>): ServerSecretStoreShape => ({
  get: (name) => Effect.sync(() => values.get(name)?.slice() ?? null),
  set: (name, value) =>
    Effect.sync(() => {
      values.set(name, value.slice());
    }),
  getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
  remove: (name) =>
    Effect.sync(() => {
      values.delete(name);
    }),
});

const provisionInput = (authority: "memfire-phone" | "supabase-google", accessToken: string) => ({
  authority,
  accessToken,
  gatewayBaseUrl: "https://moss.example.test/functions/v1/moss-model-gateway",
  selectionPolicy: "preserve" as const,
});

const makeManagedProvider = () => {
  const provision = vi.fn<MossManagedProviderShape["provision"]>(() => Effect.void);
  const disable = vi.fn<MossManagedProviderShape["disable"]>(() => Effect.void);
  const needsDisable = vi.fn<MossManagedProviderShape["needsDisable"]>(() => Effect.succeed(true));
  const getProvisioningState = vi.fn<MossManagedProviderShape["getProvisioningState"]>(() =>
    Effect.succeed("ready"),
  );
  return {
    provision,
    disable,
    needsDisable,
    getProvisioningState,
  } satisfies MossManagedProviderShape;
};

describe("Moss managed account lifecycle coordinator", () => {
  it("rejects a pending local selection independently of an entered provider provision", async () => {
    const values = new Map<string, Uint8Array>();
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(
      makePersistedSecretStore(values),
      provider,
    );
    await Effect.runPromise(coordinator.provision(provisionInput("memfire-phone", "phone-access")));

    await Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      provider.provision.mockImplementation(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const provisioning = yield* coordinator
        .provision(provisionInput("supabase-google", "google-access"))
        .pipe(Effect.forkChild);
      try {
        yield* Deferred.await(entered);
        const reading = yield* coordinator
          .getLocalActiveAuthority()
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        expect(reading.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(reading)).toEqual(new Error("LOCAL_MANAGED_BINDING_UNAVAILABLE"));
        expect(provisioning.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(provisioning);
        expect(yield* coordinator.getLocalActiveAuthority()).toBe("supabase-google");
      } finally {
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.interrupt(provisioning);
      }
    }).pipe(Effect.scoped, Effect.runPromise);
  });

  it("reads the durable selection across reconstruction and realm changes without provider work", async () => {
    const values = new Map<string, Uint8Array>();
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(
      makePersistedSecretStore(values),
      provider,
    );
    await Effect.runPromise(coordinator.provision(provisionInput("memfire-phone", "phone-access")));
    const reconstructed = makeMossManagedProviderCoordinator(
      makePersistedSecretStore(values),
      provider,
    );
    provider.provision.mockClear();
    expect(await Effect.runPromise(reconstructed.getLocalActiveAuthority())).toBe("memfire-phone");
    expect(provider.getProvisioningState).not.toHaveBeenCalled();
    expect(provider.provision).not.toHaveBeenCalled();
    await Effect.runPromise(
      coordinator.provision(provisionInput("supabase-google", "global-access")),
    );
    expect(await Effect.runPromise(reconstructed.getLocalActiveAuthority())).toBe(
      "supabase-google",
    );
    values.delete("moss.managed.binding");
    expect(await Effect.runPromise(reconstructed.getLocalActiveAuthority())).toBeNull();
    expect(provider.disable).not.toHaveBeenCalled();
    expect(provider.getProvisioningState).not.toHaveBeenCalled();
  });

  it.each(["pending", "corrupt"])(
    "refuses a %s durable selection without using its cached owner",
    async (state) => {
      const values = new Map<string, Uint8Array>();
      const provider = makeManagedProvider();
      const coordinator = makeMossManagedProviderCoordinator(
        makePersistedSecretStore(values),
        provider,
      );
      await Effect.runPromise(
        coordinator.provision(provisionInput("memfire-phone", "phone-access")),
      );
      const active = JSON.parse(new TextDecoder().decode(values.get("moss.managed.binding")));
      values.set(
        "moss.managed.binding",
        new TextEncoder().encode(state === "corrupt" ? "{" : JSON.stringify({ ...active, state })),
      );
      await expect(Effect.runPromise(coordinator.getLocalActiveAuthority())).rejects.toThrow(
        "LOCAL_MANAGED_BINDING_UNAVAILABLE",
      );
      expect(provider.getProvisioningState).not.toHaveBeenCalled();
      expect(provider.disable).not.toHaveBeenCalled();
    },
  );

  it("does not let a late cloud release disable a phone binding", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);

    const phoneBinding = await Effect.runPromise(
      coordinator.provision(provisionInput("memfire-phone", "phone-access")),
    );
    await Effect.runPromise(coordinator.release({ authority: "supabase-google", force: true }));

    expect(provider.disable).not.toHaveBeenCalled();
    expect(phoneBinding.authority).toBe("memfire-phone");
  });

  it("does not let an explicit phone logout disable a cloud binding, then fences cloud", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);

    const cloudBinding = await Effect.runPromise(
      coordinator.provision(provisionInput("supabase-google", "cloud-access")),
    );
    await Effect.runPromise(coordinator.release({ authority: "memfire-phone", force: true }));
    expect(provider.disable).not.toHaveBeenCalled();

    await Effect.runPromise(
      coordinator.release({ authority: "supabase-google", expected: cloudBinding }),
    );
    expect(provider.disable).toHaveBeenCalledOnce();
  });

  it("force-fences the current same-authority generation when logout has a newer token", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);
    await Effect.runPromise(
      coordinator.provision(provisionInput("supabase-google", "older-receipted-token")),
    );

    const released = await Effect.runPromise(
      coordinator.release({
        authority: "supabase-google",
        expected: {
          authority: "supabase-google",
          accessToken: "newer-session-token",
        },
        force: true,
      }),
    );

    expect(released).toBe(true);
    expect(provider.disable).toHaveBeenCalledOnce();
    expect(provider.disable).toHaveBeenCalledWith({
      cleanupFallbackAccessToken: "newer-session-token",
    });
  });

  it("does not use an unscoped force fence when no durable authority receipt exists", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);

    const released = await Effect.runPromise(
      coordinator.release({ authority: "memfire-phone", force: true }),
    );

    expect(released).toBe(false);
    expect(provider.needsDisable).toHaveBeenCalledOnce();
    expect(provider.disable).not.toHaveBeenCalled();
  });

  it("passes the previous active binding hash as cleanup proof during token rotation", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);

    await Effect.runPromise(
      coordinator.provision(provisionInput("memfire-phone", "previous-phone-access")),
    );
    await Effect.runPromise(
      coordinator.provision(provisionInput("memfire-phone", "rotated-phone-access")),
    );

    expect(provider.provision).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accessToken: "rotated-phone-access",
        cleanupAccessTokenHash: createHash("sha256").update("previous-phone-access").digest("hex"),
      }),
    );
    expect(JSON.stringify(provider.provision.mock.calls[1])).not.toContain("previous-phone-access");
  });

  it("recovers a stale paired generation after restart only for the current same-authority binding", async () => {
    const values = new Map<string, Uint8Array>();
    const provider = makeManagedProvider();
    const first = makeMossManagedProviderCoordinator(makePersistedSecretStore(values), provider);
    await Effect.runPromise(
      first.provision(provisionInput("memfire-phone", "current-phone-access")),
    );
    provider.provision.mockClear();
    provider.getProvisioningState.mockReturnValue(Effect.succeed("recoverable-stale"));

    const reconstructed = makeMossManagedProviderCoordinator(
      makePersistedSecretStore(values),
      provider,
    );
    const state = await Effect.runPromise(
      reconstructed.getReconcileState({
        authority: "memfire-phone",
        accessToken: "current-phone-access",
        gatewayBaseUrl: "https://moss.example.test/functions/v1/moss-model-gateway",
      }),
    );
    await Effect.runPromise(
      reconstructed.provision(provisionInput("memfire-phone", "current-phone-access")),
    );

    expect(state).toBe("same-authority-stale");
    expect(provider.provision).toHaveBeenCalledOnce();
    expect(provider.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: "memfire-phone",
        recoverStalePairedGeneration: true,
      }),
    );
    expect(new TextDecoder().decode(values.get("moss.managed.binding"))).not.toContain(
      "current-phone-access",
    );
  });

  it("recovers a fenced paired generation after a same-authority bearer rotation", async () => {
    const values = new Map<string, Uint8Array>();
    const provider = makeManagedProvider();
    const first = makeMossManagedProviderCoordinator(makePersistedSecretStore(values), provider);
    await Effect.runPromise(
      first.provision(provisionInput("memfire-phone", "previous-phone-access")),
    );
    provider.provision.mockClear();
    provider.getProvisioningState.mockReturnValue(Effect.succeed("recoverable-stale"));

    const reconstructed = makeMossManagedProviderCoordinator(
      makePersistedSecretStore(values),
      provider,
    );
    const state = await Effect.runPromise(
      reconstructed.getReconcileState({
        authority: "memfire-phone",
        accessToken: "rotated-phone-access",
        gatewayBaseUrl: "https://moss.example.test/functions/v1/moss-model-gateway",
      }),
    );
    await Effect.runPromise(
      reconstructed.provision(provisionInput("memfire-phone", "rotated-phone-access")),
    );

    expect(state).toBe("same-authority-stale");
    expect(provider.provision).toHaveBeenCalledOnce();
    expect(provider.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: "memfire-phone",
        recoverStalePairedGeneration: true,
        cleanupAccessTokenHash: createHash("sha256").update("previous-phone-access").digest("hex"),
      }),
    );
    expect(JSON.stringify(provider.provision.mock.calls[0])).not.toContain("previous-phone-access");
  });

  it("does not grant paired-generation recovery across realms or token generations", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);
    await Effect.runPromise(
      coordinator.provision(provisionInput("memfire-phone", "phone-generation-access")),
    );
    provider.provision.mockClear();

    await Effect.runPromise(
      coordinator.provision(provisionInput("supabase-google", "cloud-generation-access")),
    );
    await Effect.runPromise(
      coordinator.provision(provisionInput("supabase-google", "rotated-cloud-access")),
    );

    expect(provider.provision).toHaveBeenCalledTimes(2);
    for (const call of provider.provision.mock.calls) {
      expect(call[0]).not.toHaveProperty("recoverStalePairedGeneration");
    }
  });

  it("does not authorize background recovery when an active same-authority surface collides", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);
    await Effect.runPromise(
      coordinator.provision(provisionInput("memfire-phone", "phone-collision-access")),
    );
    provider.provision.mockClear();
    provider.getProvisioningState.mockReturnValue(Effect.succeed("collision"));

    const state = await Effect.runPromise(
      coordinator.getReconcileState({
        authority: "memfire-phone",
        accessToken: "phone-collision-access",
        gatewayBaseUrl: "https://moss.example.test/functions/v1/moss-model-gateway",
      }),
    );

    expect(state).toBe("collision");
    expect(provider.provision).not.toHaveBeenCalled();
  });

  it("does not treat an active binding receipt as current after its launch surfaces are fenced", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);
    await Effect.runPromise(coordinator.provision(provisionInput("memfire-phone", "phone-access")));
    provider.getProvisioningState.mockReturnValueOnce(Effect.succeed("stale"));

    const state = await Effect.runPromise(
      coordinator.getReconcileState({
        authority: "memfire-phone",
        accessToken: "phone-access",
        gatewayBaseUrl: "https://moss.example.test/functions/v1/moss-model-gateway",
      }),
    );

    expect(state).toBe("same-authority-stale");
    expect(provider.getProvisioningState).toHaveBeenCalledWith({
      authority: "memfire-phone",
      accessToken: "phone-access",
      gatewayBaseUrl: "https://moss.example.test/functions/v1/moss-model-gateway",
    });
  });

  it("reports another realm owner without inspecting or replacing its provider surfaces", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);
    await Effect.runPromise(coordinator.provision(provisionInput("memfire-phone", "phone-access")));
    provider.getProvisioningState.mockClear();

    const state = await Effect.runPromise(
      coordinator.getReconcileState({
        authority: "supabase-google",
        accessToken: "cloud-access",
        gatewayBaseUrl: "https://moss.example.test/functions/v1/moss-model-gateway",
      }),
    );

    expect(state).toBe("owned-by-other");
    expect(provider.getProvisioningState).not.toHaveBeenCalled();
    expect(provider.provision).toHaveBeenCalledOnce();
  });

  it("reports a reserved-id collision without authorizing background reprovision", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);
    provider.getProvisioningState.mockReturnValueOnce(Effect.succeed("collision"));

    const state = await Effect.runPromise(
      coordinator.getReconcileState({
        authority: "memfire-phone",
        accessToken: "phone-access",
        gatewayBaseUrl: "https://moss.example.test/functions/v1/moss-model-gateway",
      }),
    );

    expect(state).toBe("collision");
    expect(provider.provision).not.toHaveBeenCalled();
  });

  it("preserves the previous owner hash across cross-realm pending crash retries", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);
    await Effect.runPromise(
      coordinator.provision(provisionInput("memfire-phone", "confirmed-phone-owner-token")),
    );
    provider.provision
      .mockImplementationOnce(() =>
        Effect.fail(
          new MossCloudAccountServiceError({
            code: "persistence_failed",
            message: "injected first crash",
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Effect.fail(
          new MossCloudAccountServiceError({
            code: "persistence_failed",
            message: "injected second crash",
          }),
        ),
      );

    await Effect.runPromise(
      coordinator
        .provision(provisionInput("supabase-google", "first-global-retry-token"))
        .pipe(Effect.exit),
    );
    await Effect.runPromise(
      coordinator
        .provision(provisionInput("supabase-google", "second-global-retry-token"))
        .pipe(Effect.exit),
    );
    await Effect.runPromise(
      coordinator.provision(provisionInput("supabase-google", "final-global-token")),
    );

    const expectedHash = createHash("sha256").update("confirmed-phone-owner-token").digest("hex");
    for (const call of provider.provision.mock.calls.slice(1)) {
      expect(call[0]).toMatchObject({ cleanupAccessTokenHash: expectedHash });
      expect(JSON.stringify(call[0])).not.toContain("confirmed-phone-owner-token");
    }
  });

  it("fences provider surfaces when the active receipt cannot be persisted and releases the pending receipt after restart", async () => {
    const values = new Map<string, Uint8Array>();
    let bindingSetCount = 0;
    const makePersistedStore = (failActiveReceipt: boolean): ServerSecretStoreShape => ({
      get: (name) => Effect.sync(() => values.get(name)?.slice() ?? null),
      set: (name, value) => {
        if (name === "moss.managed.binding") bindingSetCount += 1;
        if (failActiveReceipt && name === "moss.managed.binding" && bindingSetCount === 2) {
          return Effect.fail(
            new SecretStoreError({ message: "injected active receipt persistence failure" }),
          );
        }
        return Effect.sync(() => values.set(name, value.slice())).pipe(Effect.asVoid);
      },
      getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
      remove: (name) => Effect.sync(() => values.delete(name)).pipe(Effect.asVoid),
    });
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makePersistedStore(true), provider);

    const failure = await coordinator
      .provision(provisionInput("supabase-google", "unreceipted-global-token"))
      .pipe(Effect.flip, Effect.runPromise);

    expect(failure).toBeInstanceOf(SecretStoreError);
    expect(provider.disable).toHaveBeenCalledOnce();
    expect(provider.disable).toHaveBeenCalledWith({
      expectedAccessToken: "unreceipted-global-token",
    });
    const pendingBytes = values.get("moss.managed.binding");
    expect(pendingBytes).toBeDefined();
    const pending = JSON.parse(
      new TextDecoder().decode(pendingBytes ?? new Uint8Array()),
    ) as Record<string, unknown>;
    expect(pending).toMatchObject({ state: "pending", authority: "supabase-google" });

    const reconstructed = makeMossManagedProviderCoordinator(makePersistedStore(false), provider);
    const released = await Effect.runPromise(
      reconstructed.release({
        authority: "supabase-google",
        expected: {
          authority: "supabase-google",
          accessToken: "unreceipted-global-token",
        },
        force: true,
      }),
    );

    expect(released).toBe(true);
    expect(provider.disable).toHaveBeenCalledTimes(2);
    expect(provider.disable.mock.calls.at(-1)).toEqual([
      { cleanupFallbackAccessToken: "unreceipted-global-token" },
    ]);
    expect(values.has("moss.managed.binding")).toBe(false);
  });

  it("grants automatic recovery only to the previous owner of a cross-realm pending receipt", async () => {
    const provider = makeManagedProvider();
    const coordinator = makeMossManagedProviderCoordinator(makeSecretStore(), provider);
    await Effect.runPromise(
      coordinator.provision(provisionInput("memfire-phone", "confirmed-phone-token")),
    );
    provider.provision.mockImplementationOnce(() =>
      Effect.fail(
        new MossCloudAccountServiceError({
          code: "persistence_failed",
          message: "injected global claim failure",
        }),
      ),
    );
    await coordinator
      .provision(provisionInput("supabase-google", "failed-global-token"))
      .pipe(Effect.exit, Effect.runPromise);

    const phoneState = await Effect.runPromise(
      coordinator.getReconcileState({
        authority: "memfire-phone",
        accessToken: "confirmed-phone-token",
        gatewayBaseUrl: "https://moss.example.test/functions/v1/moss-model-gateway",
      }),
    );
    const cloudState = await Effect.runPromise(
      coordinator.getReconcileState({
        authority: "supabase-google",
        accessToken: "failed-global-token",
        gatewayBaseUrl: "https://moss.example.test/functions/v1/moss-model-gateway",
      }),
    );

    expect(phoneState).toBe("same-authority-stale");
    expect(cloudState).toBe("owned-by-other");
  });

  it("uses version and authority CAS for double failure and a reconstructed caller", async () => {
    const provider = makeManagedProvider();
    const secretStore = makeSecretStore();
    const coordinator = makeMossManagedProviderCoordinator(secretStore, provider);

    const phoneBinding = await Effect.runPromise(
      coordinator.provision(provisionInput("memfire-phone", "phone-access")),
    );
    await Effect.runPromise(coordinator.release({ authority: "supabase-google", force: true }));
    const reconstructed = makeMossManagedProviderCoordinator(secretStore, provider);
    await Effect.runPromise(
      reconstructed.release({
        authority: "memfire-phone",
        expected: { ...phoneBinding, accessToken: "stale-access" } as MossManagedBinding,
      }),
    );
    expect(provider.disable).not.toHaveBeenCalled();

    await Effect.runPromise(
      reconstructed.release({ authority: "memfire-phone", expected: phoneBinding }),
    );
    expect(provider.disable).toHaveBeenCalledOnce();
  });
});
