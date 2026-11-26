// FILE: composerFileBlobStore.ts
// Purpose: Persists attached composer file blobs outside localStorage so files survive thread switches and reloads.
// Layer: Browser storage adapter
// Depends on: IndexedDB structured-clone support for Blob values.

import { awaitIdbRequest, openIndexedDbDatabase, waitForIdbTransaction } from "./indexedDb";

const DATABASE_NAME = "moss-composer-files";
const DATABASE_VERSION = 1;
const FILE_STORE_NAME = "files";
const ORPHANED_BLOB_MIN_AGE_MS = 60 * 60 * 1000;

interface StoredComposerFileBlob {
  key: string;
  blob: Blob;
  name: string;
  mimeType: string;
  lastModified: number;
  updatedAt?: number;
}

function openComposerFileDatabase(): Promise<IDBDatabase> {
  return openIndexedDbDatabase({
    name: DATABASE_NAME,
    version: DATABASE_VERSION,
    storeName: FILE_STORE_NAME,
    keyPath: "key",
    label: "composer file database",
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return waitForIdbTransaction(transaction, "Composer file storage");
}

export function composerFileBlobKey(threadId: string, fileId: string): string {
  return `${threadId}:${fileId}`;
}

export async function persistComposerFileBlob(input: {
  threadId: string;
  fileId: string;
  file: File;
}): Promise<string> {
  const key = composerFileBlobKey(input.threadId, input.fileId);
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is unavailable for composer file persistence.");
  }
  const database = await openComposerFileDatabase();
  try {
    const transaction = database.transaction(FILE_STORE_NAME, "readwrite");
    transaction.objectStore(FILE_STORE_NAME).put({
      key,
      blob: input.file,
      name: input.file.name,
      mimeType: input.file.type,
      lastModified: input.file.lastModified,
      updatedAt: Date.now(),
    } satisfies StoredComposerFileBlob);
    await waitForTransaction(transaction);
    return key;
  } finally {
    database.close();
  }
}

export async function readComposerFileBlob(key: string): Promise<File | null> {
  if (key.length === 0 || typeof indexedDB === "undefined") return null;
  const database = await openComposerFileDatabase();
  try {
    const transaction = database.transaction(FILE_STORE_NAME, "readonly");
    const completion = waitForTransaction(transaction);
    const stored = (await awaitIdbRequest(
      transaction.objectStore(FILE_STORE_NAME).get(key),
      "Could not read the composer file.",
    )) as StoredComposerFileBlob | undefined;
    await completion;
    if (!stored?.blob) return null;
    return new File([stored.blob], stored.name, {
      type: stored.mimeType || stored.blob.type,
      lastModified: stored.lastModified,
    });
  } finally {
    database.close();
  }
}

export interface OrphanedComposerFileBlobInput {
  isReferenced: (key: string) => boolean;
  nowMs: number;
  minAgeMs?: number;
}

export function selectOrphanedComposerFileBlobKeys(
  records: ReadonlyArray<{ key: string; updatedAt?: number | undefined }>,
  input: OrphanedComposerFileBlobInput,
): string[] {
  const minAgeMs = input.minAgeMs ?? ORPHANED_BLOB_MIN_AGE_MS;
  return records
    .filter(
      (record) =>
        !input.isReferenced(record.key) && (record.updatedAt ?? 0) + minAgeMs <= input.nowMs,
    )
    .map((record) => record.key);
}

export async function deleteOrphanedComposerFileBlobs(input: {
  isReferenced: (key: string) => boolean;
  nowMs?: number;
}): Promise<number> {
  if (typeof indexedDB === "undefined") return 0;
  const selectionInput: OrphanedComposerFileBlobInput = {
    isReferenced: input.isReferenced,
    nowMs: input.nowMs ?? Date.now(),
  };
  const database = await openComposerFileDatabase();
  try {
    const keysTransaction = database.transaction(FILE_STORE_NAME, "readonly");
    const keysCompletion = waitForTransaction(keysTransaction);
    const keys = await awaitIdbRequest(
      keysTransaction.objectStore(FILE_STORE_NAME).getAllKeys(),
      "Could not list the composer files.",
    );
    await keysCompletion;

    const candidateKeys = keys.filter(
      (key): key is string => typeof key === "string" && !selectionInput.isReferenced(key),
    );
    if (candidateKeys.length === 0) return 0;

    const transaction = database.transaction(FILE_STORE_NAME, "readwrite");
    const store = transaction.objectStore(FILE_STORE_NAME);
    let deleted = 0;
    for (const key of candidateKeys) {
      const request = store.get(key);
      request.addEventListener("success", () => {
        const record = request.result as StoredComposerFileBlob | undefined;
        if (!record) return;
        if (selectOrphanedComposerFileBlobKeys([record], selectionInput).length === 0) return;
        store.delete(key);
        deleted += 1;
      });
    }
    await waitForTransaction(transaction);
    return deleted;
  } finally {
    database.close();
  }
}

export async function deleteComposerFileBlob(key: string): Promise<void> {
  if (key.length === 0 || typeof indexedDB === "undefined") return;
  const database = await openComposerFileDatabase();
  try {
    const transaction = database.transaction(FILE_STORE_NAME, "readwrite");
    transaction.objectStore(FILE_STORE_NAME).delete(key);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}
