// FILE: accountLane.ts
// Purpose: The one phone-account check the server uses: whether a mainland China phone
//   account is signed in, and the service lane that follows from it ("cn" or "global").
//   Read from local account state, no network.
// Layer: Server account helper
// Exports: phoneAccountSignedIn, accountLane

import { Effect } from "effect";

import type { MossPhoneAccountServiceShape } from "./Services/MossPhoneAccountService.ts";

type PhoneAccount = Pick<MossPhoneAccountServiceShape, "getLocalAuthority"> | undefined;

/**
 * Whether a phone account is signed in: it has a local identity. An account state that
 * cannot be read counts as not signed in. CN connectors and service plugins, developer
 * reports, place photos and the map provider all read it here.
 */
export const phoneAccountSignedIn = (phoneAccount: PhoneAccount): Effect.Effect<boolean> =>
  phoneAccount === undefined
    ? Effect.succeed(false)
    : phoneAccount.getLocalAuthority().pipe(
        Effect.map((authority) => authority.identity !== null),
        Effect.catch(() => Effect.succeed(false)),
      );

/** The account lane: "cn" while a phone account is signed in, "global" otherwise. */
export const accountLane = (phoneAccount: PhoneAccount): Effect.Effect<"cn" | "global"> =>
  phoneAccountSignedIn(phoneAccount).pipe(
    Effect.map((signedIn): "cn" | "global" => (signedIn ? "cn" : "global")),
  );
