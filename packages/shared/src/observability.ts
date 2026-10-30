// FILE: observability.ts
// Purpose: Defines the vendor-neutral, privacy-safe Sentry runtime configuration contract.
// Layer: Shared runtime configuration
// Depends on: Web URL parsing only; no provider SDK or platform globals.

export const MOSS_SENTRY_DSN_ENV = "MOSS_SENTRY_DSN" as const;
export const MOSS_SENTRY_ENVIRONMENT_ENV = "MOSS_SENTRY_ENVIRONMENT" as const;
export const MOSS_SENTRY_RELEASE_ENV = "MOSS_SENTRY_RELEASE" as const;
export const MOSS_SENTRY_TRACES_SAMPLE_RATE_ENV = "MOSS_SENTRY_TRACES_SAMPLE_RATE" as const;
export const MOSS_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE_ENV =
  "MOSS_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE" as const;

export interface MossSentryRuntimeConfig {
  readonly dsn?: string;
  readonly environment: string;
  readonly release: string;
  readonly tracesSampleRate: number;
  readonly replaysOnErrorSampleRate: number;
}

const SENSITIVE_KEY_VALUE_PATTERN =
  /\b(prompt|token|secret|password|phone|payment|credential|authorization|cookie|body)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const SENSITIVE_KEY_PATTERN =
  /(?:prompt|token|secret|password|phone|payment|credential|authorization|cookie|body|request|payload|content|input|output|user|identity|email)/iu;

/**
 * Keep exception messages useful for triage without allowing request payloads
 * or credentials to become part of a Sentry event. Unknown objects are not
 * serialized because their enumerable fields may contain user content.
 */
export function sanitizeSentryText(value: unknown, maxLength = 240): string {
  const raw =
    value instanceof Error
      ? value.message || value.name
      : typeof value === "string"
        ? value
        : value && typeof value === "object" && "message" in value
          ? String((value as { readonly message?: unknown }).message ?? "")
          : "Unknown error";
  const sanitized = raw
    .replace(SENSITIVE_KEY_VALUE_PATTERN, "$1=[REDACTED]")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim();
  return (sanitized || "Unknown error").slice(0, Math.max(1, maxLength));
}

/**
 * Convert an arbitrary caught value into an Error whose message and first
 * stack line are safe to send. Preserve the remaining stack frames when
 * available so source locations remain actionable.
 */
export function toSentrySafeError(error: unknown): Error {
  const sourceName = error instanceof Error && error.name ? error.name : "Error";
  const safe = new Error(sanitizeSentryText(error, 500));
  safe.name = sanitizeSentryText(sourceName, 64);
  if (error instanceof Error && typeof error.stack === "string") {
    const stackLines = error.stack.split("\n");
    stackLines[0] = `${safe.name}: ${safe.message}`;
    safe.stack = stackLines.slice(0, 40).join("\n");
  }
  return safe;
}

function scrubSentryValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return sanitizeSentryText(value, 240);
  if (value instanceof Error) return sanitizeSentryText(value, 240);
  if (depth >= 2 || typeof value !== "object") return "[redacted]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => scrubSentryValue(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    output[sanitizeSentryText(key, 64)] = scrubSentryValue(item, depth + 1);
  }
  return output;
}

function scrubSentryUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/u, 1)[0]?.slice(0, 500);
  }
}

/**
 * Apply the same privacy boundary to SDK-generated and manually captured
 * events. The SDKs differ across browser, Bun, Electron, Node, and Workers,
 * so this intentionally accepts/returns a structural event rather than a
 * vendor type. It drops request payloads and sensitive maps while preserving
 * stack frames, status codes, and bounded diagnostic labels.
 */
