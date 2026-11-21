// FILE: appSnapIconStore.ts
// Purpose: Deduplicates native AppSnap icons outside localStorage.
// Layer: Browser storage adapter
// Depends on: IndexedDB structured-clone support.

import { awaitIdbRequest, openIndexedDbDatabase, waitForIdbTransaction } from "./indexedDb";

const DATABASE_NAME = "moss-appsnap-icons";
const DATABASE_VERSION = 1;
const ICON_STORE_NAME = "icons";
const MAX_BUNDLE_IDENTIFIER_LENGTH = 512;
const MAX_ICON_DATA_URL_LENGTH = 256_000;
const MAX_STORED_APP_ICONS = 100;

// In-memory read-through cache so repeated AppSnaps from the same app resolve
// their cached icon in 0 ms without opening IndexedDB on the capture hot path.
const memoryIconCache = new Map<string, string | null>();

function rememberCachedIcon(bundleIdentifier: string, dataUrl: string | null): void {
  if (memoryIconCache.has(bundleIdentifier)) {
    memoryIconCache.delete(bundleIdentifier);
  }
  memoryIconCache.set(bundleIdentifier, dataUrl);
  while (memoryIconCache.size > MAX_STORED_APP_ICONS) {
    const oldest = memoryIconCache.keys().next().value as string | undefined;
    if (!oldest) break;
    memoryIconCache.delete(oldest);
  }
}

export function peekCachedAppSnapIcon(
  bundleIdentifier: string | null | undefined,
): string | null | undefined {
  const normalized = normalizeBundleIdentifier(bundleIdentifier);
  if (!normalized) return undefined;
  return memoryIconCache.has(normalized) ? memoryIconCache.get(normalized) : undefined;
}

export function clearAppSnapIconMemoryCacheForTests(): void {
  memoryIconCache.clear();
}

interface StoredAppSnapIcon {
  bundleIdentifier: string;
  dataUrl: string;
  updatedAt: number;
}

export function selectAppSnapIconEvictionKeys(
  entries: ReadonlyArray<Pick<StoredAppSnapIcon, "bundleIdentifier" | "updatedAt">>,
  maximumEntries = MAX_STORED_APP_ICONS,
): string[] {
  const overflow = Math.max(0, entries.length - Math.max(0, maximumEntries));
  if (overflow === 0) return [];
  return entries
    .toSorted(
      (left, right) =>
        left.updatedAt - right.updatedAt ||
        left.bundleIdentifier.localeCompare(right.bundleIdentifier),
    )
    .slice(0, overflow)
    .map((entry) => entry.bundleIdentifier);
}

function normalizeBundleIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_BUNDLE_IDENTIFIER_LENGTH
    ? normalized
    : null;
}

function normalizeIconDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_ICON_DATA_URL_LENGTH) return null;
  return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

function openAppSnapIconDatabase(): Promise<IDBDatabase> {
  return openIndexedDbDatabase({
    name: DATABASE_NAME,
    version: DATABASE_VERSION,
    storeName: ICON_STORE_NAME,
    keyPath: "bundleIdentifier",
    label: "AppSnap icon cache",
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return waitForIdbTransaction(transaction, "AppSnap icon storage");
}

export async function persistAppSnapIcon(input: {
  bundleIdentifier: string;
  dataUrl: string;
}): Promise<void> {
  const bundleIdentifier = normalizeBundleIdentifier(input.bundleIdentifier);
  const dataUrl = normalizeIconDataUrl(input.dataUrl);
  if (!bundleIdentifier || !dataUrl) return;
  rememberCachedIcon(bundleIdentifier, dataUrl);

  const database = await openAppSnapIconDatabase();
  try {
    const transaction = database.transaction(ICON_STORE_NAME, "readwrite");
    const store = transaction.objectStore(ICON_STORE_NAME);
    store.put({
      bundleIdentifier,
      dataUrl,
      updatedAt: Date.now(),
    } satisfies StoredAppSnapIcon);
    const entriesRequest = store.getAll();
    entriesRequest.addEventListener("success", () => {
      const entries = entriesRequest.result as StoredAppSnapIcon[];
      for (const key of selectAppSnapIconEvictionKeys(entries)) {
        store.delete(key);
      }
    });
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function readAppSnapIcon(bundleIdentifier: string): Promise<string | null> {
  const normalizedBundleIdentifier = normalizeBundleIdentifier(bundleIdentifier);
  if (!normalizedBundleIdentifier) return null;
  if (memoryIconCache.has(normalizedBundleIdentifier)) {
    return memoryIconCache.get(normalizedBundleIdentifier) ?? null;
  }

  const database = await openAppSnapIconDatabase();
  try {
    const transaction = database.transaction(ICON_STORE_NAME, "readonly");
    const completion = waitForTransaction(transaction);
    const stored = (await awaitIdbRequest(
      transaction.objectStore(ICON_STORE_NAME).get(normalizedBundleIdentifier),
      "Could not read the AppSnap icon cache.",
    )) as StoredAppSnapIcon | undefined;
    await completion;
    const dataUrl = normalizeIconDataUrl(stored?.dataUrl);
    rememberCachedIcon(normalizedBundleIdentifier, dataUrl);
    return dataUrl;
  } finally {
    database.close();
  }
}
