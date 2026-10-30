import type { MossEnterpriseKeySignInInput, MossEnterpriseKeyState } from "@synara/contracts";
import { Data, Effect, ServiceMap } from "effect";

export class MossEnterpriseKeyError extends Data.TaggedError("MossEnterpriseKeyError")<{
  readonly code:
    | "invalid_key"
    | "not_configured"
    | "key_rejected"
    | "no_entitlement"
    | "gateway_unavailable"
    | "not_signed_in"
    | "persistence_failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Bearer for Moss-owned services beside the managed engines (voice notes,
 * realtime voice, Canvas and media). Usage is reserved against the enterprise
 * account that owns the key, exactly like its text requests.
 */
export interface MossEnterpriseKeyAuthorityCredential {
  readonly realm: "moss-enterprise-key";
  /** Stable authority label; the key has no Auth issuer of its own. */
  readonly issuer: string;
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
  readonly realtimeRelayUrl: string;
  /** Local owner id for desktop data; derived from the key, never the key itself. */
  readonly accountId: string;
}

export interface MossEnterpriseKeyAccountShape {
  readonly getState: () => Effect.Effect<MossEnterpriseKeyState, MossEnterpriseKeyError>;
  /**
   * The key's credential while it owns the managed Moss surface; null when it
   * is signed out or a phone/Google sign-in is active.
   */
  readonly getActiveAuthorityCredential: () => Effect.Effect<
    MossEnterpriseKeyAuthorityCredential | null,
    MossEnterpriseKeyError
  >;
  /** Verify a key against the mainland gateway, save it, and select Moss on it. */
  readonly signIn: (
    input: MossEnterpriseKeySignInInput,
  ) => Effect.Effect<MossEnterpriseKeyState, MossEnterpriseKeyError>;
  /** Re-select the saved key after a phone or Google sign-in took the managed surface. */
  readonly activate: () => Effect.Effect<MossEnterpriseKeyState, MossEnterpriseKeyError>;
  readonly signOut: () => Effect.Effect<MossEnterpriseKeyState, MossEnterpriseKeyError>;
  /** Startup reconciliation; never takes the surface from another signed-in account. */
  readonly restore: () => Effect.Effect<void, MossEnterpriseKeyError>;
}

export class MossEnterpriseKeyAccount extends ServiceMap.Service<
  MossEnterpriseKeyAccount,
  MossEnterpriseKeyAccountShape
>()("moss/account/Services/MossEnterpriseKeyAccount") {}
