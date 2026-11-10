// FILE: composerSendTiming.ts
// Purpose: User Timing marks for one composer send, from Enter to the message on screen
//          and on to the server's acknowledgement, so a slow send can be read in the
//          Performance panel (or `performance.getEntriesByType("measure")`) instead of
//          guessed at.
// Layer: Web diagnostics helper. Marks are cheap and carry no message content.

const PREFIX = "moss.send";

/** The steps of one send, in the order a plain chat message passes them. */
const COMPOSER_SEND_STAGES = [
  "start",
  "echo",
  "painted",
  "editors-saved",
  "images-ready",
  "commands-checked",
  "provider-checked",
  "quota-checked",
  "captures-resolved",
  "workspace-ready",
  "dispatched",
] as const;
export type ComposerSendStage = (typeof COMPOSER_SEND_STAGES)[number];

function supportsUserTiming(): boolean {
  return typeof performance !== "undefined" && typeof performance.mark === "function";
}

/** Starts a new send: clears the previous send's marks so each send reads on its own. */
export function beginComposerSendTiming(): void {
  if (!supportsUserTiming()) return;
  for (const stage of COMPOSER_SEND_STAGES) performance.clearMarks?.(`${PREFIX}.${stage}`);
  performance.clearMeasures?.(`${PREFIX}.enter-to-message`);
  performance.clearMeasures?.(`${PREFIX}.enter-to-dispatch`);
  markComposerSend("start");
}

export function markComposerSend(stage: ComposerSendStage): void {
  if (!supportsUserTiming()) return;
  try {
    performance.mark(`${PREFIX}.${stage}`);
    if (stage === "painted") {
      performance.measure(`${PREFIX}.enter-to-message`, `${PREFIX}.start`, `${PREFIX}.painted`);
    } else if (stage === "dispatched") {
      performance.measure(`${PREFIX}.enter-to-dispatch`, `${PREFIX}.start`, `${PREFIX}.dispatched`);
    }
  } catch {
    // A measure without its start mark (a send that began before a reload) is just skipped.
  }
}

/** Marks the frame after the message row was committed: the moment a person sees it. */
export function markComposerSendPaintedAfterNextFrame(): void {
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => setTimeout(() => markComposerSend("painted"), 0));
}
