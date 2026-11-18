// FILE: codeUpdateState.ts
// Purpose: The code-update store's state and the boot decision: which code the desktop starts
//          (a verified code update or the installed archive), and when a new code update is
//          rejected and the previous code restored.
// Layer: Shared runtime policy. Pure functions plus two small synchronous file helpers, because
//        the desktop's boot entry runs it before anything else is loaded. No package imports.
//
// Design: D:\ceshi\moss-codex-handoff\rounds\20261117-owner-test\CODE-UPDATES.md §2.3 and §4.2.

import * as path from "node:path";

/** Off by default: without it the boot entry loads the installed code and nothing else happens. */
export const CODE_UPDATE_SWITCH_ENV = "MOSS_CODE_UPDATES";
export const CODE_UPDATE_DIR_ENV = "MOSS_CODE_UPDATE_DIR";

export const CODE_UPDATE_STATE_FILE = "state.json";
export const CODE_UPDATE_INSTALLED_FILE = "installed.json";
export const CODE_UPDATE_ARCHIVE_FILE = "app.asar";

/** A trial that has not reported healthy this long after its start is rejected. */
export const CODE_UPDATE_HEALTHY_DEADLINE_MS = 180_000;
/** Starts of a trial that ended without a clean quit and without reaching healthy. */
export const CODE_UPDATE_MAX_UNCLEAN_STARTS = 2;

export type CodeUpdateRejectionReason =
  | "load-error"
  | "timeout"
  | "crash-loop"
  | "damaged"
  | "shell-changed";

export interface CodeUpdateRejection {
  readonly reason: CodeUpdateRejectionReason;
  readonly detail: string;
  readonly at: string;
}

/** Written by the apply step into `<store>/<id>/installed.json`, last, after every check passed. */
export interface CodeUpdateInstalled {
  readonly schema: 1;
  readonly id: string;
  readonly commit: string;
  readonly codeVersion: string;
  readonly channel: string;
  readonly sequence: number;
  /** The installed shell (the commit in the installed archive's package.json) it was spliced onto. */
  readonly shellCommit: string;
  readonly archiveSize: number;
  readonly archiveSha256: string;
  readonly migrations: { readonly latest: number; readonly readerFloor: number };
  readonly installedAt: string;
}

export interface CodeUpdateTrial {
  readonly id: string;
  readonly uncleanStarts: number;
  /** True from a start until a clean quit or healthy; still true at the next start = unclean. */
  readonly running: boolean;
  readonly pid: number | null;
  readonly startedAt: string | null;
}

/**
 * Disk use: in steady state ONE private archive (the active code's). A trial has its own archive
 * beside the active one until it is healthy; then the old one is deleted. The packages of the
 * last two applied updates (about 21 MB each, compressed) stay in `packages/`, with their signed
 * manifests, so an archive that went missing is rebuilt from them instead of downloaded again.
 */
export const CODE_UPDATE_KEPT_PACKAGES = 2;

export interface CodeUpdateState {
  readonly schema: 1;
  /** Healthy code in use; its archive is the one kept. */
  readonly active: string | null;
  /** Verified and installed, waiting for the next start. */
  readonly pending: string | null;
  /** Started, not yet healthy. Falls back to `active` (else the installed code) when it fails. */
  readonly trial: CodeUpdateTrial | null;
  /** Kept packages, newest first (at most CODE_UPDATE_KEPT_PACKAGES). */
  readonly packages: ReadonlyArray<string>;
  /** A healthy code whose archive went missing: the client rebuilds it from its kept package. */
  readonly rebuild: string | null;
  readonly rejected: Readonly<Record<string, CodeUpdateRejection>>;
}

export const EMPTY_CODE_UPDATE_STATE: CodeUpdateState = {
  schema: 1,
  active: null,
  pending: null,
  trial: null,
  packages: [],
  rebuild: null,
  rejected: {},
};

const ID_PATTERN = /^[0-9a-f]{12}-[0-9a-f]{16}$/u;

export const isCodeUpdateId = (value: unknown): value is string =>
  typeof value === "string" && ID_PATTERN.test(value);

/**
 * Off unless the switch is set, and always off on macOS until a shell loading an archive from
 * outside its signed bundle is proven on the ops Mac (lead, 2026-11-18).
 */
export function isCodeUpdateEnabled(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "darwin" && env[CODE_UPDATE_SWITCH_ENV]?.trim() === "1";
}

