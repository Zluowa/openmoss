// FILE: ComposerAttachmentPreview.tsx
// Purpose: The preview a composer attachment opens: an image at a comfortable size over the
//   dimmed chat, with close and mark up beside its top edge, or a card naming a file. Mark up
//   reuses Moss's shared markup bar and canvas (the browser panel's too); Save replaces the
//   attachment with the marked image.
// Layer: Chat composer UI
// Exports: ComposerAttachmentPreview, ComposerAttachmentPreviewTarget

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { formatBytes } from "@moss/shared/formatBytes";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { PencilIcon, XIcon } from "~/lib/icons";
import { notifyNativeSurfaceOcclusionChange } from "~/lib/nativeSurfaceOcclusion";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { MarkupCanvas, composeMarkupPng } from "../markup/MarkupCanvas";
import { MarkupToolbar } from "../markup/MarkupToolbar";
import {
  addMarkupMark,
  DEFAULT_MARKUP_STYLE,
  EMPTY_MARKUP_HISTORY,
  markupFileName,
  redoMarkupMark,
  undoMarkupMark,
  type MarkupHistory,
  type MarkupMark,
  type MarkupStyle,
  type MarkupTool,
} from "../markup/markup.logic";
import { IconButton } from "../ui/icon-button";
import { toastManager } from "../ui/toast";
import { fileAttachmentTypeLabel } from "./FileAttachmentChip";
import { FileEntryIcon } from "./FileEntryIcon";

export type ComposerAttachmentPreviewTarget =
  | { readonly kind: "image"; readonly image: ComposerImageAttachment }
  | { readonly kind: "file"; readonly file: ComposerFileAttachment };

interface ComposerAttachmentPreviewProps {
  readonly target: ComposerAttachmentPreviewTarget | null;
  readonly onClose: () => void;
  /** Swaps an image attachment for its marked copy. Without it images have no Mark up. */
  readonly onReplaceImage?: ((imageId: string, file: File) => void | Promise<void>) | undefined;
  /** Arrow keys step through these while an image is shown (not while marking it up). */
  readonly images?: readonly ComposerImageAttachment[];
  readonly onShowImage?: (imageId: string) => void;
}

// The image never grows past 40rem wide, as in Claude's preview, and leaves room for the
// buttons beside it and, while marking up, the bar under it.
const PREVIEW_IMAGE_CLASS_NAME =
  "block h-auto max-h-[calc(100vh-9rem)] w-auto max-w-full select-none rounded-[5px]";
const PREVIEW_FRAME_CLASS_NAME = "relative w-fit max-w-[min(40rem,calc(100vw-6rem))]";
// Round, quiet buttons on the dim: white glyphs, a faint fill on hover.
const PREVIEW_BUTTON_CLASS_NAME =
  "size-8 rounded-full bg-black/35 text-white/90 shadow-none hover:bg-black/55 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 [&_[data-slot=central-icon]]:size-4";

const NO_IMAGES: readonly ComposerImageAttachment[] = [];

function markedName(name: string): string {
  const dot = name.lastIndexOf(".");
  return markupFileName(dot > 0 ? name.slice(0, dot) : name);
}

/** Close (and Mark up) stacked to the right of the preview's top edge. */
function PreviewActions(props: { readonly children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label={t("composer.attachmentPreview.actions")}
      data-attachment-preview-actions=""
      className="absolute start-full top-0 ms-1.5 flex flex-col gap-1.5"
    >
      {props.children}
    </div>
  );
}

