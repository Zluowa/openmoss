import {
  WS_METHODS,
  WsRpcError,
  type AuthCreatePairingCredentialInput,
  type AuthRevokeClientSessionInput,
  type AuthRevokePairingLinkInput,
  type AuthSessionState,
} from "@moss/contracts";
import { DateTime, Effect } from "effect";
import { CurrentManagedAttachmentPrincipal } from "../managedAttachmentPrincipal";
import { CurrentWsAuthenticatedSession, CurrentWsSessionRole } from "../wsConnectionSessions";
import { ownerRoleRequired } from "../wsOwnerAuthorization";
import type { AuthError, ServerAuthShape } from "./Services/ServerAuth";

/** Operate on the identity admitted by the existing socket, never a renderer-supplied session id. */
export function makeAuthWsRpcHandlers(auth: ServerAuthShape) {
  const currentSessionId = Effect.gen(function* () {
    return (yield* CurrentWsAuthenticatedSession)?.sessionId;
  });
  const owner = <A>(operation: () => Effect.Effect<A, AuthError>) =>
    ownerRoleRequired.pipe(
      Effect.andThen(Effect.suspend(operation)),
      Effect.mapError((error) =>
        error instanceof WsRpcError
          ? error
          : new WsRpcError({
              message: error.status === 403 ? error.message : "Unable to manage network access.",
              code: error.status === 403 ? "AUTH_FORBIDDEN" : "AUTH_MANAGEMENT_FAILED",
              retryable: false,
            }),
      ),
    );
  return {
    [WS_METHODS.serverGetAuthSession]: () =>
      Effect.gen(function* () {
        const descriptor = yield* auth.getDescriptor();
        const role = yield* CurrentWsSessionRole;
        const session = yield* CurrentWsAuthenticatedSession;
        const principal = yield* CurrentManagedAttachmentPrincipal;
        const authenticated =
          session !== null || (role === "owner" && principal.ownerKind === "local-loopback");
        return {
          authenticated,
          auth: descriptor,
          ...(authenticated ? { role } : {}),
          ...(session
            ? {
                sessionMethod: session.method,
                ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
              }
            : {}),
        } satisfies AuthSessionState;
      }),
    [WS_METHODS.serverCreateAuthPairingToken]: (input: AuthCreatePairingCredentialInput) =>
      owner(() =>
        auth.issuePairingCredential({
          role: "client",
          ...(input.label ? { label: input.label } : {}),
        }),
      ),
    [WS_METHODS.serverListAuthPairingLinks]: () => owner(() => auth.listPairingLinks()),
    [WS_METHODS.serverRevokeAuthPairingLink]: (input: AuthRevokePairingLinkInput) =>
      owner(() => auth.revokePairingLink(input.id).pipe(Effect.map((revoked) => ({ revoked })))),
    [WS_METHODS.serverListAuthClients]: () =>
      owner(() =>
        currentSessionId.pipe(Effect.flatMap((sessionId) => auth.listClientSessions(sessionId))),
      ),
    [WS_METHODS.serverRevokeAuthClient]: (input: AuthRevokeClientSessionInput) =>
      owner(() =>
        currentSessionId.pipe(
          Effect.flatMap((sessionId) => auth.revokeClientSession(sessionId, input.sessionId)),
          Effect.map((revoked) => ({ revoked })),
        ),
      ),
    [WS_METHODS.serverRevokeOtherAuthClients]: () =>
      owner(() =>
        currentSessionId.pipe(
          Effect.flatMap((sessionId) => auth.revokeOtherClientSessions(sessionId)),
          Effect.map((revokedCount) => ({ revokedCount })),
        ),
      ),
  };
}
