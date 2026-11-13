// FILE: accountSignInRequestModel.ts
// Purpose: Pure rules for the confirmation a phone's account sign-in waits on: which request
//   shows, how long it has left, what it is titled, and when the system is told.
// Layer: Auth UI model
// Exports: ShownAccountSignInRequest, waitingAccountSignInRequests, accountSignInSecondsLeft,
//   accountSignInTitle, groupedCheckCode, freshAccountSignInRequestIds,
//   shouldNotifyAccountSignIn, lapsedAccountSignInRequest
import type { AuthAccountPendingRequests } from "@moss/contracts";
import { DateTime } from "effect";

export interface ShownAccountSignInRequest {
  readonly requestId: string;
  /** The phone's own name for itself: untrusted text, already cleaned by the server. */
  readonly deviceName: string | null;
  readonly accountLabel: string | null;
  readonly checkCode: string;
  readonly expiresAtMs: number;
}

/** Requests still waiting, the one that will expire first (the oldest) first. */
export function waitingAccountSignInRequests(
  snapshot: AuthAccountPendingRequests,
  nowMs: number,
): ReadonlyArray<ShownAccountSignInRequest> {
  return snapshot.requests
    .map((request) => ({
      requestId: request.requestId,
      deviceName: request.deviceName,
      accountLabel: request.accountLabel,
      checkCode: request.checkCode,
      expiresAtMs: DateTime.toEpochMillis(request.expiresAt),
    }))
    .filter((request) => request.expiresAtMs > nowMs)
    .toSorted((left, right) => left.expiresAtMs - right.expiresAtMs);
}

export function accountSignInSecondsLeft(
  request: Pick<ShownAccountSignInRequest, "expiresAtMs">,
  nowMs: number,
): number {
  return Math.max(0, Math.ceil((request.expiresAtMs - nowMs) / 1000));
}

/** The dialog title: the phone's name when it gave one. */
export function accountSignInTitle(
  request: Pick<ShownAccountSignInRequest, "deviceName">,
):
  | { readonly key: "auth.accountSignIn.title"; readonly device: string }
  | { readonly key: "auth.accountSignIn.titleUnnamed" } {
  return request.deviceName
    ? { key: "auth.accountSignIn.title", device: request.deviceName }
    : { key: "auth.accountSignIn.titleUnnamed" };
}

/** "4 8 1 5" reads more easily against another screen than "4815". */
export function groupedCheckCode(code: string): string {
  return Array.from(code).join(" ");
}

/** Requests this window has not seen yet; `seen` is updated in place. */
export function freshAccountSignInRequestIds(
  seen: Set<string>,
  requests: ReadonlyArray<Pick<ShownAccountSignInRequest, "requestId">>,
): ReadonlyArray<string> {
  const fresh = requests
    .map((request) => request.requestId)
    .filter((requestId) => !seen.has(requestId));
  for (const requestId of fresh) seen.add(requestId);
  return fresh;
}

/** The system is told only when a new phone is waiting and the Moss window is not in front. */
export function shouldNotifyAccountSignIn(
  freshIds: ReadonlyArray<string>,
  windowFocused: boolean,
): boolean {
  return freshIds.length > 0 && !windowFocused;
}

/**
 * The request the dialog was showing ran out without an answer from this window: it left
 * the waiting list at or after its expiry and was not decided here. The window then says
 * so in one line.
 */
export function lapsedAccountSignInRequest(input: {
  readonly shown: Pick<ShownAccountSignInRequest, "requestId" | "expiresAtMs"> | null;
  readonly waiting: ReadonlyArray<Pick<ShownAccountSignInRequest, "requestId">>;
  readonly decidedHere: ReadonlySet<string>;
  readonly nowMs: number;
}): boolean {
  const { shown } = input;
  if (!shown || input.decidedHere.has(shown.requestId)) return false;
  if (input.waiting.some((request) => request.requestId === shown.requestId)) return false;
  return input.nowMs >= shown.expiresAtMs;
}
