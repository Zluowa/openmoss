// @vitest-environment happy-dom
import { ThreadId } from "@moss/contracts";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEmptyThreadDraft,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type PersistedComposerFileAttachment,
} from "../../composerDraftDomain";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import * as composerFileBlobStore from "../../lib/composerFileBlobStore";
import * as composerSend from "../../lib/composerSend";
import { useComposerAttachmentPersistence } from "./useComposerAttachmentPersistence";

const EMPTY_IMAGES: readonly ComposerImageAttachment[] = [];
const EMPTY_FILES: readonly ComposerFileAttachment[] = [];
const EMPTY_PERSISTED_FILES: readonly PersistedComposerFileAttachment[] = [];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function PersistenceHarness({ threadId }: { threadId: ThreadId }) {
  const draft = useComposerDraftStore((state) => state.draftsByThreadId[threadId]);
  useComposerAttachmentPersistence({
    threadId,
    composerImages: draft?.images ?? EMPTY_IMAGES,
    composerPromptHistorySavedDraftImages: draft?.promptHistorySavedDraft?.images ?? null,
    composerFiles: draft?.files ?? EMPTY_FILES,
    composerPersistedFiles: draft?.persistedFiles ?? EMPTY_PERSISTED_FILES,
    composerPromptHistorySavedDraftFiles: draft?.promptHistorySavedDraft?.files ?? null,
    composerPromptHistorySavedDraftPersistedFiles:
      draft?.promptHistorySavedDraft?.persistedFiles ?? null,
  });
  return null;
}

function makePersistedFile(threadId: ThreadId, id: string, name: string, body: string) {
  const file = new File([body], name, { type: "text/plain" });
  const persisted: PersistedComposerFileAttachment = {
    id,
    name,
    mimeType: "text/plain",
    sizeBytes: file.size,
    blobKey: composerFileBlobStore.composerFileBlobKey(threadId, id),
  };
  return { file, persisted };
}

