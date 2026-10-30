// FILE: observability.ts
// Purpose: Initializes privacy-safe Sentry monitoring for the Web/Electron renderer.
// Layer: Web runtime observability
// Depends on: @sentry/react and the shared Moss observability contract.

import * as Sentry from "@sentry/react";
import type { RootOptions } from "react-dom/client";
import {
  resolveMossSentryRuntimeConfig,
  scrubSentryEvent,
  sanitizeSentryText,
  toSentrySafeError,
} from "@synara/shared/observability";
import { APP_VERSION } from "./branding";
import { isElectron } from "./env";

const sentryConfig = resolveMossSentryRuntimeConfig({
  env: {
    MOSS_SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN,
    MOSS_SENTRY_ENVIRONMENT: import.meta.env.VITE_SENTRY_ENVIRONMENT,
    MOSS_SENTRY_RELEASE: import.meta.env.VITE_SENTRY_RELEASE,
    MOSS_SENTRY_TRACES_SAMPLE_RATE: import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE,
    MOSS_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE: import.meta.env
      .VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE,
  },
  defaultEnvironment: import.meta.env.PROD ? "production" : "development",
  defaultRelease: `moss-web@${APP_VERSION}`,
  defaultTracesSampleRate: import.meta.env.PROD ? 0.1 : 0,
});

let initialized = false;
let fetchInstrumentationInstalled = false;

function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  if (breadcrumb.category === "ui.input") return null;
  const { data: _data, message, ...safeBreadcrumb } = breadcrumb;
  return {
    ...safeBreadcrumb,
    ...(message !== undefined &&
    breadcrumb.category !== "console" &&
    !breadcrumb.category?.startsWith("ui.")
      ? { message: sanitizeSentryText(message, 240) }
      : {}),
  };
}

function safeFetchTarget(input: RequestInfo | URL): { pathname: string; host: string } {
  try {
    const raw =
      typeof input === "string"
        ? input
        : typeof URL !== "undefined" && input instanceof URL
          ? input.toString()
          : typeof Request !== "undefined" && input instanceof Request
            ? input.url
            : String(input);
    const parsed = new URL(raw, window.location.href);
    return { pathname: parsed.pathname || "/", host: parsed.host.toLowerCase() };
  } catch {
    return { pathname: "/unknown", host: "" };
  }
}

function installSentryFetchInstrumentation(): void {
  if (fetchInstrumentationInstalled || typeof globalThis.fetch !== "function") return;
  const nativeFetch = globalThis.fetch;
  const sentryHost = (() => {
    try {
      return new URL(sentryConfig.dsn ?? "").host.toLowerCase();
    } catch {
      return "";
    }
  })();
  fetchInstrumentationInstalled = true;
  const wrappedFetch: typeof fetch = async (input, init) => {
    const { pathname, host } = safeFetchTarget(input);
    const method = String(
      init?.method ??
        (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET"),
    ).toUpperCase();
    const observe = host !== sentryHost;
    try {
      const response = await nativeFetch.call(globalThis, input, init);
      if (observe && (response.status === 429 || response.status >= 500)) {
        captureSentryException(new Error("Moss direct fetch failed"), {
          errorSource: "renderer-fetch",
          operation: pathname.slice(0, 120),
          method,
          status: response.status,
        });
      }
      return response;
    } catch (error) {
      if (
        observe &&
        !(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError")
      ) {
        captureSentryException(new Error("Moss direct fetch failed"), {
          errorSource: "renderer-fetch",
          operation: pathname.slice(0, 120),
          method,
          status: "network",
        });
      }
      throw error;
    }
  };
  try {
    globalThis.fetch = wrappedFetch;
  } catch {
    fetchInstrumentationInstalled = false;
  }
}

function initializeSentry(): boolean {
  if (initialized) return Boolean(sentryConfig.dsn);
  initialized = true;
  if (!sentryConfig.dsn) return false;

  const integrations: Sentry.BrowserOptions["integrations"] = [Sentry.browserTracingIntegration()];
  if (sentryConfig.replaysOnErrorSampleRate > 0) {
    integrations.push(Sentry.replayIntegration());
  }

  Sentry.init({
    dsn: sentryConfig.dsn,
    environment: sentryConfig.environment,
    release: sentryConfig.release,
    sendDefaultPii: false,
    tracesSampleRate: sentryConfig.tracesSampleRate,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: sentryConfig.replaysOnErrorSampleRate,
    integrations,
    beforeSend(event) {
      // Moss events must never carry prompts, request bodies, cookies, or user
      // identity. Keep only the origin/path needed to correlate a failure.
      return scrubSentryEvent(event);
    },
    beforeBreadcrumb: scrubBreadcrumb,
  });

  Sentry.setTags({
    surface: isElectron ? "desktop-renderer" : "web",
    runtime: isElectron ? "electron" : "browser",
  });
  installSentryFetchInstrumentation();
  return true;
}

export function captureSentryException(
  error: unknown,
  tags?: Readonly<Record<string, string | number | boolean>>,
): string | null {
  if (!initializeSentry()) return null;
  try {
    return Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(tags ?? {})) {
        scope.setTag(key, sanitizeSentryText(String(value), 96));
      }
      return Sentry.captureException(toSentrySafeError(error));
    });
  } catch {
    return null;
  }
}

function isExpectedHandledError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = Number((error as { readonly status?: unknown }).status);
    if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 429) return true;
    const name = String((error as { readonly name?: unknown }).name ?? "");
    if (name === "AbortError") return true;
  }
  return false;
}

function safeQueryBoundaryKey(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim();
  return /^[a-z0-9._/-]{1,96}$/iu.test(normalized) ? normalized : "unknown";
}

/**
 * TanStack Query deliberately handles rejected promises inside the UI, so
 * browser global error handlers never see them. Report only operational or
 * malformed-response failures; ordinary auth/validation/abort responses stay
 * in the product's existing user-facing error flow.
 */
export function reportHandledWebError(
  error: unknown,
  boundary: "query" | "mutation",
  key?: unknown,
): void {
  if (isExpectedHandledError(error)) return;
  captureSentryException(new Error(`Moss web ${boundary} failed`), {
    errorSource: "react-query",
    boundary,
    operation: safeQueryBoundaryKey(key),
    errorClass:
      error && typeof error === "object"
        ? safeQueryBoundaryKey((error as { readonly name?: unknown }).name)
        : "UnknownError",
  });
}

/**
 * React 19 reports caught, uncaught, and recoverable root errors through
 * callbacks rather than only through the browser's global error handlers.
 * Keep this in the shared observability module so the Web and Electron
 * renderer entrypoints use the same Sentry boundary.
 */
export function getSentryReactRootOptions(): RootOptions {
  if (!initialized) return {};
  const makeRootErrorHandler = () => {
    const sentryHandler = Sentry.reactErrorHandler();
    return (error: unknown, errorInfo: { componentStack?: string | undefined }) => {
      // React DOM's RootOptions makes componentStack optional, while the
      // Sentry React ErrorInfo type uses null for a missing stack.
      sentryHandler(error, { componentStack: errorInfo.componentStack ?? null });
    };
  };
  return {
    onCaughtError: makeRootErrorHandler(),
    onUncaughtError: makeRootErrorHandler(),
    onRecoverableError: makeRootErrorHandler(),
  };
}

export { initializeSentry };
export const SentryErrorBoundary = Sentry.ErrorBoundary;
