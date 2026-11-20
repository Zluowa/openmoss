import * as fs from "node:fs/promises";
import { Effect } from "effect";
import { redactDiagnosticText } from "@moss/shared/diagnosticsRedaction";
import { writeFileStringAtomically } from "./atomicWrite";

const MINUTE = 60_000;

export interface DevsMirrorOptions {
  /** Fetches GitHub's main into the mirror, killed after `timeoutMs`. */
  fetch: (timeoutMs: number) => Promise<void>;
  /** The mirror's main commit, so a saved fetch time is trusted only for the same mirror. */
  head: () => Promise<string>;
  /** Keeps the time of the last successful fetch across worker restarts. */
  stampFile: string;
  now?: () => number;
  /** A background fetch outside any job. A slow link needs time to finish a pack. */
  warmTimeoutMs?: number;
  /** The short refresh a job makes when the mirror is not recent; on failure it uses the mirror. */
  topUpTimeoutMs?: number;
  /** A job skips its own refresh when the mirror was refreshed this recently. */
  topUpAfterMs?: number;
  /** Past this age the worker stops claiming reports. */
  maxAgeMs?: number;
  /** Wait after a successful background fetch, and the longest wait after failed ones. */
  refreshEveryMs?: number;
  /** First wait after a failed background fetch; it doubles up to `refreshEveryMs`. */
  retryAfterMs?: number;
  log?: (line: string) => void;
}

/**
 * The local mirror every job clones from. It is kept current by fetches that run outside any
 * job lease, with a generous timeout, so a slow link to GitHub delays claiming instead of
 * failing a user's report: the worker claims only while the mirror is recent, and a job never
 * fails just because its own refresh is slow.
 */
export class DevsMirror {
  private fetchedAt: number | null = null;
  private inFlight: Promise<boolean> | null = null;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private readonly options: DevsMirrorOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private get maxAgeMs(): number {
    return this.options.maxAgeMs ?? 120 * MINUTE;
  }

  /** Trusts a saved fetch time only while the mirror still holds the commit it recorded. */
  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.options.stampFile, "utf8")) as {
        fetchedAt?: unknown;
        head?: unknown;
      };
      if (
        typeof saved.fetchedAt === "number" &&
        Number.isFinite(saved.fetchedAt) &&
        saved.fetchedAt <= this.now() &&
        typeof saved.head === "string" &&
        saved.head === (await this.options.head()).trim()
      )
        this.fetchedAt = saved.fetchedAt;
    } catch {
      // No usable record: the first background fetch decides.
    }
  }

  /** Milliseconds since the last successful fetch, or null before the first one. */
  age(): number | null {
    return this.fetchedAt === null ? null : Math.max(0, this.now() - this.fetchedAt);
  }

  isFresh(): boolean {
    const age = this.age();
    return age !== null && age <= this.maxAgeMs;
  }

  /** One fetch at a time; a caller that arrives during one shares its result. */
  refresh(timeoutMs = this.options.warmTimeoutMs ?? 60 * MINUTE): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const started = this.now();
    this.inFlight = (async () => {
      try {
        await this.options.fetch(timeoutMs);
        const head = (await this.options.head()).trim();
        // The start time: everything on GitHub before it is in the mirror.
        this.fetchedAt = started;
        if (this.failures)
          this.options.log?.(
            `Repository mirror refreshed after ${this.failures} failed attempt(s); the worker can claim reports.`,
          );
        this.failures = 0;
        // Only lets a restart skip its first fetch; the mirror is usable without it.
        await Effect.runPromise(
          writeFileStringAtomically({
            filePath: this.options.stampFile,
            contents: JSON.stringify({ fetchedAt: started, head }),
          }),
        ).catch(() => {});
        return true;
      } catch (error) {
        this.failures++;
        const age = this.age();
        this.options.log?.(
          `Repository mirror refresh failed (${redactDiagnosticText(
            error instanceof Error ? error.message : "error",
            { maxLength: 300 },
          )}); ${
            this.isFresh()
              ? `the mirror is ${Math.round((age ?? 0) / MINUTE)} min old and still used.`
              : "reports stay queued until a refresh succeeds."
          }`,
        );
        return false;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * Called inside a job. A recent mirror is used as it is; an older one gets one short
   * refresh, and if that fails the job still uses the mirror while it is within its age limit.
   * A background fetch already running is never waited for.
   */
  async topUp(): Promise<void> {
    if (this.inFlight && this.isFresh()) return;
    const age = this.age();
    if (age !== null && age < (this.options.topUpAfterMs ?? 10 * MINUTE)) return;
    if (await this.refresh(this.options.topUpTimeoutMs ?? 5 * MINUTE)) return;
    if (!this.isFresh())
      throw new Error(
        "The repository mirror is out of date and GitHub could not be reached; no change was made.",
      );
  }

  /** Background refreshes: now, then after every success, with a backoff after failures. */
  start(): void {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      const ok = await this.refresh();
      if (this.stopped) return;
      const every = this.options.refreshEveryMs ?? 10 * MINUTE;
      const retry = this.options.retryAfterMs ?? 2 * MINUTE;
      const delay = ok ? every : Math.min(every, retry * 2 ** Math.min(this.failures - 1, 10));
      this.timer = setTimeout(() => void tick(), delay);
      this.timer.unref?.();
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Combines the checks a worker must pass before it claims a report. It answers false while
 * any check fails, and logs one line when the set of failing checks changes, so a worker
 * that cannot run a repair leaves every report in the queue and says why.
 */
export function devsWorkerReadiness(
  checks: Readonly<Record<string, () => Promise<boolean> | boolean>>,
  log?: (line: string) => void,
): () => Promise<boolean> {
  let previous: string | null = null;
  return async () => {
    const failing: string[] = [];
    for (const [name, check] of Object.entries(checks)) {
      let ok = false;
      try {
        ok = await check();
      } catch {
        ok = false;
      }
      if (!ok) failing.push(name);
    }
    const current = failing.join(", ");
    if (current !== previous) {
      if (failing.length)
        log?.(`Developer worker not ready (${current}); reports stay in the queue.`);
      else if (previous !== null) log?.("Developer worker ready; claiming reports again.");
      previous = current;
    }
    return failing.length === 0;
  };
}

/** True when the path is an existing file, for a configured executable. */
export async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
