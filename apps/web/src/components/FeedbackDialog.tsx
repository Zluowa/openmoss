// FILE: FeedbackDialog.tsx
// Purpose: Collects categorized Moss feedback, with optional screenshots, and privacy-safe
//          diagnostics.
// Layer: Shared UI component
// Depends on: Feedback delivery logic and the shared dialog primitives.

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { useTranslation } from "../localization";
import {
  acceptFeedbackImages,
  buildFeedbackSubmission,
  FEEDBACK_CATEGORIES,
  FEEDBACK_IMAGE_LIMITS,
  isFeedbackDeliveryConfigured,
  prepareFeedbackAttachments,
  submitFeedback,
  type FeedbackCategory,
  type FeedbackImageRejection,
  type FeedbackThreadContext,
} from "../feedback";
import { cn } from "../lib/utils";
import { ImageIcon, XIcon } from "../lib/icons";
import { DEVS_CONSENT_REQUIRED_MESSAGE } from "@moss/shared/devsReport";
import { readNativeApi } from "../nativeApi";
import {
  buildFeedbackDeveloperRequest,
  submitFeedbackToDevelopers,
} from "../feedbackDeveloperDelivery";
import { requestDevsReportConfirmation } from "./chat/devsReportConfirmStore";
import type { DevsReportSubmitInput } from "@moss/contracts";
import { Button } from "./ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

export interface FeedbackDialogProps {
  open: boolean;
  context: FeedbackThreadContext;
  onOpenChange: (open: boolean) => void;
}

