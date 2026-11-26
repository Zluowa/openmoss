import { ThreadId } from "@moss/contracts";
import { useEffect } from "react";
import { deletePersistedComposerFileBlobs } from "../../composerDraftAttachments";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type PersistedComposerFileAttachment,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  composerFileBlobKey,
  persistComposerFileBlob,
  readComposerFileBlob,
} from "../../lib/composerFileBlobStore";
import { composerImageBlobKey, persistComposerImageBlob } from "../../lib/composerImageBlobStore";
import { readFileAsDataUrl } from "../../lib/composerSend";

// Track the newest in-flight staging run per thread rather than cancelling on
// thread switch. Otherwise pasting an image or file and switching to another
// conversation before async serialization finishes would drop persistence.
let nextStageGenerationToken = 0;
const latestImageStageGenerationByThreadId = new Map<ThreadId, number>();
const latestPromptHistoryImageStageGenerationByThreadId = new Map<ThreadId, number>();
const latestFileStageGenerationByThreadId = new Map<ThreadId, number>();
const latestPromptHistoryFileStageGenerationByThreadId = new Map<ThreadId, number>();
const fileBlobHydrationInFlight = new Set<string>();

function nextStageGeneration(map: Map<ThreadId, number>, threadId: ThreadId): number {
  const next = ++nextStageGenerationToken;
  map.set(threadId, next);
  return next;
}

function isLatestStageGeneration(
  map: Map<ThreadId, number>,
  threadId: ThreadId,
  generation: number,
): boolean {
  return map.get(threadId) === generation;
}

function finishStageGeneration(
  map: Map<ThreadId, number>,
  threadId: ThreadId,
  generation: number,
): void {
  if (map.get(threadId) === generation) {
    map.delete(threadId);
  }
}

// Shared by the live-composer and prompt-history attachment sync effects:
// AppSnap images persist their bytes as IndexedDB blobs (reusing an existing
// blob key when valid), everything else inlines a data URL. Falls back to the
// already-persisted attachments for images whose serialization fails.
async function stagePersistedComposerImageAttachments(input: {
  threadId: ThreadId;
  images: ReadonlyArray<ComposerImageAttachment>;
  getPersistedAttachments: () => PersistedComposerImageAttachment[];
}): Promise<PersistedComposerImageAttachment[]> {
  try {
    const existingPersistedById = new Map(
      input.getPersistedAttachments().map((attachment) => [attachment.id, attachment]),
    );
    const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
    await Promise.all(
      input.images.map(async (image) => {
        try {
          if (image.source?.kind === "appsnap") {
            const existingPersisted = existingPersistedById.get(image.id);
            const expectedBlobKey = composerImageBlobKey(input.threadId, image.id);
            const blobKey =
              existingPersisted?.blobKey === expectedBlobKey
                ? expectedBlobKey
                : await persistComposerImageBlob({
                    threadId: input.threadId,
                    imageId: image.id,
                    file: image.file,
                  });
            stagedAttachmentById.set(image.id, {
              id: image.id,
              name: image.name,
              mimeType: image.mimeType,
              sizeBytes: image.sizeBytes,
              blobKey,
              source: image.source,
            });
            return;
          }
          const dataUrl = await readFileAsDataUrl(image.file);
          stagedAttachmentById.set(image.id, {
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl,
          });
        } catch {
          const existingPersisted = existingPersistedById.get(image.id);
          if (existingPersisted) {
            stagedAttachmentById.set(image.id, existingPersisted);
          }
        }
      }),
    );
    return Array.from(stagedAttachmentById.values());
  } catch {
    const currentImageIds = new Set(input.images.map((image) => image.id));
    return input
      .getPersistedAttachments()
      .filter((attachment) => currentImageIds.has(attachment.id));
  }
}

async function stagePersistedComposerFileAttachments(input: {
  threadId: ThreadId;
  files: ReadonlyArray<ComposerFileAttachment>;
  getPersistedFiles: () => PersistedComposerFileAttachment[];
}): Promise<PersistedComposerFileAttachment[]> {
  try {
    const existingPersistedById = new Map(
      input.getPersistedFiles().map((attachment) => [attachment.id, attachment]),
    );
    const stagedFileById = new Map<string, PersistedComposerFileAttachment>();
    await Promise.all(
      input.files.map(async (fileAttachment) => {
        try {
          const existingPersisted = existingPersistedById.get(fileAttachment.id);
          const expectedBlobKey = composerFileBlobKey(input.threadId, fileAttachment.id);
          const blobKey =
            existingPersisted?.blobKey === expectedBlobKey
              ? expectedBlobKey
              : await persistComposerFileBlob({
                  threadId: input.threadId,
                  fileId: fileAttachment.id,
                  file: fileAttachment.file,
                });
          stagedFileById.set(fileAttachment.id, {
            id: fileAttachment.id,
            name: fileAttachment.name,
            mimeType: fileAttachment.mimeType,
            sizeBytes: fileAttachment.sizeBytes,
            blobKey,
          });
        } catch {
          const existingPersisted = existingPersistedById.get(fileAttachment.id);
          if (existingPersisted) {
            stagedFileById.set(fileAttachment.id, existingPersisted);
          }
        }
      }),
    );
    return Array.from(stagedFileById.values());
  } catch {
    const currentFileIds = new Set(input.files.map((file) => file.id));
    return input.getPersistedFiles().filter((file) => currentFileIds.has(file.id));
  }
}

