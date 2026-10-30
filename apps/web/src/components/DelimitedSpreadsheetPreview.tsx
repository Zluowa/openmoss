import { useEffect, useMemo, useRef } from "react";

import { readDelimitedWorkbook, type WorkbookAnnotation } from "~/lib/preview/workbookModel";
import { buildLocalImageUrl } from "~/lib/localImageUrls";

import { WorkbookPreview } from "./preview/WorkbookPreview";

export { parseDelimited } from "~/lib/preview/workbookModel";

export function DelimitedSpreadsheetPreview(props: {
  filePath: string;
  contents: string;
  className?: string | undefined;
  cwd?: string | null | undefined;
  previewGrant?: string | null | undefined;
  onReload?: (() => void) | undefined;
  onPreviewReady?: (() => void) | undefined;
  onPreviewError?: ((error: Error) => void) | undefined;
  onAnnotate?: ((annotation: WorkbookAnnotation) => void) | undefined;
}) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const result = useMemo(() => {
    try {
      return {
        workbook: readDelimitedWorkbook(
          props.contents,
          props.filePath.toLowerCase().endsWith(".tsv") ? "\t" : ",",
        ),
        error: null,
      };
    } catch (error) {
      return {
        workbook: null,
        error: error instanceof Error ? error : new Error("Unable to read spreadsheet."),
      };
    }
  }, [props.contents, props.filePath]);
  useEffect(() => {
    if (result.error) callbacks.current.onPreviewError?.(result.error);
    else callbacks.current.onPreviewReady?.();
  }, [result]);
  if (result.error)
    return (
      <div
        role="alert"
        className="flex flex-1 items-center justify-center p-6 text-ui-lg text-muted-foreground"
      >
        {result.error.message}
      </div>
    );
  const downloadUrl = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
    download: true,
  });
  return (
    <WorkbookPreview
      key={props.filePath}
      workbook={result.workbook!}
      className={props.className}
      onAnnotate={props.onAnnotate}
      filePath={props.filePath}
      cwd={props.cwd}
      downloadUrl={downloadUrl}
      onReload={props.onReload}
    />
  );
}
