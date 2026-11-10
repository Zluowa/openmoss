// Runs the real Sentry SDK and its real fetch transport, so these tests fail if
// anything can still reach the network while error reports are off.

import * as Sentry from "@sentry/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./branding", () => ({ APP_VERSION: "test-version" }));
vi.mock("./env", () => ({ isElectron: false }));

const INGEST_HOST = "example.ingest.us.sentry.io";

describe("error reports switch", () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response("{}", { status: 200 });
  });
  const requestsToSentry = () =>
    fetchMock.mock.calls.filter(([input]) => String(input).includes(INGEST_HOST));

  async function loadObservability() {
    vi.stubEnv("VITE_SENTRY_DSN", `https://public@${INGEST_HOST}/1`);
    vi.stubGlobal("fetch", fetchMock);
    return import("./observability");
  }

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockClear();
  });

  afterEach(async () => {
    await Sentry.close(100);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("lets no request reach Sentry while off, whichever way an error is captured", async () => {
    const { captureSentryException, initializeSentry, setWebErrorReportsEnabled } =
      await loadObservability();
    setWebErrorReportsEnabled(false);
    initializeSentry();

    // Moss's own path, then the SDK's, which is what global error handlers use.
    captureSentryException(new Error("moss path"));
    Sentry.captureException(new Error("sdk path"));
    Sentry.captureMessage("sdk message");
    Sentry.captureSession();
    await Sentry.flush(500);

    expect(requestsToSentry()).toEqual([]);
  });

  it("stops sending the moment the switch turns off, and resumes when it turns on", async () => {
    const { initializeSentry, setWebErrorReportsEnabled } = await loadObservability();
    setWebErrorReportsEnabled(true);
    initializeSentry();
    await Sentry.flush(500);
    fetchMock.mockClear();

    Sentry.captureException(new Error("while on"));
    await Sentry.flush(500);
    expect(requestsToSentry().length).toBeGreaterThan(0);

    fetchMock.mockClear();
    setWebErrorReportsEnabled(false);
    Sentry.captureException(new Error("while off"));
    await Sentry.flush(500);
    expect(requestsToSentry()).toEqual([]);

    setWebErrorReportsEnabled(true);
    Sentry.captureException(new Error("back on"));
    await Sentry.flush(500);
    expect(requestsToSentry().length).toBeGreaterThan(0);
  });

  it("waits for the preference in a browser, and sends nothing if it turns out to be off", async () => {
    const { captureSentryException, initializeSentry, setWebErrorReportsEnabled } =
      await loadObservability();
    initializeSentry();

    captureSentryException(new Error("before settings loaded"));
    await Sentry.flush(500);
    expect(requestsToSentry()).toEqual([]);

    setWebErrorReportsEnabled(false);
    await Sentry.flush(500);
    expect(requestsToSentry()).toEqual([]);
  });

  it("adds no trace headers to the app's own requests", async () => {
    const { initializeSentry, setWebErrorReportsEnabled } = await loadObservability();
    setWebErrorReportsEnabled(true);
    initializeSentry();
    fetchMock.mockClear();

    await globalThis.fetch("https://provider.example.test/v1/chat", { method: "POST" });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.has("sentry-trace")).toBe(false);
    expect(headers.has("baggage")).toBe(false);
  });

  it("sends schema-safe diagnostic contexts without trace IDs or application start time", async () => {
    const { initializeSentry, setWebErrorReportsEnabled } = await loadObservability();
    setWebErrorReportsEnabled(true);
    initializeSentry();

    Sentry.captureEvent({
      message: "Moss web query failed",
      contexts: {
        app: { app_start_time: "2026-11-01T08:38:10.251Z", app_memory: 42, free_memory: 128 },
        trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef" },
      },
    });
    await Sentry.flush(500);

    expect(requestsToSentry().length).toBeGreaterThan(0);
    const events = requestsToSentry().map(
      ([, init]) =>
        JSON.parse(String(init?.body).split("\n")[2] ?? "{}") as {
          contexts?: Record<string, unknown>;
        },
    );
    const event = events.find((item) => item.contexts?.app);
    expect(event?.contexts).toMatchObject({ app: { app_memory: 42, free_memory: 128 } });
    expect(event?.contexts).not.toHaveProperty("trace");
    expect(event?.contexts).not.toHaveProperty("app.app_start_time");
  });
});
