// FILE: providerDeliveryBlock.ts
// Purpose: Single source for the provider-delivery messages the server writes and the web app
//          matches: the quarantine block, an unconfirmed turn start, and a slow turn start.
// Layer: Shared runtime utilities
// Exports: PROVIDER_DELIVERY_BLOCK_SUMMARY, formatProviderDeliveryBlockDetail,
//          isProviderDeliveryBlockDetail, UNCONFIRMED_TURN_START_DETAIL,
//          isUnconfirmedTurnStartDetail, PROVIDER_TURN_START_DELAYED_ACTIVITY_KIND

/**
 * Written when Moss stopped waiting for a turn start whose effect on the provider it could
 * not learn. Nothing was sent again; the web app offers to send the message again.
 */
export const UNCONFIRMED_TURN_START_DETAIL =
  "Moss could not confirm what the provider did with this message, so it stopped waiting. It was not sent again.";

export function isUnconfirmedTurnStartDetail(detail: string | null | undefined): boolean {
  return typeof detail === "string" && detail.includes(UNCONFIRMED_TURN_START_DETAIL);
}

/** Activity kind for a sent message its provider has not taken up yet ("still starting"). */
export const PROVIDER_TURN_START_DELAYED_ACTIVITY_KIND = "provider.turn.start.delayed";

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