async function syncImagesForThread(
  threadId: ThreadId,
  composerImages: readonly ComposerImageAttachment[],
): Promise<void> {
  const generation = nextStageGeneration(latestImageStageGenerationByThreadId, threadId);
  try {
    if (composerImages.length === 0) {
      const hasDeferredBlobAttachment =
        useComposerDraftStore
          .getState()
          .draftsByThreadId[threadId]?.persistedAttachments.some(
            (attachment) => attachment.blobKey,
          ) ?? false;
      if (hasDeferredBlobAttachment) {
        return;
      }
      useComposerDraftStore.getState().clearPersistedAttachments(threadId);
      return;
    }
    const staged = await stagePersistedComposerImageAttachments({
      threadId,
      images: composerImages,
      getPersistedAttachments: () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [],
    });
    if (!isLatestStageGeneration(latestImageStageGenerationByThreadId, threadId, generation)) {
      return;
    }
    const liveDraft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    if (!liveDraft) {
      return;
    }
    const liveImageIds = new Set(liveDraft.images.map((image) => image.id));
    const filtered = staged.filter((attachment) => liveImageIds.has(attachment.id));
    void useComposerDraftStore.getState().syncPersistedAttachments(threadId, filtered);
  } finally {
    finishStageGeneration(latestImageStageGenerationByThreadId, threadId, generation);
  }
}

async function syncPromptHistoryImagesForThread(
  threadId: ThreadId,
  images: readonly ComposerImageAttachment[],
): Promise<void> {
  const generation = nextStageGeneration(
    latestPromptHistoryImageStageGenerationByThreadId,
    threadId,
  );
  try {
    const staged = await stagePersistedComposerImageAttachments({
      threadId,
      images,
      getPersistedAttachments: () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft
          ?.persistedAttachments ?? [],
    });
    if (
      !isLatestStageGeneration(
        latestPromptHistoryImageStageGenerationByThreadId,
        threadId,
        generation,
      )
    ) {
      return;
    }
    const liveSavedDraft =
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft;
    if (!liveSavedDraft) {
      return;
    }
    const liveImageIds = new Set(liveSavedDraft.images.map((image) => image.id));
    const filtered = staged.filter((attachment) => liveImageIds.has(attachment.id));
    void useComposerDraftStore
      .getState()
      .syncPromptHistorySavedDraftPersistedAttachments(threadId, filtered);
  } finally {
    finishStageGeneration(latestPromptHistoryImageStageGenerationByThreadId, threadId, generation);
  }
}

function mergeStagedPersistedFiles(input: {
  existingPersistedFiles: readonly PersistedComposerFileAttachment[];
  liveFiles: readonly ComposerFileAttachment[];
  stagedFiles: readonly PersistedComposerFileAttachment[];
}): {
  merged: PersistedComposerFileAttachment[];
  rejectedStaged: PersistedComposerFileAttachment[];
} {
  const liveFileIds = new Set(input.liveFiles.map((file) => file.id));
  const stagedById = new Map<string, PersistedComposerFileAttachment>();
  const rejectedStaged: PersistedComposerFileAttachment[] = [];
  for (const file of input.stagedFiles) {
    if (liveFileIds.has(file.id)) {
      stagedById.set(file.id, file);
    } else {
      rejectedStaged.push(file);
    }
  }
  const merged: PersistedComposerFileAttachment[] = [];
  const includedIds = new Set<string>();
  // Keep every existing persisted file entry (including still-unhydrated files
  // and files hydrated while this sync was in flight). Explicit removals
  // (`removeFile`, `clearComposerContent`, or missing-blob cleanup) have
  // already removed their entries from `existingPersistedFiles`.
  for (const persisted of input.existingPersistedFiles) {
    const next = stagedById.get(persisted.id) ?? persisted;
    merged.push(next);
    includedIds.add(next.id);
  }
  for (const file of input.liveFiles) {
    const staged = stagedById.get(file.id);
    if (staged && !includedIds.has(staged.id)) {
      merged.push(staged);
      includedIds.add(staged.id);
    }
  }
  return { merged, rejectedStaged };
}