describe("useComposerAttachmentPersistence", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("rehydrates 2+ persisted files after reload without dropping later files or deleting blobs", async () => {
    const threadId = ThreadId.makeUnsafe("thread-multi-reload");
    const first = makePersistedFile(threadId, "file-1", "one.txt", "first body");
    const second = makePersistedFile(threadId, "file-2", "two.txt", "second body");
    const third = makePersistedFile(threadId, "file-3", "three.txt", "third body");

    useComposerDraftStore.setState({
      draftsByThreadId: {
        [threadId]: {
          ...createEmptyThreadDraft(),
          persistedFiles: [first.persisted, second.persisted, third.persisted],
        },
      },
    });

    const readDeferreds = new Map<string, Deferred<File | null>>([
      [first.persisted.blobKey, createDeferred<File | null>()],
      [second.persisted.blobKey, createDeferred<File | null>()],
      [third.persisted.blobKey, createDeferred<File | null>()],
    ]);
    vi.spyOn(composerFileBlobStore, "readComposerFileBlob").mockImplementation(
      (key) => readDeferreds.get(key)?.promise ?? Promise.resolve(null),
    );
    const deleteSpy = vi
      .spyOn(composerFileBlobStore, "deleteComposerFileBlob")
      .mockResolvedValue(undefined);
    vi.spyOn(composerFileBlobStore, "persistComposerFileBlob").mockImplementation(
      async ({ threadId: tid, fileId }) => composerFileBlobStore.composerFileBlobKey(tid, fileId),
    );

    render(<PersistenceHarness threadId={threadId} />);

    // Resolve staggered across turns: first finishes before second and third.
    await act(async () => {
      readDeferreds.get(first.persisted.blobKey)!.resolve(first.file);
      await Promise.resolve();
    });
    await act(async () => {
      readDeferreds.get(second.persisted.blobKey)!.resolve(second.file);
      await Promise.resolve();
    });
    await act(async () => {
      readDeferreds.get(third.persisted.blobKey)!.resolve(third.file);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.files.map((f) => f.id),
      ).toEqual(["file-1", "file-2", "file-3"]);
    });
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedFiles?.map((f) => f.id),
    ).toEqual(["file-1", "file-2", "file-3"]);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("preserves hydrating persisted files when the user attaches a new file mid-hydration", async () => {
    const threadId = ThreadId.makeUnsafe("thread-attach-mid-hydrate");
    const first = makePersistedFile(threadId, "file-1", "one.txt", "first");
    const second = makePersistedFile(threadId, "file-2", "two.txt", "second");
    const newFile = new File(["fresh"], "three.txt", { type: "text/plain" });

    useComposerDraftStore.setState({
      draftsByThreadId: {
        [threadId]: {
          ...createEmptyThreadDraft(),
          persistedFiles: [first.persisted, second.persisted],
        },
      },
    });

    const readDeferreds = new Map<string, Deferred<File | null>>([
      [first.persisted.blobKey, createDeferred<File | null>()],
      [second.persisted.blobKey, createDeferred<File | null>()],
    ]);
    vi.spyOn(composerFileBlobStore, "readComposerFileBlob").mockImplementation(
      (key) => readDeferreds.get(key)?.promise ?? Promise.resolve(null),
    );
    const deleteSpy = vi
      .spyOn(composerFileBlobStore, "deleteComposerFileBlob")
      .mockResolvedValue(undefined);
    const persistSpy = vi
      .spyOn(composerFileBlobStore, "persistComposerFileBlob")
      .mockImplementation(async ({ threadId: tid, fileId }) =>
        composerFileBlobStore.composerFileBlobKey(tid, fileId),
      );

    render(<PersistenceHarness threadId={threadId} />);

    // While both persisted files are still hydrating, attach a brand-new file.
    await act(async () => {
      useComposerDraftStore.getState().addFiles(threadId, [
        {
          type: "file",
          id: "file-3",
          name: "three.txt",
          mimeType: "text/plain",
          sizeBytes: newFile.size,
          file: newFile,
        },
      ]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(persistSpy).toHaveBeenCalledWith(
        expect.objectContaining({ threadId, fileId: "file-3" }),
      );
      expect(
        useComposerDraftStore
          .getState()
          .draftsByThreadId[threadId]?.persistedFiles?.map((f) => f.id),
      ).toEqual(["file-1", "file-2", "file-3"]);
    });
    expect(deleteSpy).not.toHaveBeenCalled();

    // Now finish hydrating the two persisted files; all 3 must land in live files.
    await act(async () => {
      readDeferreds.get(first.persisted.blobKey)!.resolve(first.file);
      readDeferreds.get(second.persisted.blobKey)!.resolve(second.file);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        useComposerDraftStore
          .getState()
          .draftsByThreadId[threadId]?.files.map((f) => f.id)
          .toSorted(),
      ).toEqual(["file-1", "file-2", "file-3"]);
    });
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedFiles?.map((f) => f.id),
    ).toEqual(["file-1", "file-2", "file-3"]);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("rehydrates multi-file promptHistorySavedDraft without wiping unhydrated entries", async () => {
    const threadId = ThreadId.makeUnsafe("thread-history-multi-reload");
    const saved1 = makePersistedFile(threadId, "hist-1", "h1.txt", "h1");
    const saved2 = makePersistedFile(threadId, "hist-2", "h2.txt", "h2");
    const liveFile = new File(["h3"], "h3.txt", { type: "text/plain" });

    useComposerDraftStore.setState({
      draftsByThreadId: {
        [threadId]: {
          ...createEmptyThreadDraft(),
          promptHistorySavedDraft: {
            prompt: "saved draft",
            images: [],
            files: [
              {
                type: "file",
                id: "hist-3",
                name: "h3.txt",
                mimeType: "text/plain",
                sizeBytes: liveFile.size,
                file: liveFile,
              },
            ],
            nonPersistedImageIds: [],
            persistedAttachments: [],
            persistedFiles: [saved1.persisted, saved2.persisted],
            assistantSelections: [],
            browserAnnotations: [],
            terminalContexts: [],
            fileComments: [],
            pastedTexts: [],
            pullRequestContexts: [],
            skills: [],
            mentions: [],
          },
        },
      },
    });

    const readDeferreds = new Map<string, Deferred<File | null>>([
      [saved1.persisted.blobKey, createDeferred<File | null>()],
      [saved2.persisted.blobKey, createDeferred<File | null>()],
    ]);
    vi.spyOn(composerFileBlobStore, "readComposerFileBlob").mockImplementation(
      (key) => readDeferreds.get(key)?.promise ?? Promise.resolve(null),
    );
    const deleteSpy = vi
      .spyOn(composerFileBlobStore, "deleteComposerFileBlob")
      .mockResolvedValue(undefined);
    vi.spyOn(composerFileBlobStore, "persistComposerFileBlob").mockImplementation(
      async ({ threadId: tid, fileId }) => composerFileBlobStore.composerFileBlobKey(tid, fileId),
    );

    render(<PersistenceHarness threadId={threadId} />);

    await waitFor(() => {
      expect(
        useComposerDraftStore
          .getState()
          .draftsByThreadId[threadId]?.promptHistorySavedDraft?.persistedFiles?.map((f) => f.id),
      ).toEqual(["hist-1", "hist-2", "hist-3"]);
    });
    expect(deleteSpy).not.toHaveBeenCalled();

    await act(async () => {
      readDeferreds.get(saved1.persisted.blobKey)!.resolve(saved1.file);
      readDeferreds.get(saved2.persisted.blobKey)!.resolve(saved2.file);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        useComposerDraftStore
          .getState()
          .draftsByThreadId[threadId]?.promptHistorySavedDraft?.files.map((f) => f.id)
          .toSorted(),
      ).toEqual(["hist-1", "hist-2", "hist-3"]);
    });
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("saves the original thread's persisted image and file when switching threads mid-serialization", async () => {
    const threadA = ThreadId.makeUnsafe("thread-switch-a");
    const threadB = ThreadId.makeUnsafe("thread-switch-b");
    const imgFile = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const docFile = new File(["doc-bytes"], "notes.md", { type: "text/markdown" });

    const imageDeferred = createDeferred<string>();
    const fileDeferred = createDeferred<string>();
    vi.spyOn(composerSend, "readFileAsDataUrl").mockReturnValue(imageDeferred.promise);
    vi.spyOn(composerFileBlobStore, "persistComposerFileBlob").mockReturnValue(
      fileDeferred.promise,
    );

    useComposerDraftStore.getState().addImage(threadA, {
      type: "image",
      id: "img-a",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: imgFile.size,
      previewUrl: "blob:shot.png",
      file: imgFile,
    });
    useComposerDraftStore.getState().addFiles(threadA, [
      {
        type: "file",
        id: "file-a",
        name: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: docFile.size,
        file: docFile,
      },
    ]);

    const { rerender } = render(<PersistenceHarness threadId={threadA} />);

    // Switch to another thread BEFORE either async persistence promise resolves.
    rerender(<PersistenceHarness threadId={threadB} />);

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadA]?.persistedAttachments,
    ).toEqual([]);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadA]?.persistedFiles).toEqual([]);

    // Resolve both deferred promises AFTER switching away from threadA.
    await act(async () => {
      imageDeferred.resolve("data:image/png;base64,cG5nLWJ5dGVz");
      fileDeferred.resolve(composerFileBlobStore.composerFileBlobKey(threadA, "file-a"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        useComposerDraftStore.getState().draftsByThreadId[threadA]?.persistedAttachments,
      ).toEqual([
        expect.objectContaining({
          id: "img-a",
          name: "shot.png",
          dataUrl: "data:image/png;base64,cG5nLWJ5dGVz",
        }),
      ]);
      expect(useComposerDraftStore.getState().draftsByThreadId[threadA]?.persistedFiles).toEqual([
        expect.objectContaining({
          id: "file-a",
          name: "notes.md",
          blobKey: `${threadA}:file-a`,
        }),
      ]);
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadB]).toBeUndefined();
  });
});