export function scrubSentryEvent<T>(event: T): T {
  if (!event || typeof event !== "object") return event;
  const source = event as Record<string, unknown>;
  const scrubbed: Record<string, unknown> = { ...source };
  delete scrubbed.user;

  if (source.request && typeof source.request === "object") {
    const request = source.request as Record<string, unknown>;
    const {
      url,
      data: _data,
      headers: _headers,
      cookies: _cookies,
      query_string: _query,
      ...rest
    } = request;
    const safeUrl = scrubSentryUrl(url);
    scrubbed.request = {
      ...rest,
      ...(safeUrl !== undefined ? { url: safeUrl } : {}),
    };
  }

  if (Array.isArray(source.breadcrumbs)) {
    scrubbed.breadcrumbs = source.breadcrumbs.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const breadcrumb = item as Record<string, unknown>;
      if (breadcrumb.category === "ui.input") return [];
      const { data: _data, message, ...rest } = breadcrumb;
      return [
        {
          ...rest,
          ...(message !== undefined &&
          breadcrumb.category !== "console" &&
          typeof breadcrumb.category === "string" &&
          !breadcrumb.category.startsWith("ui.")
            ? { message: sanitizeSentryText(message, 240) }
            : {}),
        },
      ];
    });
  }

  if (source.exception && typeof source.exception === "object") {
    const exception = source.exception as Record<string, unknown>;
    if (Array.isArray(exception.values)) {
      scrubbed.exception = {
        ...exception,
        values: exception.values.slice(0, 20).map((item) => {
          if (!item || typeof item !== "object") return item;
          const value = item as Record<string, unknown>;
          const stacktrace =
            value.stacktrace && typeof value.stacktrace === "object"
              ? (value.stacktrace as Record<string, unknown>)
              : undefined;
          return {
            ...value,
            ...(stacktrace
              ? {
                  stacktrace: {
                    ...stacktrace,
                    ...(Array.isArray(stacktrace.frames)
                      ? {
                          frames: stacktrace.frames.slice(-40).map((frame) => {
                            if (!frame || typeof frame !== "object") return frame;
                            const {
                              vars: _vars,
                              pre_context: _preContext,
                              post_context: _postContext,
                              ...safeFrame
                            } = frame as Record<string, unknown>;
                            return safeFrame;
                          }),
                        }
                      : {}),
                  },
                }
              : {}),
            ...(value.type !== undefined ? { type: sanitizeSentryText(value.type, 64) } : {}),
            ...(value.value !== undefined ? { value: sanitizeSentryText(value.value, 500) } : {}),
          };
        }),
      };
    }
  }

  if (source.extra && typeof source.extra === "object") {
    scrubbed.extra = scrubSentryValue(source.extra, 0);
  }
  if (source.contexts && typeof source.contexts === "object") {
    scrubbed.contexts = scrubSentryValue(source.contexts, 0);
  }
  if (source.tags && typeof source.tags === "object") {
    scrubbed.tags = Object.fromEntries(
      Object.entries(source.tags as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_KEY_PATTERN.test(key))
        .slice(0, 50)
        .map(([key, value]) => [sanitizeSentryText(key, 64), sanitizeSentryText(value, 96)]),
    );
  }
  if (source.message !== undefined) scrubbed.message = sanitizeSentryText(source.message, 500);
  if (source.transaction !== undefined) {
    scrubbed.transaction =
      scrubSentryUrl(source.transaction) ?? sanitizeSentryText(source.transaction, 240);
  }
  return scrubbed as T;
}

/**
 * Sentry DSNs contain a public project key in URL user-info, so that field is
 * deliberately allowed. Passwords, query strings and fragments are not valid
 * for Moss and would make accidental secret/data exfiltration easier.
 */
export function normalizeSentryDsn(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.includes("\u0000")) return undefined;

  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith("/")
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function normalizeSentryEnvironment(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  if (!candidate || /[\u0000-\u001f\u007f]/u.test(candidate)) return fallback;
  return candidate.slice(0, 64);
}

export function normalizeSentryRelease(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  if (!candidate || /[\u0000-\u001f\u007f]/u.test(candidate)) return fallback;
  return candidate.slice(0, 200);
}

export function parseSentrySampleRate(value: string | undefined, fallback: number): number {
  const candidate = value?.trim();
  if (!candidate) return fallback;
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

export function resolveMossSentryRuntimeConfig(input: {
  readonly env: Record<string, string | undefined>;
  readonly defaultEnvironment: string;
  readonly defaultRelease: string;
  readonly defaultTracesSampleRate?: number;
  readonly defaultReplaysOnErrorSampleRate?: number;
}): MossSentryRuntimeConfig {
  const defaultTracesSampleRate = input.defaultTracesSampleRate ?? 0.1;
  const defaultReplaysOnErrorSampleRate = input.defaultReplaysOnErrorSampleRate ?? 0;
  const dsn = normalizeSentryDsn(input.env[MOSS_SENTRY_DSN_ENV]);
  return {
    ...(dsn ? { dsn } : {}),
    environment: normalizeSentryEnvironment(
      input.env[MOSS_SENTRY_ENVIRONMENT_ENV],
      input.defaultEnvironment,
    ),
    release: normalizeSentryRelease(input.env[MOSS_SENTRY_RELEASE_ENV], input.defaultRelease),
    tracesSampleRate: parseSentrySampleRate(
      input.env[MOSS_SENTRY_TRACES_SAMPLE_RATE_ENV],
      defaultTracesSampleRate,
    ),
    replaysOnErrorSampleRate: parseSentrySampleRate(
      input.env[MOSS_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE_ENV],
      defaultReplaysOnErrorSampleRate,
    ),
  };
}
