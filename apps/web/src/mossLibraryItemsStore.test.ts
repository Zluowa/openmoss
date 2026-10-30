// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  list: vi.fn(),
  register: vi.fn(),
  createFolder: vi.fn(),
  favorite: vi.fn(),
  move: vi.fn(),
  trash: vi.fn(),
  restore: vi.fn(),
  deletePermanently: vi.fn(),
  rename: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  importFiles: vi.fn(),
}));
vi.mock("~/nativeApi", () => ({ readNativeApi: () => ({ library: calls }) }));
vi.mock("~/wsNativeApi", () => ({ readWsServerCapabilities: () => ({}) }));
import {
  useMossLibraryItemsStore,
  MOSS_LIBRARY_ITEMS_STORAGE_KEY,
  MOSS_LIBRARY_MIGRATION_DONE_KEY,
} from "./mossLibraryItemsStore";

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  calls.list.mockResolvedValue({ items: [], folders: [] });
  calls.register.mockResolvedValue({ items: [] });
  calls.createFolder.mockResolvedValue({ folder: {} });
  useMossLibraryItemsStore.getState().resetAccountBoundary();
});
afterEach(() => vi.useRealTimers());

describe("Library recovery", () => {
  it.each([
    "favorite",
    "move",
    "trash",
    "restore",
    "deletePermanently",
    "rename",
    "renameFolder",
    "deleteFolder",
  ] as const)(
    "keeps the real catalog and reports a rejected %s mutation without local replay",
    async (action) => {
      const entry = {
        id: "real",
        title: "owned.png",
        kind: "image" as const,
        sourceCli: "moss" as const,
        updatedAt: 1,
        favorite: false,
        sectionIds: [] as const,
        subtitleZh: "图片",
      };
      useMossLibraryItemsStore.setState({ items: [entry] });
      calls[action].mockRejectedValueOnce(new Error("server unavailable"));
      const store = useMossLibraryItemsStore.getState();
      const result =
        action === "favorite"
          ? await store.favoriteItems([entry.id], true)
          : action === "move"
            ? await store.moveItemsToFolder([entry.id], "folder")
            : action === "trash"
              ? await store.trashItems([entry.id])
              : action === "restore"
                ? await store.restoreItems([entry.id])
                : action === "deletePermanently"
                  ? await store.deleteItemsPermanently([entry.id])
                  : action === "rename"
                    ? await store.renameItem(entry.id, "renamed.png")
                    : action === "renameFolder"
                      ? await store.renameFolderOnServer("folder", "renamed")
                      : await store.deleteFolderOnServer("folder");
      expect(result).toBe(false);
      expect(useMossLibraryItemsStore.getState().items).toEqual([entry]);
      expect(calls[action]).toHaveBeenCalledTimes(1);
      expect(calls.list).not.toHaveBeenCalled();
    },
  );
  it("does not replay a timed-out mutation or reconcile its late result", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    calls.favorite.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const mutation = useMossLibraryItemsStore.getState().favoriteItems(["real"], true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await mutation).toBe(false);
    finish({ items: [] });
    await Promise.resolve();
    expect(calls.favorite).toHaveBeenCalledTimes(1);
    expect(calls.list).not.toHaveBeenCalled();
    expect(useMossLibraryItemsStore.getState().items).toEqual([]);
  });
  it("ignores a mutation acknowledgement from a retired account before refreshing the new account", async () => {
    let finish!: (value: unknown) => void;
    calls.trash.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const mutation = useMossLibraryItemsStore.getState().trashItems(["old"]);
    useMossLibraryItemsStore.getState().resetAccountBoundary();
    finish({ items: [] });
    expect(await mutation).toBe(false);
    expect(calls.list).not.toHaveBeenCalled();
  });
  it("forwards the original imported bytes and reports the actual returned counts", async () => {
    calls.importFiles.mockResolvedValueOnce({ imported: 1, skipped: 1 });
    const files = [{ name: "synthetic.png", mimeType: "image/png", dataBase64: "AQMHCQ==" }];
    expect(await useMossLibraryItemsStore.getState().importFileBlobs(files)).toEqual({
      imported: 1,
      skipped: 1,
    });
    expect(calls.importFiles).toHaveBeenCalledExactlyOnceWith({ files });
  });
  it("reports a failed read instead of interpreting it as an empty library", async () => {
    calls.list.mockRejectedValueOnce(new Error("connection unavailable"));
    await useMossLibraryItemsStore.getState().refresh();
    expect(useMossLibraryItemsStore.getState().loadError).toBeTruthy();
    await useMossLibraryItemsStore.getState().refresh();
    expect(useMossLibraryItemsStore.getState().loadError).toBeNull();
  });
  it("recovers real legacy folders and their membership even after the older migration flag was set", async () => {
    const original = JSON.stringify({
      state: {
        items: [
          {
            id: "folder-pets",
            title: "Pets",
            kind: "folder",
            sourceCli: "moss",
            updatedAt: 1_800_000_000_000,
            favorite: false,
            sectionIds: ["folders"],
            subtitleZh: "文件夹",
          },
          {
            id: "real-image",
            title: "saved.png",
            kind: "image",
            sourceCli: "moss",
            updatedAt: 1_800_000_000_000,
            favorite: true,
            sectionIds: ["images"],
            subtitleZh: "图像",
            folderId: "folder-pets",
          },
          {
            id: "demo",
            title: "example.png",
            kind: "image",
            sourceCli: "moss",
            updatedAt: 1_800_000_000_000,
            favorite: false,
            sectionIds: [],
            subtitleZh: "样例",
            isDemo: true,
          },
        ],
      },
    });
    localStorage.setItem(MOSS_LIBRARY_ITEMS_STORAGE_KEY, original);
    localStorage.setItem(MOSS_LIBRARY_MIGRATION_DONE_KEY, "1");
    await useMossLibraryItemsStore.getState().refresh();
    expect(calls.createFolder).toHaveBeenCalledWith({ id: "folder-pets", title: "Pets" });
    expect(calls.register).toHaveBeenCalledWith({
      items: [
        expect.objectContaining({ id: "real-image", folderId: "folder-pets", favorite: true }),
      ],
    });
    expect(localStorage.getItem(MOSS_LIBRARY_ITEMS_STORAGE_KEY)).toBe(original);
  });
  it("rejects a late response from the previous account after its previews were retired", async () => {
    let finish!: (value: unknown) => void;
    calls.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oldRefresh = useMossLibraryItemsStore.getState().refresh();
    await vi.waitFor(() => expect(finish).toBeDefined());
    useMossLibraryItemsStore.getState().resetAccountBoundary();
    await useMossLibraryItemsStore.getState().refresh();
    finish({
      folders: [
        {
          id: "old-account-folder",
          title: "Old",
          createdAt: "2026-10-14T00:00:00.000Z",
          updatedAt: "2026-10-14T00:00:00.000Z",
        },
      ],
      items: [],
    });
    await oldRefresh;
    expect(useMossLibraryItemsStore.getState().items).toEqual([]);
  });
});
