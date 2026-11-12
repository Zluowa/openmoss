import { Effect } from "effect";
import { type StatsUsageAnalyticsScope, WsRpcError } from "@moss/contracts";
import { CurrentWsSessionRole } from "./wsConnectionSessions";

/** The authenticated connection supplies this role; request payloads cannot grant it. */
export const requireWsOwnerSession = Effect.gen(function* () {
  if ((yield* CurrentWsSessionRole) !== "owner") {
    return yield* Effect.fail(
      new WsRpcError({ message: "Owner authorization is required for this operation." }),
    );
  }
});

/** Provider session files can include activity outside the paired Moss workspace. */
export function requireUsageAnalyticsAccess(
  scope: StatsUsageAnalyticsScope | undefined,
): Effect.Effect<void, WsRpcError> {
  return scope === "computer" ? requireWsOwnerSession : Effect.void;
}

export const ownerRoleRequired = requireWsOwnerSession.pipe(
  Effect.mapError(
    () =>
      new WsRpcError({
        message: "Owner authorization is required for this operation.",
        code: "OWNER_REQUIRED",
        retryable: false,
      }),
  ),
);

/** Do not construct a host mutation until the verified owner role is admitted. */
export const ownerOnlyWsRpcHandler =
  (
    handler: (input: unknown, options: unknown) => Effect.Effect<unknown, unknown, never>,
    guard: Effect.Effect<void, WsRpcError, never> = ownerRoleRequired,
  ) =>
  (input: unknown, options: unknown) =>
    guard.pipe(Effect.andThen(Effect.suspend(() => handler(input, options))));
