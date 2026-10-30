// FILE: mossLibraryItemsStore.ts
// Purpose: Moss 资料库 server-backed catalog cache. The server index (SQLite,
//          fed by scans of the agent data roots) is the source of truth; this
//          store mirrors it for the surface, forwards mutations over wsRpc,
//          and runs the one-time legacy localStorage migration.
// Layer: UI state store
// Exports: useMossLibraryItemsStore, MOSS_LIBRARY_ITEMS_STORAGE_KEY

import { create } from "zustand";

import type {
  LibraryFolder as ServerLibraryFolder,
  LibraryItem as ServerLibraryItem,
} from "@synara/contracts";

import { buildLocalImageUrl } from "~/lib/localImageUrls";
import { readNativeApi } from "~/nativeApi";
import { readWsServerCapabilities } from "~/wsNativeApi";

import {
  createMossLibraryDemoCatalog,
  discoverMossLibraryItemsFromDescriptors,
  mergeMossLibraryItems,
  mossLibraryFolderItemFromServer,
  mossLibraryItemFromServer,
  mossLibraryRegisterPayloadFromLegacy,
  newMossLibraryFolderId,
  resolveMossLibraryCatalog,
  type MossLibraryCliFileDescriptor,
  type MossLibraryItem,
} from "./components/MossLibrarySurface.logic";

/** Legacy zustand persist key (pre-index catalog). Kept for the one-time migration. */
export const MOSS_LIBRARY_ITEMS_STORAGE_KEY = "moss:library-items:v1";
/** Set once the legacy localStorage catalog has been pushed into the server index. */
export const MOSS_LIBRARY_MIGRATION_DONE_KEY = "moss:library-items:migrated:v1";
const MOSS_LIBRARY_FOLDER_MIGRATION_DONE_KEY = "moss:library-items:migrated:v2";

export type MossLibraryCatalogSource =
  | "persisted"
  | "discovered"
  | "merged"
  | "demo"
  | "empty"
  | "idle"
  | "server";

export interface MossLibraryImportResult {
  readonly imported: number;
  readonly skipped: number;
}

interface MossLibraryItemsStoreState {
  items: MossLibraryItem[];
  /** Trashed rows (回收站) — excluded from `items`, shown in the trash view. */
  trashedItems: MossLibraryItem[];
  /** Image thumbnails resolved via server preview grants, keyed by item id. */
  thumbnails: Readonly<Record<string, string>>;
  /** Last resolve source for diagnostics and destination state. */
  catalogSource: MossLibraryCatalogSource;
  /** True once the first server refresh settled (success or honest empty). */
  hydrated: boolean;
  loadError: string | null;
  resetAccountBoundary: () => void;
  /** Fetch the index (incl. trash) from the server and run the migration once. */
  refresh: () => Promise<void>;
  favoriteItems: (ids: readonly string[], favorite: boolean) => Promise<boolean>;
  moveItemsToFolder: (ids: readonly string[], folderId: string | null) => Promise<boolean>;
  renameItem: (id: string, title: string) => Promise<boolean>;
  trashItems: (ids: readonly string[]) => Promise<boolean>;
  restoreItems: (ids: readonly string[]) => Promise<boolean>;
  deleteItemsPermanently: (ids: readonly string[]) => Promise<boolean>;
  createFolderOnServer: (title: string) => Promise<MossLibraryItem | null>;
  renameFolderOnServer: (id: string, title: string) => Promise<boolean>;
  deleteFolderOnServer: (id: string) => Promise<boolean>;
  importFileBlobs: (
    files: readonly { name: string; mimeType?: string; dataBase64: string }[],
  ) => Promise<MossLibraryImportResult>;
  /** Lazily resolve a servable thumbnail URL for an image item with a path. */
  ensureThumbnail: (item: MossLibraryItem) => void;
  /** Legacy compat shims (local/test mode and demo fixtures). */
  setItems: (items: readonly MossLibraryItem[]) => void;
  upsertItems: (items: readonly MossLibraryItem[]) => void;
  registerFromDescriptors: (descriptors: readonly MossLibraryCliFileDescriptor[]) => void;
  ensureCatalog: (input?: {
    readonly discovered?: readonly MossLibraryItem[] | null;
    readonly seedDemoIfEmpty?: boolean;
    readonly now?: number;
  }) => {
    readonly items: MossLibraryItem[];
    readonly source: "persisted" | "discovered" | "merged" | "demo" | "empty";
    readonly hasDemo: boolean;
  };
  clearDemoItems: () => void;
}

