// FILE: ownerDeviceAccess.ts
// Purpose: Who may pair the owner's phone, and when every paired phone is signed out.
// Layer: Server auth
//
// A phone pairing code hands out owner access. Only this computer may make one, and only
// while the desktop's "Allow phone connections" is on; a phone already paired is an owner
// too, but it is not this computer. With the switch off no phone keeps access.

import { WsRpcError } from "@moss/contracts";
import { isOwnerDeviceSubject } from "@moss/shared/ownerDeviceSession";
import { Effect } from "effect";

import { isLocalOnlyAccess, type LocalAccessConfig } from "../startupAccess";
import { CurrentWsAuthenticatedSession, CurrentWsLocalAccess } from "../wsConnectionSessions";
import type { ServerAuthShape } from "./Services/ServerAuth";

/**
 * The current WebSocket connection came straight from this computer and is not one of the
 * owner's phones (paired by code or admitted through a Moss account).
 */
export const isFromThisComputer = (config: LocalAccessConfig) =>
  Effect.gen(function* () {
    const localAccess = yield* CurrentWsLocalAccess;
    const session = yield* CurrentWsAuthenticatedSession;
    return (
      (localAccess ?? isLocalOnlyAccess(config, undefined)) &&
      !(session && isOwnerDeviceSubject(session.subject))
    );
  });

export const requireOwnerDeviceCodeAccess = (config: LocalAccessConfig) =>
  Effect.gen(function* () {
    const fromThisComputer = yield* isFromThisComputer(config);
    if (config.desktopPhoneAccess === true && fromThisComputer) return;
    return yield* Effect.fail(
      new WsRpcError({
        message: "Pair a phone from the Moss desktop app on this computer.",
        code: "AUTH_FORBIDDEN",
        retryable: false,
      }),
    );
  });

/**
 * Run before the desktop backend listens: with "Allow phone connections" off, sign out
 * every paired phone and withdraw open phone codes. Until a phone has been paired this
 * only reads the local sign-in records. A failure is logged, never fatal to startup.
 */
export const signOutPhonesWhilePhoneAccessOff = (
  config: Pick<LocalAccessConfig, "mode" | "desktopPhoneAccess">,
  auth: Pick<ServerAuthShape, "revokeOwnerDeviceAccess">,
): Effect.Effect<void> =>
  config.mode !== "desktop" || config.desktopPhoneAccess === true
    ? Effect.void
    : auth.revokeOwnerDeviceAccess().pipe(
        Effect.flatMap((revoked) =>
          revoked > 0 ? Effect.logInfo("Signed out paired phones", { revoked }) : Effect.void,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Could not sign out paired phones", { cause: String(cause) }),
        ),
      );
