// FILE: ComposerReferenceAttachments.tsx
// Purpose: Render assistant-selection, file-comment, pasted-text, pull-request-context,
//   file, and image composer attachments in one reusable row, and the preview a file or
//   image opens (with Mark up for images).
// Layer: Chat composer presentation

import { useState } from "react";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { type BrowserAnnotationDraft } from "../../lib/browserAnnotations";
import { type PastedTextDraft } from "../../lib/composerPastedText";
import { type FileCommentDraft } from "../../lib/fileComments";
import { type PullRequestContextDraft } from "../../lib/pullRequestContext";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";
import { FileAttachmentChip } from "./FileAttachmentChip";
import { ComposerPastedTextCard } from "./PastedTextChip";
import { ComposerPullRequestContextCard } from "./PullRequestContextCard";
import { FileCommentsSummaryChip } from "./FileCommentsSummaryChip";
import { BrowserAnnotationStrip } from "./BrowserAnnotationStrip";
import {
  ComposerAttachmentPreview,
  type ComposerAttachmentPreviewTarget,
} from "./ComposerAttachmentPreview";

interface ComposerReferenceAttachmentsProps {
  assistantSelections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  browserAnnotations?: ReadonlyArray<BrowserAnnotationDraft>;
  fileComments: ReadonlyArray<FileCommentDraft>;
  pastedTexts?: ReadonlyArray<PastedTextDraft>;
  pullRequestContexts?: ReadonlyArray<PullRequestContextDraft>;
  files: ReadonlyArray<ComposerFileAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
  nonPersistedImageIdSet: ReadonlySet<string>;
  /** Swaps an image for its marked copy; images get Mark up in their preview when set. */
  onReplaceImage?: (imageId: string, file: File) => void | Promise<void>;
  onRemoveAssistantSelections: () => void;
  onRemoveBrowserAnnotation?: (annotationId: string) => void;
  onRemoveFileComments: () => void;
  onRemovePastedText?: (pastedTextId: string) => void;
  onShowPastedTextInField?: (pastedTextId: string) => void;
  onRemovePullRequestContext?: (contextId: string) => void;
  onRemoveFile: (fileId: string) => void;
  onRemoveImage: (imageId: string) => void;
}

export function ComposerReferenceAttachments({
  assistantSelections,
  browserAnnotations = [],
  fileComments,
  pastedTexts: pastedTextsProp,
  pullRequestContexts: pullRequestContextsProp,
  files,
  images,
  nonPersistedImageIdSet,
  onReplaceImage,
  onRemoveAssistantSelections,
  onRemoveBrowserAnnotation,
  onRemoveFileComments,
  onRemovePastedText,
  onShowPastedTextInField,
  onRemovePullRequestContext,
  onRemoveFile,
  onRemoveImage,
}: ComposerReferenceAttachmentsProps) {
  const pastedTexts = pastedTextsProp ?? [];
  const pullRequestContexts = pullRequestContextsProp ?? [];
  const [previewed, setPreviewed] = useState<{ kind: "image" | "file"; id: string } | null>(null);
  // Looked up each render, so a removed attachment closes its preview.
  const previewImage =
    previewed?.kind === "image" ? images.find((image) => image.id === previewed.id) : undefined;
  const previewFile =
    previewed?.kind === "file" ? files.find((file) => file.id === previewed.id) : undefined;
  const previewTarget: ComposerAttachmentPreviewTarget | null = previewImage
    ? { kind: "image", image: previewImage }
    : previewFile
      ? { kind: "file", file: previewFile }
      : null;
  if (
    assistantSelections.length === 0 &&
    browserAnnotations.length === 0 &&
    fileComments.length === 0 &&
    pastedTexts.length === 0 &&
    pullRequestContexts.length === 0 &&
    files.length === 0 &&
    images.length === 0
  ) {
    return null;
  }

  return (
    <div className="-mx-1.5 -mt-1 mb-2 flex flex-wrap items-start gap-1.5">
      <AssistantSelectionsSummaryChip
        selections={assistantSelections}
        onRemove={assistantSelections.length > 0 ? onRemoveAssistantSelections : undefined}
      />
      <BrowserAnnotationStrip
        annotations={browserAnnotations}
        onRemove={onRemoveBrowserAnnotation}
      />
      <FileCommentsSummaryChip
        comments={fileComments}
        onRemove={fileComments.length > 0 ? onRemoveFileComments : undefined}
      />
      {pastedTexts.map((pasted) => (
        <ComposerPastedTextCard
          key={pasted.id}
          text={pasted.text}
          metrics={{ lineCount: pasted.lineCount, charCount: pasted.charCount }}
          onShowInTextField={() => onShowPastedTextInField?.(pasted.id)}
          onRemove={() => onRemovePastedText?.(pasted.id)}
        />
      ))}
      {pullRequestContexts.map((context) => (
        <ComposerPullRequestContextCard
          key={context.id}
          scope={context.scope}
          itemKind={context.itemKind}
          title={context.title}
          subtitle={context.subtitle}
          onRemove={() => onRemovePullRequestContext?.(context.id)}
        />
      ))}
      {files.map((file) => (
        <FileAttachmentChip
          key={file.id}
          file={file}
          variant="card"
          onRemove={onRemoveFile}
          onOpen={() => setPreviewed({ kind: "file", id: file.id })}
        />
      ))}
      {images.map((image) => (
        <ComposerImageAttachmentChip
          key={image.id}
          image={image}
          images={images}
          nonPersisted={nonPersistedImageIdSet.has(image.id)}
          onOpenPreview={(imageId) => setPreviewed({ kind: "image", id: imageId })}
          onRemoveImage={onRemoveImage}
        />
      ))}
      <ComposerAttachmentPreview
        target={previewTarget}
        images={images}
        onShowImage={(imageId) => setPreviewed({ kind: "image", id: imageId })}
        onClose={() => setPreviewed(null)}
        onReplaceImage={onReplaceImage}
      />
    </div>
  );
}
