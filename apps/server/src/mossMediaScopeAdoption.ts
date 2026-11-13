// FILE: mossMediaScopeAdoption.ts
// Purpose: Brings an account's media and Canvas data saved under its legacy scopes (which named
//          the gateway URL) into its account scope, once per account and state folder.
// Layer: media storage (server).
// Exports: adoptLegacyMediaScopes, resetMossMediaScopeAdoptionForTest
// Why: a scope that named the gateway URL hid a person's history, assets and Canvas whenever
//      Moss reached the gateway through another entry or domain. Data moves by rename into the
//      account scope; nothing is rewritten, anything that would collide stays where it is, and
//      when there is nothing to move nothing is created (a read stays a read).

import { lstat, mkdir, readdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";

import { createLogger } from "./logger";
import { MossMediaHistory } from "./mossMediaHistory";

const log = createLogger("media-scope");
const SCOPE = /^[a-f0-9]{64}$/u;

const adoptions = new Map<string, Promise<void>>();

/** Tests only: forget which accounts were adopted in this process. */
export function resetMossMediaScopeAdoptionForTest(): void {
  adoptions.clear();
}

const exists = (path: string) =>
  lstat(path).then(
    (info) => (info.isSymbolicLink() ? null : info),
    () => null,
  );

/** Renames `from` to `to` when `to` does not exist. Returns whether it moved. */
async function moveIfFree(from: string, to: string): Promise<boolean> {
  if (!(await exists(from)) || (await exists(to))) return false;
  await rename(from, to);
  return true;
}

/** Moves every entry of directory `from` into `to` that `to` lacks; removes `from` if empty. */
async function mergeDirectory(from: string, to: string): Promise<number> {
  const info = await exists(from);
  if (!info?.isDirectory()) return 0;
  await mkdir(to, { recursive: true, mode: 0o700 });
  let left = 0;
  for (const name of await readdir(from)) {
    if (!(await moveIfFree(join(from, name), join(to, name)))) left += 1;
  }
  if (left === 0) await rmdir(from).catch(() => undefined);
  return left;
}

async function adopt(stateDirectory: string, scope: string, legacy: ReadonlyArray<string>) {
  const history = new MossMediaHistory(stateDirectory);
  // Opening the database creates it; with no database there is no history to move.
  const hasHistory =
    (await exists(join(stateDirectory, "media-history", "history.sqlite"))) !== null;
  // Most recently used first: when two legacy scopes each hold a Canvas for the same place,
  // the one the person saw last becomes the account's, the other stays where it is.
  const candidates = await Promise.all(
    [...new Set(legacy)]
      .filter((value) => value !== scope && SCOPE.test(value))
      .map(async (value) => ({
        value,
        used: Math.max(
          0,
          ...(await Promise.all(
            [
              join(stateDirectory, "moss-canvas", value),
              join(stateDirectory, "moss-canvas-threads", value),
              join(stateDirectory, "media-jobs", `${value}.json`),
            ].map(async (path) => (await exists(path))?.mtimeMs ?? 0),
          )),
        ),
      })),
  );
  for (const { value } of candidates.toSorted((a, b) => b.used - a.used)) {
    const { moved, left } = hasHistory
      ? await history.adoptScope(value, scope)
      : { moved: 0, left: 0 };
    const leftOver =
      left +
      (await mergeDirectory(
        join(stateDirectory, "media-assets", value),
        join(stateDirectory, "media-assets", scope),
      )) +
      (await mergeDirectory(
        join(stateDirectory, "moss-canvas-threads", value),
        join(stateDirectory, "moss-canvas-threads", scope),
      )) +
      (await mergeDirectory(
        join(stateDirectory, "media-job-workspaces", value),
        join(stateDirectory, "media-job-workspaces", scope),
      ));
    const canvasLeft =
      (await exists(join(stateDirectory, "moss-canvas", value))) &&
      !(await moveIfFree(
        join(stateDirectory, "moss-canvas", value),
        join(stateDirectory, "moss-canvas", scope),
      ));
    const jobsLeft =
      (await exists(join(stateDirectory, "media-jobs", `${value}.json`))) &&
      !(await moveIfFree(
        join(stateDirectory, "media-jobs", `${value}.json`),
        join(stateDirectory, "media-jobs", `${scope}.json`),
      ));
    if (moved > 0 || leftOver > 0 || canvasLeft || jobsLeft)
      log.info("adopted a legacy media scope", {
        movedHistoryRows: moved,
        leftInPlace: leftOver + (canvasLeft ? 1 : 0) + (jobsLeft ? 1 : 0),
      });
  }
}

/**
 * Adopts the legacy scopes into `scope`, once per state folder and account in this process.
 * Never fails the caller: a failure is logged and tried again on the next call.
 */
export function adoptLegacyMediaScopes(
  stateDirectory: string,
  scope: string,
  legacy: ReadonlyArray<string>,
): Promise<void> {
  const key = `${stateDirectory}\0${scope}`;
  let adoption = adoptions.get(key);
  if (!adoption) {
    adoption = adopt(stateDirectory, scope, legacy).catch((error: unknown) => {
      adoptions.delete(key);
      log.warn("legacy media scope adoption failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    });
    adoptions.set(key, adoption);
  }
  return adoption;
}
