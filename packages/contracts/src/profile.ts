// FILE: profile.ts
// Purpose: The person's Moss profile (display name, unique @handle, avatar) and the
// RPCs that read and change it. A signed-in account keeps its profile in its own
// realm's database (`public.moss_profiles`, CN MemFire or Global Supabase); a
// signed-out Moss keeps one profile on this computer. The local server serves both
// through the same methods and caches the account profile for offline reads.
// Stats for the profile page are `stats.getProfileStats` / `stats.getProfileTokenStats`.
// Layer: shared contracts (schema-only, no runtime logic)

import { Schema } from "effect";

import { IsoDateTime } from "./baseSchemas";
import { MossAccountRealm } from "./mossAccount";

// ── Validation rules (mirrored by supabase/migrations/20261121010000_moss_profiles.sql) ──

export const MOSS_PROFILE_HANDLE_MIN_LENGTH = 3;
export const MOSS_PROFILE_HANDLE_MAX_LENGTH = 20;
export const MOSS_PROFILE_HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/u;
/** Handles nobody can claim. Kept identical to `public.moss_profile_reserved_handles()`. */
export const MOSS_PROFILE_RESERVED_HANDLES: ReadonlyArray<string> = [
  "about",
  "account",
  "admin",
  "administrator",
  "api",
  "billing",
  "help",
  "login",
  "logout",
  "me",
  "moss",
  "moss_ai",
  "moss_official",
  "mossai",
  "null",
  "official",
  "pay",
  "privacy",
  "profile",
  "root",
  "security",
  "settings",
  "signin",
  "signup",
  "staff",
  "support",
  "system",
  "team",
  "terms",
  "undefined",
];
export const MOSS_PROFILE_DISPLAY_NAME_MAX_LENGTH = 32;
export const MOSS_PROFILE_PRESET_AVATAR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/u;
export const MOSS_PROFILE_AVATAR_MAX_BYTES = 1024 * 1024;
export const MOSS_PROFILE_AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const RESERVED_HANDLES = new Set(MOSS_PROFILE_RESERVED_HANDLES);
// Code points, as PostgreSQL `char_length` counts them.
const codePointLength = (value: string) => [...value].length;
const hasControlCharacter = (value: string) =>
  [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

/** A claimable handle: 3–20 of `a-z 0-9 _`, not reserved. Clients lowercase before sending. */
export const MossProfileHandle = Schema.String.check(
  Schema.isPattern(MOSS_PROFILE_HANDLE_PATTERN),
).check(Schema.makeFilter((value: string) => !RESERVED_HANDLES.has(value)));
export type MossProfileHandle = typeof MossProfileHandle.Type;

/** 1–32 characters after trimming, no line breaks or control characters. */
export const MossProfileDisplayName = Schema.Trim.check(
  Schema.makeFilter(
    (value: string) =>
      codePointLength(value) >= 1 &&
      codePointLength(value) <= MOSS_PROFILE_DISPLAY_NAME_MAX_LENGTH &&
      !hasControlCharacter(value),
  ),
);
export type MossProfileDisplayName = typeof MossProfileDisplayName.Type;

/** Id of a preset avatar shipped with the web app (for example `leaf-sprout`). */
export const MossProfilePresetAvatarId = Schema.String.check(
  Schema.isPattern(MOSS_PROFILE_PRESET_AVATAR_ID_PATTERN),
);
export type MossProfilePresetAvatarId = typeof MossProfilePresetAvatarId.Type;

// ── Profile ──────────────────────────────────────────────────────────

export const MossProfilePresetAvatar = Schema.Struct({
  kind: Schema.Literal("preset"),
  id: MossProfilePresetAvatarId,
});
/**
 * An uploaded picture. `url` is the realm's public storage URL for an account
 * (`https://…/storage/v1/object/public/moss-avatars/<user>/avatar?v=…`) or a
 * `data:image/…;base64,` URL for the signed-out profile kept on this computer.
 */
export const MossProfileUploadAvatar = Schema.Struct({
  kind: Schema.Literal("upload"),
  url: Schema.String.check(Schema.isMaxLength(1_500_000)),
});
export const MossProfileInitialsAvatar = Schema.Struct({ kind: Schema.Literal("initials") });

export const MossProfileAvatar = Schema.Union([
  MossProfilePresetAvatar,
  MossProfileUploadAvatar,
  MossProfileInitialsAvatar,
]);
export type MossProfileAvatar = typeof MossProfileAvatar.Type;

/** What `profile.update` can set directly; an upload goes through `profile.uploadAvatar`. */
export const MossProfileAvatarChoice = Schema.Union([
  MossProfilePresetAvatar,
  MossProfileInitialsAvatar,
]);
export type MossProfileAvatarChoice = typeof MossProfileAvatarChoice.Type;

export const MossProfile = Schema.Struct({
  displayName: Schema.String,
  /** `null` until the person claims one. */
  handle: Schema.NullOr(Schema.String),
  avatar: MossProfileAvatar,
  /** `null` when nothing was saved yet (the defaults are shown). */
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type MossProfile = typeof MossProfile.Type;

/**
 * `account`: the signed-in account's profile in its realm. `local`: signed out,
 * kept on this computer only.
 */
export const MossProfileScope = Schema.Literals(["account", "local"]);
export type MossProfileScope = typeof MossProfileScope.Type;

/**
 * `synced`: just read from the realm. `offline`: the realm was unreachable (or the
 * session needs a new sign-in), so this is the last copy seen on this computer, or
 * the defaults; edits are refused until it is reachable again. `local`: signed out.
 */
export const MossProfileSync = Schema.Literals(["synced", "offline", "local"]);
export type MossProfileSync = typeof MossProfileSync.Type;

export const MossProfileState = Schema.Struct({
  scope: MossProfileScope,
  /** Realm of the signed-in account; `null` for the local profile. */
  realm: Schema.NullOr(MossAccountRealm),
  sync: MossProfileSync,
  /** Whether update and uploadAvatar can succeed right now. */
  editable: Schema.Boolean,
  profile: MossProfile,
});
export type MossProfileState = typeof MossProfileState.Type;

// ── RPC payloads ─────────────────────────────────────────────────────

/** Only the given fields change. */
export const MossProfileUpdateInput = Schema.Struct({
  displayName: Schema.optional(MossProfileDisplayName),
  handle: Schema.optional(MossProfileHandle),
  avatar: Schema.optional(MossProfileAvatarChoice),
});
export type MossProfileUpdateInput = typeof MossProfileUpdateInput.Type;

export const MossProfileCheckHandleInput = Schema.Struct({
  handle: Schema.String.check(Schema.isMaxLength(64)),
});
export type MossProfileCheckHandleInput = typeof MossProfileCheckHandleInput.Type;

/**
 * `available`: free (or, for the local profile, well-formed). `current`: already
 * this profile's handle. `unverified`: well-formed, but the realm could not be
 * asked; saving will check again. The rest say why it cannot be used.
 */
export const MossProfileHandleStatus = Schema.Literals([
  "available",
  "current",
  "taken",
  "reserved",
  "too_short",
  "too_long",
  "invalid_characters",
  "unverified",
]);
export type MossProfileHandleStatus = typeof MossProfileHandleStatus.Type;

export const MossProfileCheckHandleResult = Schema.Struct({
  /** The handle as it would be saved (trimmed, lowercased). */
  handle: Schema.String,
  status: MossProfileHandleStatus,
});
export type MossProfileCheckHandleResult = typeof MossProfileCheckHandleResult.Type;

export const MossProfileAvatarMimeType = Schema.Literals(MOSS_PROFILE_AVATAR_MIME_TYPES);
export type MossProfileAvatarMimeType = typeof MossProfileAvatarMimeType.Type;

/** The cropped picture, at most 1 MB before base64. Uploading also selects it. */
export const MossProfileUploadAvatarInput = Schema.Struct({
  mimeType: MossProfileAvatarMimeType,
  dataBase64: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(Math.ceil(MOSS_PROFILE_AVATAR_MAX_BYTES / 3) * 4),
  ),
});
export type MossProfileUploadAvatarInput = typeof MossProfileUploadAvatarInput.Type;

/** `WsRpcError.code` values the profile methods fail with; clients localize by code. */
export const MOSS_PROFILE_ERROR_CODES = {
  /** Retryable: the realm is unreachable or the session needs a new sign-in. */
  offline: "PROFILE_OFFLINE",
  handleTaken: "PROFILE_HANDLE_TAKEN",
  invalid: "PROFILE_INVALID",
  avatarInvalid: "PROFILE_AVATAR_INVALID",
} as const;
