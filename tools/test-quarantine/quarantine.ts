// The test quarantine list (`test-quarantine.json` at the repository root): its shape, its
// rules, and how an entry is matched to a test. Pure functions only; callers do the I/O.
// See tools/test-quarantine/README.md.

export const QUARANTINE_FILE = "test-quarantine.json";
export const MAX_ENTRIES = 40;
export const MAX_DAYS = 14;

export const PLATFORMS = ["win32", "linux", "darwin", "all"] as const;
export type QuarantinePlatform = (typeof PLATFORMS)[number];

/** Where each lane's files live, and whether the lane runs in a browser. */
export const LANES = {
  contracts: { dir: "packages/contracts", browser: false },
  shared: { dir: "packages/shared", browser: false },
  desktop: { dir: "apps/desktop", browser: false },
  web: { dir: "apps/web", browser: false },
  server: { dir: "apps/server", browser: false },
  scripts: { dir: "scripts", browser: false },
  components: { dir: "apps/web", browser: true },
  chat: { dir: "apps/web", browser: true },
  geometry: { dir: "apps/web", browser: true },
} as const;
export type QuarantineLane = keyof typeof LANES;

/** Tests that must stay visible however often they fail. */
export const NEVER_QUARANTINE: Readonly<Record<string, string>> = {
  "apps/desktop/src/backendShutdown.windows.integration.test.ts":
    "it finds real shutdown regressions (bisected 2026-11-05); rerun it alone and bisect instead",
};

export interface QuarantineEntry {
  readonly id: string;
  readonly platform: QuarantinePlatform;
  readonly reason: string;
  readonly owner: string;
  readonly added: string;
  readonly expires: string;
  readonly evidence: string;
}

export interface ParsedId {
  readonly lane: QuarantineLane;
  /** Repository-relative, forward slashes. */
  readonly file: string;
  /** Describe blocks and test title joined by " > ", as Vitest prints a failure; absent for a whole file. */
  readonly name?: string;
}

const FIELDS = ["id", "platform", "reason", "owner", "added", "expires", "evidence"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OWNER = /^[a-z][a-z0-9-]*(\/[a-z0-9-]+)*$/;

export function parseQuarantineId(id: string): ParsedId | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const lane = id.slice(0, colon);
  if (!Object.hasOwn(LANES, lane)) return null;
  const rest = id.slice(colon + 1);
  const separator = rest.indexOf(" > ");
  const file = separator === -1 ? rest : rest.slice(0, separator);
  const name = separator === -1 ? undefined : rest.slice(separator + 3);
  if (!file || file !== file.trim() || file.includes("\\") || file.startsWith("/")) return null;
  if (name !== undefined && name.trim() === "") return null;
  return name === undefined
    ? { lane: lane as QuarantineLane, file }
    : { lane: lane as QuarantineLane, file, name };
}

function dayNumber(date: string): number | null {
  if (!DATE.test(date)) return null;
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) return null;
  return time / 86_400_000;
}

/** Today as YYYY-MM-DD in UTC, so every machine and CI agree on when an entry expires. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface ValidateOptions {
  /** YYYY-MM-DD (UTC). Omit to skip the date-dependent rules (expired, added in the future). */
  readonly today?: string;
  /** Whether a repository-relative file exists; omit to skip the check. */
  readonly fileExists?: (file: string) => boolean;
}

