// FILE: mossManagedSession.ts
// Purpose: The sentence a Moss lane shows when the gateway rejected the bearer a turn ran on.
// Layer: Shared runtime utilities
// Exports: MOSS_MANAGED_SESSION_RENEWED_MESSAGE, MOSS_GATEWAY_SESSION_REJECTED_MESSAGE,
//          MOSS_ACCOUNT_SERVICE_UNAVAILABLE_MESSAGE

/**
 * Moss owns a Moss lane's credential and renews it on its own, so a rejected bearer never
 * means "run the CLI's login". The adapters write this sentence and the web app matches it
 * to show its translation and a retry button, so server and client must not drift apart.
 */
export const MOSS_MANAGED_SESSION_RENEWED_MESSAGE =
  "Moss renewed its sign-in while this task was running. Send the message again to continue.";

/**
 * What a Moss lane's chat says while the account service cannot renew an expired sign-in:
 * the turn waits, and Moss continues it by itself once the service answers again.
 */
export const MOSS_ACCOUNT_SERVICE_UNAVAILABLE_MESSAGE =
  "The Moss account service is temporarily unavailable. Moss continues automatically once it is back.";

/** What the Moss model gateway answers with HTTP 401 for an expired or revoked bearer. */
export const MOSS_GATEWAY_SESSION_REJECTED_MESSAGE =
  "The Moss account session is invalid or expired.";