export function FeedbackDialog({ open, context, onOpenChange }: FeedbackDialogProps) {
  const [isSending, setIsSending] = useState(false);
  const { t } = useTranslation();
  const request = useRef<{ key: string; input: DevsReportSubmitInput } | null>(null);

  const handleSubmit = async (
    category: FeedbackCategory | null,
    details: string,
    images: readonly File[],
  ) => {
    setIsSending(true);
    try {
      const attachments = await prepareFeedbackAttachments(images);
      const submission = buildFeedbackSubmission({ category, details, context, attachments });
      let delivery: "queued" | "delivered" = "delivered";
      if (isFeedbackDeliveryConfigured()) {
        await submitFeedback(submission);
      } else {
        const api = readNativeApi();
        if (!api) throw new Error("The Moss developer service is not connected yet.");
        const key = JSON.stringify({ category, details, context });
        if (request.current?.key !== key)
          request.current = {
            key,
            input: buildFeedbackDeveloperRequest(submission, crypto.randomUUID()),
          };
        const result = await submitFeedbackToDevelopers(
          request.current.input,
          api,
          requestDevsReportConfirmation,
        );
        if (result === "cancelled") {
          setIsSending(false);
          return;
        }
        delivery = result;
      }
      request.current = null;
      setIsSending(false);
      onOpenChange(false);
      toastManager.add({
        type: "success",
        title: delivery === "queued" ? t("feedback.queuedTitle") : t("feedback.sentTitle"),
        description: delivery === "queued" ? t("feedback.queuedDetail") : t("feedback.sentDetail"),
      });
    } catch (error) {
      setIsSending(false);
      toastManager.add({
        type: "error",
        title: t("feedback.failedTitle"),
        description:
          error instanceof Error && error.message.includes(DEVS_CONSENT_REQUIRED_MESSAGE)
            ? t("devs.consentRequired")
            : t("devs.sendFailedDetail"),
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSending) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-xl" showCloseButton={!isSending}>
        <DialogHeader className="gap-0 px-5 pt-5 pb-3">
          <DialogTitle className="text-xl tracking-[-0.01em]">{t("feedback.title")}</DialogTitle>
        </DialogHeader>
        {/* The form state lives below DialogPopup, which unmounts its children
            once the close transition ends — every open starts from a blank
            form without a reset effect, and closing never flashes empty. */}
        <FeedbackDialogForm isSending={isSending} onSubmit={handleSubmit} />
      </DialogPopup>
    </Dialog>
  );
}

interface FeedbackImage {
  id: string;
  file: File;
  previewUrl: string;
}

const REJECTION_MESSAGES: Record<FeedbackImageRejection, string> = {
  type: "Only PNG, JPG and WebP images can be added.",
  size: "Each image must be 5 MB or smaller.",
  count: "You can add up to 5 images.",
};

const IMAGE_ACCEPT = FEEDBACK_IMAGE_LIMITS.mimeTypes.join(",");

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function FeedbackDialogForm({
  isSending,
  onSubmit,
}: {
  isSending: boolean;
  onSubmit: (
    category: FeedbackCategory | null,
    details: string,
    images: readonly File[],
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [details, setDetails] = useState("");
  const [images, setImages] = useState<FeedbackImage[]>([]);
  const [rejection, setRejection] = useState<FeedbackImageRejection | null>(null);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const developerService = readNativeApi()?.server;
  const deliveryConfigured =
    isFeedbackDeliveryConfigured() ||
    Boolean(developerService?.prepareDevsReport && developerService.submitDevsReport);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Previews are object URLs; release them when the form goes away.
  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    },
    [],
  );

  const addImages = (files: readonly File[]) => {
    if (files.length === 0 || isSending) return;
    const { accepted, rejected } = acceptFeedbackImages(files, imagesRef.current.length);
    setRejection(rejected[0] ?? null);
    if (accepted.length === 0) return;
    const added = accepted.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    const next = [...imagesRef.current, ...added];
    imagesRef.current = next;
    setImages(next);
  };

  const removeImage = (id: string) => {
    const removed = imagesRef.current.find((image) => image.id === id);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    const next = imagesRef.current.filter((image) => image.id !== id);
    imagesRef.current = next;
    setImages(next);
    setRejection(null);
  };

  const handlePaste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    // Pasted text still goes into the field; only pasted files become attachments.
    event.preventDefault();
    addImages(files);
  };

  const handleDrop = (event: DragEvent) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    addImages(Array.from(event.dataTransfer.files));
  };

  const canSubmit = details.trim().length > 0 && !isSending && deliveryConfigured;
  const canAddImages = !isSending && images.length < FEEDBACK_IMAGE_LIMITS.maxCount;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit(
      category,
      details,
      images.map((image) => image.file),
    );
  };

  return (
    <form
      className={cn(
        "relative flex min-h-0 flex-col gap-3 px-5 pb-5",
        dragging && "[&_[data-slot=textarea]]:border-dashed",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      onPaste={handlePaste}
      onDragOver={(event) => {
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = isSending ? "none" : "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <div className="flex flex-wrap gap-1.5" aria-label={t("feedback.category.aria")}>
        {FEEDBACK_CATEGORIES.map((option) => {
          const selected = category === option.value;
          return (
            <Button
              key={option.value}
              type="button"
              variant={selected ? "secondary" : "outline"}
              size="sm"
              aria-pressed={selected}
              // Reference pills breathe at ~14px per side; the default `sm`
              // padding (10px) crams the label against the pill wall.
              className="rounded-full px-3.5 font-normal"
              disabled={isSending}
              // Keeps the caret (and the field's focus ring) in the details
              // textarea, so picking a category never interrupts typing.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setCategory(selected ? null : option.value)}
            >
              <span aria-hidden="true">{selected ? "−" : "+"}</span>
              {t(`feedback.category.${option.value}`)}
            </Button>
          );
        })}
      </div>

      <Textarea
        ref={textareaRef}
        value={details}
        maxLength={4_800}
        placeholder={t("feedback.details.placeholder")}
        aria-label={t("feedback.details.ariaLabel")}
        disabled={isSending}
        className="[&_[data-slot=textarea]]:min-h-32 [&_[data-slot=textarea]]:resize-y"
        onChange={(event) => setDetails(event.target.value)}
      />

      <div className="flex flex-col gap-2">
        {images.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Attached images">
            {images.map((image) => (
              <li
                key={image.id}
                className="group relative size-14 overflow-hidden rounded-md border border-border bg-muted/40"
              >
                <img
                  src={image.previewUrl}
                  alt={image.file.name}
                  className="size-full object-cover"
                  draggable={false}
                />
                <button
                  type="button"
                  aria-label={`Remove image: ${image.file.name}`}
                  disabled={isSending}
                  className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground opacity-0 shadow-xs transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:hidden"
                  onClick={() => removeImage(image.id)}
                >
                  <XIcon className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="-ml-1.5 font-normal text-muted-foreground"
            disabled={!canAddImages}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImageIcon />
            Add images
          </Button>
          <span className="text-ui-sm text-muted-foreground">
            {dragging
              ? "Drop images to attach them"
              : "Paste, drop or choose up to 5 images (PNG, JPG, WebP, 5 MB each)"}
          </span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          hidden
          aria-label="Choose images"
          onChange={(event) => {
            addImages(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        {rejection ? (
          <p role="status" className="text-ui-sm text-destructive">
            {REJECTION_MESSAGES[rejection]}
          </p>
        ) : null}
      </div>

      <p className="text-ui leading-relaxed text-muted-foreground">
        {isFeedbackDeliveryConfigured()
          ? t("feedback.endpointPrivacy")
          : t("feedback.developerPrivacy")}
      </p>

      {!deliveryConfigured ? (
        <p className="text-ui-sm leading-relaxed text-destructive">{t("feedback.unavailable")}</p>
      ) : null}

      <Button type="submit" className="w-full" disabled={!canSubmit}>
        {isSending ? (
          <>
            <Spinner />
            {t("feedback.sending")}
          </>
        ) : (
          t("feedback.submit")
        )}
      </Button>
    </form>
  );
}
