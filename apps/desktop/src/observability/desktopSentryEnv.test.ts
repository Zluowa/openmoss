import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readDesktopErrorReportsPreference,
  resolveDesktopSentryEnv,
  writeDesktopErrorReportsPreference,
} from "./desktopSentryEnv";

const EMBEDDED = "https://public@example.ingest.us.sentry.io/1";

describe("resolveDesktopSentryEnv", () => {
  it("adds nothing when the build embedded no DSN", () => {
    expect(resolveDesktopSentryEnv({}, "")).toEqual({});
    expect(resolveDesktopSentryEnv({}, "   ")).toEqual({});
  });

  it("uses the embedded DSN and labels the process as production", () => {
    expect(resolveDesktopSentryEnv({}, ` ${EMBEDDED} `)).toEqual({
      MOSS_SENTRY_DSN: EMBEDDED,
      MOSS_SENTRY_ENVIRONMENT: "production",
    });
  });

  it("keeps an explicit environment label", () => {
    expect(resolveDesktopSentryEnv({ MOSS_SENTRY_ENVIRONMENT: "canary" }, EMBEDDED)).toEqual({
      MOSS_SENTRY_DSN: EMBEDDED,
      MOSS_SENTRY_ENVIRONMENT: "canary",
    });
  });

  it("lets the launch environment replace the embedded DSN", () => {
    expect(
      resolveDesktopSentryEnv({ MOSS_SENTRY_DSN: "https://other@example.test/2" }, EMBEDDED),
    ).toEqual({});
  });

  it("lets an empty launch value turn reporting off", () => {
    expect(resolveDesktopSentryEnv({ MOSS_SENTRY_DSN: "" }, EMBEDDED)).toEqual({});
  });
});

describe("desktop error-report preference", () => {
  const directories: string[] = [];
  const preferencePath = () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-error-reports-"));
    directories.push(directory);
    return Path.join(directory, "nested", "desktop-error-reports");
  };

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("defaults to on when nothing has been saved", () => {
    expect(readDesktopErrorReportsPreference(preferencePath())).toBe(true);
  });

  it("round-trips both choices", async () => {
    const path = preferencePath();
    await writeDesktopErrorReportsPreference(path, false);
    expect(readDesktopErrorReportsPreference(path)).toBe(false);
    await writeDesktopErrorReportsPreference(path, true);
    expect(readDesktopErrorReportsPreference(path)).toBe(true);
  });

  it("treats a file it can't understand as off", async () => {
    const path = preferencePath();
    await writeDesktopErrorReportsPreference(path, true);
    FS.writeFileSync(path, "garbled");
    expect(readDesktopErrorReportsPreference(path)).toBe(false);
  });

  it("treats an unreadable preference as off", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-error-reports-"));
    directories.push(directory);
    // Reading a directory fails with something other than "not found".
    expect(readDesktopErrorReportsPreference(directory)).toBe(false);
  });
});
