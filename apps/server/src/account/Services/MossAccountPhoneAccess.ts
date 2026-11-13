// FILE: MossAccountPhoneAccess.ts
// Purpose: Lets the owner's phone ask for this computer through the Moss account both are
//   signed in to, with a person at this computer deciding, and keeps this computer listed
//   in that account only while phone access is on.
// Layer: account (server) service contract
// Exports: MossAccountPhoneAccess, MossAccountPhoneAccessShape, MossAccountPhoneAccessRefused,
//   MossAccountRequestSource
import type {
  AuthAccountChallengeResult,
  AuthAccountLoginRefusal,
  AuthAccountPendingRequests,
  AuthAccountRealm,
  AuthAccountRequestResult,
  AuthAccountStatusResult,
  AuthClientMetadata,
} from "@moss/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export class MossAccountPhoneAccessRefused extends Data.TaggedError(
  "MossAccountPhoneAccessRefused",
)<{
  readonly reason: AuthAccountLoginRefusal;
  /** A plain sentence; never a code, token, key or account identifier. */
  readonly message: string;
  readonly status: 401 | 403 | 409 | 410 | 429 | 503;
}> {}

/** Who is asking over the network: the TCP peer address, and what its request says it is. */
export interface MossAccountRequestSource {
  readonly address: string;
  readonly client: AuthClientMetadata;
}

export interface MossAccountPhoneAccessShape {
  /** A one-time code for a phone to write, with its public key, into the shared account. */
  readonly createChallenge: (input: {
    readonly realm: AuthAccountRealm;
    readonly source: MossAccountRequestSource;
  }) => Effect.Effect<AuthAccountChallengeResult, MossAccountPhoneAccessRefused>;
  /**
   * Turns a proven challenge into a pending request that waits for a person at this
   * computer. Grants nothing by itself.
   */
  readonly requestAccess: (input: {
    readonly realm: AuthAccountRealm;
    readonly challengeId: string;
    readonly deviceName?: string | undefined;
    readonly source: MossAccountRequestSource;
  }) => Effect.Effect<AuthAccountRequestResult, MossAccountPhoneAccessRefused>;
  /** Where a pending request stands; once allowed, the session sealed to the phone. */
  readonly requestStatus: (input: {
    readonly requestId: string;
    readonly source: MossAccountRequestSource;
  }) => Effect.Effect<AuthAccountStatusResult, MossAccountPhoneAccessRefused>;
  /** The waiting phones, now and on every change. Only the local owner may subscribe. */
  readonly pendingRequests: Stream.Stream<AuthAccountPendingRequests>;
  /** The local owner allowed the phone: issue its session and seal it. Works once. */
  readonly approve: (requestId: string) => Effect.Effect<void, MossAccountPhoneAccessRefused>;
  /** The local owner refused the phone. Works once. */
  readonly deny: (requestId: string) => Effect.Effect<void, MossAccountPhoneAccessRefused>;
  /** One registry pass: list this computer in each signed-in account, if anything changed. */
  readonly publishComputer: () => Effect.Effect<void>;
  /**
   * With phone access off: remove the entries this computer left behind. True once no local
   * listing record is left.
   */
  readonly withdrawComputer: () => Effect.Effect<boolean>;
  /** Before this computer signs out of a realm: remove its entry, end the phones it let in. */
  readonly beforeSignOut: (realm: AuthAccountRealm) => Effect.Effect<void>;
  /**
   * Around an action that may switch the realm's account: if it did, remove this computer
   * from the old account and end the phones that account let in. Never fails the action.
   */
  readonly aroundAccountChange: <A, E, R>(
    realm: AuthAccountRealm,
    action: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class MossAccountPhoneAccess extends ServiceMap.Service<
  MossAccountPhoneAccess,
  MossAccountPhoneAccessShape
>()("moss/account/Services/MossAccountPhoneAccess") {}