/** Demo rows from an older build must never survive into the runtime catalog. */
function realLibraryItems(items: readonly MossLibraryItem[]): MossLibraryItem[] {
  return items.filter((item) => !item.isDemo);
}

function isMossLibraryItem(value: unknown): value is MossLibraryItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MossLibraryItem>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.sourceCli === "string" &&
    typeof candidate.updatedAt === "number" &&
    typeof candidate.favorite === "boolean" &&
    Array.isArray(candidate.sectionIds) &&
    typeof candidate.subtitleZh === "string"
  );
}

/** Read the legacy zustand persist envelope without rehydrating it into a store. */
function readLegacyPersistedItems(): MossLibraryItem[] {
  try {
    const raw = window.localStorage.getItem(MOSS_LIBRARY_ITEMS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { state?: { items?: unknown } } | null;
    const items = parsed?.state?.items;
    if (!Array.isArray(items)) return [];
    return realLibraryItems(items.filter(isMossLibraryItem));
  } catch {
    return [];
  }
}

/** One-time migration: push the legacy localStorage catalog into the server index. */
async function migrateLegacyItemsOnce(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(MOSS_LIBRARY_FOLDER_MIGRATION_DONE_KEY) === "1") return;
  } catch {
    return;
  }
  const api = readNativeApi();
  const legacy = readLegacyPersistedItems();
  const payloads = legacy
    .map(mossLibraryRegisterPayloadFromLegacy)
    .filter((payload) => payload !== null);
  try {
    const folders = legacy.filter((item) => item.kind === "folder" && !item.title.startsWith("."));
    if (folders.length) {
      if (!api || !libraryServerAvailable()) return;
      const catalog = await withTimeout(
        api.library.list({ includeTrashed: true }),
        SERVER_CALL_TIMEOUT_MS,
      );
      if (!catalog) return;
      for (const folder of folders) {
        if (catalog.folders.some((current) => current.id === folder.id)) continue;
        const created = await withTimeout(
          api.library.createFolder({ id: folder.id, title: folder.title }),
          SERVER_CALL_TIMEOUT_MS,
        );
        if (!created) return;
      }
    }
    if (payloads.length > 0) {
      if (!api || !libraryServerAvailable()) return; // Retry on the next refresh.
      const registered = await withTimeout(
        api.library.register({ items: payloads }),
        SERVER_CALL_TIMEOUT_MS,
      );
      if (registered === null) return; // No server yet — the next refresh retries.
    }
    // The legacy key stays on disk untouched; the flag only stops re-registering.
    window.localStorage.setItem(MOSS_LIBRARY_MIGRATION_DONE_KEY, "1");
    window.localStorage.setItem(MOSS_LIBRARY_FOLDER_MIGRATION_DONE_KEY, "1");
  } catch {
    // No server yet — the next refresh retries the migration.
  }
}

