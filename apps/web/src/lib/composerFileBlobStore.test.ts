import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  composerFileBlobKey,
  deleteComposerFileBlob,
  deleteOrphanedComposerFileBlobs,
  persistComposerFileBlob,
  readComposerFileBlob,
  selectOrphanedComposerFileBlobKeys,
} from "./composerFileBlobStore";

interface FakeStoredRecord {
  key: string;
  [field: string]: unknown;
}

function makeFakeIdbRequest<Result>(run: () => Result): IDBRequest<Result> {
  const target = new EventTarget();
  const request = Object.assign(target, {
    result: undefined as unknown as Result,
    error: null as DOMException | null,
  });
  queueMicrotask(() => {
    try {
      request.result = run();
      target.dispatchEvent(new Event("success"));
    } catch (error) {
      request.error = error as DOMException;
      target.dispatchEvent(new Event("error"));
    }
  });
  return request as unknown as IDBRequest<Result>;
}

function installFakeIndexedDb(): Map<string, FakeStoredRecord> {
  const records = new Map<string, FakeStoredRecord>();

  const fakeIndexedDb = {
    open: (_name: string, _version?: number) => {
      const target = new EventTarget();
      const storeNames = new Set<string>();
      const database = {
        objectStoreNames: { contains: (name: string) => storeNames.has(name) },
        createObjectStore: (name: string) => {
          storeNames.add(name);
          return {};
        },
        close: () => undefined,
        transaction: () => {
          const txTarget = new EventTarget();
          let pendingOps = 0;
          let scheduled = false;
          const scheduleComplete = () => {
            if (scheduled) return;
            scheduled = true;
            queueMicrotask(() => {
              queueMicrotask(() => {
                if (pendingOps === 0) {
                  txTarget.dispatchEvent(new Event("complete"));
                }
              });
            });
          };
          const trackRequest = <Result>(run: () => Result): IDBRequest<Result> => {
            pendingOps += 1;
            const request = makeFakeIdbRequest(() => {
              const value = run();
              pendingOps -= 1;
              if (pendingOps === 0) {
                queueMicrotask(() => {
                  if (pendingOps === 0) {
                    txTarget.dispatchEvent(new Event("complete"));
                  }
                });
              }
              return value;
            });
            return request;
          };
          const objectStore = {
            put: (record: FakeStoredRecord) =>
              trackRequest(() => {
                records.set(record.key, record);
                return record.key;
              }),
            get: (key: string) => trackRequest(() => records.get(key)),
            getAllKeys: () => trackRequest(() => Array.from(records.keys())),
            delete: (key: string) =>
              trackRequest(() => {
                records.delete(key);
                return undefined;
              }),
          };
          scheduleComplete();
          return Object.assign(txTarget, {
            error: null,
            objectStore: () => objectStore,
          });
        },
      };
      const request = Object.assign(target, {
        result: database,
        error: null,
      });
      queueMicrotask(() => {
        target.dispatchEvent(new Event("upgradeneeded"));
        target.dispatchEvent(new Event("success"));
      });
      return request;
    },
  };

  vi.stubGlobal("indexedDB", fakeIndexedDb);
  return records;
}

describe("selectOrphanedComposerFileBlobKeys", () => {
  const hourMs = 60 * 60 * 1000;
  const nowMs = 10 * hourMs;

  it("keeps referenced blobs regardless of age", () => {
    const keys = selectOrphanedComposerFileBlobKeys(
      [
        { key: "thread-1:file-1", updatedAt: 0 },
        { key: "thread-1:file-2", updatedAt: 0 },
      ],
      { isReferenced: (key) => key === "thread-1:file-1", nowMs },
    );

    expect(keys).toEqual(["thread-1:file-2"]);
  });

  it("keeps unreferenced blobs written within the minimum age window", () => {
    const keys = selectOrphanedComposerFileBlobKeys(
      [
        { key: "thread-1:file-1", updatedAt: nowMs - hourMs / 2 },
        { key: "thread-1:file-2", updatedAt: nowMs - 2 * hourMs },
      ],
      { isReferenced: () => false, nowMs },
    );

    expect(keys).toEqual(["thread-1:file-2"]);
  });

  it("honors an explicit minimum age", () => {
    const keys = selectOrphanedComposerFileBlobKeys(
      [{ key: "thread-1:file-1", updatedAt: nowMs - hourMs / 2 }],
      { isReferenced: () => false, nowMs, minAgeMs: hourMs / 4 },
    );

    expect(keys).toEqual(["thread-1:file-1"]);
  });

  it("treats records without a write time as old", () => {
    const keys = selectOrphanedComposerFileBlobKeys([{ key: "thread-1:file-1" }], {
      isReferenced: () => false,
      nowMs,
    });

    expect(keys).toEqual(["thread-1:file-1"]);
  });
});

describe("composerFileBlobStore IndexedDB persistence", () => {
  let records: Map<string, FakeStoredRecord>;

  beforeEach(() => {
    records = installFakeIndexedDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists, reads back with metadata and bytes, and deletes a file blob", async () => {
    const file = new File(["quarterly report"], "q4.txt", {
      type: "text/plain",
      lastModified: 1_700_000_000_000,
    });

    const key = await persistComposerFileBlob({
      threadId: "thread-1",
      fileId: "file-1",
      file,
    });
    expect(key).toBe(composerFileBlobKey("thread-1", "file-1"));

    const restored = await readComposerFileBlob(key);
    expect(restored).not.toBeNull();
    expect(restored?.name).toBe("q4.txt");
    expect(restored?.type).toBe("text/plain");
    expect(restored?.lastModified).toBe(1_700_000_000_000);
    expect(await restored?.text()).toBe("quarterly report");

    await deleteComposerFileBlob(key);
    expect(await readComposerFileBlob(key)).toBeNull();
  });

  it("sweeps only expired unreferenced blobs and leaves referenced or recent blobs intact", async () => {
    const hourMs = 60 * 60 * 1000;
    const baseNow = 20 * hourMs;
    const dateNowSpy = vi.spyOn(Date, "now");

    dateNowSpy.mockReturnValue(baseNow - 2 * hourMs);
    const oldReferencedKey = await persistComposerFileBlob({
      threadId: "thread-1",
      fileId: "referenced",
      file: new File(["keep"], "keep.txt", { type: "text/plain" }),
    });
    const oldOrphanKey = await persistComposerFileBlob({
      threadId: "thread-1",
      fileId: "orphan-old",
      file: new File(["stale"], "stale.txt", { type: "text/plain" }),
    });

    dateNowSpy.mockReturnValue(baseNow - hourMs / 3);
    const recentOrphanKey = await persistComposerFileBlob({
      threadId: "thread-1",
      fileId: "orphan-recent",
      file: new File(["recent"], "recent.txt", { type: "text/plain" }),
    });

    const deletedCount = await deleteOrphanedComposerFileBlobs({
      isReferenced: (key) => key === oldReferencedKey,
      nowMs: baseNow,
    });

    expect(deletedCount).toBe(1);
    expect(records.has(oldOrphanKey)).toBe(false);
    expect(records.has(oldReferencedKey)).toBe(true);
    expect(records.has(recentOrphanKey)).toBe(true);
    expect(await readComposerFileBlob(oldOrphanKey)).toBeNull();
    expect(await (await readComposerFileBlob(oldReferencedKey))?.text()).toBe("keep");
    expect(await (await readComposerFileBlob(recentOrphanKey))?.text()).toBe("recent");
  });
});
