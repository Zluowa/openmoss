// FILE: pageAppManifest.ts
// Purpose: Read and write the manifest an 应用页 carries in its own HTML
// (`<script type="application/json" id="moss-app-manifest">`), so a page
// saved or promoted from chat keeps its title, description, declared
// capabilities, and desktop permissions.
// Layer: Shared

import {
  DesktopPageAppWindowOptions,
  filterDeclaredDesktopPermissions,
  PAGE_APP_MANIFEST_ELEMENT_ID,
  PAGE_APP_MANIFEST_MAX_JSON_CHARS,
  type PageAppCapabilities,
  type PageAppDesktopManifestConfig,
  type PageAppDesktopPermission,
} from "@moss/contracts";
import { Schema } from "effect";

export interface PageAppManifest {
  readonly title?: string;
  readonly description?: string;
  readonly capabilities?: PageAppCapabilities;
  readonly desktop?: PageAppDesktopManifestConfig;
  readonly permissions?: readonly PageAppDesktopPermission[];
}

const MANIFEST_RE = new RegExp(
  String.raw`<script\b[^>]*\bid\s*=\s*["']${PAGE_APP_MANIFEST_ELEMENT_ID}["'][^>]*>([\s\S]*?)</script\s*>`,
  "iu",
);
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu;
const DESCRIPTION_RE =
  /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*>/iu;

const decodeWindowOptions = Schema.decodeUnknownExit(DesktopPageAppWindowOptions);

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

/**
 * Validates and normalizes a `desktop` manifest configuration block.
 * Permissions are capped at 32 items (each <= 64 chars) and filtered against
 * the 5-item whitelist.
 */
export function parsePageAppDesktopConfig(value: unknown): PageAppDesktopManifestConfig | null {
  const record = plainRecord(value);
  if (!record) return null;
  const out: {
    permissions?: PageAppDesktopPermission[];
    window?: DesktopPageAppWindowOptions;
  } = {};
  if (record.permissions !== undefined) {
    out.permissions = filterDeclaredDesktopPermissions(record.permissions);
  }
  if (record.window !== undefined) {
    const decodedWindow = decodeWindowOptions(record.window);
    if (decodedWindow._tag === "Success") {
      out.window = decodedWindow.value;
    }
  }
  return out;
}

/** Manifest values found in the HTML; missing, oversized, or malformed fields are omitted. */
export function readPageAppManifest(html: string): PageAppManifest {
  const out: {
    title?: string;
    description?: string;
    capabilities?: PageAppCapabilities;
    desktop?: PageAppDesktopManifestConfig;
    permissions?: PageAppDesktopPermission[];
  } = {};
  const block = MANIFEST_RE.exec(html);
  if (block?.[1] && block[1].length <= PAGE_APP_MANIFEST_MAX_JSON_CHARS) {
    try {
      const parsed = plainRecord(JSON.parse(block[1]));
      if (parsed) {
        if (typeof parsed.title === "string" && parsed.title.trim()) {
          out.title = parsed.title.trim();
        }
        if (typeof parsed.description === "string") {
          out.description = parsed.description.trim();
        }
        const capabilities = plainRecord(parsed.capabilities);
        if (capabilities) {
          const normalizedCapabilities: Record<string, unknown> = { ...capabilities };
          if ("desktop" in capabilities) {
            const desktopConfig = parsePageAppDesktopConfig(capabilities.desktop) ?? {};
            normalizedCapabilities.desktop = desktopConfig;
            out.desktop = desktopConfig;
            if (desktopConfig.permissions !== undefined) {
              out.permissions = [...desktopConfig.permissions];
            }
          }
          out.capabilities = normalizedCapabilities;
        }
        if (parsed.desktop !== undefined) {
          const topDesktop = parsePageAppDesktopConfig(parsed.desktop);
          if (topDesktop) {
            out.desktop = { ...out.desktop, ...topDesktop };
            if (topDesktop.permissions !== undefined) {
              out.permissions = [...topDesktop.permissions];
            }
          }
        }
        if (parsed.permissions !== undefined) {
          const topPermissions = filterDeclaredDesktopPermissions(parsed.permissions);
          out.permissions = topPermissions;
          out.desktop = { ...out.desktop, permissions: topPermissions };
        }
      }
    } catch {
      // A broken or oversized manifest is ignored; the page still runs without capabilities.
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

/**
 * Extracts deduplicated, whitelisted desktop permissions from HTML or an
 * already-parsed `PageAppManifest`.
 */
export function readPageAppDesktopPermissions(
  source: string | PageAppManifest,
): PageAppDesktopPermission[] {
  const manifest = typeof source === "string" ? readPageAppManifest(source) : source;
  const seen = new Set<PageAppDesktopPermission>();
  const ordered: PageAppDesktopPermission[] = [];
  const add = (list: unknown) => {
    for (const permission of filterDeclaredDesktopPermissions(list)) {
      if (seen.has(permission)) continue;
      seen.add(permission);
      ordered.push(permission);
    }
  };
  const capDesktop = plainRecord(manifest.capabilities?.desktop);
  if (capDesktop?.permissions !== undefined) add(capDesktop.permissions);
  if (manifest.desktop?.permissions !== undefined) add(manifest.desktop.permissions);
  if (manifest.permissions !== undefined) add(manifest.permissions);
  return ordered;
}

function manifestScript(manifest: PageAppManifest): string {
  const payload: Record<string, unknown> = {
    ...(manifest.title !== undefined ? { title: manifest.title } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    capabilities: manifest.capabilities ?? {},
  };
  if (manifest.desktop !== undefined) {
    payload.desktop = parsePageAppDesktopConfig(manifest.desktop) ?? {};
  }
  if (manifest.permissions !== undefined) {
    payload.permissions = filterDeclaredDesktopPermissions(manifest.permissions);
  }
  // `<` is escaped so the JSON can never close the script element.
  const json = JSON.stringify(payload, null, 2).replace(/</gu, "\\u003c");
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
