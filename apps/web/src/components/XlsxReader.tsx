import { useEffect, useMemo, useRef, useState } from "react";

import { basenameOfPath } from "~/file-icons";
import { DownloadIcon, TriangleAlertIcon } from "~/lib/icons";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import type { PreviewWorkbook, WorkbookAnnotation } from "~/lib/preview/workbookModel";

import { WorkbookPreview } from "./preview/WorkbookPreview";

type Props = {
  filePath: string;
  cwd: string | null;
  previewGrant?: string | null;
  cacheKey?: string | number;
  onPreviewReady?: (() => void) | undefined;
  onPreviewError?: ((error: Error) => void) | undefined;
  onAnnotate?: ((annotation: WorkbookAnnotation) => void) | undefined;
  onReload?: (() => void) | undefined;
};
type State =
  | { status: "loading" }
  | { status: "ready"; workbook: PreviewWorkbook }
  | { status: "error"; error: string };

export function XlsxReader(props: Props) {
  const [state, setState] = useState<State>({ status: "loading" });
  const callbacks = useRef(props);
  callbacks.current = props;
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
    setState({ status: "loading" });
    void (async () => {
      const response = await fetch(src, { signal: abort.signal });
      if (!response.ok) throw new Error(`Unable to read spreadsheet (${response.status}).`);
      const bytes = await response.arrayBuffer();
      if (abort.signal.aborted) return;
      const { readXlsxWorkbook } = await import("~/lib/preview/workbookXlsx");
      const workbook = await readXlsxWorkbook(bytes);
      if (abort.signal.aborted) return;
      setState({ status: "ready", workbook });
      callbacks.current.onPreviewReady?.();
    })().catch((error: unknown) => {
      if (abort.signal.aborted) return;
      const failure = error instanceof Error ? error : new Error("Unable to render spreadsheet.");
      setState({ status: "error", error: failure.message });
      callbacks.current.onPreviewError?.(failure);
    });
    return () => abort.abort();
  }, [src]);
  if (state.status === "loading")
    return (
      <div
        role="status"
        className="flex flex-1 items-center justify-center text-ui-lg text-muted-foreground"
      >
        Loading spreadsheet…
      </div>
    );
  if (state.status === "error")
    return (
      <div
        role="alert"
        className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-ui-lg text-muted-foreground"
      >
        <TriangleAlertIcon className="size-5" />
        <p>Unable to render {basenameOfPath(props.filePath)}.</p>
        <p className="max-w-md text-ui-sm">{state.error}</p>
        <a
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-ui-sm font-medium"
          href={downloadUrl}
          download={basenameOfPath(props.filePath)}
        >
          <DownloadIcon className="size-3.5" /> Download file
        </a>
      </div>
    );
  return (
    <WorkbookPreview
      key={src}
      workbook={state.workbook}
      onAnnotate={props.onAnnotate}
      filePath={props.filePath}
      cwd={props.cwd}
      downloadUrl={downloadUrl}
      onReload={props.onReload}
    />
  );
}
