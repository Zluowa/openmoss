import { describe, expect, it } from "vitest";
import {
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
      tracesSampleRate: 0.1,
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
      ],
      exception: { values: [{ type: "ProviderError", value: "body=private" }] },
      extra: { prompt: "private", identity: { email: "private" }, retryCount: 2 },
      contexts: { user: { email: "private" }, runtime: { name: "bun" } },
      tags: { surface: "web", token: "private" },
      message: "failure body=private",
    });

    expect(scrubbed).toMatchObject({
      request: { url: "https://example.test/failure" },
      breadcrumbs: [{ category: "network", message: "request failed token=[REDACTED]" }],
      exception: { values: [{ value: "body=[REDACTED]" }] },
      extra: { retryCount: 2 },
      contexts: { runtime: { name: "bun" } },
      tags: { surface: "web" },
      message: "failure body=[REDACTED]",
    });
    expect((scrubbed as { user?: unknown }).user).toBeUndefined();
  });
});
