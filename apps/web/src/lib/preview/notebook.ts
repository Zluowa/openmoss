export type NotebookOutput =
  | { type: "image"; dataUrl: string; outputNumber: number }
  | { type: "html"; html: string }
  | { type: "markdown"; markdown: string }
  | { type: "text" | "stream" | "json"; text: string; summaryMarkdown: string | null }
  | {
      type: "error";
      name: string;
      message: string;
      traceback: string;
      summaryMarkdown: string | null;
    };

export interface NotebookCell {
  cellType: "code" | "markdown" | "raw";
  id: string | null;
  source: string;
  title: string | null;
  descriptionMarkdown: string | null;
  executionCount: number | null;
  outputs: NotebookOutput[];
}

export interface NotebookDocument {
  title: string | null;
  cells: NotebookCell[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  return Array.isArray(value) && value.every((part) => typeof part === "string")
    ? value.join("")
    : null;
}

function metadataLayers(metadata: Record<string, unknown> | null): Record<string, unknown>[] {
  if (metadata === null) return [];
  return ["codex", "codexNotebook", "codex_notebook", "codex-app"]
    .flatMap((key) => (object(metadata[key]) ? [object(metadata[key])!] : []))
    .concat(metadata);
}

function metadataText(
  metadata: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  for (const layer of metadataLayers(metadata)) {
    for (const key of keys) {
      const value = text(layer[key]);
      if (value !== null && value.trim()) return value;
    }
  }
  return null;
}

function outputSummary(metadata: Record<string, unknown> | null, index: number): string | null {
  for (const layer of metadataLayers(metadata)) {
    if (!Array.isArray(layer.outputSummaries)) continue;
    const summary = text(object(layer.outputSummaries[index])?.summaryMarkdown);
    if (summary?.trim()) return summary;
  }
  return null;
}

function parseOutput(
  value: unknown,
  index: number,
  summaryMarkdown: string | null,
): NotebookOutput[] {
  const output = object(value);
  if (output === null) throw new Error("Notebook output must be an object.");
  if (output.output_type === "stream") {
    const source = text(output.text);
    return source === null ? [] : [{ type: "stream", text: source, summaryMarkdown }];
  }
  if (output.output_type === "error") {
    return [
      {
        type: "error",
        name: typeof output.ename === "string" ? output.ename : "Error",
        message: typeof output.evalue === "string" ? output.evalue : "",
        traceback: text(output.traceback) ?? "",
        summaryMarkdown,
      },
    ];
  }
  if (output.output_type !== "display_data" && output.output_type !== "execute_result") return [];
  const data = object(output.data);
  if (data === null) return [];
  for (const mimeType of ["image/png", "image/jpeg", "image/svg+xml"]) {
    const source = text(data[mimeType]);
    if (source === null) continue;
    const dataUrl = source.trimStart().startsWith("data:")
      ? source.trim()
      : mimeType === "image/svg+xml"
        ? `data:${mimeType};charset=utf-8,${encodeURIComponent(source)}`
        : `data:${mimeType};base64,${source.replaceAll(/\s/gu, "")}`;
    return [
      {
        type: "image",
        dataUrl,
        outputNumber: index + 1,
      },
    ];
  }
  const html = text(data["text/html"]);
  if (html?.trim()) return [{ type: "html", html }];
  const markdown = text(data["text/markdown"]);
  if (markdown?.trim()) return [{ type: "markdown", markdown }];
  const plain = text(data["text/plain"]);
  if (plain !== null) return [{ type: "text", text: plain, summaryMarkdown }];
  const json = data["application/json"] ?? data["application/vnd.vega.v5+json"];
  return json === undefined || json === null
    ? []
    : [{ type: "json", text: JSON.stringify(json, null, 2), summaryMarkdown }];
}

export function parseNotebook(contents: string): NotebookDocument {
  const notebook = object(JSON.parse(contents));
  if (notebook === null || !Array.isArray(notebook.cells)) {
    throw new Error("Notebook must be a JSON object with a cells array.");
  }
  const metadata = object(notebook.metadata);
  if (notebook.metadata !== undefined && metadata === null)
    throw new Error("Invalid notebook metadata.");
  return {
    title: typeof metadata?.title === "string" ? metadata.title : null,
    cells: notebook.cells.map((value: unknown): NotebookCell => {
      const cell = object(value);
      if (cell === null || typeof cell.cell_type !== "string")
        throw new Error("Invalid notebook cell.");
      const source = cell.source === undefined ? "" : text(cell.source);
      const cellMetadata = object(cell.metadata);
      if (
        source === null ||
        (cell.metadata !== undefined && cellMetadata === null) ||
        (cell.id !== undefined && typeof cell.id !== "string") ||
        (cell.outputs !== undefined && !Array.isArray(cell.outputs)) ||
        (cell.execution_count !== undefined &&
          cell.execution_count !== null &&
          !Number.isInteger(cell.execution_count))
      ) {
        throw new Error("Invalid notebook cell data.");
      }
      const cellType =
        cell.cell_type === "code" || cell.cell_type === "markdown" ? cell.cell_type : "raw";
      return {
        cellType,
        id: typeof cell.id === "string" ? cell.id : null,
        source,
        title: metadataText(cellMetadata, ["title", "cellTitle", "cell_title"]),
        descriptionMarkdown:
          cellType === "code"
            ? metadataText(cellMetadata, [
                "codeDescriptionMarkdown",
                "code_description_markdown",
                "descriptionMarkdown",
                "description_markdown",
                "description",
              ])
            : null,
        executionCount:
          cellType === "code" && typeof cell.execution_count === "number"
            ? cell.execution_count
            : null,
        outputs:
          cellType === "code" && Array.isArray(cell.outputs)
            ? cell.outputs.flatMap((output: unknown, index: number) =>
                parseOutput(output, index, outputSummary(cellMetadata, index)),
              )
            : [],
      };
    }),
  };
}

function plainMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replace(/^[#>\s]+/u, "")
    .replace(/[*_`~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function notebookCellTitle(cell: NotebookCell, index: number): string {
  if (cell.title?.trim()) return cell.title.trim();
  const heading =
    cell.cellType === "markdown"
      ? cell.source.split(/\r?\n/u).find((line) => /^\s*#{1,6}\s+/u.test(line))
      : cell.cellType === "code"
        ? cell.descriptionMarkdown
        : null;
  const title = heading ? plainMarkdown(heading) : "";
  if (title) return title.length <= 80 ? title : `${title.slice(0, 77).trimEnd()}…`;
  return `${cell.cellType === "code" ? "Code" : cell.cellType === "markdown" ? "Markdown" : "Raw"} cell ${index + 1}`;
}

export function notebookCodeFence(source: string, language: string): string {
  let longest = 0;
  for (const [match] of source.matchAll(/`+/gu)) longest = Math.max(longest, match.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${source}\n${fence}`;
}

/** HTML output is static and isolated: no scripts, same-origin access or network. */
export function notebookHtmlDocument(html: string): string {
  const policy =
    "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data:; form-action 'none'; frame-src 'none'; img-src data: blob:; media-src data: blob:; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="color-scheme" content="light dark"><style>html,body{margin:0;background:transparent;color:CanvasText;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{padding:12px}img,svg,canvas,video{max-width:100%;height:auto}table{border-collapse:collapse}th,td{border:1px solid color-mix(in srgb,CanvasText 18%,transparent);padding:4px 6px}</style></head><body>${html}</body></html>`;
}
