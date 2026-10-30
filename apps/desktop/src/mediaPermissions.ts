// FILE: mediaPermissions.ts
// Purpose: Centralizes fail-closed desktop microphone-permission guards.
// Layer: Desktop permission helper
// Exports: normalizePermissionOrigin, shouldAllowMediaPermissionCheck, shouldAllowMediaPermissionRequest
// Depends on: Electron permission check/request detail shapes.

type UnknownRecord = Record<string, unknown>;

interface MediaPermissionPolicyInput {
  permission: unknown;
  webContents: unknown;
  trustedWebContents: unknown;
  trustedRendererUrl: unknown;
  details: unknown;
}

export interface MediaPermissionCheckInput extends MediaPermissionPolicyInput {
  requestingOrigin: unknown;
}

export type MediaPermissionRequestInput = MediaPermissionPolicyInput;

interface TrustedMediaPermissionContext {
  details: UnknownRecord;
  trustedOrigin: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

/**
 * Return a canonical scheme/host/port origin for both standard and custom URLs.
 *
 * `URL.origin` returns `"null"` for Electron's custom `moss:` scheme, so it cannot
 * be used as the security boundary here. User info, hostless URLs, and strings that
 * the URL parser would silently trim are rejected instead of normalized.
 */
export function normalizePermissionOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol.length === 0 ||
      parsed.host.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return null;
    }
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function hasExpectedOrigin(value: unknown, trustedOrigin: string): boolean {
  return normalizePermissionOrigin(value) === trustedOrigin;
}

function resolveTrustedContext(
  input: MediaPermissionPolicyInput,
): TrustedMediaPermissionContext | null {
  if (input.permission !== "media") {
    return null;
  }
  if (
    typeof input.trustedWebContents !== "object" ||
    input.trustedWebContents === null ||
    input.webContents !== input.trustedWebContents
  ) {
    return null;
  }
  if (!isRecord(input.details) || input.details.isMainFrame !== true) {
    return null;
  }

  const trustedOrigin = normalizePermissionOrigin(input.trustedRendererUrl);
  if (trustedOrigin === null || !hasExpectedOrigin(input.details.requestingUrl, trustedOrigin)) {
    return null;
  }

  const securityOrigin = input.details.securityOrigin;
  if (securityOrigin !== undefined && !hasExpectedOrigin(securityOrigin, trustedOrigin)) {
    return null;
  }

  return { details: input.details, trustedOrigin };
}

/**
 * Electron's synchronous permission check must prove it is checking audio for the
 * trusted top-level Moss renderer. Missing or unknown media types fail closed here,
 * matching the explicit audio-only requirement enforced for permission requests.
 */
export function shouldAllowMediaPermissionCheck(input: MediaPermissionCheckInput): boolean {
  const context = resolveTrustedContext(input);
  if (context === null) {
    return false;
  }
  if (!hasExpectedOrigin(input.requestingOrigin, context.trustedOrigin)) {
    return false;
  }
  return context.details.mediaType === "audio";
}

/**
 * Permit microphone requests only from the trusted top-level Moss renderer.
 * Electron 43 supplies `["audio"]` for microphone capture. Missing, empty, mixed,
 * or unknown media types cannot prove an audio-only request and must fail closed.
 */
export function shouldAllowMediaPermissionRequest(input: MediaPermissionRequestInput): boolean {
  const context = resolveTrustedContext(input);
  if (context === null) {
    return false;
  }

  const mediaTypes = context.details.mediaTypes;
  return Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === "audio";
}
