import { useTranslation } from "~/localization";
// FILE: FileAttachmentChip.tsx
// Purpose: Renders generic file attachments as compact pills or composer cards.
// Layer: Chat attachment presentation
// Depends on: shared byte formatting, chat attachment types, and compact chip styles.

import { formatBytes } from "@moss/shared/formatBytes";

import { basenameOfPath } from "~/file-icons";
import { FileIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type ChatFileAttachment } from "../../types";
import { COMPOSER_ATTACHMENT_CHIP_CLASS_NAME } from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AttachmentCard } from "./AttachmentCard";
import { AttachmentRemoveButton } from "./AttachmentRemoveButton";
import {
  DRAFT_ATTACHMENT_WARNING_DESCRIPTION,
  DraftAttachmentWarningIcon,
} from "./DraftAttachmentWarning";
import { FileEntryIcon } from "./FileEntryIcon";

type FileAttachmentChipVariant = "pill" | "card";

const MIME_TYPE_LABEL_BY_TYPE: Record<string, string> = {
  "application/gzip": "GZ",
  "application/json": "JSON",
  "application/msword": "DOC",
  "application/pdf": "PDF",
  "application/rtf": "RTF",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.ms-powerpoint": "PPT",
  "application/vnd.ms-word": "DOC",
  "application/vnd.oasis.opendocument.presentation": "ODP",
  "application/vnd.oasis.opendocument.spreadsheet": "ODS",
  "application/vnd.oasis.opendocument.text": "ODT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/x-7z-compressed": "7Z",
  "application/x-tar": "TAR",
  "application/xml": "XML",
  "application/zip": "ZIP",
  "audio/mpeg": "MP3",
  "image/jpeg": "JPG",
  "text/calendar": "ICS",
  "text/csv": "CSV",
  "text/html": "HTML",
  "text/markdown": "MD",
  "text/plain": "TXT",
  "text/tab-separated-values": "TSV",
  "text/xml": "XML",
};

interface FileAttachmentChipProps {
  file: ChatFileAttachment;
  onRemove?: ((fileId: string) => void) | undefined;
  className?: string;
  nonPersisted?: boolean;
  variant?: FileAttachmentChipVariant;
  /** Opens the file's preview when the card is clicked (composer cards only). */
  onOpen?: ((file: ChatFileAttachment) => void) | undefined;
}

// Builds the short sub-label shown on composer cards, preferring precise
// extensions before MIME fallbacks so long vendor MIME strings never leak into UI.
export function fileAttachmentTypeLabel(file: ChatFileAttachment): string {
  const basename = basenameOfPath(file.name).trim();
  const extensionStart = basename.startsWith(".") ? -1 : basename.indexOf(".");
  if (extensionStart > 0 && extensionStart < basename.length - 1) {
    const compoundExtension = basename.slice(extensionStart + 1).toUpperCase();
    // Only short clean parts read as one type (TAR.GZ); "Moss-1.0.4-notes.pdf" is a PDF.
    if (
      compoundExtension.length <= 12 &&
      /^[A-Z0-9]{1,5}(\.[A-Z0-9]{1,5})*$/.test(compoundExtension)
    ) {
      return compoundExtension;
    }

    const finalExtension = compoundExtension.split(".").pop();
    if (finalExtension) {
      return finalExtension;
    }
  }

  const mimeType = file.mimeType.trim().toLowerCase();
  const mappedMimeType = MIME_TYPE_LABEL_BY_TYPE[mimeType];
  if (mappedMimeType) {
    return mappedMimeType;
  }

  const mimeSubtype = mimeType.split("/")[1]?.trim();
  if (mimeSubtype && mimeSubtype !== "octet-stream") {
    const fallback = mimeSubtype
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .toUpperCase();
    if (fallback.length > 0 && fallback.length <= 12) {
      return fallback;
    }
  }

  return "FILE";
}

function fileAttachmentDetail(file: ChatFileAttachment): string {
  const mimeType = file.mimeType.trim() || "Unknown type";
  return `${mimeType} - ${formatBytes(file.sizeBytes)}`;
}

function FileAttachmentPillTrigger({
  file,
  onRemove,
  className,
  nonPersisted,
}: {
  file: ChatFileAttachment;
  onRemove?: ((fileId: string) => void) | undefined;
  className?: string | undefined;
  nonPersisted: boolean;
}) {
  const { format } = useTranslation();
  return (
    <span
      className={cn(
        "group relative",
        COMPOSER_ATTACHMENT_CHIP_CLASS_NAME,
        onRemove ? "pr-6" : "",
        className,
      )}
    >
      <span className="inline-flex h-7 min-w-0 max-w-[16rem] items-center gap-1.5 rounded-full pl-2 pr-2">
        <FileIcon className="size-4 shrink-0 text-muted-foreground/90" />
        <span className="min-w-0 truncate">{file.name}</span>
        <span className="shrink-0 text-muted-foreground/70">{formatBytes(file.sizeBytes)}</span>
        {nonPersisted ? <DraftAttachmentWarningIcon /> : null}
      </span>
      {onRemove ? (
        <AttachmentRemoveButton
          size="sm"
          placement="center-right"
          label={format("attachments.remove", { name: file.name })}
          onRemove={() => onRemove(file.id)}
        />
      ) : null}
    </span>
  );
}

export function FileAttachmentChip({
  file,
  onRemove,
  className,
  nonPersisted: nonPersistedProp,
  variant: variantProp,
  onOpen,
}: FileAttachmentChipProps) {
  const { format } = useTranslation();
  const nonPersisted = nonPersistedProp ?? false;
  const variant = variantProp ?? "pill";
  const detail = fileAttachmentDetail(file);
  const typeLabel = fileAttachmentTypeLabel(file);
  const trigger =
    variant === "card" ? (
      <AttachmentCard
        className={className}
        icon={
          <FileEntryIcon
            pathValue={file.name}
            mimeType={file.mimeType}
            kind="file"
            // Attachment cards keep a calm, uniform glyph: the shared icon tint,
            // not the per-type colors used in the diff/editor file lists.
            colorMode="inherit"
            className="size-5"
          />
        }
        title={file.name}
        subtitle={
          <>
            <span className="truncate uppercase">{typeLabel}</span>
            {nonPersisted ? <DraftAttachmentWarningIcon /> : null}
          </>
        }
        onRemove={onRemove ? () => onRemove(file.id) : undefined}
        removeLabel={format("attachments.remove", { name: file.name })}
        {...(onOpen
          ? {
              role: "button",
              tabIndex: 0,
              "aria-label": format("attachments.preview", { name: file.name }),
              "data-attachment-open": "",
              className: cn(
                "cursor-pointer transition-colors hover:border-[color:var(--color-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                className,
              ),
              onClick: (event: React.MouseEvent<HTMLSpanElement>) => {
                // The remove button inside the card is not a click on the card.
                if (event.target instanceof Element && event.target.closest("button")) return;
                onOpen(file);
              },
              onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>) => {
                if (event.target !== event.currentTarget) return;
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onOpen(file);
              },
            }
          : {})}
      />
    ) : (
      <FileAttachmentPillTrigger
        file={file}
        onRemove={onRemove}
        className={className}
        nonPersisted={nonPersisted}
      />
    );

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
        <div className="space-y-1">
          <p className="text-ui leading-snug font-medium text-foreground">{file.name}</p>
          <p className="text-ui-sm text-muted-foreground">{detail}</p>
          {nonPersisted ? (
            <p className="text-ui-sm text-amber-600">{DRAFT_ATTACHMENT_WARNING_DESCRIPTION}</p>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
