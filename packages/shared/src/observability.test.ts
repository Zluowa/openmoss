import { describe, expect, it } from "vitest";
import {
  createSentryReportingGate,
  normalizeSentryDsn,
  parseSentrySampleRate,
  resolveMossSentryRuntimeConfig,
  sanitizeSentryText,
  scrubSentryEvent,
  toSentrySafeError,
} from "./observability";

describe("Moss Sentry runtime configuration", () => {
  it("accepts a public HTTPS DSN but rejects credentials outside the public key", () => {
    expect(normalizeSentryDsn("https://public-key@o123.ingest.sentry.io/456")).toBe(
      "https://public-key@o123.ingest.sentry.io/456",
    );
    expect(normalizeSentryDsn("http://public-key@o123.ingest.sentry.io/456")).toBeUndefined();
    expect(
      normalizeSentryDsn("https://public-key:secret@o123.ingest.sentry.io/456"),
    ).toBeUndefined();
    expect(
      normalizeSentryDsn("https://public-key@o123.ingest.sentry.io/456?debug=1"),
    ).toBeUndefined();
  });

  it("fails closed to bounded defaults for malformed configuration", () => {
    expect(
      resolveMossSentryRuntimeConfig({
        env: {
          MOSS_SENTRY_DSN: "not a dsn",
          MOSS_SENTRY_ENVIRONMENT: "production\ncanary",
          MOSS_SENTRY_RELEASE: "\u0000release",
          MOSS_SENTRY_TRACES_SAMPLE_RATE: "2",
          MOSS_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE: "-1",
        },
        defaultEnvironment: "development",
        defaultRelease: "moss-server@0.0.0",
      }),
    ).toEqual({
      environment: "development",
      release: "moss-server@0.0.0",
      tracesSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    });
  });

  it("preserves configured rates and release metadata", () => {
    expect(
      resolveMossSentryRuntimeConfig({
        env: {
          MOSS_SENTRY_DSN: "https://public-key@o123.ingest.sentry.io/456",
          MOSS_SENTRY_ENVIRONMENT: "production-cn",
          MOSS_SENTRY_RELEASE: "moss-server@0.7.6+abc123",
          MOSS_SENTRY_TRACES_SAMPLE_RATE: "0.25",
          MOSS_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE: "0.05",
        },
        defaultEnvironment: "development",
        defaultRelease: "moss-server@0.0.0",
      }),
    ).toEqual({
      dsn: "https://public-key@o123.ingest.sentry.io/456",
      environment: "production-cn",
      release: "moss-server@0.7.6+abc123",
      tracesSampleRate: 0.25,
      replaysOnErrorSampleRate: 0.05,
    });
  });

  it("uses the fallback when a sample rate is not finite", () => {
    expect(parseSentrySampleRate("NaN", 0.2)).toBe(0.2);
    expect(parseSentrySampleRate("0.4", 0.2)).toBe(0.4);
  });

  it("redacts sensitive exception text without serializing unknown objects", () => {
    expect(sanitizeSentryText("provider failed token=abc123 prompt=private value")).toBe(
      "provider failed token=[REDACTED] prompt=[REDACTED] value",
    );
    const source = new Error("request failed password=secret");
    source.name = "ProviderError";
    const safe = toSentrySafeError(source);
    expect(safe).toMatchObject({
      name: "ProviderError",
      message: "request failed password=[REDACTED]",
    });
    expect(safe.stack?.split("\n")[0]).toBe("ProviderError: request failed password=[REDACTED]");
    expect(sanitizeSentryText({ prompt: "private" })).toBe("Unknown error");
  });

  it("scrubs SDK event payloads while retaining bounded diagnostics", () => {
    const scrubbed = scrubSentryEvent({
      user: { id: "private" },
      request: {
        url: "https://example.test/failure?token=private",
        headers: { authorization: "private" },
        data: { prompt: "private" },
      },
      breadcrumbs: [
        { category: "ui.input", message: "private prompt" },
        { category: "network", message: "request failed token=private" },
        { category: "electron", message: "window.focus token=private" },
      ],
      exception: { values: [{ type: "ProviderError", value: "body=private" }] },
      extra: { prompt: "private", identity: { email: "private" }, retryCount: 2, arg: "private" },
      contexts: { user: { email: "private" }, runtime: { name: "bun" } },
      tags: { surface: "web", token: "private" },
      message: "failure body=private",
    });

    expect(scrubbed).toEqual({
      request: { url: "https://example.test/failure" },
      breadcrumbs: [
        { category: "network" },
        { category: "electron", message: "window.focus token=[REDACTED]" },
      ],
      exception: { values: [{ type: "ProviderError", value: "[message withheld]" }] },
      extra: { retryCount: 2 },
      contexts: { runtime: { name: "bun" } },
      tags: { surface: "web" },
      message: "[message withheld]",
    });
  });

  it("withholds error text that could quote a prompt, a file, or a provider's response", () => {
    const secret = "sk-ant-canaryCANARYcanary1234567890";
    const withheld = [
      `Provider said: your prompt was "please review my private plan" using ${secret}`,
      'Error 400: {"error":{"message":"Invalid request","prompt":"my private plan"}}',
      `Unexpected token 'h', "here is my private file" is not valid JSON`,
      "Non-Error promise rejection captured with value: my private plan",
      "Moss, please review my private plan",
      "Failed to fetch https://example.test/private?token=canary",
      "the plan is not a function of what we said",
    ];
    for (const value of withheld) {
      const scrubbed = scrubSentryEvent({ exception: { values: [{ type: "Error", value }] } });
      expect(scrubbed).toEqual({
        exception: { values: [{ type: "Error", value: "[message withheld]" }] },
      });
    }
  });

  it("keeps Moss's own messages and runtime errors of a known shape", () => {
    const passes = (value: string, expected = value) =>
      expect(scrubSentryEvent({ exception: { values: [{ value }] } })).toEqual({
        exception: { values: [{ value: expected }] },
      });

    passes("Moss web query failed");
    passes("Moss desktop IPC handler failed");
    passes("Moss server process failure");
    passes("Moss realtime relay process failure");
    passes("Moss model gateway returned 5xx");
    passes("Agent gateway MCP failure (provider-query-failed)");
    passes("Cannot read properties of undefined (reading 'length')");
    passes("foo.bar is not a function");
    passes("Failed to fetch");
    passes("unable to open database file");
    // Only the code survives, because the rest names the user's file.
    passes("ENOENT: no such file or directory, open 'C:\\Users\\jane\\plan.md'", "ENOENT");
    passes("read ECONNRESET", "ECONNRESET");
    passes(
      "Minified React error #185; visit https://react.dev/errors/185",
      "Minified React error #185",
    );
  });

  it("drops an error type that isn't an identifier", () => {
    expect(
      scrubSentryEvent({ exception: { values: [{ type: "my private plan", value: "x" }] } }),
    ).toEqual({ exception: { values: [{ type: "Error", value: "[message withheld]" }] } });
  });

  it("redacts known secret shapes from every remaining free-text field", () => {
    expect(sanitizeSentryText("failed with sk-ant-canaryCANARYcanary1234567890 here")).toBe(
      "failed with [redacted] here",
    );
    expect(sanitizeSentryText("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("[redacted]");
  });

  it("drops the boot time, which helps fingerprint a machine and doesn't help triage", () => {
    expect(
      scrubSentryEvent({
        contexts: { device: { boot_time: "2026-11-01T08:38:10.251Z", arch: "x64" } },
      }),
    ).toEqual({ contexts: { device: { arch: "x64" } } });
  });

  it("removes SDK trace correlation and startup times without damaging the canary context schema", () => {
    // Mirrors the contexts returned by the real server canary. IDs are synthetic.
    const source = {
      contexts: {
        app: {
          app_start_time: "2026-11-01T08:38:10.251Z",
          app_memory: 42,
          free_memory: 128,
          type: "app",
        },
        trace: {
          trace_id: "0123456789abcdef0123456789abcdef",
          span_id: "0123456789abcdef",
          status: "unknown",
          type: "trace",
        },
        device: { boot_time: "2026-11-01T08:00:00.000Z", arch: "x64" },
        runtime: { name: "node", version: "24.18.0" },
      },
    };
    const unchanged = structuredClone(source);
    const scrubbed = scrubSentryEvent(source);

    expect(scrubbed.contexts).toEqual({
      app: { app_memory: 42, free_memory: 128, type: "app" },
      device: { arch: "x64" },
      runtime: { name: "node", version: "24.18.0" },
    });
    expect(source).toEqual(unchanged);
    // A trace-shaped credential elsewhere must still go through the strict scrubber.
    expect(
      scrubSentryEvent({ contexts: { runtime: { version: source.contexts.trace.trace_id } } }),
    ).toEqual({ contexts: { runtime: { version: "[redacted]" } } });
  });

  it("drops equivalent startup timestamp fields while preserving durations and other timestamps", () => {
    for (const key of [
      "appStartTime",
      "application_start_time",
      "process_start_time",
      "systemBootTime",
      "startup_timestamp",
      "bootTime",
    ]) {
      expect(
        scrubSentryEvent({
          contexts: { app: { [key]: 1234, duration_ms: 12, timestamp: 5678 } },
        }),
      ).toEqual({ contexts: { app: { duration_ms: 12, timestamp: 5678 } } });
    }
  });

  it("keeps a request to its method and a query-free URL", () => {
    expect(
      scrubSentryEvent({
        request: {
          method: "POST",
          url: "https://example.test/v1?key=private",
          env: { REMOTE_ADDR: "203.0.113.9" },
          data: "private",
        },
      }),
    ).toEqual({ request: { method: "POST", url: "https://example.test/v1" } });
  });

  it("removes the machine name and the user's name from paths", () => {
    const scrubbed = scrubSentryEvent({
      server_name: "janes-laptop",
      modules: { "private-package": "1.0.0" },
      logentry: { message: "jane's private text" },
      debug_meta: { images: [{ code_file: "C:\\Users\\jane\\app.js", debug_id: "abc" }] },
      breadcrumbs: [{ category: "network", message: "failed C:\\Users\\jane\\logs\\a.log" }],
      exception: {
        values: [
          {
            type: "Error",
            value: "ENOENT: open 'C:\\Users\\jane\\AppData\\state.json'",
            stacktrace: {
              frames: [
                {
                  filename: "C:\\Users\\jane\\AppData\\Local\\Programs\\Moss\\app.asar\\main.js",
                  abs_path: "file:///C:/Users/jane/AppData/main.js",
                  function: "run",
                  context_line: "const key = janesSecret;",
                },
                { filename: "/Users/jane/Applications/Moss.app/Contents/main.js" },
                { filename: "/home/jane/.local/share/moss/main.js" },
                { filename: "app:///dist/main.js" },
              ],
            },
          },
        ],
      },
    });

    expect(JSON.stringify(scrubbed)).not.toMatch(/jane/iu);
    expect(scrubbed).toMatchObject({
      debug_meta: { images: [{ code_file: "C:\\Users\\[user]\\app.js", debug_id: "abc" }] },
      exception: {
        values: [
          {
            value: "ENOENT",
            stacktrace: {
              frames: [
                {
                  filename: "C:\\Users\\[user]\\AppData\\Local\\Programs\\Moss\\app.asar\\main.js",
                  abs_path: "file:///C:/Users/[user]/AppData/main.js",
                  function: "run",
                },
                { filename: "/Users/[user]/Applications/Moss.app/Contents/main.js" },
                { filename: "/home/[user]/.local/share/moss/main.js" },
                { filename: "app:///dist/main.js" },
              ],
            },
          },
        ],
      },
    });
    expect((scrubbed as { server_name?: unknown }).server_name).toBeUndefined();
  });
});

describe("createSentryReportingGate", () => {
  function recordingTransport() {
    const sent: string[] = [];
    const flush = () => Promise.resolve(true);
    const send = (envelope: string) => {
      sent.push(envelope);
      return Promise.resolve({ statusCode: 200 });
    };
    return { sent, make: () => ({ send, flush }) };
  }

  it("sends nothing at all while closed", async () => {
    const { sent, make } = recordingTransport();
    const gate = createSentryReportingGate(false);
    const transport = gate.wrapTransport(make)({});

    await transport.send("error");
    await transport.send("session");
    await transport.send("client_report");

    expect(gate.isClosed()).toBe(true);
    expect(sent).toEqual([]);
  });

  it("sends while open and stops the moment it's turned off", async () => {
    const { sent, make } = recordingTransport();
    const gate = createSentryReportingGate(true);
    const transport = gate.wrapTransport(make)({});

    await transport.send("before");
    gate.setEnabled(false);
    await transport.send("after");

    expect(sent).toEqual(["before"]);
  });

  it("starts sending again when turned back on, without replaying what it refused", async () => {
    const { sent, make } = recordingTransport();
    const gate = createSentryReportingGate(false);
    const transport = gate.wrapTransport(make)({});

    await transport.send("refused");
    gate.setEnabled(true);
    await transport.send("later");

    expect(sent).toEqual(["later"]);
  });

  it("holds events until the preference is known, then sends them if it's on", async () => {
    const { sent, make } = recordingTransport();
    const gate = createSentryReportingGate(undefined);
    const transport = gate.wrapTransport(make)({});

    await transport.send("early");
    expect(gate.isPending()).toBe(true);
    expect(sent).toEqual([]);

    gate.setEnabled(true);
    expect(gate.isPending()).toBe(false);
    expect(sent).toEqual(["early"]);
  });

  it("drops held events if the preference turns out to be off", async () => {
    const { sent, make } = recordingTransport();
    const gate = createSentryReportingGate(undefined);
    const transport = gate.wrapTransport(make)({});

    await transport.send("early");
    gate.setEnabled(false);
    gate.setEnabled(true);

    expect(sent).toEqual([]);
  });

  it("holds only a bounded number of events", async () => {
    const { sent, make } = recordingTransport();
    const gate = createSentryReportingGate(undefined);
    const transport = gate.wrapTransport(make)({});

    for (let index = 0; index < 100; index += 1) await transport.send(`event-${index}`);
    gate.setEnabled(true);

    expect(sent).toHaveLength(30);
  });
});
