// FILE: UnsupportedFilePreview.tsx
// Purpose: Explicit download fallback for workspace files that Codex can attach
//          but does not render in the in-app preview (archives and other binary
//          formats). Keeping this separate from the text error state makes the
//          limitation actionable and preserves the file's identity.
// Layer: Web chat/editor file-preview component
// Exports: UnsupportedFilePreview

import { basenameOfPath } from "~/file-icons";
import { DownloadIcon, PlusIcon } from "~/lib/icons";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import { cn } from "~/lib/utils";

import { FileEntryIcon } from "./chat/FileEntryIcon";

export function UnsupportedFilePreview(props: {
  filePath: string;
  cwd: string | null | undefined;
  previewGrant?: string | null | undefined;
  cacheKey?: string | number | undefined;
  className?: string | undefined;
  onAttachToChat?: (() => void) | undefined;
}) {
  const fileName = basenameOfPath(props.filePath);
  const downloadUrl = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
    cacheKey: props.cacheKey,
    download: true,
  });

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center overflow-auto p-6",
        props.className,
      )}
      data-file-preview="unsupported"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-3 px-6 py-7 text-center">
        <span className="flex size-16 items-center justify-center rounded-2xl bg-foreground/10">
          <FileEntryIcon pathValue={props.filePath} kind="file" className="size-6" />
        </span>
        <div className="min-w-0 space-y-1">
          <p className="truncate text-base font-medium text-foreground" title={props.filePath}>
            {fileName}
          </p>
          <p className="text-ui-lg text-muted-foreground">Preview not available</p>
          <p className="text-ui-lg text-muted-foreground">
            This file type can be downloaded{props.onAttachToChat ? " or attached to chat" : ""}.
          </p>
        </div>
        {props.onAttachToChat ? (
          <button
            type="button"
            onClick={props.onAttachToChat}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-ui-sm font-medium hover:bg-foreground/8"
          >
            <PlusIcon className="size-4" aria-hidden="true" /> Attach to chat
          </button>
        ) : null}
        <a
          href={downloadUrl}
          download={fileName}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-background-surface)] px-3 py-1.5 text-ui-sm font-medium text-foreground transition-colors hover:bg-foreground/8"
        >
          <DownloadIcon className="size-4" aria-hidden="true" />
          Download file
        </a>
      </div>
    </div>
  );
}
