// FILE: guestCopy.ts
// Purpose: Maps guest protocol outcomes (error reasons, end reasons) to Moss translation keys.
// Layer: Guest page
// Why: Every server reason has its own line in both languages; the server's English message is
//      only the fallback for a reason this page predates.

import type { GuestAccessErrorReason, GuestShareEndReason } from "@synara/contracts";

import type { TranslationKey } from "~/localization";

import type { GuestFailure } from "./transport";

export const GUEST_ACCESS_ERROR_KEY: Record<GuestAccessErrorReason, TranslationKey> = {
  invalid: "guest.error.invalid",
  inactive: "guest.error.inactive",
  used: "guest.error.used",
  busy: "guest.error.busy",
  files_busy: "guest.error.files_busy",
  unavailable: "guest.error.unavailable",
  rejected: "guest.error.rejected",
  empty: "guest.error.empty",
  too_many_files: "guest.error.too_many_files",
  too_large: "guest.error.too_large",
  unsupported_file: "guest.error.unsupported_file",
  owner_offline: "guest.error.owner_offline",
  owner_outdated: "guest.error.owner_outdated",
};

export const GUEST_END_REASON_KEY: Record<GuestShareEndReason, TranslationKey> = {
  closed: "guest.ended.closed",
  expired: "guest.ended.expired",
  replaced: "guest.ended.replaced",
  archived: "guest.ended.archived",
  deleted: "guest.ended.deleted",
};

export type GuestTranslate = (key: TranslationKey) => string;

/** The copy for a failed guest request: by reason, else the server's words, else generic. */
export function describeGuestFailure(failure: GuestFailure, t: GuestTranslate): string {
  if (failure.kind === "network") return t("guest.error.network");
  if (failure.reason !== null) return t(GUEST_ACCESS_ERROR_KEY[failure.reason]);
  return failure.message ?? t("guest.error.unknown");
}
