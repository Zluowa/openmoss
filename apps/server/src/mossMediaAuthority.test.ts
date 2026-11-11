import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ServiceMap } from "effect";
import { MossCloudAccountService } from "./account/Services/MossCloudAccountService";
import { MossEnterpriseKeyAccount } from "./account/Services/MossEnterpriseKeyAccount";
import { MossPhoneAccountService } from "./account/Services/MossPhoneAccountService";
import {
  MOSS_MEDIA_CREDENTIAL_REUSE_MS,
  resetMossMediaCredentialReuse,
  resolveMossMediaCredential,
} from "./mossMediaAuthority";

const gateway = "https://gateway.example/functions/v1/moss-model-gateway/v1";

beforeEach(() => {
  vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gateway);
});
afterEach(() => {
  resetMossMediaCredentialReuse();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function harness(options: { exp?: number | null; validate?: () => Promise<void> } = {}) {
  const state = { accountId: "account-a", validations: 0, fail: false };
  const token = () =>
    `header.${Buffer.from(
      JSON.stringify({
        sub: state.accountId,
        ...(options.exp === null ? {} : { exp: options.exp ?? Date.now() / 1000 + 3600 }),
      }),
    ).toString("base64url")}.signature`;
  const layer = Layer.mergeAll(
    Layer.succeed(MossPhoneAccountService, {
      // Local and cheap: it sees a logout or a switch at once.
      getLocalAuthority: () =>
        Effect.sync(() => ({
          activeRealm: "cn",
          identity: {
            realm: "memfire-phone",
            gatewayBaseUrl: gateway,
            account: { id: state.accountId, realm: "memfire-phone" },
          },
        })),
      getSession: () =>
        Effect.sync(() => ({
          authenticated: true,
          activeRealm: "cn",
          session: { user: { id: state.accountId } },
        })),
      // The network sign-in check the reuse saves.
      getAuthorityCredential: () =>
        Effect.promise(async () => {
          state.validations += 1;
          await options.validate?.();
          if (state.fail) throw new Error("offline");
          return {
            realm: "memfire-phone",
            gatewayBaseUrl: gateway,
            issuer: "https://auth.example",
            realtimeRelayUrl: "wss://relay.example",
            accessToken: token(),
          };
        }).pipe(Effect.orDie),
    } as unknown as ServiceMap.Service.Shape<typeof MossPhoneAccountService>),
    Layer.succeed(MossEnterpriseKeyAccount, {
      getActiveAuthorityCredential: () => Effect.succeed(null),
    } as unknown as ServiceMap.Service.Shape<typeof MossEnterpriseKeyAccount>),
    Layer.succeed(MossCloudAccountService, {
      getState: () => Effect.succeed({ authenticated: false, account: null }),
      getLocalAuthority: () => Effect.succeed({ identity: null }),
    } as unknown as ServiceMap.Service.Shape<typeof MossCloudAccountService>),
  );
  const resolve = () => Effect.runPromise(resolveMossMediaCredential.pipe(Effect.provide(layer)));
  return { state, resolve };
}

describe("resolveMossMediaCredential", () => {
  it("reuses a credential checked a moment ago for the same account", async () => {
    const app = harness();
    const first = await app.resolve();
    const second = await app.resolve();
    expect(second).toEqual(first);
    expect(second.account.id).toBe("account-a");
    expect(app.state.validations).toBe(1);
  });

  it("shares one sign-in check between requests that arrive together", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = harness({ validate: () => gate });
    const pending = Promise.all([app.resolve(), app.resolve(), app.resolve()]);
    await vi.waitFor(() => expect(app.state.validations).toBe(1));
    release();
    const results = await pending;
    expect(new Set(results.map((credential) => credential.accessToken)).size).toBe(1);
    expect(app.state.validations).toBe(1);
  });

  it("checks again as soon as the account on this device changes", async () => {
    const app = harness();
    await app.resolve();
    app.state.accountId = "account-b";
    const switched = await app.resolve();
    expect(switched.account.id).toBe("account-b");
    expect(app.state.validations).toBe(2);
  });

  it("checks again after the reuse window", async () => {
    const app = harness();
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    await app.resolve();
    now.mockReturnValue(start + MOSS_MEDIA_CREDENTIAL_REUSE_MS - 1);
    await app.resolve();
    expect(app.state.validations).toBe(1);
    now.mockReturnValue(start + MOSS_MEDIA_CREDENTIAL_REUSE_MS);
    await app.resolve();
    expect(app.state.validations).toBe(2);
  });

  it("never reuses a bearer close to expiry or without an expiry", async () => {
    const soon = harness({ exp: Date.now() / 1000 + 60 });
    await soon.resolve();
    await soon.resolve();
    expect(soon.state.validations).toBe(2);
    resetMossMediaCredentialReuse();
    const unknown = harness({ exp: null });
    await unknown.resolve();
    await unknown.resolve();
    expect(unknown.state.validations).toBe(2);
  });

  it("never reuses a failed check", async () => {
    const app = harness();
    app.state.fail = true;
    await expect(app.resolve()).rejects.toBeDefined();
    app.state.fail = false;
    await expect(app.resolve()).resolves.toMatchObject({ account: { id: "account-a" } });
    expect(app.state.validations).toBe(2);
  });
});
