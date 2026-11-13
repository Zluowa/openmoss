// FILE: accountSignInGuards.ts
// Purpose: The small rules account sign-in leans on: per-caller limits with bounded memory,
//   how untrusted device names are cleaned, how the account is named on screen, and the
//   one-way key a phone session records its account by.
// Layer: account (server), pure apart from the clock passed in
// Exports: makeWindowLimiter, makeDenialBlocks, sanitizeDeviceName, accountDisplayLabel,
//   accountKeyOf, unverifiedTokenSubject, describeAccountFailure
import * as Crypto from "node:crypto";

/** Counts events per key in a sliding window. Keys are pruned so memory stays bounded. */
export function makeWindowLimiter(options: {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  readonly now: () => number;
}) {
  const events = new Map<string, number[]>();
  const prune = (cutoff: number) => {
    for (const [key, times] of events) {
      const kept = times.filter((at) => at > cutoff);
      if (kept.length === 0) events.delete(key);
      else events.set(key, kept);
    }
    // Still too many callers: forget the ones seen longest ago.
    while (events.size > options.maxKeys) {
      const oldest = events.keys().next().value;
      if (oldest === undefined) break;
      events.delete(oldest);
    }
  };
  return {
    /** Records one event for `key`; false (and nothing recorded) once the key is at its limit. */
    take(key: string): boolean {
      const now = options.now();
      const cutoff = now - options.windowMs;
      const times = (events.get(key) ?? []).filter((at) => at > cutoff);
      if (times.length >= options.limit) {
        events.set(key, times);
        return false;
      }
      times.push(now);
      // Re-insert so the map's order is "least recently active first".
      events.delete(key);
      events.set(key, times);
      if (events.size > options.maxKeys) prune(cutoff);
      return true;
    },
    size: () => events.size,
  };
}

/**
 * Refused requests block their account and their address: two refusals within the window
 * block both for the same window, counted from the second refusal.
 */
export function makeDenialBlocks(options: {
  readonly denials: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  readonly now: () => number;
}) {
  const recent = new Map<string, number[]>();
  const blockedUntil = new Map<string, number>();
  const bound = (map: Map<string, unknown>) => {
    while (map.size > options.maxKeys) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };
  return {
    record(keys: ReadonlyArray<string>): void {
      const now = options.now();
      for (const key of keys) {
        const times = (recent.get(key) ?? []).filter((at) => at > now - options.windowMs);
        times.push(now);
        recent.delete(key);
        recent.set(key, times);
        if (times.length >= options.denials) {
          blockedUntil.delete(key);
          blockedUntil.set(key, now + options.windowMs);
        }
      }
      bound(recent);
      bound(blockedUntil);
    },
    isBlocked(key: string): boolean {
      const until = blockedUntil.get(key);
      if (until === undefined) return false;
      if (until > options.now()) return true;
      blockedUntil.delete(key);
      return false;
    },
  };
}

const DEVICE_NAME_MAX = 40;

/**
 * A phone's own name for itself, made safe to show: no control or formatting characters
 * (which include right-to-left overrides), none of the quote marks the dialog puts around
 * it, single spaces, at most 40 characters. Null when nothing is left.
 */
export function sanitizeDeviceName(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[「」『』"“”‘’<>]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const limited = Array.from(cleaned).slice(0, DEVICE_NAME_MAX).join("").trim();
  return limited.length > 0 ? limited : null;
}

/** How this computer's own account appears in the dialog: its email, or a masked number. */
export function accountDisplayLabel(user: {
  readonly email: string | null;
  readonly phone: string | null;
}): string | null {
  const email = user.email?.trim();
  if (email) return email;
  const digits = (user.phone ?? "").replace(/\D/gu, "");
  const national = digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
  if (national.length >= 7) return `${national.slice(0, 3)}****${national.slice(-4)}`;
  if (national.length >= 4) return `****${national.slice(-4)}`;
  return null;
}

/** A one-way, stable key for one account of one realm. Not reversible to the account id. */
export function accountKeyOf(realm: string, accountId: string): string {
  return Crypto.createHash("sha256")
    .update(`moss-account-device:${realm}:${accountId}`)
    .digest("base64url")
    .slice(0, 22);
}

/** The account id inside this computer's own access token, read without verifying it. */
export function unverifiedTokenSubject(accessToken: string): string | null {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    const subject = (payload as { sub?: unknown } | null)?.sub;
    return typeof subject === "string" && subject.length > 0 ? subject : null;
  } catch {
    return null;
  }
}

/**
 * A log-safe description of why an account-service call failed: the operation and status
 * an account-service error carries, or the error's kind. Never its message, which may
 * echo a request.
 */
export function describeAccountFailure(cause: unknown): string {
  if (cause && typeof cause === "object") {
    const record = cause as {
      readonly operation?: unknown;
      readonly status?: unknown;
      readonly code?: unknown;
      readonly _tag?: unknown;
      readonly name?: unknown;
    };
    if (typeof record.operation === "string") {
      const status = typeof record.status === "number" ? record.status : "none";
      const code = typeof record.code === "string" ? record.code : "unknown";
      return `${record.operation}:${status}:${code}`.slice(0, 80);
    }
    if (typeof record._tag === "string") return record._tag.slice(0, 60);
    if (typeof record.name === "string") return record.name.slice(0, 60);
  }
  return "unknown";
}
