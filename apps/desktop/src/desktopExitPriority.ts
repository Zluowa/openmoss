// FILE: desktopExitPriority.ts
// Purpose: Lets Moss's own processes finish exiting on a busy Windows machine.
// Layer: Desktop main process lifecycle
//
// Chromium runs its helper processes (GPU, network, renderers) at idle or background
// priority, and Windows tears each process down on whichever of its threads exits last.
// With the CPUs busy, as on the first launch after an install while it is being scanned,
// those threads wait up to minutes for a turn: Moss.exe stays listed after it quit, cannot
// be stopped, and a relaunch in that window finds the old instance still there.

import { raiseProcessPriorityForExit } from "@moss/shared/platformProcess";

/** Raises this process and its helper processes as the app quits. Never throws. */
export function raiseDesktopExitPriority(input: {
  readonly listHelperPids: () => ReadonlyArray<number>;
  readonly platform?: NodeJS.Platform;
  readonly raise?: (pid: number) => void;
}): void {
  if ((input.platform ?? process.platform) !== "win32") return;
  const raise =
    input.raise ??
    ((pid: number) => {
      raiseProcessPriorityForExit(pid);
    });
  let helperPids: ReadonlyArray<number> = [];
  try {
    helperPids = input.listHelperPids();
  } catch {
    // Metrics can be unavailable this late; this process still gets raised.
  }
  for (const pid of new Set(helperPids)) {
    if (pid === process.pid) continue;
    try {
      raise(pid);
    } catch {
      // A helper that is already gone needs nothing.
    }
  }
  try {
    raise(0);
  } catch {
    // Same: priority only speeds the exit up.
  }
}
