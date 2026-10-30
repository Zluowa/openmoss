// FILE: sentry.ts
// Purpose: Initializes privacy-safe Sentry monitoring for the Electron main process.
// Layer: Desktop runtime observability
// Depends on: @sentry/electron/main and shared Moss configuration.

import { createRequire } from "node:module";
import type * as SentryModule from "@sentry/electron/main";
import type { ErrorEvent } from "@sentry/electron/main";
import type { IpcMain } from "electron";
import {
  resolveMossSentryRuntimeConfig,
  sanitizeSentryText,
  scrubSentryEvent,
  toSentrySafeError,
} from "@synara/shared/observability";
import desktopPackageJson from "../../package.json" with { type: "json" };

// JSON modules expose only a default export; destructure `version` here so the
// same module can be bundled into the e2e fixtures by Node's ESM loader.
const { version } = desktopPackageJson;

const config = resolveMossSentryRuntimeConfig({
  env: process.env,
  defaultEnvironment: process.env.NODE_ENV === "production" ? "production" : "development",
  defaultRelease: `moss-desktop@${version}`,
  defaultTracesSampleRate: process.env.NODE_ENV === "production" ? 0.05 : 0,
});

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
      attachScreenshot: false,
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
  if (!initializeSentry()) return;
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