/** `%LOCALAPPDATA%\Moss\code-updates` and the platform equivalents; the env override wins. */
export function resolveCodeUpdateStoreDir(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
}): string {
  const override = input.env[CODE_UPDATE_DIR_ENV]?.trim();
  if (override) return path.resolve(override);
  if (input.platform === "win32") {
    const local = input.env.LOCALAPPDATA?.trim() || path.join(input.homeDir, "AppData", "Local");
    return path.join(local, "Moss", "code-updates");
  }
  if (input.platform === "darwin") {
    return path.join(input.homeDir, "Library", "Application Support", "Moss", "code-updates");
  }
  const data = input.env.XDG_DATA_HOME?.trim() || path.join(input.homeDir, ".local", "share");
  return path.join(data, "moss", "code-updates");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const idOrNull = (value: unknown): string | null => (isCodeUpdateId(value) ? value : null);

/** Unreadable or foreign state is treated as empty: the installed code always works. */
export function parseCodeUpdateState(text: string | null): CodeUpdateState {
  if (text === null) return EMPTY_CODE_UPDATE_STATE;
  let raw: Record<string, unknown> | null;
  try {
    raw = record(JSON.parse(text));
  } catch {
    return EMPTY_CODE_UPDATE_STATE;
  }
  if (!raw || raw.schema !== 1) return EMPTY_CODE_UPDATE_STATE;
  const trialRaw = record(raw.trial);
  const trial: CodeUpdateTrial | null =
    trialRaw && isCodeUpdateId(trialRaw.id)
      ? {
          id: trialRaw.id,
          uncleanStarts: Number.isSafeInteger(trialRaw.uncleanStarts)
            ? (trialRaw.uncleanStarts as number)
            : 0,
          running: trialRaw.running === true,
          pid: Number.isSafeInteger(trialRaw.pid) ? (trialRaw.pid as number) : null,
          startedAt: typeof trialRaw.startedAt === "string" ? trialRaw.startedAt : null,
        }
      : null;
  const rejected: Record<string, CodeUpdateRejection> = {};
  for (const [id, value] of Object.entries(record(raw.rejected) ?? {})) {
    const entry = record(value);
    if (isCodeUpdateId(id) && entry && typeof entry.reason === "string") {
      rejected[id] = {
        reason: entry.reason as CodeUpdateRejectionReason,
        detail: typeof entry.detail === "string" ? entry.detail : "",
        at: typeof entry.at === "string" ? entry.at : "",
      };
    }
  }
  const packages = Array.isArray(raw.packages)
    ? [...new Set(raw.packages.filter(isCodeUpdateId))].slice(0, CODE_UPDATE_KEPT_PACKAGES)
    : [];
  return {
    schema: 1,
    active: idOrNull(raw.active),
    pending: idOrNull(raw.pending),
    trial,
    packages,
    rebuild: idOrNull(raw.rebuild),
    rejected,
  };
}

export function parseCodeUpdateInstalled(text: string): CodeUpdateInstalled | null {
  try {
    const raw = record(JSON.parse(text));
    const migrations = record(raw?.migrations);
    if (
      !raw ||
      raw.schema !== 1 ||
      !isCodeUpdateId(raw.id) ||
      typeof raw.commit !== "string" ||
      typeof raw.shellCommit !== "string" ||
      !Number.isSafeInteger(raw.archiveSize) ||
      typeof raw.archiveSha256 !== "string" ||
      !Number.isSafeInteger(raw.sequence) ||
      !migrations ||
      !Number.isSafeInteger(migrations.latest) ||
      !Number.isSafeInteger(migrations.readerFloor)
    ) {
      return null;
    }
    return raw as unknown as CodeUpdateInstalled;
  } catch {
    return null;
  }
}

export function rejectCodeUpdate(
  state: CodeUpdateState,
  id: string,
  rejection: CodeUpdateRejection,
): CodeUpdateState {
  return {
    ...state,
    active: state.active === id ? null : state.active,
    pending: state.pending === id ? null : state.pending,
    trial: state.trial?.id === id ? null : state.trial,
    packages: state.packages.filter((kept) => kept !== id),
    rebuild: state.rebuild === id ? null : state.rebuild,
    rejected: { ...state.rejected, [id]: rejection },
  };
}

/** The trial reached healthy: it becomes the active code; the old active's archive may go. */
export function markCodeUpdateHealthy(state: CodeUpdateState, id: string): CodeUpdateState {
  if (state.trial?.id !== id) return state;
  return { ...state, active: id, trial: null };
}

/** A clean quit before healthy does not count against the trial. */
export function markCodeUpdateCleanExit(
  state: CodeUpdateState,
  id: string,
  pid: number,
): CodeUpdateState {
  if (state.trial?.id !== id || state.trial.pid !== pid || !state.trial.running) return state;
  return { ...state, trial: { ...state.trial, running: false } };
}

/** A verified package was applied: it waits for the next start and is kept as a package. */
export function markCodeUpdatePending(state: CodeUpdateState, id: string): CodeUpdateState {
  if (state.rejected[id]) return state;
  return {
    ...state,
    pending: state.active === id || state.trial?.id === id ? state.pending : id,
    rebuild: state.rebuild === id ? null : state.rebuild,
    packages: [id, ...state.packages.filter((kept) => kept !== id)].slice(
      0,
      CODE_UPDATE_KEPT_PACKAGES,
    ),
  };
}

export type CodeUpdateInspection =
  | { readonly ok: true; readonly installed: CodeUpdateInstalled }
  | { readonly ok: false; readonly reason: "damaged" | "shell-changed"; readonly detail: string };

export interface CodeUpdateBootInput {
  readonly state: CodeUpdateState;
  /** Checks `<store>/<id>`: installed.json readable, this shell, archive size as recorded. */
  readonly inspect: (id: string) => CodeUpdateInspection;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly pid: number;
  readonly now: string;
}

export type CodeUpdateBootChoice =
  | { readonly kind: "installed" }
  | { readonly kind: "code"; readonly id: string; readonly trial: boolean };

export interface CodeUpdateBootDecision {
  readonly choice: CodeUpdateBootChoice;
  /** The state to write before the chosen code is loaded (unchanged when nothing changed). */
  readonly state: CodeUpdateState;
  /** One line per thing decided, for the desktop log. */
  readonly events: ReadonlyArray<string>;
}

export function decideCodeUpdateBoot(input: CodeUpdateBootInput): CodeUpdateBootDecision {
  let state = input.state;
  const events: string[] = [];
  const reject = (id: string, reason: CodeUpdateRejectionReason, detail: string) => {
    state = rejectCodeUpdate(state, id, { reason, detail, at: input.now });
    events.push(`code-update rejected id=${id} reason=${reason} detail=${detail}`);
  };

  const trial = state.trial;
  if (trial?.running && trial.pid !== null && trial.pid !== input.pid) {
    if (input.isProcessAlive(trial.pid)) {
      // Another instance of this trial is running (a second launch): same code, nothing counted.
      events.push(`code-update trial id=${trial.id} already running pid=${trial.pid}`);
      return { choice: { kind: "code", id: trial.id, trial: true }, state, events };
    }
  }
  if (trial?.running) {
    const uncleanStarts = trial.uncleanStarts + 1;
    state = { ...state, trial: { ...trial, running: false, uncleanStarts } };
    events.push(`code-update trial id=${trial.id} ended without healthy (${uncleanStarts})`);
    if (uncleanStarts >= CODE_UPDATE_MAX_UNCLEAN_STARTS) {
      reject(trial.id, "crash-loop", `${uncleanStarts} starts ended before healthy`);
    }
  }
  if (!state.trial && state.pending) {
    const id = state.pending;
    state = {
      ...state,
      pending: null,
      trial: state.rejected[id]
        ? null
        : { id, uncleanStarts: 0, running: false, pid: null, startedAt: null },
    };
  }

  if (state.trial && !state.rejected[state.trial.id]) {
    const inspection = input.inspect(state.trial.id);
    if (inspection.ok) {
      state = {
        ...state,
        trial: { ...state.trial, running: true, pid: input.pid, startedAt: input.now },
      };
      events.push(`code-update trial start id=${state.trial!.id}`);
      return { choice: { kind: "code", id: state.trial!.id, trial: true }, state, events };
    }
    reject(state.trial.id, inspection.reason, inspection.detail);
  }
  if (state.active && !state.rejected[state.active]) {
    const id = state.active;
    const inspection = input.inspect(id);
    if (inspection.ok) {
      events.push(`code-update start id=${id}`);
      return { choice: { kind: "code", id, trial: false }, state, events };
    }
    if (inspection.reason === "damaged" && state.packages.includes(id)) {
      // Healthy code whose archive is gone or changed: start the installed code now and let
      // the client rebuild it from its kept package in the background.
      state = { ...state, active: null, rebuild: id };
      events.push(
        `code-update archive damaged id=${id} detail=${inspection.detail}; rebuild queued`,
      );
    } else {
      reject(id, inspection.reason, inspection.detail);
    }
  }
  return { choice: { kind: "installed" }, state, events };
}

/** Archive folders no state field names: safe to delete (never the one being written). */
export function prunableCodeUpdateIds(
  state: CodeUpdateState,
  present: ReadonlyArray<string>,
): string[] {
  const keep = new Set(
    [state.active, state.pending, state.trial?.id].filter(
      (id): id is string => id !== null && id !== undefined,
    ),
  );
  return present.filter((id) => isCodeUpdateId(id) && !keep.has(id));
}

/** Files in `packages/` that belong to no kept package. */
export function prunablePackageFiles(
  state: CodeUpdateState,
  present: ReadonlyArray<string>,
): string[] {
  return present.filter((name) => !state.packages.some((id) => name.startsWith(`${id}.`)));
}

/** The sync file operations the boot needs; the desktop passes Electron's `original-fs`. */
export interface CodeUpdateSyncFs {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, data: string): void;
  renameSync(from: string, to: string): void;
  mkdirSync(dir: string, options: { recursive: true }): unknown;
  statSync(file: string): { size: number; isDirectory?: () => boolean };
}

