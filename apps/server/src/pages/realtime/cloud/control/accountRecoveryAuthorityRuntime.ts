import { Effect, Layer, ServiceMap } from "effect";

import { AccountRecoveryRuntime, type AccountRecoveryRuntimeShape } from "./accountRecoveryRuntime";
import {
  openAccountRecoveryAuthorityFromRuntime,
  type AccountRecoveryTransport,
  type RecoveryAuthorityConfig,
} from "./accountRecoveryAuthority";

/**
 * The hosted authority is a separate deployment boundary. The desktop server
 * only supplies this service when an operator has provisioned the authority's
 * database, account verifier, and trusted page-head lookup.
 *
 * The private KMS key is intentionally absent: AccountRecoveryRuntime loads it
 * from ServerSecretStore only when the process role is explicitly `authority`.
 */
export type AccountRecoveryAuthorityProvision = Omit<RecoveryAuthorityConfig, "kms">;

export class AccountRecoveryAuthorityConfig extends ServiceMap.Service<
  AccountRecoveryAuthorityConfig,
  AccountRecoveryAuthorityProvision | null
>()("moss/pages/accountRecovery/AuthorityConfig") {}

export class AccountRecoveryAuthority extends ServiceMap.Service<
  AccountRecoveryAuthority,
  AccountRecoveryTransport | null
>()("moss/pages/accountRecovery/Authority") {}

/**
 * Compose the authority only from an explicit provision and an authority
 * runtime. Invalid or missing deployment configuration stays fail-closed and
 * leaves the public route unavailable.
 */
export const AccountRecoveryAuthorityLive = Layer.effect(
  AccountRecoveryAuthority,
  Effect.gen(function* () {
    const runtime = yield* AccountRecoveryRuntime;
    const provision = yield* AccountRecoveryAuthorityConfig;
    if (!provision) return null;
    return yield* Effect.try({
      try: () => openAccountRecoveryAuthorityFromRuntime(provision, runtime),
      catch: () => null,
    });
  }),
);

/** Provide a runtime shape to the authority composition in tests or a hosted entry point. */
export const accountRecoveryAuthorityRuntimeLayer = (runtime: AccountRecoveryRuntimeShape) =>
  Layer.succeed(AccountRecoveryRuntime, runtime);

/** A config layer for a deployment wrapper; pass `null` to keep the route disabled. */
export const accountRecoveryAuthorityConfigLayer = (
  provision: AccountRecoveryAuthorityProvision | null,
) => Layer.succeed(AccountRecoveryAuthorityConfig, provision);