async function syncFilesForThread(
  threadId: ThreadId,
  composerFiles: readonly ComposerFileAttachment[],
): Promise<void> {
  const generation = nextStageGeneration(latestFileStageGenerationByThreadId, threadId);
  try {
    if (composerFiles.length === 0) {
      const hasDeferredPersistedFile =
        (useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedFiles?.length ?? 0) >
        0;
      if (hasDeferredPersistedFile) {
        return;
      }
      useComposerDraftStore.getState().clearPersistedFiles(threadId);
      return;
    }
    const staged = await stagePersistedComposerFileAttachments({
      threadId,
      files: composerFiles,
      getPersistedFiles: () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedFiles ?? [],
    });
    if (!isLatestStageGeneration(latestFileStageGenerationByThreadId, threadId, generation)) {
      return;
    }
    const liveDraft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    if (!liveDraft) {
      deletePersistedComposerFileBlobs(
        staged,
        () => useComposerDraftStore.getState().draftsByThreadId,
      );
      return;
    }
    const { merged, rejectedStaged } = mergeStagedPersistedFiles({
      existingPersistedFiles: liveDraft.persistedFiles ?? [],
      liveFiles: liveDraft.files,
      stagedFiles: staged,
    });
    useComposerDraftStore.getState().syncPersistedFiles(threadId, merged);
    if (rejectedStaged.length > 0) {
      deletePersistedComposerFileBlobs(
        rejectedStaged,
        () => useComposerDraftStore.getState().draftsByThreadId,
      );
    }
  } finally {
    finishStageGeneration(latestFileStageGenerationByThreadId, threadId, generation);
  }
}

async function syncPromptHistoryFilesForThread(
  threadId: ThreadId,
  files: readonly ComposerFileAttachment[],
): Promise<void> {
  const generation = nextStageGeneration(
    latestPromptHistoryFileStageGenerationByThreadId,
    threadId,
  );
  try {
    const staged = await stagePersistedComposerFileAttachments({
      threadId,
      files,
      getPersistedFiles: () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft
          ?.persistedFiles ?? [],
    });
    if (
      !isLatestStageGeneration(
        latestPromptHistoryFileStageGenerationByThreadId,
        threadId,
        generation,
      )
    ) {
      return;
    }
    const liveSavedDraft =
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft;
    if (!liveSavedDraft) {
      deletePersistedComposerFileBlobs(
        staged,
        () => useComposerDraftStore.getState().draftsByThreadId,
      );
      return;
    }
    const { merged, rejectedStaged } = mergeStagedPersistedFiles({
      existingPersistedFiles: liveSavedDraft.persistedFiles ?? [],
      liveFiles: liveSavedDraft.files,
      stagedFiles: staged,
    });
    useComposerDraftStore.getState().syncPromptHistorySavedDraftPersistedFiles(threadId, merged);
    if (rejectedStaged.length > 0) {
      deletePersistedComposerFileBlobs(
        rejectedStaged,
        () => useComposerDraftStore.getState().draftsByThreadId,
      );
    }
  } finally {
    finishStageGeneration(latestPromptHistoryFileStageGenerationByThreadId, threadId, generation);
  }
}

async function hydratePersistedFilesForSlot(input: {
  threadId: ThreadId;
  slotKey: "draft" | "prompt-history";
  persistedFiles: readonly PersistedComposerFileAttachment[];
  liveFileIds: ReadonlySet<string>;
  hasPersistedFile: (fileId: string) => boolean;
  addFiles: (files: ComposerFileAttachment[]) => number;
  removePersistedFile: (fileId: string) => void;
}): Promise<void> {
  const pending: Array<{
    persisted: PersistedComposerFileAttachment;
    inFlightKey: string;
  }> = [];
  for (const persisted of input.persistedFiles) {
    if (input.liveFileIds.has(persisted.id)) {
      continue;
    }
    const inFlightKey = `${input.slotKey}:${input.threadId}:${persisted.blobKey}`;
    if (fileBlobHydrationInFlight.has(inFlightKey)) {
      continue;
    }
    fileBlobHydrationInFlight.add(inFlightKey);
    pending.push({ persisted, inFlightKey });
  }
  if (pending.length === 0) {
    return;
  }
  const results = await Promise.all(
    pending.map(async ({ persisted, inFlightKey }) => {
      try {
        const file = await readComposerFileBlob(persisted.blobKey);
        return { persisted, file, failed: false as const };
      } catch (error) {
        console.warn("[composer-files] Could not restore persisted file attachment", error);
        return { persisted, file: null, failed: true as const };
      } finally {
        fileBlobHydrationInFlight.delete(inFlightKey);
      }
    }),
  );
  const hydratedFiles: ComposerFileAttachment[] = [];
  for (const result of results) {
    if (result.failed) {
      continue;
    }
    if (!input.hasPersistedFile(result.persisted.id)) {
      continue;
    }
    if (!result.file) {
      input.removePersistedFile(result.persisted.id);
      continue;
    }
    hydratedFiles.push({
      type: "file",
      id: result.persisted.id,
      name: result.persisted.name,
      mimeType: result.persisted.mimeType,
      sizeBytes: result.persisted.sizeBytes,
      file: result.file,
    });
  }
  if (hydratedFiles.length > 0) {
    input.addFiles(hydratedFiles);
  }
}

