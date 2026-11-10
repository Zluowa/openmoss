// FILE: pageAppManifest.ts
// Purpose: Read and write the manifest an 应用页 carries in its own HTML
// (`<script type="application/json" id="moss-app-manifest">`), so a page
// saved or promoted from chat keeps its title, description and declared
// capabilities. The server stores the same values in columns; this block is
// what travels with the file.
// Layer: Shared

import { PAGE_APP_MANIFEST_ELEMENT_ID, type PageAppCapabilities } from "@moss/contracts";

export interface PageAppManifest {
  readonly title?: string;
  readonly description?: string;
  readonly capabilities?: PageAppCapabilities;
}

const MANIFEST_RE = new RegExp(
  String.raw`<script\b[^>]*\bid\s*=\s*["']${PAGE_APP_MANIFEST_ELEMENT_ID}["'][^>]*>([\s\S]*?)</script\s*>`,
  "iu",
);
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu;
const DESCRIPTION_RE =
  /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*>/iu;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Manifest values found in the HTML; missing or malformed fields are omitted. */
export function readPageAppManifest(html: string): PageAppManifest {
  const out: { title?: string; description?: string; capabilities?: PageAppCapabilities } = {};
  const block = MANIFEST_RE.exec(html);
  if (block?.[1]) {
    try {
      const parsed = plainRecord(JSON.parse(block[1]));
      if (parsed) {
        if (typeof parsed.title === "string" && parsed.title.trim())
          out.title = parsed.title.trim();
        if (typeof parsed.description === "string") out.description = parsed.description.trim();
        const capabilities = plainRecord(parsed.capabilities);
        if (capabilities) out.capabilities = capabilities;
      }
    } catch {
      // A broken manifest is ignored; the page still runs without capabilities.
    }
  }
  if (!out.title) {
    const title = TITLE_RE.exec(html)?.[1];
    const text = title ? decodeEntities(title).replace(/\s+/gu, " ").trim() : "";
    if (text) out.title = text.slice(0, 256);
  }
  if (out.description === undefined) {
    const description = DESCRIPTION_RE.exec(html)?.[1];
    if (description) out.description = decodeEntities(description).trim().slice(0, 2_000);
  }
  return out;
}

function manifestScript(manifest: PageAppManifest): string {
  // `<` is escaped so the JSON can never close the script element.
  const json = JSON.stringify(
    {
      title: manifest.title,
      description: manifest.description,
      capabilities: manifest.capabilities ?? {},
    },
    null,
    2,
  ).replace(/</gu, "\\u003c");
  return `<script type="application/json" id="${PAGE_APP_MANIFEST_ELEMENT_ID}">\n${json}\n</script>`;
}

/** Writes (or replaces) the manifest block, placing a new one in `<head>`. */
export function writePageAppManifest(html: string, manifest: PageAppManifest): string {
  const script = manifestScript(manifest);
  if (MANIFEST_RE.test(html)) return html.replace(MANIFEST_RE, () => script);
  const headClose = /<\/head\s*>/iu.exec(html);
  if (headClose) {
    return `${html.slice(0, headClose.index)}${script}\n${html.slice(headClose.index)}`;
  }
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}\n${script}${html.slice(at)}`;
  }
  return `${script}\n${html}`;
}
