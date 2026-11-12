// FILE: MossManagedTurnPreflight.ts
// Purpose: Rotates a Moss lane before a send when its live bearer is too short for a long turn.
// Layer: Account service implementation
// Exports: makeMossManagedTurnPreflight, MossManagedTurnPreflightLive, MOSS_TURN_PREFLIGHT_WAIT
// Why: Rotation goes through the owning account's normal maintenance pass, so identity checks,
//      the running-turn wait and the same-authority recovery all apply unchanged.

import { ProviderInstanceId } from "@moss/contracts";
import { resolveProviderInstance } from "@moss/shared/providerInstances";
import { Cause, Duration, Effect, Exit, Fiber, Layer, Option, Scope } from "effect";

import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings";
import { managedCredentialRefreshAuthority } from "../managedCredentialFreshness";
import { describeMossErrorCauses } from "../mossAccountErrors";
import type { MossManagedGatewayAuthority } from "../../provider/mossManagedGatewayTrust";
import { MossCloudAccountService } from "../Services/MossCloudAccountService";
import {
  MossManagedTurnPreflight,
  type MossManagedTurnPreflightShape,
} from "../Services/MossManagedTurnPreflight";
import { MossPhoneAccountService } from "../Services/MossPhoneAccountService";

/** Longest a send waits for a rotation; the bearer it would otherwise use is still valid. */
export const MOSS_TURN_PREFLIGHT_WAIT = Duration.seconds(3);

export function makeMossManagedTurnPreflight(input: {
  readonly settings: Pick<ServerSettingsShape, "getSettings">;
  /** The owning account's maintenance pass; it refreshes, then rotates the lanes. */
  readonly rotate: (authority: MossManagedGatewayAuthority) => Effect.Effect<void, unknown>;
  /** Owns rotations that outlive the send that started them. */
  readonly scope: Scope.Scope;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly wait?: Duration.Input;
}): MossManagedTurnPreflightShape {
  const beforeTurn: MossManagedTurnPreflightShape["beforeTurn"] = ({ instanceId }) =>
    Effect.gen(function* () {
      const settings = yield* input.settings.getSettings;
      const instance = resolveProviderInstance(settings, {
        instanceId: ProviderInstanceId.makeUnsafe(instanceId),
      });
      const authority = managedCredentialRefreshAuthority(
        instance ?? undefined,
        input.env ?? process.env,
        (input.now ?? Date.now)(),
      );
      if (!authority) return;
      // Fork into the layer scope: a send that stops waiting must not interrupt a rotation
      // halfway through its settings fence.
      const rotation = yield* input.rotate(authority).pipe(Effect.forkIn(input.scope));
      const settled = yield* Fiber.await(rotation).pipe(
        Effect.timeoutOption(input.wait ?? MOSS_TURN_PREFLIGHT_WAIT),
      );
      if (Option.isNone(settled)) {
        yield* Effect.logInfo("Moss lane rotation still running; sending with the current bearer", {
          instanceId,
        });
      } else if (Exit.isFailure(settled.value)) {
        const failure = Cause.squash(settled.value.cause);
        yield* Effect.logWarning("Moss lane rotation before a send failed; sending anyway", {
          instanceId,
          cause: describeMossErrorCauses({ cause: failure }),
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Moss lane check before a send failed; sending anyway", {
          instanceId,
          cause: describeMossErrorCauses({ cause: Cause.squash(cause) }),
        }),
      ),
    );
  return { beforeTurn };
}

export const MossManagedTurnPreflightLive = Layer.effect(
  MossManagedTurnPreflight,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const phone = yield* MossPhoneAccountService;
    const cloud = yield* MossCloudAccountService;
    const scope = yield* Effect.scope;
    return makeMossManagedTurnPreflight({
      settings,
      scope,
      rotate: (authority) =>
        authority === "memfire-phone"
          ? (phone.maintainSession?.() ?? Effect.void)
          : cloud.getState().pipe(Effect.asVoid),
    });
  }),
);
