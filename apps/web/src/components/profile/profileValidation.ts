// FILE: profileValidation.ts
// Purpose: Client-side validation, normalization, and error-code mapping for the
//          Moss profile (display name, unique @handle, avatar uploads), mirroring
//          `packages/contracts/src/profile.ts`.
// Layer: Web profile feature (pure logic, no I/O)

import {
  MOSS_PROFILE_DISPLAY_NAME_MAX_LENGTH,
  MOSS_PROFILE_ERROR_CODES,
  MOSS_PROFILE_HANDLE_MAX_LENGTH,
  MOSS_PROFILE_HANDLE_MIN_LENGTH,
  MOSS_PROFILE_RESERVED_HANDLES,
  type MossProfileHandleStatus,
} from "@moss/contracts";

const RESERVED_HANDLE_SET = new Set(MOSS_PROFILE_RESERVED_HANDLES);

export type ProfileDisplayNameError = "empty" | "too_long" | "invalid_characters";

function codePointLength(value: string): number {
  return [...value].length;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

/** Normalize raw @handle draft input: strip leading `@`, trim, and lowercase. */
export function normalizeProfileHandleDraft(value: string): string {
  return value.trim().replace(/^@+/u, "").toLowerCase();
}

/**
 * Instant local format verdict for a normalized handle (without leading `@`),
 * matching the server's `handleFormatStatus` rules. Returns `null` when valid.
 */
export function validateProfileHandleLocal(
  normalizedHandle: string,
): Exclude<MossProfileHandleStatus, "available" | "current" | "taken" | "unverified"> | null {
  if (!/^[a-z0-9_]*$/u.test(normalizedHandle)) {
    return "invalid_characters";
  }
  if (normalizedHandle.length < MOSS_PROFILE_HANDLE_MIN_LENGTH) {
    return "too_short";
  }
  if (normalizedHandle.length > MOSS_PROFILE_HANDLE_MAX_LENGTH) {
    return "too_long";
  }
  if (RESERVED_HANDLE_SET.has(normalizedHandle)) {
    return "reserved";
  }
  return null;
}

/** Validate display name draft (1–32 Unicode code points after trim, no control chars). */
export function validateProfileDisplayName(raw: string): ProfileDisplayNameError | null {
  const trimmed = raw.trim();
  if (codePointLength(trimmed) === 0) {
    return "empty";
  }
  if (codePointLength(trimmed) > MOSS_PROFILE_DISPLAY_NAME_MAX_LENGTH) {
    return "too_long";
  }
  if (hasControlCharacter(trimmed)) {
    return "invalid_characters";
  }
  return null;
}

/** Format a handle with a single leading `@`, or `null` when unset. */
export function formatDisplayHandle(handle: string | null | undefined): string | null {
  if (!handle) {
    return null;
  }
  const normalized = normalizeProfileHandleDraft(handle);
  return normalized.length > 0 ? `@${normalized}` : null;
}

/** Extract a typed `MOSS_PROFILE_ERROR_CODES` key from an RPC/Error rejection. */
export function extractProfileErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return null;
}

export type ProfileErrorKind = "offline" | "handleTaken" | "invalid" | "avatarInvalid" | "unknown";

export function classifyProfileError(error: unknown): ProfileErrorKind {
  const code = extractProfileErrorCode(error);
  if (code === MOSS_PROFILE_ERROR_CODES.offline) return "offline";
  if (code === MOSS_PROFILE_ERROR_CODES.handleTaken) return "handleTaken";
  if (code === MOSS_PROFILE_ERROR_CODES.invalid) return "invalid";
  if (code === MOSS_PROFILE_ERROR_CODES.avatarInvalid) return "avatarInvalid";
  return "unknown";
}
