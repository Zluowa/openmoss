import { createPrivateKey, type KeyObject } from "node:crypto";
import { Effect, Layer, Option, ServiceMap } from "effect";
import { ServerSecretStore } from "../../../../auth/Services/ServerSecretStore";
import { accountRecoveryHttpTransport } from "./accountRecoveryHttp";
import { rsaRecoveryKms, type AccountRecoveryKms } from "./accountRecoveryCrypto";
import type { AccountRecoveryTransport } from "./accountRecoveryAuthority";

/** The origin is deliberately separate from the ordinary page-room relay origin. */
export const ACCOUNT_RECOVERY_ORIGIN_ENV = "MOSS_ACCOUNT_RECOVERY_ORIGIN";
/** This is a ServerSecretStore name, never the private-key value itself. */
export const ACCOUNT_RECOVERY_KMS_SECRET_ENV = "MOSS_ACCOUNT_RECOVERY_KMS_SECRET";
export const ACCOUNT_RECOVERY_ROLE_ENV = "MOSS_ACCOUNT_RECOVERY_ROLE";

export type AccountRecoveryRole = "client" | "authority";
export type AccountRecoveryHealth = {
  state: "disabled" | "degraded" | "ready";
  reason:
    | "origin-not-configured"
    | "origin-invalid"
    | "kms-not-configured"
    | "kms-unavailable"
    | "authority-not-provisioned"
    | "ready";
  role: AccountRecoveryRole;
  origin: string | null;
};

export interface AccountRecoveryRuntimeShape {
  readonly health: AccountRecoveryHealth;
  readonly transport: AccountRecoveryTransport | null;
  /** Present only for an explicitly configured authority process. */
  readonly kms: AccountRecoveryKms | null;
}

export class AccountRecoveryRuntime extends ServiceMap.Service<
  AccountRecoveryRuntime,
  AccountRecoveryRuntimeShape
>()("moss/pages/AccountRecoveryRuntime") {}

const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** Parse process configuration without ever returning a secret value. */
export function parseAccountRecoveryRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const rawOrigin = env[ACCOUNT_RECOVERY_ORIGIN_ENV]?.trim() || null;
  let origin: string | null = null;
  let originReason: AccountRecoveryHealth["reason"] = "origin-not-configured";
  if (rawOrigin) {
    try {
      const url = new URL(rawOrigin);
      if (
        url.origin === rawOrigin &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === "" &&
        (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname)))
      ) {
        origin = url.origin;
        originReason = "ready";
      } else {
        originReason = "origin-invalid";
      }
    } catch {
      originReason = "origin-invalid";
    }
  }
  const role: AccountRecoveryRole =
    env[ACCOUNT_RECOVERY_ROLE_ENV]?.trim() === "authority" ? "authority" : "client";
  const kmsSecretName = env[ACCOUNT_RECOVERY_KMS_SECRET_ENV]?.trim() || null;
  return { role, origin, originReason, kmsSecretName } as const;
}

function privateKeyFromBytes(bytes: Uint8Array): KeyObject {
  if (bytes.byteLength < 1 || bytes.byteLength > 16 * 1024)
    throw new Error("invalid account recovery KMS key");
  return createPrivateKey({ key: Buffer.from(bytes), format: "der", type: "pkcs8" });
}

/**
 * Runtime composition for the production boundary. A desktop/client process
 * receives only the account-recovery origin and never reads a KMS key. An
 * authority process must name a ServerSecretStore entry; missing or malformed
 * key material produces a degraded, unusable service instead of generating a
 * new key and orphaning existing backups.
 */
export const makeAccountRecoveryRuntime = Effect.gen(function* () {
  const config = parseAccountRecoveryRuntimeConfig();
  const store = Option.getOrUndefined(yield* Effect.serviceOption(ServerSecretStore));
  let kms: AccountRecoveryKms | null = null;
  let reason: AccountRecoveryHealth["reason"] = config.originReason;

  if (config.role === "authority") {
    reason = "kms-not-configured";
    if (config.kmsSecretName && store) {
      const bytes = yield* store.get(config.kmsSecretName).pipe(Effect.orElseSucceed(() => null));
      if (bytes) {
        try {
          const key = privateKeyFromBytes(bytes);
          try {
            kms = rsaRecoveryKms(key);
            reason = "ready";
          } finally {
            bytes.fill(0);
          }
        } catch {
          bytes.fill(0);
          reason = "kms-unavailable";
        }
      } else {
        reason = "kms-unavailable";
      }
    }
  }

  const transport =
    config.role === "client" && config.origin ? accountRecoveryHttpTransport(config.origin) : null;
  if (config.role === "client" && !config.origin) reason = config.originReason;
  if (config.role === "client" && config.origin) reason = "ready";
  const health: AccountRecoveryHealth = {
    state:
      reason === "ready" ? "ready" : reason === "origin-not-configured" ? "disabled" : "degraded",
    reason,
    role: config.role,
    origin: config.origin,
  };
  return { health, transport, kms } satisfies AccountRecoveryRuntimeShape;
});

export const AccountRecoveryRuntimeLive = Layer.effect(
  AccountRecoveryRuntime,
  makeAccountRecoveryRuntime,
);
