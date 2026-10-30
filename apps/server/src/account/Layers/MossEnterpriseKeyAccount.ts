// FILE: MossEnterpriseKeyAccount.ts
// Purpose: Sign Moss in with a Moss-issued enterprise API key. The key is the
// bearer the managed engines forward to the mainland gateway (the `enterprise`
// access lane), which serves every model vendor without an overseas network.
// Layer: account (server). The key lives only in the server secret store and in
// the managed provider environment; the renderer sees its display prefix.
import { createHash } from "node:crypto";

import type { MossEnterpriseKeyState } from "@synara/contracts";
import {
  isMossEnterpriseApiKey,
  mossEnterpriseApiKeyDisplayPrefix,
} from "@synara/shared/mossRealmCatalog";
import { Effect, Layer, Semaphore } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import {
  isTrustedMossManagedGatewayUrlForAuthority,
  MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY,
} from "../../provider/mossManagedGatewayTrust";
import {
  makeMossManagedProviderCoordinator,
  type MossManagedBinding,
} from "../mossAccountLifecycleLock";
import {
  fetchMossGatewayModelIds,
  type FetchMossGatewayModelIds,
  type MossGatewayModelCatalogStatus,
  normalizeMossGatewayModelCatalog,
} from "../mossGatewayModels";
import {
  MossEnterpriseKeyAccount,
  type MossEnterpriseKeyAccountShape,
  MossEnterpriseKeyError,
} from "../Services/MossEnterpriseKeyAccount";
import { MossManagedProvider } from "../Services/MossManagedProvider";
import { MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS, normalizeStrictHttpsOrigin } from "../supabaseMossAuth";

const AUTHORITY = "moss-enterprise-key" as const;
export const MOSS_ENTERPRISE_KEY_SECRET_NAME = "moss.enterprise-key";

interface StoredEnterpriseKey {
  readonly version: 1;
  readonly apiKey: string;
  readonly verifiedAt: string;
  readonly modelCount: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function parseStoredKey(bytes: Uint8Array): StoredEnterpriseKey | null {
  try {
    const value: unknown = JSON.parse(textDecoder.decode(bytes));
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      typeof record.apiKey !== "string" ||
      !isMossEnterpriseApiKey(record.apiKey) ||
      typeof record.verifiedAt !== "string" ||
      Number.isNaN(Date.parse(record.verifiedAt)) ||
      typeof record.modelCount !== "number" ||
      !Number.isSafeInteger(record.modelCount) ||
      record.modelCount < 0
    ) {
      return null;
    }
    return {
      version: 1,
      apiKey: record.apiKey,
      verifiedAt: record.verifiedAt,
      modelCount: record.modelCount,
    };
  } catch {
    return null;
  }
}

/** Local owner id for desktop data (media history, Canvas segments): one per key. */
export function mossEnterpriseKeyAccountId(apiKey: string): string {
  return `enterprise-${createHash("sha256").update(apiKey).digest("hex").slice(0, 32)}`;
}

const persistenceFailed = (cause: unknown) =>
  new MossEnterpriseKeyError({
    code: "persistence_failed",
    message: "无法安全保存企业 API Key。",
    cause,
  });

function catalogError(status: Exclude<MossGatewayModelCatalogStatus, "ready">) {
  switch (status) {
    case "auth-denied":
      return new MossEnterpriseKeyError({
        code: "key_rejected",
        message: "这个企业 API Key 无效或已被吊销。",
      });
    case "no-entitlement":
      return new MossEnterpriseKeyError({
        code: "no_entitlement",
        message: "这个企业 API Key 当前没有可用的模型额度。",
      });
    case "transport-degraded":
      return new MossEnterpriseKeyError({
        code: "gateway_unavailable",
        message: "暂时无法连接 Moss 模型服务，请稍后重试。",
      });
  }
}

export interface MakeMossEnterpriseKeyAccountOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchGatewayModels?: FetchMossGatewayModelIds;
  readonly now?: () => number;
}

