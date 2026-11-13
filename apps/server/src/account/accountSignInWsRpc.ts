// FILE: accountSignInWsRpc.ts
// Purpose: The confirmation side of account sign-in: the Moss window on this computer sees
//   the waiting phones and allows or refuses them. Only the local owner passes: a paired
//   phone, a phone admitted through an account, or anything relayed is refused.
// Layer: account (server) WebSocket handlers
// Exports: makeAccountSignInWsRpcHandlers, requireLocalOwner, guardPhoneAccountChanges,
//   guardCloudAccountChanges
import {
  ACCOUNT_SIGN_IN_WS_METHODS,
  WsRpcError,
  type AuthAccountDecisionInput,
} from "@moss/contracts";
import { Effect, Stream } from "effect";

import { isFromThisComputer } from "../auth/ownerDeviceAccess";
import type { LocalAccessConfig } from "../startupAccess";
import { requireWsOwnerSession } from "../wsOwnerAuthorization";
import type {
  MossAccountPhoneAccessRefused,
  MossAccountPhoneAccessShape,
} from "./Services/MossAccountPhoneAccess";
import type { MossCloudAccountServiceShape } from "./Services/MossCloudAccountService";
import type { MossPhoneAccountServiceShape } from "./Services/MossPhoneAccountService";

const forbidden = () =>
  new WsRpcError({
    message: "Only the Moss window on this computer can answer a phone.",
    code: "AUTH_FORBIDDEN",
    retryable: false,
  });

/** The owner, connected straight from this computer, and not one of the owner's phones. */
export const requireLocalOwner = (config: LocalAccessConfig) =>
  requireWsOwnerSession.pipe(
    Effect.mapError(forbidden),
    Effect.andThen(isFromThisComputer(config)),
    Effect.flatMap((local) => (local ? Effect.void : Effect.fail(forbidden()))),
  );

const toWsError = (refusal: MossAccountPhoneAccessRefused) =>
  new WsRpcError({ message: refusal.message, code: refusal.reason, retryable: false });

const unavailable = () =>
  new WsRpcError({
    message: "Account sign-in is not available on this server.",
    code: "confirmation_unavailable",
    retryable: false,
  });

/**
 * The phone-account service as the WebSocket handlers see it: signing out first removes
 * this computer from the account and ends the phones it let in; signing in to another
 * account does the same for the old one.
 */
export function guardPhoneAccountChanges(
  service: MossPhoneAccountServiceShape,
  access: MossAccountPhoneAccessShape | undefined,
): MossPhoneAccountServiceShape {
  if (!access) return service;
  const realm = "memfire-phone";
  return {
    ...service,
    verifyPhoneLogin: (input) => access.aroundAccountChange(realm, service.verifyPhoneLogin(input)),
    logout: () => access.beforeSignOut(realm).pipe(Effect.andThen(service.logout())),
  };
}

/** The same for the Google (global) account service, which can hold several accounts. */
export function guardCloudAccountChanges(
  service: MossCloudAccountServiceShape,
  access: MossAccountPhoneAccessShape | undefined,
): MossCloudAccountServiceShape {
  if (!access) return service;
  const realm = "supabase-google";
  return {
    ...service,
    selectAccount: (input) => access.aroundAccountChange(realm, service.selectAccount(input)),
    removeAccount: (input) => access.aroundAccountChange(realm, service.removeAccount(input)),
    signUp: (input) => access.aroundAccountChange(realm, service.signUp(input)),
    signIn: (input) => access.aroundAccountChange(realm, service.signIn(input)),
    exchangeGoogleOAuthCode: (input) =>
      access.aroundAccountChange(realm, service.exchangeGoogleOAuthCode(input)),
    exchangeCode: (input) => access.aroundAccountChange(realm, service.exchangeCode(input)),
    logout: () => access.beforeSignOut(realm).pipe(Effect.andThen(service.logout())),
  };
}

export function makeAccountSignInWsRpcHandlers(
  access: MossAccountPhoneAccessShape | undefined,
  config: LocalAccessConfig,
) {
  const localOwner = requireLocalOwner(config);
  const decide =
    (operation: "approve" | "deny") =>
    (input: AuthAccountDecisionInput): Effect.Effect<void, WsRpcError> =>
      localOwner.pipe(
        Effect.andThen(
          access
            ? access[operation](input.requestId).pipe(Effect.mapError(toWsError))
            : Effect.fail(unavailable()),
        ),
      );
  return {
    [ACCOUNT_SIGN_IN_WS_METHODS.subscribe]: () =>
      Stream.unwrap(
        localOwner.pipe(Effect.as(access ? access.pendingRequests : Stream.make({ requests: [] }))),
      ),
    [ACCOUNT_SIGN_IN_WS_METHODS.approve]: decide("approve"),
    [ACCOUNT_SIGN_IN_WS_METHODS.deny]: decide("deny"),
  };
}
