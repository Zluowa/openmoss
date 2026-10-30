import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acknowledgeMossStorageSnapshot,
  readMossStorageSnapshot,
  MOSS_STORAGE_SNAPSHOT_MAX_BYTES,
  validateMossStorageSnapshot,
} from "./desktopStorageMigration";

const snapshot = (exportedAt = "2026-07-09T00:00:00.000Z") => ({
  version: 1 as const,
  exportedAt,
  entries: {
    "moss:theme": "dark",
    "moss.openUsage.enabled": "true",
  },
});

describe("desktopStorageMigration", () => {
  it("reads a legacy snapshot and removes it after acknowledgement", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      FS.writeFileSync(target, `${JSON.stringify(snapshot())}\n`);
      expect(readMossStorageSnapshot(target)).toEqual(snapshot());

      await acknowledgeMossStorageSnapshot(target);
      expect(readMossStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, disallowed, and oversized snapshots", () => {
    expect(validateMossStorageSnapshot({ version: 1 })).toBeNull();
    expect(
      validateMossStorageSnapshot({
        ...snapshot(),
        entries: { "foreign:theme": "dark" },
      }),
    ).toBeNull();
    expect(
      validateMossStorageSnapshot({
        ...snapshot(),
        entries: { "moss:large": "x".repeat(MOSS_STORAGE_SNAPSHOT_MAX_BYTES) },
      }),
    ).toBeNull();
  });

  it("accepts renderer snapshots containing large composer drafts", () => {
    const largeDraft = "x".repeat(2 * 1024 * 1024);

    expect(
      validateMossStorageSnapshot({
        ...snapshot(),
        entries: { "moss:composer-drafts:v1": largeDraft },
      })?.entries["moss:composer-drafts:v1"],
    ).toBe(largeDraft);
  });

  it("treats missing and malformed files as absent", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      expect(readMossStorageSnapshot(target)).toBeNull();
      FS.writeFileSync(target, "not json");
      expect(readMossStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
