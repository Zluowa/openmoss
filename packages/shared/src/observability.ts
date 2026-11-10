// FILE: observability.ts
// Purpose: Defines the vendor-neutral, privacy-safe Sentry runtime configuration contract.
// Layer: Shared runtime configuration
// Depends on: Web URL parsing and diagnostics redaction only; no provider SDK or platform globals.

import { redactDiagnosticText } from "./diagnosticsRedaction";
import { normalizeSentryDsn } from "./sentryDsn";

export { normalizeSentryDsn };

export const MOSS_ERROR_REPORTS_ENABLED_ENV = "MOSS_ERROR_REPORTS_ENABLED" as const;
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
  /(?:prompt|token|secret|password|phone|payment|credential|authorization|cookie|body|request|payload|content|input|output|user|identity|email|boot_time)/iu;
const STARTUP_TIME_KEY_PATTERN =
  /^(?:(?:app|application|process|system)[_-]?)?(?:start(?:up)?|boot)[_-]?(?:time|timestamp)$/iu;
// A packaged app runs from the user's home on Windows and macOS, so its paths name them.
const USER_HOME_PATH_PATTERN = /([\\/](?:Users|home)[\\/]+)[^\\/\s"'`:;,()]+/giu;
const SENTRY_HELD_ENVELOPE_LIMIT = 30;
/** Outgoing requests to providers and gateways must not carry Sentry trace headers. */
export const SENTRY_TRACE_PROPAGATION_TARGETS: string[] = [];

const SENTRY_TEXT_REDACTION_LIMIT = 4096;
const WITHHELD_ERROR_MESSAGE = "[message withheld]";
const ERROR_TYPE_PATTERN = /^[A-Za-z_$][\w$.]{0,63}$/u;
const NODE_ERROR_CODE_PATTERN = /^(?:[a-z]+ )?(E[A-Z0-9_]{2,32})\b/u;
const MINIFIED_REACT_ERROR_PATTERN = /^Minified React error #(\d{1,4})\b/u;
/**
 * Error text is where provider responses, file contents, and prompts end up, and
 * no filter can recognize them in free text. So only messages Moss wrote itself
 * and runtime errors of a known shape pass; anything else keeps its type and
 * stack but loses its text.
 */
const SAFE_ERROR_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /^Moss (?:web|desktop|server|direct|realtime|model) [A-Za-z0-9 ]{1,48}$/u,
  /^Agent gateway MCP failure \([a-z-]{1,48}\)$/u,
  /^Cannot (?:read|set) properties of (?:undefined|null)(?: \((?:reading|setting) '[\w$]{1,64}'\))?$/u,
  /^[\w$.]{1,96} is not (?:a function|a constructor|defined|iterable)$/u,
  /^Maximum call stack size exceeded$/u,
  /^(?:Failed to fetch|Load failed|fetch failed|socket hang up)$/u,
  /^NetworkError when attempting to fetch resource\.$/u,
  /^(?:The|This) operation was aborted\.?$/u,
  /^The user aborted a request\.$/u,
  /^ResizeObserver loop [a-z ]{1,64}\.?$/u,
  /^Importing a module script failed\.$/u,
  /^(?:unable to open database file|database is locked|disk I\/O error)$/u,
];
const SAFE_BREADCRUMB_MESSAGE_CATEGORIES: ReadonlySet<string> = new Set([
  "electron",
  "child-process",
]);

function scrubUserHomePaths(value: string): string {
  return value.replace(USER_HOME_PATH_PATTERN, "$1[user]");
}

function safeErrorMessage(value: unknown): string {
  if (typeof value !== "string") return WITHHELD_ERROR_MESSAGE;
  const message = value.trim();
  if (SAFE_ERROR_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) return message;
  const nodeErrorCode = NODE_ERROR_CODE_PATTERN.exec(message)?.[1];
  if (nodeErrorCode) return nodeErrorCode;
  const reactError = MINIFIED_REACT_ERROR_PATTERN.exec(message)?.[1];
  if (reactError) return `Minified React error #${reactError}`;
  return WITHHELD_ERROR_MESSAGE;
}

function safeErrorType(value: unknown): string {
  return typeof value === "string" && ERROR_TYPE_PATTERN.test(value) ? value : "Error";
}

/**
 * The switch every Moss event must pass to reach the network. All surfaces build
 * their Sentry transport through this, so turning reports off stops sessions and
 * client reports as well as errors, whatever the SDK or its integrations do.
 *
 * `undefined` means the preference isn't known yet: events wait, in a small
 * bounded queue, and are sent or dropped once it is.
 */
