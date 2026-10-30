import type {
  MossAccountLogoutResult,
  MossAccountSessionState,
  MossAccountStartPhoneLoginInput,
  MossAccountStartPhoneLoginResult,
  MossAccountActiveRealmState,
  MossAccountSelectRealmInput,
  MossAccountVerifyPhoneLoginInput,
  MossAccountVerifyPhoneLoginResult,
} from "@synara/contracts";
import type { Effect } from "effect";
import { ServiceMap } from "effect";

import type { MossAccountServiceError } from "../mossAccountErrors";
import type { MossLocalAccountAuthorityState } from "../mossLocalAccountAuthority";

export interface MossMemFirePhoneAuthorityCredential {
  readonly realm: "memfire-phone";
  readonly issuer: string;
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
  readonly realtimeRelayUrl: string;
}

export interface MossPhoneAccountServiceShape {
  readonly getSession: () => Effect.Effect<MossAccountSessionState, MossAccountServiceError>;
  /** Local owner data only; never refreshes or returns an access token. */
  readonly getLocalAuthority: () => Effect.Effect<
    MossLocalAccountAuthorityState,
    MossAccountServiceError
  >;
  /**
   * Validate a durable phone session for server startup without waiting for
   * the regional model catalog or provisioning the managed provider. Invalid
   * or expired credentials may still clear stale managed state. The startup
   * coordinator runs provider/catalog reconciliation separately so a transient
   * CN gateway outage cannot block account admission.
   */
  readonly restoreSession?: () => Effect.Effect<void, MossAccountServiceError>;
  /** Access token for Moss-owned server relays. Never expose it to a renderer. */
  readonly getAccessToken: () => Effect.Effect<string, MossAccountServiceError>;
  /**
   * Realm-bound credential for any caller that can choose between account
   * authorities. The access token must only be sent to the paired gateway and
   * relay origins.
   */
  readonly getAuthorityCredential: () => Effect.Effect<
    MossMemFirePhoneAuthorityCredential,
    MossAccountServiceError
  >;
  /**
   * Make the currently authenticated phone account the explicit active realm.
   * The managed provider is single-active; this switches the reserved surface.
   */
  readonly activateRealm?: (
    input?: MossAccountSelectRealmInput,
  ) => Effect.Effect<MossAccountActiveRealmState, MossAccountServiceError>;
  readonly startPhoneLogin: (
    input: MossAccountStartPhoneLoginInput,
  ) => Effect.Effect<MossAccountStartPhoneLoginResult, MossAccountServiceError>;
  readonly verifyPhoneLogin: (
    input: MossAccountVerifyPhoneLoginInput,
  ) => Effect.Effect<MossAccountVerifyPhoneLoginResult, MossAccountServiceError>;
  readonly logout: () => Effect.Effect<MossAccountLogoutResult, MossAccountServiceError>;
}

export class MossPhoneAccountService extends ServiceMap.Service<
  MossPhoneAccountService,
  MossPhoneAccountServiceShape
>()("moss/account/Services/MossPhoneAccountService") {}
