import {
  MOSS_DEVELOPER_INITIAL_GRANT_FEN,
  MOSS_DEVELOPER_INITIAL_GRANT_NANO_CNY,
  type MossDeveloperApiKeyRecord,
  type MossDeveloperApiKeysState,
  type MossDeveloperCapability,
  type MossDeveloperCapabilityBreakdown,
  type MossDeveloperCreateApiKeyInput,
  type MossDeveloperCreateApiKeyResult,
  type MossDeveloperLedgerCapability,
  type MossDeveloperLedgerEntry,
  type MossDeveloperLedgerEventType,
  type MossDeveloperRevokeApiKeyInput,
  type MossDeveloperRevokeApiKeyResult,
  type MossDeveloperWalletSummary,
} from "@moss/contracts";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config";
import { isTrustedMossManagedGatewayUrlForAuthority } from "../../provider/mossManagedGatewayTrust";
import { mossPayFetch, MossPayError } from "../mossPayGateway";
import { MossCloudAccountService } from "../Services/MossCloudAccountService";
import { MossDeveloperKeyService } from "../Services/MossDeveloperKeyService";
import { MossPhoneAccountService } from "../Services/MossPhoneAccountService";
import {
  resolveMossPayAuthorityCredential,
  toMossPayError,
  type MossPayAuthorityCredential,
} from "./MossPayService";

