// FILE: MossManagedTurnPreflight.ts
// Purpose: The check a turn on a Moss lane runs before its CLI starts or receives the turn.
// Layer: Account service contract
// Exports: MossManagedTurnPreflight, MossManagedTurnPreflightShape
// Why: A managed CLI keeps the bearer it started with for as long as it lives, so a send is
//      the last point where Moss can still hand a turn a bearer long enough to finish it.

import type { Effect } from "effect";
import { ServiceMap } from "effect";

export interface MossManagedTurnPreflightShape {
  /**
   * Rotates the Moss lane `instanceId` when its live bearer is too short for a long turn,
   * so the turn's CLI starts with the fresh one. Never fails and never holds a send for
   * long: a slow or failed rotation leaves the current (still valid) bearer in place and
   * the maintenance loop retries.
   */
  readonly beforeTurn: (input: { readonly instanceId: string }) => Effect.Effect<void>;
}

export class MossManagedTurnPreflight extends ServiceMap.Service<
  MossManagedTurnPreflight,
  MossManagedTurnPreflightShape
>()("moss/account/Services/MossManagedTurnPreflight") {}
