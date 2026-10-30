// FILE: browserDownload.ts
// Purpose: Browser-side file download helpers that keep failed downloads inside the app.
// Layer: Web utility
// Exports: downloadBlob, downloadUrlAsBlob
// Depends on: DOM anchor downloads and Fetch.

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename.trim() || "download";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

const MAX_ERROR_DETAIL_CHARS = 300;

// Routes like /api/thread-export return a human-readable reason in the body
// (e.g. 409 while a turn is running); surface it instead of the bare status.
async function downloadResponseError(response: Response): Promise<Error> {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  let detail = "";
  try {
    detail = (await response.text()).trim();
  } catch {
    detail = "";
  }
  const suffix = detail.length > 0 && detail.length <= MAX_ERROR_DETAIL_CHARS ? ` ${detail}` : "";
  return new Error(`Download failed with HTTP ${response.status}${statusText}.${suffix}`);
}

function filenameFromContentDisposition(headerValue: string | null): string | null {
  if (!headerValue) return null;

  const match = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(headerValue);
  const filename = (match?.[1] ?? match?.[2] ?? "").trim();
  return filename.length > 0 ? filename : null;
}

function preferredDownloadFilename(requested: string, serverFilename: string | null): string {
  let filename = requested
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/[. ]+$/u, "");
  if (!filename) return serverFilename ?? "download";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(filename)) filename = `_${filename}`;
  // Display-only names can omit an extension; retain the original file's type.
  if (filename.lastIndexOf(".") <= 0) {
    filename += /\.[a-z0-9]{1,16}$/iu.exec(serverFilename ?? "")?.[0] ?? "";
  }
  return filename;
}

// Fetches a local artifact before saving it so server 404/auth errors cannot
// navigate the main Electron renderer away from the app.
export async function downloadUrlAsBlob(input: {
  readonly url: string;
  readonly filename: string;
  /** Explicit display-name overrides, such as a user rename in the Library. */
  readonly preferFilename?: boolean | undefined;
  readonly credentials?: RequestCredentials | undefined;
  readonly isCurrent?: (() => boolean) | undefined;
}): Promise<void> {
  const response = await (input.credentials
    ? fetch(input.url, { credentials: input.credentials })
    : fetch(input.url));
  if (!response.ok) {
    throw await downloadResponseError(response);
  }
  const filename = filenameFromContentDisposition(response.headers.get("Content-Disposition"));
  const blob = await response.blob();
  if (input.isCurrent && !input.isCurrent()) return;
  downloadBlob(
    blob,
    input.preferFilename
      ? preferredDownloadFilename(input.filename, filename)
      : (filename ?? input.filename),
  );
}
