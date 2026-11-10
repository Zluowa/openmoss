// FILE: sentry.ts
// Purpose: Initializes privacy-safe Sentry monitoring for the Electron main process.
// Layer: Desktop runtime observability
// Depends on: @sentry/electron/main and shared Moss configuration.

import { createRequire } from "node:module";
import type * as SentryModule from "@sentry/electron/main";
import type { ErrorEvent } from "@sentry/electron/main";
import type { IpcMain } from "electron";
import {
  createSentryReportingGate,
  resolveMossSentryRuntimeConfig,
  sanitizeSentryText,
  scrubSentryEvent,
  SENTRY_TRACE_PROPAGATION_TARGETS,
  toSentrySafeError,
} from "@moss/shared/observability";
import desktopPackageJson from "../../package.json" with { type: "json" };
import { resolveDesktopSentryEnv } from "./desktopSentryEnv";

declare const __MOSS_SENTRY_DSN__: string | undefined;

// JSON modules expose only a default export; destructure `version` here so the
// same module can be bundled into the e2e fixtures by Node's ESM loader.
const { version } = desktopPackageJson;

/** The backend is a child process and reads these settings from its environment. */
export const DESKTOP_SENTRY_BACKEND_ENV = resolveDesktopSentryEnv(
  process.env,
  typeof __MOSS_SENTRY_DSN__ === "string" ? __MOSS_SENTRY_DSN__ : "",
);

const config = resolveMossSentryRuntimeConfig({
  env: { ...process.env, ...DESKTOP_SENTRY_BACKEND_ENV },
  defaultEnvironment: process.env.NODE_ENV === "production" ? "production" : "development",
  defaultRelease: `moss-desktop@${version}`,
});

// main.ts sets this as soon as it knows where the preference is saved, so
// anything captured earlier waits for the user's choice.
const reportingGate = createSentryReportingGate(undefined);

export function setDesktopErrorReportsEnabled(enabled: boolean): void {
  reportingGate.setEnabled(enabled);
}

export function desktopErrorReportsEnabled(): boolean {
  return !reportingGate.isClosed();
}

type SentryApi = typeof SentryModule;
const require = createRequire(import.meta.url);
let sentryApi: SentryApi | null | undefined;

function loadSentry(): SentryApi | null {
  if (sentryApi !== undefined) return sentryApi;
  try {
    sentryApi = require("@sentry/electron/main") as SentryApi;
  } catch {
    sentryApi = null;
  }
  return sentryApi;
}

let initialized = false;
let enabled = false;

export function initializeSentry(): boolean {
  if (initialized) return enabled;
  initialized = true;
  const sentry = loadSentry();
  if (!sentry || !config.dsn) return false;

  try {
    sentry.init({
      dsn: config.dsn,
      environment: config.environment,
      release: config.release,
      sendDefaultPii: false,
      tracesSampleRate: config.tracesSampleRate,
      tracePropagationTargets: SENTRY_TRACE_PROPAGATION_TARGETS,
      attachScreenshot: false,
      // The SDK's default transport keeps failed sends on disk and retries them
      // later, including after a restart. This one forgets them, so a blocked
      // network costs nothing and turning reports off leaves nothing waiting.
      transport: reportingGate.wrapTransport(sentry.makeElectronTransport),
      // A minidump is raw process memory, which can hold prompts and credentials
      // that beforeSend never sees. Crashes still report through the process-gone
      // listeners in main.ts. The session integration holds up every quit for as
      // long as it takes to send, which on a blocked network is its full 2 seconds.
      integrations: (defaults) =>
        defaults.filter(
          (integration) =>
            integration.name !== "SentryMinidump" && integration.name !== "MainProcessSession",
        ),
      beforeSend(event: ErrorEvent) {
        return scrubSentryEvent(event);
      },
    });

    sentry.setTags({
      surface: "desktop-main",
      runtime: "electron",
    });
    enabled = true;
    return true;
  } catch {
    return false;
  }
}

export function captureSentryException(
  error: unknown,
  tags?: Readonly<Record<string, string | number | boolean>>,
): void {
  if (reportingGate.isClosed() || !initializeSentry()) return;
  const sentry = loadSentry();
  if (!sentry) return;
  try {
    sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(tags ?? {})) {
        scope.setTag(key, sanitizeSentryText(String(value), 96));
      }
      sentry.captureException(toSentrySafeError(error));
    });
  } catch {
    // Monitoring must never alter desktop control flow.
  }
}

export async function flushSentry(timeoutMs = 2_000): Promise<boolean> {
  if (!initializeSentry()) return false;
  const sentry = loadSentry();
  if (!sentry) return false;
  try {
    return await sentry.flush(timeoutMs);
  } catch {
    return false;
  }
}

/**
 * Register an Electron invoke handler with one safe error boundary. Several
 * desktop subsystems register their own handlers outside main.ts; routing all
 * of them through this helper keeps handled IPC rejections visible without
 * changing the native rejection contract returned to the renderer.
 */
export function registerSentryIpcHandler(
  ipcMain: IpcMain,
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      captureSentryException(new Error("Moss desktop IPC handler failed"), {
        errorSource: "desktop-ipc",
        channel: channel.slice(0, 120),
        errorClass: error instanceof Error ? error.name.slice(0, 96) : "UnknownError",
      });
      throw error;
    }
  });
}

initializeSentry();
