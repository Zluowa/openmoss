import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  setTags: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: "browser-tracing" })),
  replayIntegration: vi.fn(() => ({ name: "replay" })),
  reactErrorHandler: vi.fn(() => vi.fn()),
  withScope: vi.fn((callback: (scope: { setTag: () => void }) => unknown) =>
    callback({ setTag: vi.fn() }),
  ),
  captureException: vi.fn(() => "event-id"),
  ErrorBoundary: () => null,
}));

vi.mock("@sentry/react", () => sentryMocks);
vi.mock("./branding", () => ({ APP_VERSION: "test-version" }));
vi.mock("./env", () => ({ isElectron: false }));

describe("web Sentry observability", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("wires React 19 root error callbacks after Sentry initializes", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://public@example.ingest.sentry.io/1");

    const { getSentryReactRootOptions, initializeSentry } = await import("./observability");

    expect(initializeSentry()).toBe(true);
    const options = getSentryReactRootOptions();

    expect(Object.keys(options)).toEqual([
      "onCaughtError",
      "onUncaughtError",
      "onRecoverableError",
    ]);
    expect(sentryMocks.reactErrorHandler).toHaveBeenCalledTimes(3);
    expect(Object.values(options).every((handler) => typeof handler === "function")).toBe(true);
  });

  it("reports handled operational query failures but filters expected auth failures", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
    const { initializeSentry, reportHandledWebError } = await import("./observability");

    initializeSentry();
    reportHandledWebError(new Error("database unavailable"), "query", "settings");
    reportHandledWebError(
      Object.assign(new Error("unauthorized"), { status: 401 }),
      "query",
      "settings",
    );

    expect(sentryMocks.captureException).toHaveBeenCalledTimes(1);
  });
});
