import type {
  MossCloudAccountState,
  MossCloudExchangeGoogleOAuthCodeInput,
  MossCloudExchangeCodeInput,
  MossCloudLogoutResult,
  MossCloudListAccountsResult,
  MossCloudMutationResult,
  MossCloudRemoveAccountInput,
  MossCloudRemoveAccountResult,
  MossCloudRequestPasswordResetInput,
  MossCloudSelectAccountInput,
  MossCloudSignInInput,
  MossCloudSignInResult,
  MossCloudSignUpInput,
  MossCloudSignUpResult,
  MossCloudStartGoogleOAuthResult,
  MossCloudUpdatePasswordInput,
  MossAccountActiveRealmState,
  MossAccountSelectRealmInput,
} from "@synara/contracts";
import type { Effect } from "effect";
import { ServiceMap } from "effect";

import type { MossCloudAccountServiceError } from "../mossCloudAccountErrors";
import type { MossLocalAccountAuthorityState } from "../mossLocalAccountAuthority";

export interface MossSupabaseGoogleAuthorityCredential {
  readonly realm: "supabase-google";
  readonly issuer: string;
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
  readonly realtimeRelayUrl: string;
}

export interface MossCloudAccountServiceShape {
  /** Restore the selected server-side session after settings and persistence are ready. */
  readonly restore: () => Effect.Effect<void, MossCloudAccountServiceError>;
  readonly getState: () => Effect.Effect<MossCloudAccountState, MossCloudAccountServiceError>;
  /** Local owner data only; never refreshes or returns an access token. */
  readonly getLocalAuthority: () => Effect.Effect<
    MossLocalAccountAuthorityState,
    MossCloudAccountServiceError
  >;
  readonly listAccounts: () => Effect.Effect<
    MossCloudListAccountsResult,
    MossCloudAccountServiceError
  >;
  readonly selectAccount: (
    input: MossCloudSelectAccountInput,
  ) => Effect.Effect<MossCloudAccountState, MossCloudAccountServiceError>;
  readonly removeAccount: (
    input: MossCloudRemoveAccountInput,
  ) => Effect.Effect<MossCloudRemoveAccountResult, MossCloudAccountServiceError>;
  readonly signUp: (
    input: MossCloudSignUpInput,
  ) => Effect.Effect<MossCloudSignUpResult, MossCloudAccountServiceError>;
  readonly signIn: (
    input: MossCloudSignInInput,
  ) => Effect.Effect<MossCloudSignInResult, MossCloudAccountServiceError>;
  readonly startGoogleOAuth: () => Effect.Effect<
    MossCloudStartGoogleOAuthResult,
    MossCloudAccountServiceError
  >;
  readonly exchangeGoogleOAuthCode: (
    input: MossCloudExchangeGoogleOAuthCodeInput,
  ) => Effect.Effect<MossCloudAccountState, MossCloudAccountServiceError>;
  readonly refresh: () => Effect.Effect<MossCloudAccountState, MossCloudAccountServiceError>;
  readonly requestPasswordReset: (
    input: MossCloudRequestPasswordResetInput,
  ) => Effect.Effect<MossCloudMutationResult, MossCloudAccountServiceError>;
  readonly exchangeCode: (
    input: MossCloudExchangeCodeInput,
  ) => Effect.Effect<MossCloudAccountState, MossCloudAccountServiceError>;
  readonly updatePassword: (
    input: MossCloudUpdatePasswordInput,
  ) => Effect.Effect<MossCloudMutationResult, MossCloudAccountServiceError>;
  readonly logout: () => Effect.Effect<MossCloudLogoutResult, MossCloudAccountServiceError>;
  /** Access token for Moss-owned server relays. Never expose it to a renderer. */
  readonly getAccessToken: () => Effect.Effect<string, MossCloudAccountServiceError>;
  /** Realm-bound credential for callers that can route across account authorities. */
  readonly getAuthorityCredential: () => Effect.Effect<
    MossSupabaseGoogleAuthorityCredential,
    MossCloudAccountServiceError
  >;
  /**
   * Make the currently selected Google account the explicit active realm.
   * The managed provider is single-active; this switches the reserved surface.
   */
  readonly activateRealm?: (
    input?: MossAccountSelectRealmInput,
  ) => Effect.Effect<MossAccountActiveRealmState, MossCloudAccountServiceError>;
  /** @deprecated Prefer getAccessToken for new Moss-owned relay integrations. */
  readonly getGatewayAccessToken: () => Effect.Effect<string, MossCloudAccountServiceError>;
}

export class MossCloudAccountService extends ServiceMap.Service<
  MossCloudAccountService,
  MossCloudAccountServiceShape
>()("moss/account/Services/MossCloudAccountService") {}
