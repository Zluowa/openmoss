import { beforeEach, describe, expect, it, vi } from "vitest";

const electronSdk = vi.hoisted(() => {
  const sent: unknown[] = [];
  return {
    sent,
    init: vi.fn(),
    setTags: vi.fn(),
    withScope: vi.fn((callback: (scope: { setTag: () => void }) => void) =>
      callback({ setTag: vi.fn() }),
    ),
    captureException: vi.fn(),
    flush: vi.fn(async () => true),
    makeElectronTransport: () => ({
      send: (envelope: unknown) => {
        sent.push(envelope);
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    }),
  };
});

// The Electron SDK can't load outside Electron, so this checks what main hands it.
vi.mock("node:module", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:module")>()),
  createRequire: () => () => electronSdk,
}));

async function loadDesktopSentry() {
  vi.stubEnv("MOSS_SENTRY_DSN", "https://public@127.0.0.1:9/1");
  const module = await import("./sentry");
  const options = electronSdk.init.mock.calls[0]?.[0] as {
    readonly transport: (options: object) => {
      send(envelope: unknown): PromiseLike<unknown>;
    };
    readonly integrations: (defaults: Array<{ name: string }>) => Array<{ name: string }>;
    readonly tracePropagationTargets: readonly string[];
    readonly tracesSampleRate: number;
    readonly beforeSend: (event: Record<string, unknown>) => Record<string, unknown>;
  };
  return { ...module, options };
}

describe("Electron main error reports", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    electronSdk.sent.length = 0;
    electronSdk.init.mockClear();
    electronSdk.captureException.mockClear();
  });

  it("sends nothing through its transport while off, and follows the switch live", async () => {
    const { options, setDesktopErrorReportsEnabled } = await loadDesktopSentry();
    const transport = options.transport({});

    setDesktopErrorReportsEnabled(false);
    await transport.send("while off");
    expect(electronSdk.sent).toEqual([]);

    setDesktopErrorReportsEnabled(true);
    await transport.send("while on");
    expect(electronSdk.sent).toEqual(["while on"]);

    setDesktopErrorReportsEnabled(false);
    await transport.send("off again");
    expect(electronSdk.sent).toEqual(["while on"]);
  });

  it("holds early events until main has read the preference", async () => {
    const { options, setDesktopErrorReportsEnabled } = await loadDesktopSentry();
    const transport = options.transport({});

    await transport.send("before the preference was read");
    expect(electronSdk.sent).toEqual([]);

    setDesktopErrorReportsEnabled(false);
    expect(electronSdk.sent).toEqual([]);
  });

  it("doesn't capture while off", async () => {
    const { captureSentryException, setDesktopErrorReportsEnabled } = await loadDesktopSentry();

    setDesktopErrorReportsEnabled(false);
    captureSentryException(new Error("while off"));

    expect(electronSdk.captureException).not.toHaveBeenCalled();
  });

  it("removes native crash dumps and quit delays, and adds no trace headers or spans", async () => {
    const { options } = await loadDesktopSentry();

    expect(
      options.integrations([
        { name: "SentryMinidump" },
        { name: "MainProcessSession" },
        { name: "OnUncaughtException" },
      ]),
    ).toEqual([{ name: "OnUncaughtException" }]);
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options.tracesSampleRate).toBe(0);
  });

  it("hands the Electron SDK schema-safe contexts without trace IDs or application start time", async () => {
    const { options } = await loadDesktopSentry();

    expect(
      options.beforeSend({
        contexts: {
          app: { app_start_time: "2026-11-01T08:38:10.251Z", app_memory: 42, free_memory: 128 },
          trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef" },
          device: { arch: "x64" },
        },
      }),
    ).toEqual({
      contexts: { app: { app_memory: 42, free_memory: 128 }, device: { arch: "x64" } },
    });
  });
});