const VALID_CAPABILITIES = new Set<MossDeveloperCapability>(["llm", "image", "video", "voice"]);
const VALID_LEDGER_CAPABILITIES = new Set<MossDeveloperLedgerCapability>([
  "grant",
  "llm",
  "image",
  "video",
  "voice",
]);
const VALID_LEDGER_EVENTS = new Set<MossDeveloperLedgerEventType>([
  "initial_grant",
  "reserve",
  "capture",
  "release",
  "debit",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNonNegativeInt(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function asNanoString(value: unknown, fallback = "0"): string {
  if (typeof value === "string" && /^-?(?:0|[1-9][0-9]{0,18})$/u.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return fallback;
}

function asIsoDate(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : new Date(0).toISOString();
}

function parseWalletSummary(raw: unknown): MossDeveloperWalletSummary {
  const rec = asRecord(raw);
  return {
    initialGrantFen: asNonNegativeInt(
      rec.initial_grant_fen ?? rec.initialGrantFen,
      MOSS_DEVELOPER_INITIAL_GRANT_FEN,
    ),
    availableFen: asNonNegativeInt(rec.available_fen ?? rec.availableFen),
    heldFen: asNonNegativeInt(rec.held_fen ?? rec.heldFen),
    spentFen: asNonNegativeInt(rec.spent_fen ?? rec.spentFen),
    availableNanoCny: asNanoString(
      rec.available_nano_cny ?? rec.availableNanoCny,
      MOSS_DEVELOPER_INITIAL_GRANT_NANO_CNY,
    ),
    heldNanoCny: asNanoString(rec.held_nano_cny ?? rec.heldNanoCny, "0"),
    spentNanoCny: asNanoString(rec.spent_nano_cny ?? rec.spentNanoCny, "0"),
  };
}

function parseApiKeyRecord(raw: unknown): MossDeveloperApiKeyRecord | null {
  const rec = asRecord(raw);
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const keyPrefix =
    typeof (rec.key_prefix ?? rec.keyPrefix) === "string"
      ? String(rec.key_prefix ?? rec.keyPrefix).trim()
      : "";
  if (!id || !name || !keyPrefix) return null;
  const rawScopes = Array.isArray(rec.scopes) ? rec.scopes : [];
  const scopes = rawScopes.filter(
    (item): item is MossDeveloperCapability =>
      typeof item === "string" && VALID_CAPABILITIES.has(item as MossDeveloperCapability),
  );
  return {
    id,
    name,
    keyPrefix,
    scopes: scopes.length > 0 ? scopes : ["llm", "image", "video", "voice"],
    status: rec.status === "revoked" ? "revoked" : "active",
    lastUsedAt:
      typeof (rec.last_used_at ?? rec.lastUsedAt) === "string"
        ? String(rec.last_used_at ?? rec.lastUsedAt)
        : null,
    revokedAt:
      typeof (rec.revoked_at ?? rec.revokedAt) === "string"
        ? String(rec.revoked_at ?? rec.revokedAt)
        : null,
    createdAt: asIsoDate(rec.created_at ?? rec.createdAt),
  };
}

function parseBreakdown(raw: unknown): ReadonlyArray<MossDeveloperCapabilityBreakdown> {
  if (!Array.isArray(raw)) return [];
  const result: MossDeveloperCapabilityBreakdown[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const capability = rec.capability;
    if (
      typeof capability !== "string" ||
      !VALID_CAPABILITIES.has(capability as MossDeveloperCapability)
    ) {
      continue;
    }
    result.push({
      capability: capability as MossDeveloperCapability,
      requestCount: asNonNegativeInt(rec.request_count ?? rec.requestCount),
      spentNanoCny: asNanoString(rec.spent_nano_cny ?? rec.spentNanoCny, "0"),
    });
  }
  return result;
}

function parseLedgerEntries(raw: unknown): ReadonlyArray<MossDeveloperLedgerEntry> {
  if (!Array.isArray(raw)) return [];
  const result: MossDeveloperLedgerEntry[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const id = typeof rec.id === "string" ? rec.id : "";
    const eventType = rec.event_type ?? rec.eventType;
    const capability = rec.capability;
    if (
      !id ||
      typeof eventType !== "string" ||
      !VALID_LEDGER_EVENTS.has(eventType as MossDeveloperLedgerEventType) ||
      typeof capability !== "string" ||
      !VALID_LEDGER_CAPABILITIES.has(capability as MossDeveloperLedgerCapability)
    ) {
      continue;
    }
    const rawModelId = rec.model_id ?? rec.modelId;
    const rawApiKeyId = rec.api_key_id ?? rec.apiKeyId;
    result.push({
      id,
      eventType: eventType as MossDeveloperLedgerEventType,
      capability: capability as MossDeveloperLedgerCapability,
      modelId: typeof rawModelId === "string" && rawModelId.trim() ? rawModelId.trim() : null,
      apiKeyId: typeof rawApiKeyId === "string" && rawApiKeyId.trim() ? rawApiKeyId.trim() : null,
      deltaAvailableNanoCny: asNanoString(
        rec.delta_available_nano_cny ?? rec.deltaAvailableNanoCny,
        "0",
      ),
      availableAfterNanoCny: asNanoString(
        rec.available_after_nano_cny ?? rec.availableAfterNanoCny,
        "0",
      ),
      inputTokens: asNonNegativeInt(rec.input_tokens ?? rec.inputTokens),
      outputTokens: asNonNegativeInt(rec.output_tokens ?? rec.outputTokens),
      createdAt: asIsoDate(rec.created_at ?? rec.createdAt),
    });
  }
  return result;
}

export function makeMossDeveloperKeyService(deps: {
  readonly resolveCredential: () => Effect.Effect<MossPayAuthorityCredential, MossPayError>;
  readonly payFetch?: typeof mossPayFetch;
  readonly localGatewayBaseUrl?: string | null;
}) {
  const fetcher = deps.payFetch ?? mossPayFetch;
  const localGatewayBaseUrl = deps.localGatewayBaseUrl ?? null;

  const withGateway = <A>(
    fn: (credential: MossPayAuthorityCredential) => Promise<A>,
  ): Effect.Effect<A, MossPayError> =>
    Effect.gen(function* () {
      const credential = yield* deps.resolveCredential();
      if (
        !isTrustedMossManagedGatewayUrlForAuthority(credential.gatewayBaseUrl, credential.realm)
      ) {
        return yield* Effect.fail(
          new MossPayError({
            code: "not_configured",
            message: "开发者服务暂未配置，请稍后重试。",
          }),
        );
      }
      return yield* Effect.tryPromise({
        try: () => fn(credential),
        catch: toMossPayError,
      });
    });

  const getState = (): Effect.Effect<MossDeveloperApiKeysState, MossPayError> =>
    withGateway(async (credential) => {
      const [keysPayload, quotaPayload] = await Promise.all([
        fetcher({
          realm: credential.realm,
          modelGatewayUrl: credential.gatewayBaseUrl,
          accessToken: credential.accessToken,
          method: "GET",
          path: "/developer/keys",
        }),
        fetcher({
          realm: credential.realm,
          modelGatewayUrl: credential.gatewayBaseUrl,
          accessToken: credential.accessToken,
          method: "GET",
          path: "/developer/quota",
        }),
      ]);
      const keys = (Array.isArray(keysPayload.keys) ? keysPayload.keys : [])
        .map(parseApiKeyRecord)
        .filter((record): record is MossDeveloperApiKeyRecord => record !== null);
      return {
        configured: true,
        authenticated: true,
        gatewayBaseUrl: credential.gatewayBaseUrl.replace(/\/+$/, ""),
        localGatewayBaseUrl,
        wallet: parseWalletSummary(quotaPayload.wallet ?? keysPayload.wallet),
        breakdown: parseBreakdown(quotaPayload.breakdown),
        keys,
        recentLedger: parseLedgerEntries(quotaPayload.recent_ledger ?? quotaPayload.recentLedger),
      };
    }).pipe(
      Effect.catch((error) =>
        error.code === "unauthorized"
          ? Effect.succeed<MossDeveloperApiKeysState>({
              configured: true,
              authenticated: false,
              gatewayBaseUrl: null,
              localGatewayBaseUrl,
              wallet: null,
              breakdown: [],
              keys: [],
              recentLedger: [],
            })
          : Effect.fail(error),
      ),
    );

  const createKey = (
    input: MossDeveloperCreateApiKeyInput,
  ): Effect.Effect<MossDeveloperCreateApiKeyResult, MossPayError> =>
    withGateway(async (credential) => {
      const payload = await fetcher({
        realm: credential.realm,
        modelGatewayUrl: credential.gatewayBaseUrl,
        accessToken: credential.accessToken,
        method: "POST",
        path: "/developer/keys",
        body: {
          name: input.name,
          ...(input.scopes ? { scopes: [...input.scopes] } : {}),
        },
      });
      const key = parseApiKeyRecord(payload.key);
      const secretKey = typeof payload.api_key === "string" ? payload.api_key : "";
      if (!key || !secretKey) {
        throw new MossPayError({
          code: "invalid_response",
          message: "开发者密钥创建响应格式异常，请稍后重试。",
        });
      }
      return {
        key,
        secretKey,
        wallet: parseWalletSummary(payload.wallet),
      };
    });

  const revokeKey = (
    input: MossDeveloperRevokeApiKeyInput,
  ): Effect.Effect<MossDeveloperRevokeApiKeyResult, MossPayError> =>
    withGateway(async (credential) => {
      const payload = await fetcher({
        realm: credential.realm,
        modelGatewayUrl: credential.gatewayBaseUrl,
        accessToken: credential.accessToken,
        method: "POST",
        path: `/developer/keys/${encodeURIComponent(input.keyId)}/revoke`,
        body: {},
      });
      return {
        revoked: payload.revoked === true,
        key: payload.key ? parseApiKeyRecord(payload.key) : null,
      };
    });

  return { getState, createKey, revokeKey };
}

export const MossDeveloperKeyServiceLive = Layer.effect(
  MossDeveloperKeyService,
  Effect.gen(function* () {
    const cloudAccount = yield* MossCloudAccountService;
    const phoneAccount = yield* MossPhoneAccountService;
    const configOption = yield* Effect.serviceOption(ServerConfig);
    const localGatewayBaseUrl = Option.match(configOption, {
      onNone: () => null,
      onSome: (config) => `http://127.0.0.1:${config.port}/api/moss/developer/v1`,
    });

    return makeMossDeveloperKeyService({
      resolveCredential: () =>
        resolveMossPayAuthorityCredential({ phoneAccount, cloudAccount }).pipe(
          Effect.mapError(toMossPayError),
        ),
      localGatewayBaseUrl,
    });
  }),
);
