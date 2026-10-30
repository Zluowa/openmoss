import { useEffect, useMemo, useRef, useState } from "react";
import { isLocalAbsolutePath, joinWorkspaceRelativePath } from "@synara/shared/path";

import { basenameOfPath } from "~/file-icons";
import { DownloadIcon, LoaderCircleIcon, TriangleAlertIcon } from "~/lib/icons";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import type { PresentationPreview } from "~/lib/preview/presentationModel";

import { PresentationReader, type PresentationAnnotation } from "./preview/presentationReader";

export interface PptxReaderProps {
  filePath: string;
  cwd: string | null;
  previewGrant?: string | null;
  cacheKey?: string | number;
  onPreviewReady?: () => void;
  onPreviewError?: () => void;
  onAnnotate?: (annotation: PresentationAnnotation) => void;
}

export function PptxReader(props: PptxReaderProps) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "error" } | { status: "ready"; preview: PresentationPreview }
  >({ status: "loading" });
  const callbacks = useRef({ ready: props.onPreviewReady, error: props.onPreviewError });
  callbacks.current = { ready: props.onPreviewReady, error: props.onPreviewError };
  const src = useMemo(
    () =>
      buildLocalImageUrl({
        src: props.filePath,
        cwd: props.cwd ?? undefined,
        grant: props.previewGrant,
        cacheKey: props.cacheKey,
      }),
    [props.cacheKey, props.cwd, props.filePath, props.previewGrant],
  );
  const downloadUrl = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
    download: true,
  });

  useEffect(() => {
    const abort = new AbortController();
    let ownedPreview: PresentationPreview | undefined;
    setState({ status: "loading" });
    void (async () => {
      const response = await fetch(src, { signal: abort.signal });
      if (!response.ok) throw new Error(`Unable to read presentation (${response.status}).`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 40 * 1024 * 1024)
        throw new Error("Presentation exceeds the 40 MiB preview limit.");
      const { readPresentation } = await import("~/lib/preview/presentationModel");
      if (abort.signal.aborted) return;
      const preview = await readPresentation(bytes);
      if (abort.signal.aborted) {
        preview.dispose();
        return;
      }
      ownedPreview = preview;
      setState({ status: "ready", preview });
    })().catch(() => {
      if (abort.signal.aborted) return;
      setState({ status: "error" });
      callbacks.current.error?.();
    });
    return () => {
      abort.abort();
      ownedPreview?.dispose();
    };
  }, [src]);

  if (state.status === "loading") {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center gap-2 text-ui-lg text-muted-foreground"
      >
        <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />
        Loading presentation…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-ui-lg text-muted-foreground"
      >
        <TriangleAlertIcon className="size-5" />
        <p>Unable to preview {basenameOfPath(props.filePath)}.</p>
        <a
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-ui-sm font-medium"
          href={downloadUrl}
          download={basenameOfPath(props.filePath)}
        >
          <DownloadIcon className="size-4" />
          Download file
        </a>
      </div>
    );
  }
  const openInTarget = isLocalAbsolutePath(props.filePath)
    ? props.filePath
    : props.cwd
      ? joinWorkspaceRelativePath(props.cwd, props.filePath)
      : null;
  return (
    <PresentationReader
      key={src}
      preview={state.preview}
      fileName={basenameOfPath(props.filePath)}
      downloadUrl={downloadUrl}
      openInTarget={openInTarget}
      onReady={() => callbacks.current.ready?.()}
      onError={() => callbacks.current.error?.()}
      {...(props.onAnnotate ? { onAnnotate: props.onAnnotate } : {})}
    />
  );
}