export function readCodeUpdateStateSync(fs: CodeUpdateSyncFs, storeDir: string): CodeUpdateState {
  return inspectCodeUpdateStateSync(fs, storeDir).state;
}

/**
 * The state and, when it could not be used, why (for the log): a missing file is the normal
 * first start and no problem; anything else (unreadable folder, damaged file) is reported, and
 * the installed code starts.
 */
export function inspectCodeUpdateStateSync(
  fs: CodeUpdateSyncFs,
  storeDir: string,
): { readonly state: CodeUpdateState; readonly problem: string | null } {
  let text: string;
  try {
    text = fs.readFileSync(path.join(storeDir, CODE_UPDATE_STATE_FILE), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
    if (code !== "ENOENT") {
      return { state: EMPTY_CODE_UPDATE_STATE, problem: `store unreadable (${code})` };
    }
    // Windows answers ENOENT, not ENOTDIR, when the store path is a file.
    try {
      if (fs.statSync(storeDir).isDirectory?.() === false) {
        return { state: EMPTY_CODE_UPDATE_STATE, problem: "store unreadable (not a folder)" };
      }
    } catch {
      // No store yet: the normal first start.
    }
    return { state: EMPTY_CODE_UPDATE_STATE, problem: null };
  }
  // parseCodeUpdateState returns the shared empty value only for unusable text.
  const state = parseCodeUpdateState(text);
  return {
    state,
    problem: state === EMPTY_CODE_UPDATE_STATE ? "state.json damaged" : null,
  };
}

/** Atomic: a crash leaves the old state or the new one, never half of one. */
export function writeCodeUpdateStateSync(
  fs: CodeUpdateSyncFs,
  storeDir: string,
  state: CodeUpdateState,
): void {
  fs.mkdirSync(storeDir, { recursive: true });
  const target = path.join(storeDir, CODE_UPDATE_STATE_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

/** The boot's check of one store folder before loading it. */
export function inspectCodeUpdateSync(input: {
  readonly fs: CodeUpdateSyncFs;
  readonly storeDir: string;
  readonly id: string;
  readonly shellCommit: string | null;
}): CodeUpdateInspection {
  const dir = path.join(input.storeDir, input.id);
  let installed: CodeUpdateInstalled | null;
  try {
    installed = parseCodeUpdateInstalled(
      input.fs.readFileSync(path.join(dir, CODE_UPDATE_INSTALLED_FILE), "utf8"),
    );
  } catch {
    installed = null;
  }
  if (!installed || installed.id !== input.id) {
    return { ok: false, reason: "damaged", detail: "installed.json missing or unreadable" };
  }
  if (!input.shellCommit || installed.shellCommit !== input.shellCommit) {
    return {
      ok: false,
      reason: "shell-changed",
      detail: `built for shell ${installed.shellCommit.slice(0, 12)}, installed ${input.shellCommit?.slice(0, 12) ?? "unknown"}`,
    };
  }
  try {
    const { size } = input.fs.statSync(path.join(dir, CODE_UPDATE_ARCHIVE_FILE));
    if (size !== installed.archiveSize) {
      return {
        ok: false,
        reason: "damaged",
        detail: `archive is ${size} bytes, expected ${installed.archiveSize}`,
      };
    }
  } catch {
    return { ok: false, reason: "damaged", detail: "archive missing" };
  }
  return { ok: true, installed };
}
