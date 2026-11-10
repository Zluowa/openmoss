// FILE: sentry.ts
// Purpose: Initializes privacy-safe Sentry monitoring for the Node server runtime.
// Layer: Server runtime observability
// Depends on: @sentry/node and shared Moss configuration.

import type { IncomingMessage } from "node:http";
import * as Https from "node:https";

import * as Sentry from "@sentry/node";
import {
  createSentryReportingGate,
  MOSS_ERROR_REPORTS_ENABLED_ENV,
  resolveMossSentryRuntimeConfig,
  sanitizeSentryText,
  scrubSentryEvent,
  SENTRY_TRACE_PROPAGATION_TARGETS,
  toSentrySafeError,
} from "@moss/shared/observability";
import serverPackageJson from "../../package.json" with { type: "json" };

// JSON modules expose only a default export.
const { version } = serverPackageJson;

const config = resolveMossSentryRuntimeConfig({
  env: process.env,
  defaultEnvironment: process.env.NODE_ENV === "production" ? "production" : "development",
  defaultRelease: `moss-server@${version}`,
});

function initialReportingPreference(value: string | undefined): boolean | undefined {
  if (value === "1") return true;
  if (value === "0") return false;
  return undefined;
}

// The desktop app says what the user chose at launch. A standalone server doesn't
// know until its settings load, so events captured before then wait.
const reportingGate = createSentryReportingGate(
  initialReportingPreference(process.env[MOSS_ERROR_REPORTS_ENABLED_ENV]),
);

export function setServerErrorReportsEnabled(enabled: boolean): void {
  reportingGate.setEnabled(enabled);
}

const SENTRY_REQUEST_TIMEOUT_MS = 10_000;

/**
 * On a network that swallows packets a send never finishes. Without this it would
 * keep the process alive through shutdown, until the desktop app force-kills it, and
 * fill the SDK's send buffer so nothing could go out once the network recovered.
 */
const sentryHttpModule: NonNullable<
  NonNullable<Sentry.NodeOptions["transportOptions"]>["httpModule"]
> = {
  request: (options, callback) => {
    const request = Https.request(
      options as Https.RequestOptions,
      callback as (response: IncomingMessage) => void,
    );
    request.setTimeout(SENTRY_REQUEST_TIMEOUT_MS, () => request.destroy());
    request.on("socket", (socket) => socket.unref());
    return request;
  },
};

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
    tracePropagationTargets: SENTRY_TRACE_PROPAGATION_TARGETS,
    transport: reportingGate.wrapTransport(Sentry.makeNodeTransport),
    transportOptions: { httpModule: sentryHttpModule },
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
  if (reportingGate.isClosed() || !initializeSentry()) return;
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
    // Settings never loaded and the process is exiting: this DSN was set on purpose
    // for this server, and a failure at startup is what it's there to report.
    if (reportingGate.isPending()) reportingGate.setEnabled(true);
    return await Sentry.flush(timeoutMs);
  } catch {
    return false;
  }
}

initializeSentry();