export function createSentryReportingGate(initial: boolean | undefined) {
  let enabled = initial;
  let held: Array<() => void> = [];
  return {
    isClosed: () => enabled === false,
    isPending: () => enabled === undefined,
    setEnabled(next: boolean) {
      enabled = next;
      const release = held;
      held = [];
      if (next) for (const send of release) send();
    },
    wrapTransport<TOptions, TEnvelope, TResponse extends object>(
      make: (options: TOptions) => {
        send(envelope: TEnvelope): PromiseLike<TResponse>;
        flush(timeout?: number): PromiseLike<boolean>;
      },
    ) {
      return (options: TOptions) => {
        const transport = make(options);
        return {
          ...transport,
          send(envelope: TEnvelope): PromiseLike<TResponse> {
            if (enabled === true) return transport.send(envelope);
            if (enabled === undefined && held.length < SENTRY_HELD_ENVELOPE_LIMIT) {
              held.push(() => void transport.send(envelope));
            }
            return Promise.resolve({} as TResponse);
          },
        };
      };
    },
  };
}

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
  const sanitized = redactDiagnosticText(raw, { maxLength: SENTRY_TEXT_REDACTION_LIMIT })
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
    if (SENSITIVE_KEY_PATTERN.test(key) || STARTUP_TIME_KEY_PATTERN.test(key)) continue;
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
  // The Node SDK sets this to the machine's hostname even with sendDefaultPii off.
  delete scrubbed.server_name;
  delete scrubbed.logentry;
  delete scrubbed.modules;

  if (source.request && typeof source.request === "object") {
    const { method, url } = source.request as Record<string, unknown>;
    const safeUrl = scrubSentryUrl(url);
    scrubbed.request = {
      ...(typeof method === "string" ? { method } : {}),
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
          typeof breadcrumb.category === "string" &&
          SAFE_BREADCRUMB_MESSAGE_CATEGORIES.has(breadcrumb.category)
            ? { message: sanitizeSentryText(message, 240) }
            : {}),
        },
      ];
    });
  }

  if (source.debug_meta && typeof source.debug_meta === "object") {
    const debugMeta = source.debug_meta as Record<string, unknown>;
    if (Array.isArray(debugMeta.images)) {
      scrubbed.debug_meta = {
        ...debugMeta,
        images: debugMeta.images.map((image) => {
          if (!image || typeof image !== "object") return image;
          const { code_file: codeFile, ...rest } = image as Record<string, unknown>;
          return {
            ...rest,
            ...(typeof codeFile === "string" ? { code_file: scrubUserHomePaths(codeFile) } : {}),
          };
        }),
      };
    }
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
                              context_line: _contextLine,
                              post_context: _postContext,
                              ...safeFrame
                            } = frame as Record<string, unknown>;
                            for (const key of ["filename", "abs_path"]) {
                              const path = safeFrame[key];
                              if (typeof path === "string") {
                                safeFrame[key] = scrubUserHomePaths(path);
                              }
                            }
                            return safeFrame;
                          }),
                        }
                      : {}),
                  },
                }
              : {}),
            ...(value.type !== undefined ? { type: safeErrorType(value.type) } : {}),
            ...(value.value !== undefined ? { value: safeErrorMessage(value.value) } : {}),
          };
        }),
      };
    }
  }

  if (source.extra && typeof source.extra === "object") {
    // The SDKs put handler arguments and serialized rejection values here.
    scrubbed.extra = Object.fromEntries(
      Object.entries(source.extra).filter(
        ([key, value]) =>
          (typeof value === "number" || typeof value === "boolean") &&
          !SENSITIVE_KEY_PATTERN.test(key),
      ),
    );
  }
  if (source.contexts && typeof source.contexts === "object") {
    // Error reports don't need trace correlation. The SDK adds it even with
    // tracing off, and redacting its IDs would violate Sentry's trace schema.
    const { trace: _trace, ...contexts } = source.contexts as Record<string, unknown>;
    scrubbed.contexts = scrubSentryValue(contexts, 0);
  }
  if (source.tags && typeof source.tags === "object") {
    scrubbed.tags = Object.fromEntries(
      Object.entries(source.tags as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_KEY_PATTERN.test(key))
        .slice(0, 50)
        .map(([key, value]) => [sanitizeSentryText(key, 64), sanitizeSentryText(value, 96)]),
    );
  }
  if (source.message !== undefined) scrubbed.message = safeErrorMessage(source.message);
  if (source.transaction !== undefined) {
    scrubbed.transaction =
      scrubSentryUrl(source.transaction) ?? sanitizeSentryText(source.transaction, 240);
  }
  return scrubbed as T;
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
  const defaultTracesSampleRate = input.defaultTracesSampleRate ?? 0;
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
