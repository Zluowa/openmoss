// FILE: useMossAccountOutage.ts
// Purpose: Watches the Moss account service for a Moss lane's chat and continues the task
//          that failed while it was down, once it is back.
// Layer: Chat recovery hook
// Exports: useMossAccountOutage

import type { TurnId } from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
} from "../auth/mossServerReactQuery";
import {
  isMossAccountServiceUnavailable,
  mossAccountOutageCheckDelayMs,
  nextMossAccountOutageStep,
} from "./mossAccountOutage";

export function useMossAccountOutage(input: {
  /** The chat runs on a Moss lane. */
  readonly enabled: boolean;
  /** The latest turn when it failed and can be continued. */
  readonly recoverableTurnId: TurnId | null;
  readonly onResume: (turnId: TurnId) => Promise<boolean>;
}): { readonly unavailable: boolean } {
  const unavailableSinceRef = useRef<number | null>(null);
  const query = useQuery({
    ...serverMossAccountSessionQueryOptions({ enabled: input.enabled }),
    // While the service is down, ask again with a growing pause; otherwise as usual.
    refetchInterval: (current) => {
      if (!isMossAccountServiceUnavailable(current.state.data)) return false;
      const since = unavailableSinceRef.current ?? Date.now();
      return mossAccountOutageCheckDelayMs(Date.now() - since);
    },
    refetchIntervalInBackground: true,
  });
  const cloudQuery = useQuery(serverMossCloudAccountStateQueryOptions({ enabled: input.enabled }));
  const usesCloudLane =
    cloudQuery.data?.authenticated === true &&
    (cloudQuery.data.activeRealm === "global" || query.data?.authenticated !== true);
  const unavailable =
    input.enabled && !usesCloudLane && isMossAccountServiceUnavailable(query.data);
  useEffect(() => {
    if (!unavailable) unavailableSinceRef.current = null;
    else unavailableSinceRef.current ??= Date.now();
  }, [unavailable]);

  const [waitingTurnId, setWaitingTurnId] = useState<TurnId | null>(null);
  const onResumeRef = useRef(input.onResume);
  useEffect(() => {
    onResumeRef.current = input.onResume;
  }, [input.onResume]);
  useEffect(() => {
    const step = nextMossAccountOutageStep({
      unavailable,
      waitingTurnId,
      recoverableTurnId: input.recoverableTurnId,
    });
    if (step.waitingTurnId !== waitingTurnId) setWaitingTurnId(step.waitingTurnId);
    if (step.resumeTurnId !== null) void onResumeRef.current(step.resumeTurnId);
  }, [unavailable, waitingTurnId, input.recoverableTurnId]);
  return { unavailable };
}
