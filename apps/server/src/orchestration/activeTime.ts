// FILE: activeTime.ts
// Purpose: Deadlines that count only the time this process could make progress.
// Layer: Orchestration utilities
// Exports: activeTimeStepMs

/**
 * The part of the time since the last tick that counts towards a deadline. A tick that
 * arrives late, because the event loop stalled or the machine slept, counts as at most
 * two ticks: nothing in this process could progress during that gap, so a deadline
 * measured this way cannot expire on a turn that is starting, only on one that is stuck.
 */
export function activeTimeStepMs(lastTickAt: number, now: number, tickMs: number): number {
  return Math.min(Math.max(0, now - lastTickAt), 2 * tickMs);
}