export const makeMossEnterpriseKeyAccount = Effect.fn(function* (
  options: MakeMossEnterpriseKeyAccountOptions = {},
) {
  const secretStore = yield* ServerSecretStore;
  const managedProvider = yield* MossManagedProvider;
  const coordinator = makeMossManagedProviderCoordinator(secretStore, managedProvider);
  const semaphore = yield* Semaphore.make(1);
  const env = options.env ?? process.env;
  const fetchGatewayModels = options.fetchGatewayModels ?? fetchMossGatewayModelIds;
  const now = options.now ?? Date.now;
  let managedBinding: MossManagedBinding | null = null;
  let modelGatewayStatus: MossGatewayModelCatalogStatus | undefined;

  const serialize = <A>(effect: Effect.Effect<A, MossEnterpriseKeyError>) =>
    semaphore.withPermits(1)(effect);

  /** The enterprise lane shares the mainland gateway of the phone realm. */
  const gatewayBaseUrl = (): string | null => {
    const configured = env[MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY]?.trim();
    return configured && isTrustedMossManagedGatewayUrlForAuthority(configured, AUTHORITY, env)
      ? configured
      : null;
  };

  const readStored = () =>
    secretStore.get(MOSS_ENTERPRISE_KEY_SECRET_NAME).pipe(
      Effect.map((bytes) => (bytes ? parseStoredKey(bytes) : null)),
      Effect.mapError(persistenceFailed),
    );

  const writeStored = (stored: StoredEnterpriseKey) =>
    secretStore
      .set(MOSS_ENTERPRISE_KEY_SECRET_NAME, textEncoder.encode(JSON.stringify(stored)))
      .pipe(Effect.mapError(persistenceFailed));

  const removeStored = () =>
    secretStore.remove(MOSS_ENTERPRISE_KEY_SECRET_NAME).pipe(Effect.mapError(persistenceFailed));

  const readState = (): Effect.Effect<MossEnterpriseKeyState, MossEnterpriseKeyError> =>
    Effect.gen(function* () {
      const stored = yield* readStored();
      const owner = stored
        ? yield* coordinator.getLocalActiveAuthority().pipe(Effect.orElseSucceed(() => null))
        : null;
      return {
        configured: gatewayBaseUrl() !== null,
        authenticated: stored !== null,
        keyPrefix: stored ? mossEnterpriseApiKeyDisplayPrefix(stored.apiKey) : null,
        verifiedAt: stored?.verifiedAt ?? null,
        modelCount: stored?.modelCount ?? 0,
        active: owner === AUTHORITY,
        ...(stored && modelGatewayStatus ? { modelGatewayStatus } : {}),
      };
    });

  const requireGateway = () => {
    const url = gatewayBaseUrl();
    return url
      ? Effect.succeed(url)
      : Effect.fail(
          new MossEnterpriseKeyError({
            code: "not_configured",
            message: "这个版本的 Moss 没有配置企业模型服务。",
          }),
        );
  };

  /** Ask the gateway which models the key may use; only a ready catalog admits it. */
  const verify = (apiKey: string, url: string) =>
    fetchGatewayModels({ gatewayBaseUrl: url, accessToken: apiKey }).pipe(
      Effect.map(normalizeMossGatewayModelCatalog),
      Effect.tap((catalog) =>
        Effect.sync(() => {
          modelGatewayStatus = catalog.status;
        }),
      ),
    );

  const provision = (input: {
    readonly apiKey: string;
    readonly url: string;
    readonly models: ReadonlyArray<string>;
    readonly selectionPolicy: "select" | "preserve";
  }) =>
    coordinator
      .provision({
        authority: AUTHORITY,
        accessToken: input.apiKey,
        gatewayBaseUrl: input.url,
        // The gateway's entitlement-narrowed list is the enterprise contract.
        models: [...input.models],
        selectionPolicy: input.selectionPolicy,
      })
      .pipe(
        Effect.tap((binding) =>
          Effect.sync(() => {
            managedBinding = binding;
          }),
        ),
        Effect.mapError(persistenceFailed),
      );

  const release = (apiKey: string) =>
    coordinator
      .release({
        authority: AUTHORITY,
        expected:
          managedBinding?.accessToken === apiKey
            ? managedBinding
            : { authority: AUTHORITY, accessToken: apiKey },
        force: true,
      })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            managedBinding = null;
          }),
        ),
        Effect.mapError(persistenceFailed),
      );

  const signIn: MossEnterpriseKeyAccountShape["signIn"] = (input) =>
    serialize(
      Effect.gen(function* () {
        const apiKey = input.apiKey.trim();
        if (!isMossEnterpriseApiKey(apiKey)) {
          return yield* new MossEnterpriseKeyError({
            code: "invalid_key",
            message: "请输入以 moss_sk_ 开头的完整企业 API Key。",
          });
        }
        const url = yield* requireGateway();
        const catalog = yield* verify(apiKey, url);
        if (catalog.status !== "ready") return yield* catalogError(catalog.status);

        const previous = yield* readStored();
        const binding = yield* provision({
          apiKey,
          url,
          models: catalog.models,
          selectionPolicy: "select",
        });
        yield* writeStored({
          version: 1,
          apiKey,
          verifiedAt: new Date(now()).toISOString(),
          modelCount: catalog.models.length,
        }).pipe(
          // Never leave a provisioned surface whose key could not be saved.
          Effect.tapError(() =>
            coordinator
              .release({ authority: AUTHORITY, expected: binding, force: true })
              .pipe(Effect.ignore),
          ),
        );
        if (previous && previous.apiKey !== apiKey) {
          yield* Effect.logInfo("replaced the saved Moss enterprise key", {
            previous: mossEnterpriseApiKeyDisplayPrefix(previous.apiKey),
          });
        }
        return yield* readState();
      }),
    );

  const activate: MossEnterpriseKeyAccountShape["activate"] = () =>
    serialize(
      Effect.gen(function* () {
        const stored = yield* readStored();
        if (!stored) {
          return yield* new MossEnterpriseKeyError({
            code: "not_signed_in",
            message: "请先登录企业 API Key。",
          });
        }
        const url = yield* requireGateway();
        const catalog = yield* verify(stored.apiKey, url);
        if (catalog.status !== "ready") return yield* catalogError(catalog.status);
        yield* provision({
          apiKey: stored.apiKey,
          url,
          models: catalog.models,
          selectionPolicy: "select",
        });
        yield* writeStored({
          ...stored,
          verifiedAt: new Date(now()).toISOString(),
          modelCount: catalog.models.length,
        });
        return yield* readState();
      }),
    );

  const signOut: MossEnterpriseKeyAccountShape["signOut"] = () =>
    serialize(
      Effect.gen(function* () {
        const stored = yield* readStored();
        modelGatewayStatus = undefined;
        if (stored) yield* release(stored.apiKey);
        yield* removeStored();
        return yield* readState();
      }),
    );

  const restore: MossEnterpriseKeyAccountShape["restore"] = () =>
    serialize(
      Effect.gen(function* () {
        const stored = yield* readStored();
        const url = gatewayBaseUrl();
        if (!stored || !url) return;
        const reconcile = yield* coordinator
          .getReconcileState({
            authority: AUTHORITY,
            accessToken: stored.apiKey,
            gatewayBaseUrl: url,
          })
          .pipe(Effect.mapError(persistenceFailed));
        // A phone or Google sign-in that owns the surface keeps it until the
        // user explicitly switches back to the enterprise key.
        if (reconcile === "current" || reconcile === "owned-by-other") return;
        if (reconcile === "collision") {
          return yield* persistenceFailed(new Error("managed provider collision"));
        }
        const catalog = yield* verify(stored.apiKey, url);
        if (catalog.status === "auth-denied") {
          // A revoked key must not keep a credential-bearing surface around.
          yield* release(stored.apiKey);
          yield* removeStored();
          return;
        }
        if (catalog.status !== "ready") return;
        yield* provision({
          apiKey: stored.apiKey,
          url,
          models: catalog.models,
          selectionPolicy: "preserve",
        });
      }),
    );

  const getActiveAuthorityCredential: MossEnterpriseKeyAccountShape["getActiveAuthorityCredential"] =
    () =>
      Effect.gen(function* () {
        const stored = yield* readStored();
        const url = gatewayBaseUrl();
        if (!stored || !url) return null;
        const owner = yield* coordinator
          .getLocalActiveAuthority()
          .pipe(Effect.mapError(persistenceFailed));
        if (owner !== AUTHORITY) return null;
        // Realtime voice uses the mainland relay of the lane's realm.
        const relayValue = env[MOSS_MEMFIRE_PHONE_AUTH_ENV_KEYS.realtimeRelayUrl]?.trim();
        const realtimeRelayUrl = relayValue ? normalizeStrictHttpsOrigin(relayValue) : null;
        return {
          realm: AUTHORITY,
          issuer: AUTHORITY,
          accessToken: stored.apiKey,
          gatewayBaseUrl: url,
          realtimeRelayUrl: realtimeRelayUrl ?? "",
          accountId: mossEnterpriseKeyAccountId(stored.apiKey),
        };
      });

  return {
    getState: () => serialize(readState()),
    getActiveAuthorityCredential,
    signIn,
    activate,
    signOut,
    restore,
  } satisfies MossEnterpriseKeyAccountShape;
});

export const MossEnterpriseKeyAccountLive = Layer.effect(
  MossEnterpriseKeyAccount,
  makeMossEnterpriseKeyAccount(),
);
