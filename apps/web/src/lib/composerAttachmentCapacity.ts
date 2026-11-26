// FILE: composerAttachmentCapacity.ts
// Purpose: Defines the composer attachment limit as one shared, commit-time invariant.
// Layer: Web composer domain utility

import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@moss/contracts";

interface AttachmentIdCarrier {
  readonly id: string;
}

export interface ComposerAttachmentCountDraft {
  readonly images?: ReadonlyArray<AttachmentIdCarrier> | undefined;
  readonly files?: ReadonlyArray<{ readonly id?: string | undefined }> | undefined;
  readonly assistantSelections?: ReadonlyArray<unknown> | undefined;
  readonly persistedAttachments?: ReadonlyArray<AttachmentIdCarrier> | undefined;
  readonly persistedFiles?: ReadonlyArray<AttachmentIdCarrier> | undefined;
}

/**
 * Counts live references plus persisted images/files that have not hydrated yet.
 * Hydrating an attachment with the same id therefore consumes no additional slot.
 */
export function effectiveComposerAttachmentCount(
  draft: ComposerAttachmentCountDraft | undefined,
): number {
  if (!draft) return 0;
  const hydratedImageIds = new Set((draft.images ?? []).map((image) => image.id));
  const pendingPersistedImageCount = (draft.persistedAttachments ?? []).filter(
    (attachment) => !hydratedImageIds.has(attachment.id),
  ).length;
  const hydratedFileIds = new Set(
    (draft.files ?? []).flatMap((file) => (typeof file.id === "string" ? [file.id] : [])),
  );
  const pendingPersistedFileCount = (draft.persistedFiles ?? []).filter(
    (file) => !hydratedFileIds.has(file.id),
  ).length;
  return (
    (draft.images?.length ?? 0) +
    (draft.files?.length ?? 0) +
    (draft.assistantSelections?.length ?? 0) +
    pendingPersistedImageCount +
    pendingPersistedFileCount
  );
}

export function availableComposerAttachmentSlots(
  draft: ComposerAttachmentCountDraft | undefined,
): number {
  return Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - effectiveComposerAttachmentCount(draft));
}

export function composerImageConsumesAttachmentSlot(
  draft: ComposerAttachmentCountDraft,
  imageId: string,
): boolean {
  return !(draft.persistedAttachments ?? []).some((attachment) => attachment.id === imageId);
}

export function composerFileConsumesAttachmentSlot(
  draft: ComposerAttachmentCountDraft,
  fileId: string,
): boolean {
  return !(draft.persistedFiles ?? []).some((file) => file.id === fileId);
}
