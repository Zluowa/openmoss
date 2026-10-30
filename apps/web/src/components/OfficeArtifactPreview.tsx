import { DownloadIcon, FileIcon } from "~/lib/icons";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import { basenameOfPath } from "~/file-icons";

/** Artifact-tab scaffold matching Codex's office entry point.
 * The conversion reader is intentionally isolated so docx-preview/XlsxReader/
 * PptxReader can be added without changing workspace dispatch or chrome.
 */
export function OfficeArtifactPreview(props: {
  filePath: string;
  cwd: string | null;
  previewGrant?: string | null;
  cacheKey?: number;
}) {
  const name = basenameOfPath(props.filePath);
  const downloadUrl = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
    cacheKey: props.cacheKey,
    download: true,
  });
  return (
    <div
      className="flex h-full min-h-0 flex-1 items-center justify-center p-6"
      data-artifact-tab="office"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <FileIcon className="size-12 text-muted-foreground" aria-hidden="true" />
        <p className="text-ui-lg font-medium">Unable to render preview</p>
        <p className="text-ui-sm text-muted-foreground">
          Office artifact conversion is not available in this build.
        </p>
        <a
          href={downloadUrl}
          download={name}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-ui-sm font-medium"
        >
          <DownloadIcon className="size-3.5" aria-hidden="true" /> Download file
        </a>
      </div>
    </div>
  );
}
