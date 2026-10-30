// FILE: guestShare.logic.ts
// Purpose: Pure helpers for the owner's "share with guest" surfaces: share phase, header
//          tone, remaining-time copy, and error localization by `WsRpcError.code`.
// Layer: Chat UI logic
// Exports: resolveGuestSharePhase, resolveGuestShareIndicatorTone, formatGuestShareRemaining,
//          readGuestShareErrorCode, describeGuestShareError

import {
  GUEST_SHARE_OWNER_ERROR_MESSAGES,
  type GuestShareOwnerErrorCode,
  isGuestShareExpired,
  type ThreadGuestShare,
} from "@synara/contracts";

import type { MossLocaleCode } from "~/appSettings";
import type { TranslationKey } from "~/localization";

export type GuestSharePhase = "expired" | "waiting" | "joined";

/** The server drops an expired share on its own, but the stream may lag by a tick. */
export function resolveGuestSharePhase(share: ThreadGuestShare, nowMs: number): GuestSharePhase {
  if (isGuestShareExpired(share, nowMs)) return "expired";
  return share.guestName === null ? "waiting" : "joined";
}

export type GuestShareIndicatorTone = "live" | "waiting" | "offline";

/** The one mapping from a share's health to the status dot; null means nothing to show. */
export function resolveGuestShareIndicatorTone(
  share: ThreadGuestShare,
  nowMs: number,
): GuestShareIndicatorTone | null {
  const phase = resolveGuestSharePhase(share, nowMs);
  if (phase === "expired") return null;
  if (share.relayStatus === "offline") return "offline";
  if (share.relayStatus === "connecting" || phase === "waiting") return "waiting";
  return "live";
}

export const GUEST_SHARE_INDICATOR_DOT_CLASS_NAME: Record<GuestShareIndicatorTone, string> = {
  live: "bg-emerald-500/80",
  waiting: "bg-amber-500/80",
  offline: "bg-destructive/80",
};

/** "23h 15m" / "23 小时 15 分钟"; the caller wraps it in the "expires in" sentence. */
export function formatGuestShareRemaining(
  expiresAt: string,
  nowMs: number,
  locale: MossLocaleCode,
): string {
  const zh = locale === "zh-CN";
  const totalMinutes = Math.max(0, Math.floor((Date.parse(expiresAt) - nowMs) / 60_000));
  if (totalMinutes < 1) return zh ? "不到 1 分钟" : "under a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(zh ? `${hours} 小时` : `${hours}h`);
  if (minutes > 0) parts.push(zh ? `${minutes} 分钟` : `${minutes}m`);
  return parts.join(" ");
}

const ERROR_TRANSLATION_KEYS: Record<GuestShareOwnerErrorCode, TranslationKey> = {
  "guest_share.account_required": "chat.guestShare.error.accountRequired",
  "guest_share.relay_unavailable": "chat.guestShare.error.relayUnavailable",
  "guest_share.rate_limited": "chat.guestShare.error.rateLimited",
  "guest_share.thread_unavailable": "chat.guestShare.error.threadUnavailable",
  "guest_share.not_found": "chat.guestShare.error.notFound",
  "guest_share.message_not_pending": "chat.guestShare.error.messageNotPending",
  "guest_share.send_failed": "chat.guestShare.error.sendFailed",
};

function isGuestShareOwnerErrorCode(code: unknown): code is GuestShareOwnerErrorCode {
  return typeof code === "string" && Object.hasOwn(GUEST_SHARE_OWNER_ERROR_MESSAGES, code);
}

/** The owner error code on a rejected `guestShare.*` call, wherever the transport nested it. */
export function readGuestShareErrorCode(error: unknown): GuestShareOwnerErrorCode | null {
  const seen = new Set<object>();
  let value: unknown = error;
  while (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record._tag === "WsRpcError" && isGuestShareOwnerErrorCode(record.code)) {
      return record.code;
    }
    value = record.cause;
  }
  return null;
}

export interface GuestShareErrorDescription {
  code: GuestShareOwnerErrorCode | null;
  message: string;
}

/**
 * Localized copy for a failed owner call. Known codes get their own line; transport
 * failures keep their own explanation (timeouts, reconnects) and anything else gets the
 * generic line.
 */
export function describeGuestShareError(
  error: unknown,
  t: (key: TranslationKey) => string,
): GuestShareErrorDescription {
  const code = readGuestShareErrorCode(error);
  if (code) return { code, message: t(ERROR_TRANSLATION_KEYS[code]) };
  const message = error instanceof Error ? error.message.trim() : "";
  return { code: null, message: message || t("chat.guestShare.error.generic") };
}