export function ComposerAttachmentPreview(props: ComposerAttachmentPreviewProps) {
  const { t } = useTranslation();
  const { target, onClose } = props;
  const open = target !== null;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [marking, setMarking] = useState(false);
  const [tool, setTool] = useState<MarkupTool>("pen");
  const [style, setStyle] = useState<MarkupStyle>(DEFAULT_MARKUP_STYLE);
  const [history, setHistory] = useState<MarkupHistory>(EMPTY_MARKUP_HISTORY);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const targetKey = target
    ? `${target.kind}:${target.kind === "image" ? target.image.id : target.file.id}`
    : null;

  // A new attachment always opens as a plain preview.
  useEffect(() => {
    setMarking(false);
    setHistory(EMPTY_MARKUP_HISTORY);
    setConfirmingDiscard(false);
    setTool("pen");
  }, [targetKey]);

  // The browser panel's native page view must step aside while this covers the window.
  useLayoutEffect(() => {
    if (!open) return;
    notifyNativeSurfaceOcclusionChange();
    return notifyNativeSurfaceOcclusionChange;
  }, [open]);

  const leaveMarkup = useCallback(() => {
    setMarking(false);
    setHistory(EMPTY_MARKUP_HISTORY);
    setConfirmingDiscard(false);
    setTool("pen");
  }, []);

  const hasMarks = history.marks.length > 0;
  /** Close while marking up asks first when there are marks, then returns to the preview. */
  const requestCloseMarkup = useCallback(() => {
    if (saving) return;
    if (hasMarks) setConfirmingDiscard(true);
    else leaveMarkup();
  }, [hasMarks, leaveMarkup, saving]);

  // Every way out (Escape, a click on the dim, close) goes through here.
  const dismiss = useCallback(() => {
    if (!marking) {
      onClose();
      return;
    }
    if (confirmingDiscard) setConfirmingDiscard(false);
    else requestCloseMarkup();
  }, [confirmingDiscard, marking, onClose, requestCloseMarkup]);

  const images = props.images ?? NO_IMAGES;
  const onShowImage = props.onShowImage;
  const imageId = target?.kind === "image" ? target.image.id : null;

  // Escape is taken here, before the composer or a dialog around it can act on it. A menu
  // of the bar or a text mark being typed keeps its own Escape.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const element = event.target instanceof Element ? event.target : null;
      if (event.key === "Escape") {
        if (element?.closest("[data-markup-canvas] textarea")) return;
        if (document.querySelector("[data-markup-toolbar] [data-popup-open]")) return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (marking || !imageId || !onShowImage || images.length <= 1) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const index = images.findIndex((image) => image.id === imageId);
      if (index < 0) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === "ArrowLeft" ? -1 : 1;
      onShowImage(images[(index + step + images.length) % images.length]!.id);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [dismiss, imageId, images, marking, onShowImage, open]);

  const addMark = useCallback((mark: MarkupMark) => {
    setHistory((current) => addMarkupMark(current, mark));
  }, []);

  const save = useCallback(() => {
    if (target?.kind !== "image" || !props.onReplaceImage || !hasMarks || saving) return;
    const image = target.image;
    const marks = history.marks;
    const drawnWidth = frameRef.current?.clientWidth ?? 0;
    const replace = props.onReplaceImage;
    setSaving(true);
    void (async () => {
      try {
        const blob = await composeMarkupPng({ image: image.file, marks, drawnWidth });
        const file = new File([blob], markedName(image.name), { type: "image/png" });
        await replace(image.id, file);
        leaveMarkup();
        onClose();
      } catch {
        toastManager.add({ type: "error", title: t("composer.attachmentPreview.saveFailed") });
      } finally {
        setSaving(false);
      }
    })();
  }, [hasMarks, history.marks, leaveMarkup, onClose, props.onReplaceImage, saving, t, target]);

  const closeButton = (
    <IconButton
      ref={closeButtonRef}
      label={t("composer.attachmentPreview.close")}
      tooltip={t("composer.attachmentPreview.close")}
      tooltipSide="right"
      variant="ghost"
      className={PREVIEW_BUTTON_CLASS_NAME}
      data-attachment-preview-close=""
      onClick={onClose}
    >
      <XIcon />
    </IconButton>
  );

  let body: ReactNode = null;
  if (target?.kind === "image") {
    const { image } = target;
    body = (
      <div ref={frameRef} className={PREVIEW_FRAME_CLASS_NAME} data-attachment-preview-image="">
        <img
          src={image.previewUrl}
          alt={image.name}
          draggable={false}
          className={cn(PREVIEW_IMAGE_CLASS_NAME, "shadow-[0_16px_50px_-12px_rgba(0,0,0,0.6)]")}
        />
        {marking ? (
          <MarkupCanvas
            pageImageUrl={image.previewUrl}
            className="rounded-[5px] bg-transparent"
            tool={tool}
            style={style}
            marks={history.marks}
            onAddMark={addMark}
          />
        ) : (
          <PreviewActions>
            {closeButton}
            {props.onReplaceImage ? (
              <IconButton
                label={t("composer.attachmentPreview.annotate")}
                tooltip={t("composer.attachmentPreview.annotate")}
                tooltipSide="right"
                variant="ghost"
                className={PREVIEW_BUTTON_CLASS_NAME}
                data-attachment-preview-annotate=""
                onClick={() => setMarking(true)}
              >
                <PencilIcon />
              </IconButton>
            ) : null}
          </PreviewActions>
        )}
      </div>
    );
  } else if (target?.kind === "file") {
    const { file } = target;
    body = (
      <div className="relative" data-attachment-preview-file="">
        <div className="flex w-[min(22rem,calc(100vw-6rem))] flex-col items-center gap-3 rounded-dialog border border-[color:var(--color-border-light)] bg-popover px-6 pt-8 pb-7 text-center text-[var(--color-text-foreground)] shadow-[0_16px_50px_-12px_rgba(0,0,0,0.5)]">
          <span className="flex size-14 items-center justify-center rounded-xl bg-[var(--color-background-elevated-secondary)] text-muted-foreground">
            <FileEntryIcon
              pathValue={file.name}
              mimeType={file.mimeType}
              kind="file"
              colorMode="inherit"
              className="size-7"
            />
          </span>
          <p className="line-clamp-3 max-w-full break-all text-ui-lg font-medium leading-snug">
            {file.name}
          </p>
          <p className="text-ui-sm text-muted-foreground">
            <span className="uppercase">{fileAttachmentTypeLabel(file)}</span>
            <span aria-hidden> · </span>
            <span>{formatBytes(file.sizeBytes)}</span>
          </p>
        </div>
        <PreviewActions>{closeButton}</PreviewActions>
      </div>
    );
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-attachment-preview-backdrop=""
          className="fixed inset-0 z-50 bg-black/62.5 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
        />
        <DialogPrimitive.Popup
          initialFocus={marking ? undefined : closeButtonRef}
          data-attachment-preview=""
          data-marking={marking ? "" : undefined}
          className={cn(
            "fixed inset-0 z-50 flex flex-col items-center justify-center p-4 outline-none transition-opacity duration-150 [-webkit-app-region:no-drag] data-ending-style:opacity-0 data-starting-style:opacity-0 md:p-10",
            // Room for the markup bar under the image.
            marking && "pb-24 md:pb-24",
          )}
          onClick={(event) => {
            // A click on the dim around the preview, not on the preview itself.
            if (event.target === event.currentTarget) dismiss();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("composer.attachmentPreview.title")}
          </DialogPrimitive.Title>
          {body}
          {marking && target?.kind === "image" ? (
            // The bar takes only its own clicks and folds to fit a narrow window.
            <div className="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center px-4">
              <MarkupToolbar
                tool={tool}
                onToolChange={setTool}
                canUndo={hasMarks}
                canRedo={history.undone.length > 0}
                hasMarks={hasMarks}
                style={style}
                onStyleChange={setStyle}
                action={{
                  label: t("markup.save"),
                  busyLabel: t("markup.saving"),
                  busy: saving,
                  onClick: save,
                }}
                confirmingDiscard={confirmingDiscard}
                onUndo={() => setHistory((current) => undoMarkupMark(current))}
                onRedo={() => setHistory((current) => redoMarkupMark(current))}
                onClear={() => setHistory(EMPTY_MARKUP_HISTORY)}
                onRequestClose={requestCloseMarkup}
                onCancelDiscard={() => setConfirmingDiscard(false)}
                onDiscard={leaveMarkup}
              />
            </div>
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
