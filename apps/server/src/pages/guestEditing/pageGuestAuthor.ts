import { createHmac } from "node:crypto";
import type { GuestPageEditEligibility } from "../sharing/PageSharingService";

export const PAGE_GUEST_AUTHOR_KEY_PURPOSE = "page-guest-author-hmac-v1";

export function pageGuestActorRef(key: Uint8Array, authorized: GuestPageEditEligibility) {
  const actor = authorized.actorRef;
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        "moss-page-guest-author:v1",
        authorized.scopeSpaceId,
        authorized.pageId,
        actor.kind,
        actor.kind === "share-member" ? actor.memberId : actor.linkId,
      ]),
    )
    .digest("hex");
}
