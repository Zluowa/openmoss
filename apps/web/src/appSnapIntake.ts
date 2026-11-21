// FILE: appSnapIntake.ts
// Purpose: Turns a desktop AppSnap capture into a persisted composer image attachment.
// Layer: Web composer domain
// Depends on: composer draft store, composer image intake, and AppSnap icon cache.

import type { DesktopAppSnapCapture, ThreadId } from "@moss/contracts";

import {
  isRecentlyArrivedAppSnapCapture,
  launchAppSnapFlight,
  shouldUseAppSnapReturnVeil,
} from "./lib/appSnapArrival";
import { peekCachedAppSnapIcon, persistAppSnapIcon, readAppSnapIcon } from "./lib/appSnapIconStore";
import { deleteComposerImageBlob, persistComposerImageBlob } from "./lib/composerImageBlobStore";
import { type ComposerAppSnapSource } from "./lib/composerImageSource";
import {
  effectiveComposerAttachmentCount,
  prepareComposerImageAttachmentsFromFiles,
} from "./lib/composerSend";
import { useComposerDraftStore } from "./composerDraftStore";

export async function sourceWithCachedIcon(
  source: ComposerAppSnapSource,
): Promise<ComposerAppSnapSource> {
  const bundleIdentifier = source.bundleIdentifier?.trim() || null;
  if (!bundleIdentifier) return source;
  if (source.appIconDataUrl) {
    await persistAppSnapIcon({
      bundleIdentifier,
      dataUrl: source.appIconDataUrl,
    }).catch((error) => console.warn("[appsnap] Could not cache source app icon", error));
    return source;
  }
  const appIconDataUrl = await readAppSnapIcon(bundleIdentifier).catch((error) => {
    console.warn("[appsnap] Could not restore source app icon", error);
    return null;
  });
  return appIconDataUrl ? { ...source, appIconDataUrl } : source;
}

export async function insertAppSnapCaptureIntoDraft(
  threadId: ThreadId,
  capture: DesktopAppSnapCapture,
): Promise<"persisted" | "unverified"> {
  const parsedCaptureAt = Date.parse(capture.capturedAt);
  const captureAtMs = Number.isFinite(parsedCaptureAt) ? parsedCaptureAt : Date.now();
  if (capture.bytes.byteLength === 0) throw new Error("The captured AppSnap is empty.");
  const rawBuffer = capture.bytes.buffer;
  const blobPart: BlobPart =
    capture.bytes instanceof Uint8Array &&
    rawBuffer instanceof ArrayBuffer &&
    capture.bytes.byteOffset === 0 &&
    capture.bytes.byteLength === rawBuffer.byteLength
      ? rawBuffer
      : new Uint8Array(capture.bytes);
  const file = new File([blobPart], capture.name, {
    type: capture.mimeType,
    lastModified: captureAtMs,
  });
  const draftStore = useComposerDraftStore.getState();
  const draft = draftStore.draftsByThreadId[threadId];
  const existingAttachmentCount = effectiveComposerAttachmentCount(draft);
  const { images, error } = await prepareComposerImageAttachmentsFromFiles({
    files: [file],
    existingAttachmentCount,
  });
  const image = images[0];
  if (!image) throw new Error(error ?? "Moss could not attach the captured AppSnap.");

  let imageAddedToDraft = false;
  let blobKey: string | null = null;
  let persistenceResult: "persisted" | "unverified" = "persisted";
  try {
    const cachedIcon = capture.sourceAppIconDataUrl
      ? capture.sourceAppIconDataUrl
      : (peekCachedAppSnapIcon(capture.sourceBundleIdentifier) ?? null);
    const source: ComposerAppSnapSource = {
      kind: "appsnap",
      captureId: capture.id,
      capturedAt: capture.capturedAt,
      appName: capture.sourceAppName,
      bundleIdentifier: capture.sourceBundleIdentifier,
      appIconDataUrl: cachedIcon,
      windowTitle: capture.sourceWindowTitle,
    };
    const appSnapImage = { ...image, source };

    // Mount the attachment in the composer BEFORE awaiting IndexedDB writes so
    // the thumbnail and fly-to-composer motion start on the very first frame
    // instead of stalling behind disk persistence.
    if (!draftStore.addImage(threadId, appSnapImage)) {
      throw new Error(
        "The AppSnap was prepared, but this message already has the maximum number of references.",
      );
    }
    imageAddedToDraft = true;

    if (isRecentlyArrivedAppSnapCapture(capture.id)) {
      launchAppSnapFlight({
        captureId: capture.id,
        previewUrl: appSnapImage.previewUrl,
        appName: capture.sourceAppName?.trim() || "Captured app",
        windowTitle: capture.sourceWindowTitle?.trim() || null,
        appIconDataUrl: cachedIcon,
        sourceWindowBounds: capture.sourceWindowBounds ?? null,
        withReturnVeil: shouldUseAppSnapReturnVeil(capture.id),
      });
    }

    const [sourceWithIcon, persistedBlobKey] = await Promise.all([
      sourceWithCachedIcon(source),
      persistComposerImageBlob({
        threadId,
        imageId: image.id,
        file: image.file,
      }),
    ]);
    blobKey = persistedBlobKey;

    const latestDraft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    if (latestDraft && !latestDraft.images.some((entry) => entry.id === appSnapImage.id)) {
      // User already removed the chip before persistence finished: clean up the
      // just-written blob instead of resurrecting draft metadata.
      await deleteComposerImageBlob(blobKey).catch((cleanupError) =>
        console.warn("[appsnap] Could not clean up removed capture blob", cleanupError),
      );
      return "persisted";
    }

    const currentPersistedAttachments = latestDraft?.persistedAttachments ?? [];
    const result = await draftStore.syncPersistedAttachments(threadId, [
      ...currentPersistedAttachments.filter((attachment) => attachment.id !== appSnapImage.id),
      {
        id: appSnapImage.id,
        name: appSnapImage.name,
        mimeType: appSnapImage.mimeType,
        sizeBytes: appSnapImage.sizeBytes,
        blobKey,
        source: sourceWithIcon,
      },
    ]);
    if (result === "rejected") {
      throw new Error("The AppSnap was captured, but its draft metadata was rejected.");
    }
    // Clear recalled prompt-history state only after the new attachment has
    // survived persistence verification. A rejected mutation must leave the
    // user's prior draft snapshot intact.
    draftStore.setPromptHistorySavedDraft(threadId, null);
    persistenceResult = result;
  } catch (error) {
    if (imageAddedToDraft) {
      draftStore.removeImage(threadId, image.id);
    } else {
      URL.revokeObjectURL(image.previewUrl);
    }
    if (blobKey) {
      await deleteComposerImageBlob(blobKey).catch((cleanupError) =>
        console.warn("[appsnap] Could not roll back unattached capture", cleanupError),
      );
    }
    throw error;
  }
  return persistenceResult;
}
