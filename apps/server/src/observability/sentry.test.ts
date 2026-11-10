// Runs the real Sentry Node client with only its network call replaced, so these
// tests fail if an event of any kind can still leave while error reports are off.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentEnvelopes = vi.hoisted(() => [] as unknown[]);
const transportOptions = vi.hoisted(() => ({
  httpModule: undefined as
    | { request: (options: object, callback?: () => void) => unknown }
    | undefined,
}));
const httpsRequest = vi.hoisted(() => vi.fn());

vi.mock("@sentry/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/node")>();
  return {
    ...actual,
    makeNodeTransport: (options: { httpModule?: typeof transportOptions.httpModule }) => {
      transportOptions.httpModule = options.httpModule;
      return {
        send: (envelope: unknown) => {
          sentEnvelopes.push(envelope);
          return Promise.resolve({ statusCode: 200 });
        },
        flush: () => Promise.resolve(true),
      };
    },
  };
});

vi.mock("node:https", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:https")>()),
  request: httpsRequest,
}));

async function loadServerSentry(reportingEnv: string | undefined) {
  vi.stubEnv("MOSS_SENTRY_DSN", "https://public@127.0.0.1:9/1");
  if (reportingEnv !== undefined) vi.stubEnv("MOSS_ERROR_REPORTS_ENABLED", reportingEnv);
  const module = await import("./sentry");
  const Sentry = await import("@sentry/node");
  return { ...module, Sentry };
}

describe("server error reports switch", () => {
  beforeEach(() => {
    vi.resetModules();
    sentEnvelopes.length = 0;
  });

  afterEach(async () => {
    const Sentry = await import("@sentry/node");
    await Sentry.close(100);
    vi.unstubAllEnvs();
  });

  it("sends nothing when the desktop app says reports are off", async () => {
    const { captureSentryException, Sentry } = await loadServerSentry("0");

    captureSentryException(new Error("moss path"));
    Sentry.captureException(new Error("sdk path"));
    Sentry.captureMessage("sdk message");
    await Sentry.flush(200);

    expect(sentEnvelopes).toEqual([]);
  });

  it("follows the setting live", async () => {
    const { Sentry, setServerErrorReportsEnabled } = await loadServerSentry("1");

    Sentry.captureException(new Error("while on"));
    await Sentry.flush(200);
    expect(sentEnvelopes.length).toBeGreaterThan(0);

    sentEnvelopes.length = 0;
    setServerErrorReportsEnabled(false);
    Sentry.captureException(new Error("while off"));
    await Sentry.flush(200);
    expect(sentEnvelopes).toEqual([]);

    setServerErrorReportsEnabled(true);
    Sentry.captureException(new Error("back on"));
    await Sentry.flush(200);
    expect(sentEnvelopes.length).toBeGreaterThan(0);
  });

  it("holds events until settings load, and drops them if reports are off", async () => {
    const { captureSentryException, Sentry, setServerErrorReportsEnabled } =
      await loadServerSentry(undefined);

    captureSentryException(new Error("before settings loaded"));
    await Sentry.flush(200);
    expect(sentEnvelopes).toEqual([]);

    setServerErrorReportsEnabled(false);
    await Sentry.flush(200);
    expect(sentEnvelopes).toEqual([]);
  });

  it("still reports a startup failure that happens before settings can load", async () => {
    const { captureSentryException, flushSentry } = await loadServerSentry(undefined);

    captureSentryException(new Error("Moss server process failure"));
    await flushSentry(200);

    expect(sentEnvelopes.length).toBeGreaterThan(0);
  });

  it("doesn't let a send that never finishes hold the process open or its slot", async () => {
    await loadServerSentry("1");
    const onSocket: Array<(socket: { unref: () => void }) => void> = [];
    const request = {
      destroy: vi.fn(),
      on: vi.fn((event: string, listener: (socket: { unref: () => void }) => void) => {
        if (event === "socket") onSocket.push(listener);
      }),
      setTimeout: vi.fn(),
    };
    httpsRequest.mockReturnValue(request);

    transportOptions.httpModule?.request({ host: "127.0.0.1" });

    const unref = vi.fn();
    for (const listener of onSocket) listener({ unref });
    expect(unref).toHaveBeenCalledOnce();

    const [timeoutMs, onTimeout] = request.setTimeout.mock.calls[0] as [number, () => void];
    expect(timeoutMs).toBeLessThanOrEqual(10_000);
    onTimeout();
    expect(request.destroy).toHaveBeenCalledOnce();
  });

  it("removes the machine name and error text from what it does send", async () => {
    const { captureSentryException, flushSentry } = await loadServerSentry("1");

    captureSentryException(new Error("provider said my private plan"));
    await flushSentry(200);

    const sent = JSON.stringify(sentEnvelopes);
    expect(sent).not.toContain("my private plan");
    expect(sent).not.toContain("server_name");
    expect(sent).toContain("[message withheld]");
  });

  it("sends schema-safe diagnostic contexts without trace IDs or application start time", async () => {
    const { Sentry, flushSentry } = await loadServerSentry("1");

    Sentry.captureEvent({
      message: "Moss server process failure",
      contexts: {
        app: { app_start_time: "2026-11-01T08:38:10.251Z", app_memory: 42, free_memory: 128 },
        trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef" },
      },
    });
    await flushSentry(200);

    expect(sentEnvelopes.length).toBeGreaterThan(0);
    const [, items] = sentEnvelopes[0] as [
      unknown,
      Array<[{ type: string }, { contexts?: Record<string, unknown> }]>,
    ];
    const event = items.find(([header]) => header.type === "event")?.[1];
    expect(event?.contexts).toMatchObject({ app: { app_memory: 42, free_memory: 128 } });
    expect(event?.contexts).not.toHaveProperty("trace");
    expect(event?.contexts).not.toHaveProperty("app.app_start_time");
  });
});
