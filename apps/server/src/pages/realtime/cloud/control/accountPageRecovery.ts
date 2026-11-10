import { ServiceMap } from "effect";
import type { ControlRealm } from "./roomControlProtocol";

/** Supplied by the authenticated owner RPC. A revision fence must be current
 * before and after every await. Bearers are kept out of responses and logs. */
export interface AccountPageRecoveryContext {
  realm: ControlRealm;
  tenantRef: string;
  authorityRevision: number;
  signal: AbortSignal;
  assertCurrent(): void;
  currentCredential(): Promise<string>;
}
export interface AccountRecoverablePage {
  recoveryId: string;
  pageId: string;
  title: string;
  checkpointVersion: number;
  confirmedAt: string;
  expiresAt: string;
}
export interface AccountRecoveryTarget {
  scopeSpaceId: null;
  spaceId: string;
}
export interface AccountRecoveryStatus {
  state: "unavailable" | "not-saved" | "confirmed";
  allowed: boolean;
  confirmedCount: number;
  lastConfirmedAt: string | null;
}
export interface AccountRecoveryApi {
  list(ctx: AccountPageRecoveryContext): Promise<{ items: AccountRecoverablePage[] }>;
  restore(
    ctx: AccountPageRecoveryContext,
    input: { recoveryId: string; targetScopeSpaceId: null; expectedCheckpointVersion: number },
  ): Promise<{
    kind: "restored-local-copy";
    pageId: string;
    checkpointVersion: number;
    bundleDigest: string;
  }>;
}
export interface AccountRecoveryPublicationApi {
  status(
    ctx: AccountPageRecoveryContext,
    target: AccountRecoveryTarget,
  ): Promise<AccountRecoveryStatus>;
  saveConfirmed(ctx: AccountPageRecoveryContext, target: AccountRecoveryTarget): Promise<unknown>;
  revoke(ctx: AccountPageRecoveryContext, target: AccountRecoveryTarget): Promise<unknown>;
}
export class AccountPageRecovery extends ServiceMap.Service<
  AccountPageRecovery,
  AccountRecoveryApi
>()("moss/pages/AccountPageRecovery") {}
export class AccountRecoveryPublication extends ServiceMap.Service<
  AccountRecoveryPublication,
  AccountRecoveryPublicationApi
>()("moss/pages/AccountRecoveryPublication") {}
