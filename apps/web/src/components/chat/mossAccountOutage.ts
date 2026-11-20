// FILE: mossAccountOutage.ts
// Purpose: What a Moss lane's chat does while the Moss account service cannot renew its
//          expired sign-in: say so, ask again with a growing pause, continue once it is back.
// Layer: Chat recovery logic (pure)
// Exports: isMossAccountServiceUnavailable, mossAccountOutageCheckDelayMs,
//          nextMossAccountOutageStep, resolveAccountOutageThreadError

import type { MossAccountSessionState, TurnId } from "@moss/contracts";
import { MOSS_ACCOUNT_SERVICE_UNAVAILABLE_MESSAGE } from "@moss/shared/mossManagedSession";

import { isMossManagedSessionRejected } from "./threadErrorPresentation";

/** Signed in, but the account service cannot renew the sign-in: Moss lanes cannot run. */
export function isMossAccountServiceUnavailable(
  state: MossAccountSessionState | null | undefined,
): boolean {
  return state?.authenticated === true && state.accountService === "unavailable";
}

/**
 * How long to wait before asking the account service again, by how long it has been down:
 * every 15 seconds at first, then less often, at most every five minutes.
 */
export function mossAccountOutageCheckDelayMs(unavailableForMs: number): number {
  if (unavailableForMs < 60_000) return 15_000;
  if (unavailableForMs < 5 * 60_000) return 30_000;
  if (unavailableForMs < 15 * 60_000) return 60_000;
  if (unavailableForMs < 60 * 60_000) return 120_000;
  return 300_000;
}

export interface MossAccountOutageStep {
  /** The failed turn waiting for the service; null when none is. */
  readonly waitingTurnId: TurnId | null;
  /** The turn to continue now, once. */
  readonly resumeTurnId: TurnId | null;
}

/**
 * A failed turn seen while the service is down waits for it; when the service is back and
 * that turn is still the one to recover, it is continued. A newer turn or a resolved one
 * ends the wait without continuing anything.
 */
export function nextMossAccountOutageStep(input: {
  readonly unavailable: boolean;
  readonly waitingTurnId: TurnId | null;
  readonly recoverableTurnId: TurnId | null;
}): MossAccountOutageStep {
  if (input.unavailable) {
    return { waitingTurnId: input.recoverableTurnId ?? input.waitingTurnId, resumeTurnId: null };
  }
  if (input.waitingTurnId !== null && input.waitingTurnId === input.recoverableTurnId) {
    return { waitingTurnId: null, resumeTurnId: input.waitingTurnId };
  }
  return { waitingTurnId: null, resumeTurnId: null };
}

/**
 * The chat's own error line during an outage: a rejected sign-in is the outage, said plainly,
 * not "send the message again".
 */
export function resolveAccountOutageThreadError(
  error: string | null | undefined,
  unavailable: boolean,
): string | null {
  if (!error) return null;
  return unavailable && isMossManagedSessionRejected(error)
    ? MOSS_ACCOUNT_SERVICE_UNAVAILABLE_MESSAGE
    : error;
}
