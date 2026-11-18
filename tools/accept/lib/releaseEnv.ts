// FILE: releaseEnv.ts
// Purpose: What a release code update must carry that a session's environment does not: the Sentry
//          DSNs (without them clients send no error reports) and, when configured, the feedback
//          endpoint. Read from the same private files the installer build reads
//          (E:/DevTemp/moss/claude-takeover/build-win-candidate-107.ts): VITE_SENTRY_DSN and
//          MOSS_SENTRY_DSN lines of the Sentry env file, MOSS_FEEDBACK_ENDPOINT of the feedback env
//          file (https only). The file locations come from flags or the ws profile's `release`
//          section, never from this code. No value is ever printed or written: callers log names.
// Layer: tools/accept

import fs from "node:fs";

import { profilePathFromEnv } from "../../ws/lib/profile.ts";

export const SENTRY_NAMES = ["VITE_SENTRY_DSN", "MOSS_SENTRY_DSN"] as const;

export interface ReleaseFiles {
  readonly sentryEnvFile: string | undefined;
  readonly feedbackEnvFile: string | undefined;
}

export interface ReleaseEnv {
  /** Names to add to the build's environment. Never logged or written anywhere. */
  readonly env: Readonly<Record<string, string>>;
  /** The names that were loaded (for the log). */
  readonly loaded: readonly string[];
  /** Why this cannot be a release build; empty when it can. */
  readonly problems: readonly string[];
}

/** Flags first, then the ws profile's `release: { sentryEnvFile, feedbackEnvFile }`. */
export function resolveReleaseFiles(
  flags: { sentryEnv?: string | undefined; feedbackEnv?: string | undefined },
  profileFile: string = profilePathFromEnv(),
): ReleaseFiles {
  let release: { sentryEnvFile?: unknown; feedbackEnvFile?: unknown } = {};
  try {
    const raw = JSON.parse(fs.readFileSync(profileFile, "utf8")) as { release?: unknown };
    if (raw.release && typeof raw.release === "object") release = raw.release as typeof release;
  } catch {
    // no profile: flags only
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    sentryEnvFile: flags.sentryEnv ?? str(release.sentryEnvFile),
    feedbackEnvFile: flags.feedbackEnv ?? str(release.feedbackEnvFile),
  };
}

function lines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split(/\r?\n/);
}

export function loadReleaseEnv(files: ReleaseFiles): ReleaseEnv {
  const env: Record<string, string> = {};
  const problems: string[] = [];
  if (!files.sentryEnvFile)
    problems.push("no Sentry env file (--sentry-env, or release.sentryEnvFile in the ws profile)");
  else if (!fs.existsSync(files.sentryEnvFile))
    problems.push(`the Sentry env file does not exist: ${files.sentryEnvFile}`);
  else {
    for (const line of lines(files.sentryEnvFile)) {
      const match = /^(VITE_SENTRY_DSN|MOSS_SENTRY_DSN)=(.*)$/.exec(line);
      if (match && match[2]!.trim()) env[match[1]!] = match[2]!.trim();
    }
    for (const name of SENTRY_NAMES)
      if (!env[name]) problems.push(`${name} is missing or empty in the Sentry env file`);
  }
  if (files.feedbackEnvFile && fs.existsSync(files.feedbackEnvFile)) {
    for (const line of lines(files.feedbackEnvFile)) {
      const match = /^\s*MOSS_FEEDBACK_ENDPOINT\s*=\s*(.*)$/.exec(line);
      const value = match?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
      if (!value) continue;
      let https = false;
      try {
        const url = new URL(value);
        https = url.protocol === "https:" && !url.username && !url.password;
      } catch {
        https = false;
      }
      if (!https)
        problems.push("MOSS_FEEDBACK_ENDPOINT in the feedback env file must be an https address");
      else env.VITE_FEEDBACK_ENDPOINT = value;
    }
  }
  return { env, loaded: Object.keys(env).toSorted(), problems };
}
