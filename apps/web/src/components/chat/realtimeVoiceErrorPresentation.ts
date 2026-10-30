// FILE: realtimeVoiceErrorPresentation.ts
// Purpose: Convert all Realtime Voice failures into a finite, localized, non-sensitive UI contract.
// Layer: Realtime Voice presentation boundary

import { translateMoss, type TranslationKey } from "../../localization";

export type RealtimeVoiceErrorPresentationCategory =
  | "microphone-permission"
  | "microphone-unavailable"
  | "network-unavailable"
  | "service-unavailable"
  | "service-credits-exhausted"
  | "service-rate-limited"
  | "quota-exhausted"
  | "account-authentication"
  | "account-recovery"
  | "account-entitlement"
  | "account-permission"
  | "session-conflict"
  | "voice-unavailable";

export type RealtimeVoiceTranslate = (key: TranslationKey) => string;

const REALTIME_VOICE_ERROR_KEYS = {
  "microphone-permission": "realtimeVoice.error.microphonePermission",
  "microphone-unavailable": "realtimeVoice.error.microphoneUnavailable",
  "network-unavailable": "realtimeVoice.error.networkUnavailable",
  "service-unavailable": "realtimeVoice.error.serviceUnavailable",
  "service-credits-exhausted": "realtimeVoice.error.serviceCreditsExhausted",
  "service-rate-limited": "realtimeVoice.error.rateLimited",
  "quota-exhausted": "realtimeVoice.error.quotaExhausted",
  "account-authentication": "realtimeVoice.error.loginRequired",
  "account-recovery": "realtimeVoice.error.accountRecovery",
  "account-entitlement": "realtimeVoice.error.entitlementRequired",
  "account-permission": "realtimeVoice.error.permissionDenied",
  "session-conflict": "realtimeVoice.error.sessionConflict",
  "voice-unavailable": "realtimeVoice.error.unavailable",
} as const satisfies Record<RealtimeVoiceErrorPresentationCategory, TranslationKey>;

const DEFAULT_REALTIME_VOICE_TRANSLATE: RealtimeVoiceTranslate = (key) => translateMoss("en", key);

function readRealtimeVoiceErrorSignals(input: {
  readonly cause: unknown;
  readonly code?: string | null;
}): string {
  const parts: string[] = [];
  if (input.code) parts.push(input.code);

  const seen = new WeakSet<object>();
  const append = (value: unknown, depth: number): void => {
    if (depth > 4 || parts.length >= 32) return;
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (typeof value === "number") {
      parts.push(String(value));
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) append(item, depth + 1);
      return;
    }

    try {
      const record = value as Readonly<Record<string, unknown>>;
      for (const key of ["code", "name", "message", "status", "_tag"] as const) {
        const signal = record[key];
        if (typeof signal === "string" || typeof signal === "number") {
          parts.push(String(signal));
        }
      }
      for (const key of ["cause", "error", "errors"] as const) {
        append(record[key], depth + 1);
      }
    } catch {
      // Classification is best-effort. Never serialize an unknown object into UI copy.
    }
  };

  append(input.cause, 0);
  return parts.join(" ").slice(0, 2_048).toLowerCase();
}

function categoryForKnownRealtimeVoiceMessage(
  cause: unknown,
): RealtimeVoiceErrorPresentationCategory | null {
  if (typeof cause !== "string") return null;
  const message = cause.trim();
  for (const [category, key] of Object.entries(REALTIME_VOICE_ERROR_KEYS) as Array<
    readonly [RealtimeVoiceErrorPresentationCategory, TranslationKey]
  >) {
    if (message === translateMoss("en", key) || message === translateMoss("zh-CN", key)) {
      return category;
    }
  }
  return null;
}

/**
 * Maps renderer, relay, and provider failures into the only user-visible error categories.
 * The raw value is inspected solely for classification and is never returned or serialized.
 */
export function classifyRealtimeVoicePresentationError(input: {
  readonly cause: unknown;
  readonly code?: string | null;
}): RealtimeVoiceErrorPresentationCategory {
  const known = categoryForKnownRealtimeVoiceMessage(input.cause);
  if (known) return known;

  const signal = readRealtimeVoiceErrorSignals(input);
  if (
    /(?:voice[_ -]?account[_ -]?authentication[_ -]?required|voice[_ -]?login[_ -]?required|login[_ -]?required|unauthorized|session[_ -]?expired)/u.test(
      signal,
    )
  ) {
    return "account-authentication";
  }
  if (/(?:account[_ -]?recovery|recovery[_ -]?required)/u.test(signal)) {
    return "account-recovery";
  }
  if (/(?:voice[_ -]?session[_ -]?conflict|another realtime voice session)/u.test(signal)) {
    return "session-conflict";
  }
  if (
    /(?:voice[_ -]?entitlement[_ -]?required|entitlement[_ -]?required|model[_ -]?not[_ -]?allowed|voice[_ -]?not[_ -]?allowed|realtime voice is not included for this moss account)/u.test(
      signal,
    )
  ) {
    return "account-entitlement";
  }
  if (
    /(?:notfounderror|devices?notfound|no[ _-]?(?:microphone|audio[ _-]?input)|microphone[ _-]?(?:missing|unavailable)|audio[ _-]?input[ _-]?(?:missing|unavailable))/u.test(
      signal,
    )
  ) {
    return "microphone-unavailable";
  }
  if (
    /(?:notallowederror|permissiondeniederror|securityerror|microphone[ _-]?(?:permission|access)|media[ _-]?permission|mic[ _-]?(?:permission|access))/u.test(
      signal,
    )
  ) {
    return "microphone-permission";
  }
  if (
    /(?:permission[_ -]?denied|forbidden|account[_ -]?disabled|reservation[_ -]?denied)/u.test(
      signal,
    )
  ) {
    return "account-permission";
  }
  if (/(?:voice[_ -]?service[_ -]?credits[_ -]?exhausted)/u.test(signal)) {
    return "service-credits-exhausted";
  }
  if (
    /(?:voice[_ -]?upstream[_ -]?unavailable|openai[_ -]?(?:sideband[_ -]?)?credits[_ -]?exhausted|realtime voice service is temporarily unavailable)/u.test(
      signal,
    )
  ) {
    return "service-unavailable";
  }
  if (
    /(?:voice[_ -]?rate[_ -]?limited|openai[_ -]?rate[_ -]?limited|rate[ _-]?limit|too[ _-]?many[ _-]?requests|\b429\b)/u.test(
      signal,
    )
  ) {
    return "service-rate-limited";
  }
  if (/(?:quota|credits?|insufficient|\b402\b)/u.test(signal)) {
    return "quota-exhausted";
  }
  if (
    /(?:relay|upstream|network|transport|region|time[ _-]?out|server[ _-]?closed|connection|disconnect|fetch|egress|websocket|webrtc|service[ _-]?unavailable|not[ _-]?connected|\bwss?:\/\/)/u.test(
      signal,
    )
  ) {
    return "network-unavailable";
  }
  return "voice-unavailable";
}

export function presentRealtimeVoiceError(
  input: { readonly cause: unknown; readonly code?: string | null },
  translate: RealtimeVoiceTranslate = DEFAULT_REALTIME_VOICE_TRANSLATE,
): string {
  return translate(REALTIME_VOICE_ERROR_KEYS[classifyRealtimeVoicePresentationError(input)]);
}
