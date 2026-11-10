import { generateKeyPairSync } from "node:crypto";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_RECOVERY_KMS_SECRET_ENV,
  ACCOUNT_RECOVERY_ORIGIN_ENV,
  ACCOUNT_RECOVERY_ROLE_ENV,
  makeAccountRecoveryRuntime,
  parseAccountRecoveryRuntimeConfig,
} from "./accountRecoveryRuntime";
import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../../../../auth/Services/ServerSecretStore";

afterEach(() => vi.unstubAllEnvs());

describe("account recovery production runtime", () => {
  it("accepts only a root HTTPS origin, or loopback HTTP for local acceptance", () => {
    expect(
      parseAccountRecoveryRuntimeConfig({
        [ACCOUNT_RECOVERY_ORIGIN_ENV]: "https://recovery.example",
      }),
    ).toMatchObject({
      origin: "https://recovery.example",
      originReason: "ready",
    });
    expect(
      parseAccountRecoveryRuntimeConfig({ [ACCOUNT_RECOVERY_ORIGIN_ENV]: "http://127.0.0.1:8787" }),
    ).toMatchObject({
      origin: "http://127.0.0.1:8787",
      originReason: "ready",
    });
    expect(
      parseAccountRecoveryRuntimeConfig({
        [ACCOUNT_RECOVERY_ORIGIN_ENV]: "https://recovery.example/private",
      }).originReason,
    ).toBe("origin-invalid");
    expect(
      parseAccountRecoveryRuntimeConfig({
        [ACCOUNT_RECOVERY_ORIGIN_ENV]: "http://recovery.example",
      }).originReason,
    ).toBe("origin-invalid");
  });

  it("fails closed when a client origin is absent", async () => {
    vi.stubEnv(ACCOUNT_RECOVERY_ORIGIN_ENV, "");
    const runtime = await Effect.runPromise(makeAccountRecoveryRuntime);
    expect(runtime).toMatchObject({
      transport: null,
      kms: null,
      health: {
        state: "disabled",
        reason: "origin-not-configured",
        role: "client",
        origin: null,
      },
    });
  });

  it("loads an authority KMS only from the named server secret and never generates a replacement", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const encoded = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" }));
    const store: ServerSecretStoreShape = {
      get: vi.fn(() => Effect.succeed(Uint8Array.from(encoded))),
      set: () => Effect.void,
      getOrCreateRandom: () => Effect.die("not used"),
      remove: () => Effect.void,
    };
    vi.stubEnv(ACCOUNT_RECOVERY_ROLE_ENV, "authority");
    vi.stubEnv(ACCOUNT_RECOVERY_KMS_SECRET_ENV, "moss.test.recovery-kms");
    const runtime = await Effect.runPromise(
      makeAccountRecoveryRuntime.pipe(Effect.provide(Layer.succeed(ServerSecretStore, store))),
    );
    expect(runtime.health).toMatchObject({ state: "ready", reason: "ready", role: "authority" });
    expect(runtime.kms?.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(runtime.transport).toBeNull();
    expect(store.get).toHaveBeenCalledWith("moss.test.recovery-kms");
  });

  it("reports malformed authority key material as degraded", async () => {
    const store: ServerSecretStoreShape = {
      get: () => Effect.succeed(new Uint8Array([1, 2, 3])),
      set: () => Effect.void,
      getOrCreateRandom: () => Effect.die("not used"),
      remove: () => Effect.void,
    };
    vi.stubEnv(ACCOUNT_RECOVERY_ROLE_ENV, "authority");
    vi.stubEnv(ACCOUNT_RECOVERY_KMS_SECRET_ENV, "moss.test.recovery-kms");
    const runtime = await Effect.runPromise(
      makeAccountRecoveryRuntime.pipe(Effect.provide(Layer.succeed(ServerSecretStore, store))),
    );
    expect(runtime).toMatchObject({
      kms: null,
      transport: null,
      health: { state: "degraded", reason: "kms-unavailable" },
    });
  });
});