interface ComposerAttachmentPersistenceInput {
  threadId: ThreadId;
  composerImages: readonly ComposerImageAttachment[];
  composerPromptHistorySavedDraftImages: readonly ComposerImageAttachment[] | null;
  composerFiles: readonly ComposerFileAttachment[];
  composerPersistedFiles: readonly PersistedComposerFileAttachment[];
  composerPromptHistorySavedDraftFiles: readonly ComposerFileAttachment[] | null;
  composerPromptHistorySavedDraftPersistedFiles: readonly PersistedComposerFileAttachment[] | null;
}

export function useComposerAttachmentPersistence({
  threadId,
  composerImages,
  composerPromptHistorySavedDraftImages,
  composerFiles,
  composerPersistedFiles,
  composerPromptHistorySavedDraftFiles,
  composerPromptHistorySavedDraftPersistedFiles,
}: ComposerAttachmentPersistenceInput) {
  useEffect(() => {
    void syncImagesForThread(threadId, composerImages);
  }, [composerImages, threadId]);

  useEffect(() => {
    if (
      !composerPromptHistorySavedDraftImages ||
      composerPromptHistorySavedDraftImages.length === 0
    ) {
      return;
    }
    void syncPromptHistoryImagesForThread(threadId, composerPromptHistorySavedDraftImages);
  }, [composerPromptHistorySavedDraftImages, threadId]);

  useEffect(() => {
    void syncFilesForThread(threadId, composerFiles);
  }, [composerFiles, threadId]);

  useEffect(() => {
    if (
      !composerPromptHistorySavedDraftFiles ||
      composerPromptHistorySavedDraftFiles.length === 0
    ) {
      return;
    }
    void syncPromptHistoryFilesForThread(threadId, composerPromptHistorySavedDraftFiles);
  }, [composerPromptHistorySavedDraftFiles, threadId]);

  useEffect(() => {
    if (composerPersistedFiles.length === 0) {
      return;
    }
    const liveFileIds = new Set(composerFiles.map((file) => file.id));
    if (composerPersistedFiles.every((file) => liveFileIds.has(file.id))) {
      return;
    }
    void hydratePersistedFilesForSlot({
      threadId,
      slotKey: "draft",
      persistedFiles: composerPersistedFiles,
      liveFileIds,
      hasPersistedFile: (fileId) =>
        (useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedFiles ?? []).some(
          (file) => file.id === fileId,
        ),
      addFiles: (files) => useComposerDraftStore.getState().addFiles(threadId, files),
      removePersistedFile: (fileId) => {
        const latest =
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedFiles ?? [];
        useComposerDraftStore.getState().syncPersistedFiles(
          threadId,
          latest.filter((file) => file.id !== fileId),
        );
      },
    });
  }, [composerFiles, composerPersistedFiles, threadId]);

  useEffect(() => {
    if (
      !composerPromptHistorySavedDraftPersistedFiles ||
      composerPromptHistorySavedDraftPersistedFiles.length === 0
    ) {
      return;
    }
    const liveFileIds = new Set(
      (composerPromptHistorySavedDraftFiles ?? []).map((file) => file.id),
    );
    if (composerPromptHistorySavedDraftPersistedFiles.every((file) => liveFileIds.has(file.id))) {
      return;
    }
    void hydratePersistedFilesForSlot({
      threadId,
      slotKey: "prompt-history",
      persistedFiles: composerPromptHistorySavedDraftPersistedFiles,
      liveFileIds,
      hasPersistedFile: (fileId) =>
        (
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft
            ?.persistedFiles ?? []
        ).some((file) => file.id === fileId),
      addFiles: (files) =>
        useComposerDraftStore.getState().addPromptHistorySavedDraftFiles(threadId, files),
      removePersistedFile: (fileId) => {
        const latest =
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft
            ?.persistedFiles ?? [];
        useComposerDraftStore.getState().syncPromptHistorySavedDraftPersistedFiles(
          threadId,
          latest.filter((file) => file.id !== fileId),
        );
      },
    });
  }, [
    composerPromptHistorySavedDraftFiles,
    composerPromptHistorySavedDraftPersistedFiles,
    threadId,
  ]);
}
