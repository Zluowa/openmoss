// Codex-shaped preview dispatch. Keep this decision in one place so workspace,
// composer and library entries agree on the same rich-preview boundaries.
export type CodexPreviewKind =
  | "image"
  | "pdf"
  | "artifact"
  | "markdown"
  | "html"
  | "text"
  | "unsupported";

export type CodexPreviewEntry = "local" | "attachment" | "library-local" | "library-cloud";

/** Codex embeds HTML in code-preview only up to five million characters. */
export const CODEX_HTML_EMBED_LIMIT = 5_000_000;

export function shouldEmbedCodexHtml(contentsLength: number): boolean {
  return contentsLength <= CODEX_HTML_EMBED_LIMIT;
}

const officeByMime: Record<string, "docx" | "xlsx" | "pptx"> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
};
const artifactExtensions = new Set(["csv", "docx", "pptx", "tsv", "xlsx", "xlsm", "ipynb", "tex"]);
const textExtensions = new Set([
  "c",
  "conf",
  "cpp",
  "css",
  "go",
  "h",
  "hpp",
  "java",
  "js",
  "json",
  "jsonl",
  "jsx",
  "log",
  "py",
  "rb",
  "rs",
  "sh",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

export function codexPreviewKind(fileName: string, mimeType?: string | null): CodexPreviewKind {
  const mime = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (
    mime?.startsWith("image/") ||
    [
      "avif",
      "bmp",
      "gif",
      "heic",
      "heif",
      "ico",
      "jpeg",
      "jpg",
      "png",
      "svg",
      "tiff",
      "webp",
    ].includes(extension)
  )
    return "image";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  if (officeByMime[mime ?? ""] || artifactExtensions.has(extension)) return "artifact";
  if (mime === "text/markdown" || ["md", "mdx", "markdown", "mdown", "mkd"].includes(extension))
    return "markdown";
  if (extension === "html" || extension === "htm" || mime === "text/html") return "html";
  if (
    mime?.startsWith("text/") ||
    textExtensions.has(extension) ||
    ["application/json", "application/javascript", "application/xml", "application/yaml"].includes(
      mime ?? "",
    )
  )
    return "text";
  return "unsupported";
}

/** The current desktop dispatch depends on how the file was opened. */
export function resolveCodexPreviewKind(
  fileName: string,
  entry: CodexPreviewEntry = "local",
  mimeType?: string | null,
): CodexPreviewKind {
  const kind = codexPreviewKind(fileName, mimeType);
  const extension = fileName.toLowerCase().split(".").pop();
  // Ordinary local CSV/TSV use the editable text viewer. Only explicit
  // attachment/artifact and Library entry points prefer the spreadsheet.
  if (entry === "local" && (extension === "csv" || extension === "tsv")) return "text";
  // HTML is not a local artifact type. The cloud Library owns the executable
  // five-million-character preview; opening a local HTML file shows source.
  if (kind === "html" && entry !== "library-cloud") return "text";
  return kind;
}

export function isCodexArtifactPath(fileName: string): boolean {
  return codexPreviewKind(fileName) === "artifact";
}
