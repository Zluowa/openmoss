/**
 * How a guest's message reads once the owner sends it. The agent gets it with this attribution
 * line first, so it never takes the guest's words for the owner's and a guest cannot start a
 * slash command. Timelines parse the line back to show the guest's name above their own text.
 */

const ATTRIBUTION_PREFIX = "Message from guest ";
const ATTRIBUTION_SUFFIX = ", sent by the owner:\n\n";
/** Guest names are one line of at most 40 characters (`GUEST_NAME_MAX_LENGTH`). */
const ATTRIBUTION_PATTERN = /^Message from guest ([^\n]{1,40}?), sent by the owner:\n\n/;

export const GUEST_ATTRIBUTION_FALLBACK_NAME = "Guest";

export function formatGuestMessageAttribution(guestName: string | null, text: string): string {
  return `${ATTRIBUTION_PREFIX}${guestName ?? GUEST_ATTRIBUTION_FALLBACK_NAME}${ATTRIBUTION_SUFFIX}${text}`;
}

export interface GuestMessageAttribution {
  readonly guestName: string;
  /** The guest's own words, without the attribution line. */
  readonly text: string;
}

export function parseGuestMessageAttribution(text: string): GuestMessageAttribution | null {
  const match = ATTRIBUTION_PATTERN.exec(text);
  if (match === null || match[1] === undefined) return null;
  return { guestName: match[1], text: text.slice(match[0].length) };
}