/** Every rule the list must satisfy. An empty result means the list is valid. */
export function validateQuarantine(raw: unknown, options: ValidateOptions): string[] {
  const problems: string[] = [];
  if (!Array.isArray(raw)) return [`${QUARANTINE_FILE} must hold a JSON array of entries`];
  if (raw.length > MAX_ENTRIES) {
    problems.push(
      `${raw.length} entries; the limit is ${MAX_ENTRIES}. Fix or delete entries before adding more.`,
    );
  }
  const today = options.today === undefined ? null : dayNumber(options.today);
  if (options.today !== undefined && today === null) problems.push(`today must be YYYY-MM-DD`);
  const seen = new Set<string>();
  raw.forEach((entry: unknown, index) => {
    const label = `entry ${index + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push(`${label}: must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const where = typeof record.id === "string" && record.id ? `${label} (${record.id})` : label;
    for (const key of Object.keys(record)) {
      if (!(FIELDS as readonly string[]).includes(key))
        problems.push(`${where}: unknown field "${key}"`);
    }
    for (const key of FIELDS) {
      const value = record[key];
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`${where}: "${key}" is missing or empty`);
      }
    }
    if (typeof record.id === "string" && record.id) {
      if (seen.has(record.id)) problems.push(`${where}: duplicate id`);
      seen.add(record.id);
      const parsed = parseQuarantineId(record.id);
      if (!parsed) {
        problems.push(
          `${where}: id must be "<lane>:<repo-relative file>[ > <test name>]" with lane one of ${Object.keys(LANES).join(", ")}`,
        );
      } else {
        const lane = LANES[parsed.lane];
        if (!parsed.file.startsWith(`${lane.dir}/`)) {
          problems.push(`${where}: lane "${parsed.lane}" runs files under ${lane.dir}/`);
        }
        if (lane.browser !== parsed.file.includes(".browser.")) {
          problems.push(
            `${where}: ${lane.browser ? "browser lanes run *.browser.* files" : "unit lanes do not run *.browser.* files"}`,
          );
        }
        if (options.fileExists && !options.fileExists(parsed.file)) {
          problems.push(`${where}: ${parsed.file} does not exist`);
        }
        const never = NEVER_QUARANTINE[parsed.file];
        if (never) problems.push(`${where}: never quarantined, because ${never}`);
      }
    }
    if (
      typeof record.platform === "string" &&
      !(PLATFORMS as readonly string[]).includes(record.platform)
    ) {
      problems.push(`${where}: platform must be one of ${PLATFORMS.join(", ")}`);
    }
    if (typeof record.owner === "string" && record.owner.trim() && !OWNER.test(record.owner)) {
      problems.push(`${where}: owner must be an area such as "server" or "web/transcript"`);
    }
    const added = typeof record.added === "string" ? dayNumber(record.added) : null;
    const expires = typeof record.expires === "string" ? dayNumber(record.expires) : null;
    if (typeof record.added === "string" && record.added && added === null) {
      problems.push(`${where}: added must be a date YYYY-MM-DD`);
    }
    if (typeof record.expires === "string" && record.expires && expires === null) {
      problems.push(`${where}: expires must be a date YYYY-MM-DD`);
    }
    if (added !== null && expires !== null) {
      if (expires < added) problems.push(`${where}: expires before it was added`);
      else if (expires - added > MAX_DAYS) {
        problems.push(
          `${where}: expires ${expires - added} days after it was added; the limit is ${MAX_DAYS}`,
        );
      }
    }
    if (today !== null && added !== null && added > today) {
      problems.push(`${where}: added ${String(record.added)} is in the future (dates are UTC)`);
    }
    if (today !== null && expires !== null && today > expires) {
      problems.push(
        `${where}: expired on ${String(record.expires)}. Fix the test or delete the entry.`,
      );
    }
  });
  return problems;
}

/** Entries that apply on this platform. Assumes the list passed `validateQuarantine`. */
export function entriesFor(
  entries: readonly QuarantineEntry[],
  platform: string,
): Array<QuarantineEntry & ParsedId> {
  return entries.flatMap((entry) => {
    if (entry.platform !== "all" && entry.platform !== platform) return [];
    const parsed = parseQuarantineId(entry.id);
    return parsed ? [{ ...entry, ...parsed }] : [];
  });
}

/**
 * Whether an entry's test name covers a test. `chain` is the test's describe blocks and title
 * joined by " > ". An entry covers the test with exactly that name and every test whose name
 * continues it after a space: a whole describe block (`Suite` covers `Suite > case`) or the
 * cases of an each() table (`fits the bar` covers `fits the bar (light)`). `$name` and `%s`
 * placeholders copied from a title match any text.
 */
export function nameCovers(entryName: string, chain: string): boolean {
  const pattern = entryName
    .split(/(\$[A-Za-z_][\w.]*|%[sdifjo#%])/)
    .map((part, index) => (index % 2 === 1 ? ".+?" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${pattern}(?: .*)?$`, "s").test(chain);
}
