// FILE: useFinishedTurnLinger.ts
// Purpose: Keeps the working line for a moment after a turn ends, so its Moss mark can coast
//          to rest on the still logo instead of vanishing mid-turn.
// Layer: Chat transcript presentation hook

import { useEffect, useState } from "react";

/** Long enough for the mark to land and the light to pass its folds once. */
export const FINISHED_TURN_LINGER_MS = 1100;

/**
 * True from the render in which `isWorking` turns false until the linger ends. It is decided
 * during render, so the working row never unmounts between the two states.
 */
export function useFinishedTurnLinger(isWorking: boolean, enabled: boolean): boolean {
  const [wasWorking, setWasWorking] = useState(isWorking);
  const [lingering, setLingering] = useState(false);
  if (wasWorking !== isWorking) {
    setWasWorking(isWorking);
    setLingering(wasWorking && !isWorking && enabled);
  }
  useEffect(() => {
    if (!lingering) return;
    const timer = setTimeout(() => setLingering(false), FINISHED_TURN_LINGER_MS);
    return () => clearTimeout(timer);
  }, [lingering]);
  return lingering && !isWorking;
}
