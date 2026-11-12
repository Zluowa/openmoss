// FILE: mossManagedSession.ts
// Purpose: The sentence a Moss lane shows when the gateway rejected the bearer a turn ran on.
// Layer: Shared runtime utilities
// Exports: MOSS_MANAGED_SESSION_RENEWED_MESSAGE, MOSS_GATEWAY_SESSION_REJECTED_MESSAGE

/**
 * Moss owns a Moss lane's credential and renews it on its own, so a rejected bearer never
 * means "run the CLI's login". The adapters write this sentence and the web app matches it
 * to show its translation and a retry button, so server and client must not drift apart.
 */
export const MOSS_MANAGED_SESSION_RENEWED_MESSAGE =
  "Moss renewed its sign-in while this task was running. Send the message again to continue.";

/** What the Moss model gateway answers with HTTP 401 for an expired or revoked bearer. */
export const MOSS_GATEWAY_SESSION_REJECTED_MESSAGE =
  "The Moss account session is invalid or expired.";
