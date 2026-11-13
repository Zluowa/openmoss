// FILE: providerDeliveryBlock.ts
// Purpose: Single source for the provider-delivery messages the server writes and the web app
//          matches: the quarantine block, an unconfirmed turn start, a start that sent
//          nothing because the previous process had not stopped, a slow turn start and
//          a silent running turn.
// Layer: Shared runtime utilities
// Exports: PROVIDER_DELIVERY_BLOCK_SUMMARY, formatProviderDeliveryBlockDetail,
//          isProviderDeliveryBlockDetail, UNCONFIRMED_TURN_START_DETAIL,
//          isUnconfirmedTurnStartDetail, PREVIOUS_RUNTIME_NOT_STOPPED_DETAIL,
//          isPreviousRuntimeNotStoppedDetail, PROVIDER_TURN_START_DELAYED_ACTIVITY_KIND,
//          PROVIDER_TURN_SILENT_ACTIVITY_KIND

/**
 * Written when Moss stopped waiting for a turn start whose effect on the provider it could
 * not learn. Nothing was sent again; the web app offers to send the message again.
 */
export const UNCONFIRMED_TURN_START_DETAIL =
  "Moss could not confirm what the provider did with this message, so it stopped waiting. It was not sent again.";

export function isUnconfirmedTurnStartDetail(detail: string | null | undefined): boolean {
  return typeof detail === "string" && detail.includes(UNCONFIRMED_TURN_START_DETAIL);
}

/**
 * Written when a start ended before spawning anything because the thread's previous agent
 * process could not be proven stopped. Nothing reached the provider, so the words say
 * "not sent" and the web app offers to send the message again at once.
 */
export const PREVIOUS_RUNTIME_NOT_STOPPED_DETAIL =
  "The previous agent process had not stopped yet, so this message was not sent.";

export function isPreviousRuntimeNotStoppedDetail(detail: string | null | undefined): boolean {
  return typeof detail === "string" && detail.includes(PREVIOUS_RUNTIME_NOT_STOPPED_DETAIL);
}

/** Activity kind for a sent message its provider has not taken up yet ("still starting"). */
export const PROVIDER_TURN_START_DELAYED_ACTIVITY_KIND = "provider.turn.start.delayed";

/**
 * Activity kind for a running turn whose provider has sent nothing for a long stretch.
 * `payload.state` is "silent" when the notice starts and "cleared" when the provider speaks
 * again or the turn ends; the chat shows the notice in the working row, never as a log row.
 */
export const PROVIDER_TURN_SILENT_ACTIVITY_KIND = "provider.turn.silent";

/**
 * Summary the provider command reactor records when it refuses to run a command
 * for a quarantined thread. The web app matches on the same text to offer the
 * recovery action, so server and client must never drift apart.
 */
export const PROVIDER_DELIVERY_BLOCK_SUMMARY = "Thread is blocked by an earlier provider failure";
const PROVIDER_DELIVERY_BLOCK_DETAIL_PREFIX = `${PROVIDER_DELIVERY_BLOCK_SUMMARY}:`;

/** Session error detail written for a quarantined thread, e.g. "<summary>: <blocker>". */
export function formatProviderDeliveryBlockDetail(blockerDetail: string): string {
  return `${PROVIDER_DELIVERY_BLOCK_DETAIL_PREFIX} ${blockerDetail}`;
}

/**
 * True when a thread-level error detail was produced by the delivery quarantine,
 * meaning the thread can be recovered by reconciling its blocking deliveries.
 */
export function isProviderDeliveryBlockDetail(detail: string | null | undefined): boolean {
  if (typeof detail !== "string") return false;
  const normalized = detail.trimStart();
  return (
    normalized === PROVIDER_DELIVERY_BLOCK_SUMMARY ||
    normalized.startsWith(PROVIDER_DELIVERY_BLOCK_DETAIL_PREFIX)
  );
}