function sortByUpdatedAtDesc(items: readonly MossLibraryItem[]): MossLibraryItem[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A ws request queues forever when no server is connected; never block hydration on it. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise.then((value) => value as T | null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

const SERVER_CALL_TIMEOUT_MS = 2500;

/**
 * The ws transport queues requests until a server completes the bootstrap
 * negotiation, so "an api object exists" is not "a server is reachable".
 * Desktop preload apis are host-backed and always available.
 */
function libraryServerAvailable(): boolean {
  if (typeof window !== "undefined" && window.nativeApi) return true;
  return readWsServerCapabilities() !== null;
}

export const useMossLibraryItemsStore = create<MossLibraryItemsStoreState>()((set, get) => {
  let refreshVersion = 0;
  let accountVersion = 0;
  const applyServerItems = (
    serverItems: readonly ServerLibraryItem[],
    serverFolders: readonly ServerLibraryFolder[],
  ) => {
    const folderCards = serverFolders.map(mossLibraryFolderItemFromServer);
    const visible = serverItems
      .filter((item) => item.trashedAt === null)
      .map(mossLibraryItemFromServer);
    const trashed = serverItems
      .filter((item) => item.trashedAt !== null)
      .map(mossLibraryItemFromServer);
    const items = sortByUpdatedAtDesc([...folderCards, ...visible]);
    set({
      items,
      trashedItems: sortByUpdatedAtDesc(trashed),
      hydrated: true,
      catalogSource: items.length > 0 ? "server" : "empty",
    });
  };

  /** Forward a mutation; on success merge returned rows, on failure report false. */
  const runMutation = async (
    mutate: (api: NonNullable<ReturnType<typeof readNativeApi>>) => Promise<unknown>,
  ): Promise<boolean> => {
    const api = readNativeApi();
    if (!api || !libraryServerAvailable()) return false;
    const version = accountVersion;
    try {
      const done = await withTimeout(
        mutate(api).then(() => true as const),
        SERVER_CALL_TIMEOUT_MS,
      );
      // A timeout does not prove whether the server applied the write. Keep
      // the previous catalog and let the user refresh; never replay locally.
      if (done === null || version !== accountVersion) return false;
      await get().refresh();
      return version === accountVersion;
    } catch {
      return false;
    }
  };

  return {
    items: [],
    trashedItems: [],
    thumbnails: {},
    catalogSource: "idle",
    hydrated: false,
    loadError: null,
    resetAccountBoundary: () => {
      accountVersion += 1;
      refreshVersion += 1;
      set({
        items: [],
        trashedItems: [],
        thumbnails: {},
        hydrated: false,
        loadError: null,
        catalogSource: "idle",
      });
    },

    refresh: async () => {
      const version = ++refreshVersion;
      await migrateLegacyItemsOnce();
      if (version !== refreshVersion) return;
      const api = readNativeApi();
      if (!api || !libraryServerAvailable()) {
        set({ hydrated: true, loadError: "资料库连接尚未就绪，请刷新后重试。" });
        return;
      }
      try {
        const result = await withTimeout(
          api.library.list({ includeTrashed: true }),
          SERVER_CALL_TIMEOUT_MS,
        );
        if (version !== refreshVersion) return;
        if (result === null) {
          set({ hydrated: true, loadError: "资料库读取超时，原资料仍保留，请刷新后重试。" });
          return;
        }
        applyServerItems(result.items, result.folders);
        set({ loadError: null });
      } catch {
        if (version !== refreshVersion) return;
        // Older server build without the library group: stay in the honest
        // empty state rather than rendering stale rows as live data.
        set({ hydrated: true, loadError: "资料库暂时无法读取，原资料仍保留，请刷新后重试。" });
      }
    },

    favoriteItems: (ids, favorite) =>
      runMutation((api) => api.library.favorite({ ids: [...ids], favorite })),

    moveItemsToFolder: (ids, folderId) =>
      runMutation((api) => api.library.move({ ids: [...ids], folderId })),

    renameItem: (id, title) => runMutation((api) => api.library.rename({ id, title })),

    trashItems: (ids) => runMutation((api) => api.library.trash({ ids: [...ids] })),

    restoreItems: (ids) => runMutation((api) => api.library.restore({ ids: [...ids] })),

    deleteItemsPermanently: (ids) =>
      runMutation((api) => api.library.deletePermanently({ ids: [...ids] })),

    createFolderOnServer: async (title) => {
      const id = newMossLibraryFolderId();
      const ok = await runMutation((api) => api.library.createFolder({ id, title }));
      return ok ? (get().items.find((item) => item.id === id) ?? null) : null;
    },

    renameFolderOnServer: (id, title) =>
      runMutation((api) => api.library.renameFolder({ id, title })),

    deleteFolderOnServer: (id) => runMutation((api) => api.library.deleteFolder({ id })),

    importFileBlobs: async (files) => {
      const api = readNativeApi();
      if (!api || !libraryServerAvailable()) throw new Error("资料库连接尚未就绪，请稍后重试。");
      const version = accountVersion;
      const result = await api.library.importFiles({
        files: files.map((file) => ({
          name: file.name,
          dataBase64: file.dataBase64,
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        })),
      });
      if (version !== accountVersion) throw new DOMException("账号已切换。", "AbortError");
      await get().refresh();
      if (version !== accountVersion) throw new DOMException("账号已切换。", "AbortError");
      return { imported: result.imported, skipped: result.skipped };
    },

    ensureThumbnail: (item) => {
      if (item.kind !== "image" || !item.path || item.thumbnailUrl) return;
      if (get().thumbnails[item.id]) return;
      const api = readNativeApi();
      if (!api || !libraryServerAvailable()) return;
      const version = accountVersion;
      void api.projects
        .createLocalFilePreviewGrant({ path: item.path })
        .then(({ grant }) => {
          if (version !== accountVersion) return;
          const url = buildLocalImageUrl({
            src: item.path!,
            cwd: undefined,
            grant,
            cacheKey: item.updatedAt,
          });
          set((state) =>
            state.thumbnails[item.id]
              ? state
              : { thumbnails: { ...state.thumbnails, [item.id]: url } },
          );
        })
        .catch(() => undefined);
    },

    setItems: (items) => {
      const realItems = realLibraryItems(items);
      set({
        items: mergeMossLibraryItems(realItems),
        catalogSource: realItems.length > 0 ? "persisted" : "empty",
        hydrated: true,
      });
    },
    upsertItems: (items) => {
      const realItems = realLibraryItems(items);
      set((state) => ({
        items: mergeMossLibraryItems(state.items, realItems),
        catalogSource: state.items.length > 0 || realItems.length > 0 ? "persisted" : "empty",
        hydrated: true,
      }));
    },
    registerFromDescriptors: (descriptors) => {
      const discovered = realLibraryItems(discoverMossLibraryItemsFromDescriptors(descriptors));
      if (discovered.length === 0) return;
      set((state) => {
        const withoutDemo = state.items.filter((item) => !item.isDemo);
        return {
          items: mergeMossLibraryItems(withoutDemo, discovered),
          catalogSource: withoutDemo.length > 0 ? "merged" : "discovered",
          hydrated: true,
        };
      });
    },
    ensureCatalog: (input) => {
      const state = get();
      const resolved = resolveMossLibraryCatalog({
        persisted: realLibraryItems(state.items),
        discovered: input?.discovered ?? [],
        seedDemoIfEmpty: input?.seedDemoIfEmpty === true,
        now: input?.now ?? Date.now(),
      });
      const persistedItems = realLibraryItems(resolved.items);
      if (
        persistedItems.length !== state.items.length ||
        persistedItems.some((item, index) => item.id !== state.items[index]?.id)
      ) {
        set({
          items: persistedItems,
          catalogSource: persistedItems.length > 0 ? resolved.source : "empty",
          hydrated: true,
        });
      } else {
        set({ catalogSource: resolved.source, hydrated: true });
      }
      return resolved;
    },
    clearDemoItems: () => {
      set((state) => {
        const next = state.items.filter((item) => !item.isDemo);
        return {
          items: next.length > 0 ? next : [],
          catalogSource: next.length > 0 ? "persisted" : "empty",
        };
      });
    },
  };
});

/** Test helper — build a fresh demo without touching the store. */
export function peekMossLibraryDemoCatalog(now?: number): MossLibraryItem[] {
  return createMossLibraryDemoCatalog(now);
}
