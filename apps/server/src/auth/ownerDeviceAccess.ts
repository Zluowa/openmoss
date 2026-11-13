// FILE: ownerDeviceAccess.ts
// Purpose: Who may pair the owner's phone, and when every paired phone is signed out.
// Layer: Server auth
//
// A phone pairing code hands out owner access. Only this computer may make one, and only
// while the desktop's "Allow phone connections" is on; a phone already paired is an owner
// too, but it is not this computer. With the switch off no phone keeps access.

import { WsRpcError } from "@moss/contracts";
import { Effect } from "effect";

import { isLocalOnlyAccess, type LocalAccessConfig } from "../startupAccess";
import { CurrentWsAuthenticatedSession, CurrentWsLocalAccess } from "../wsConnectionSessions";
import { OWNER_DEVICE_PAIRING_SUBJECT } from "./Layers/ServerAuth";
import type { ServerAuthShape } from "./Services/ServerAuth";

export const requireOwnerDeviceCodeAccess = (config: LocalAccessConfig) =>
  Effect.gen(function* () {
    const localAccess = yield* CurrentWsLocalAccess;
    const session = yield* CurrentWsAuthenticatedSession;
    const fromThisComputer =
      (localAccess ?? isLocalOnlyAccess(config, undefined)) &&
      session?.subject !== OWNER_DEVICE_PAIRING_SUBJECT;
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
