import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";
import type { HtmlPreviewDescriptor } from "@synara/contracts";
import { LocalHtmlPreviewRegistry, LOCAL_HTML_PREVIEW_SCHEME } from "../localHtmlPreviewProtocol";

export const HTML_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
export const HTML_PREVIEW_PARTITION_PREFIX = "moss-html-preview-";

/** This CSP belongs to the guest, independently of the application's script policy. */
export const HTML_PREVIEW_CSP = [
  "default-src 'self' data: blob: https:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:",
  "style-src 'self' 'unsafe-inline' https:",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
].join("; ");

export const HTML_PREVIEW_HEADERS = {
  "Content-Security-Policy": HTML_PREVIEW_CSP,
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Local services and application protocols are never guest resources. */
export function isAllowedHtmlPreviewRequest(value: string, src: string): boolean {
  try {
    const url = new URL(value);
    const source = new URL(src);
    if (url.username || url.password) return false;
    if (url.protocol === `${LOCAL_HTML_PREVIEW_SCHEME}:`) {
      return url.host === source.host;
    }
    if (url.protocol === "data:" || url.protocol === "blob:") return true;
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.includes(":")
    )
      return false;
    const parts = host.split(".").map(Number);
    if (parts.length === 4 && parts.every(Number.isInteger)) {
      const [a = 0, b = 0] = parts;
      if (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class HtmlPreviewDocument {
  private disposed = false;

  private constructor(
    readonly descriptor: HtmlPreviewDescriptor,
    private html: string,
    private readonly files: LocalHtmlPreviewRegistry,
  ) {}

  static async create(input: unknown): Promise<HtmlPreviewDocument> {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid HTML preview request.");
    const value = input as Record<string, unknown>;
    if (
      typeof value.html !== "string" ||
      Buffer.byteLength(value.html, "utf8") > HTML_PREVIEW_MAX_BYTES
    ) {
      throw new Error("HTML previews support documents up to 5 MiB.");
    }
    const id = Crypto.randomBytes(24).toString("hex");
    const files = new LocalHtmlPreviewRegistry(() => id);
    let src = `${LOCAL_HTML_PREVIEW_SCHEME}://${id}/index.html`;
    if (value.filePath !== undefined) {
      if (
        typeof value.filePath !== "string" ||
        !Path.isAbsolute(value.filePath) ||
        value.filePath.includes("\0")
      ) {
        throw new Error("HTML preview requires an absolute source path.");
      }
      // Resolve the source before issuing authority, then confine all assets to
      // that real directory. A source symlink cannot grant its lexical parent.
      const realPath = await FS.realpath(value.filePath);
      if (!(await FS.stat(realPath)).isFile())
        throw new Error("HTML preview source is not a file.");
      src = files.toRuntimeUrl(pathToFileURL(realPath).href);
    }
    return new HtmlPreviewDocument(
      { id, partition: `${HTML_PREVIEW_PARTITION_PREFIX}${id}`, src },
      value.html,
      files,
    );
  }

  async respond(
    request: Request,
    fetchFile: (url: string) => Promise<Response>,
  ): Promise<Response> {
    const error = (status: number) => new Response(null, { status, headers: HTML_PREVIEW_HEADERS });
    if (this.disposed) return error(410);
    if (request.method !== "GET" && request.method !== "HEAD") return error(405);
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return error(404);
    }
    const source = new URL(this.descriptor.src);
    if (
      url.protocol !== source.protocol ||
      url.host !== source.host ||
      url.username ||
      url.password
    )
      return error(404);
    if (url.pathname === source.pathname) {
      return new Response(request.method === "HEAD" ? null : this.html, {
        headers: { ...HTML_PREVIEW_HEADERS, "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const fileUrl = await this.files.resolveRequestFileUrl(url.href);
    if (this.disposed) return error(410);
    if (!fileUrl) return error(404);
    try {
      const result = await fetchFile(fileUrl);
      if (this.disposed) {
        await result.body?.cancel();
        return error(410);
      }
      const headers = new Headers(result.headers);
      for (const [name, value] of Object.entries(HTML_PREVIEW_HEADERS)) headers.set(name, value);
      // file:// MIME inference differs between Electron versions. These common
      // module and stylesheet types must be explicit with nosniff enabled.
      const extension = Path.extname(new URL(fileUrl).pathname).toLowerCase();
      const type =
        extension === ".js" || extension === ".mjs"
          ? "text/javascript"
          : extension === ".css"
            ? "text/css"
            : extension === ".json"
              ? "application/json"
              : extension === ".svg"
                ? "image/svg+xml"
                : undefined;
      if (type) headers.set("Content-Type", type);
      if (request.method === "HEAD") await result.body?.cancel();
      return new Response(request.method === "HEAD" ? null : result.body, {
        status: result.status,
        headers,
      });
    } catch {
      return error(404);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.html = "";
    this.files.clear();
  }
}
