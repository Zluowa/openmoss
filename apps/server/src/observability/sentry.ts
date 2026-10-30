// FILE: sentry.ts
// Purpose: Initializes privacy-safe Sentry monitoring for the Node server runtime.
// Layer: Server runtime observability
// Depends on: @sentry/node and shared Moss configuration.

import * as Sentry from "@sentry/node";
import {
  resolveMossSentryRuntimeConfig,
  sanitizeSentryText,
  scrubSentryEvent,
  toSentrySafeError,
} from "@synara/shared/observability";
import serverPackageJson from "../../package.json" with { type: "json" };

// JSON modules expose only a default export.
const { version } = serverPackageJson;

const config = resolveMossSentryRuntimeConfig({
  env: process.env,
  defaultEnvironment: process.env.NODE_ENV === "production" ? "production" : "development",
  defaultRelease: `moss-server@${version}`,
  defaultTracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
});

let initialized = false;

export function initializeSentry(): boolean {
  if (initialized) return Boolean(config.dsn);
  initialized = true;
  if (!config.dsn) return false;

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    sendDefaultPii: false,
    tracesSampleRate: config.tracesSampleRate,
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
  });

  Sentry.setTags({
    surface: "server",
    runtime: "node",
  });
  return true;
}

export function captureSentryException(
  error: unknown,
  tags?: Readonly<Record<string, string | number | boolean>>,
): void {
  if (!initializeSentry()) return;
  try {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(tags ?? {})) {
        scope.setTag(key, sanitizeSentryText(String(value), 96));
      }
      Sentry.captureException(toSentrySafeError(error));
    });
  } catch {
    // Monitoring must never alter server control flow.
  }
}

export async function flushSentry(timeoutMs = 2_000): Promise<boolean> {
  if (!initializeSentry()) return false;
  try {
    return await Sentry.flush(timeoutMs);
  } catch {
    return false;
  }
}

initializeSentry();
