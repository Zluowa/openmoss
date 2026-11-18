// FILE: mossDownloadSources.ts
// Purpose: Where Moss downloads its own files from (update feeds, preview builds, first-run
//          runtimes, plugin catalog packages). Two sources serve the same files under the same
//          paths: Tencent COS on its default domain (fast in mainland China, no filing needed) and
//          Cloudflare R2 (reachable everywhere, slower and less steady from the mainland). The
//          mainland lanes try COS first; everyone else tries R2 first; each keeps the other behind
//          it. A source only carries bytes: update manifests stay signed with the release key and
//          packages stay pinned by sha256, so trust never depends on which source answered.
// Layer: Shared runtime policy (no I/O).
// Exports: MOSS_DOWNLOAD_SOURCES, MossDownloadSourceOrder, mossDownloadSourceOrder,
//          mossDownloadSourceUrls

import { MOSS_MAINLAND_CHINA_TIME_ZONES } from "./mossDownloadChannel";
import { MOSS_ACCESS_LANE_SPECS, type MossAccessLane } from "./mossRealmCatalog";

/**
 * Tencent COS default domain. Anonymous GET only: HEAD is answered 403, one byte range per request
 * works, multi-range does not, listing is refused.
 */
const COS_SOURCE = "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/";
/** Cloudflare R2 behind Moss's own domain. */
const R2_SOURCE = "https://update.mossbotai.com/";

export type MossDownloadSourceOrder = "cn" | "global";

/** Base URLs (each ending in `/`), most preferred first. */
export const MOSS_DOWNLOAD_SOURCES: Readonly<
  Record<MossDownloadSourceOrder, ReadonlyArray<string>>
> = Object.freeze({
  cn: Object.freeze([COS_SOURCE, R2_SOURCE]),
  global: Object.freeze([R2_SOURCE, COS_SOURCE]),
});

function isMainlandChinaLocale(locale: string | undefined): boolean {
  if (!locale?.trim()) return false;
  try {
    const parsed = new Intl.Locale(locale.trim().replaceAll("_", "-"));
    return parsed.language === "zh" && parsed.region === "CN";
  } catch {
    return false;
  }
}

/**
 * The account's lane decides when there is one: a lane whose realm is the mainland (phone and
 * enterprise key) gets "cn", Google gets "global". Without an account, a zh-CN locale or a
 * mainland time zone means "cn".
 */
export function mossDownloadSourceOrder(input: {
  readonly lane: MossAccessLane | null;
  readonly locale?: string;
  readonly timeZone?: string;
}): MossDownloadSourceOrder {
  if (input.lane) return MOSS_ACCESS_LANE_SPECS[input.lane].realm === "cn" ? "cn" : "global";
  if (isMainlandChinaLocale(input.locale)) return "cn";
  if (input.timeZone && MOSS_MAINLAND_CHINA_TIME_ZONES.has(input.timeZone.trim())) return "cn";
  return "global";
}

function assertRelativeSourcePath(path: string): void {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(path) || path.startsWith("/") || path.startsWith("\\")) {
    throw new Error(`Download path must be relative: ${path}`);
  }
  if (path.includes("?") || path.includes("#")) {
    throw new Error(`Download path must not carry a query or a fragment: ${path}`);
  }
  if (path.includes("\\")) {
    throw new Error(`Download path must use forward slashes: ${path}`);
  }
  for (const segment of path.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`Download path is not valid: ${path}`);
    }
    if (decoded === "." || decoded === "..") {
      throw new Error(`Download path must not contain "." or ".." segments: ${path}`);
    }
  }
}

/** The absolute URLs of one relative path (for example `desktop/latest.yml`) on every source, in order. */
export function mossDownloadSourceUrls(
  order: MossDownloadSourceOrder,
  path: string,
): ReadonlyArray<string> {
  assertRelativeSourcePath(path);
  return MOSS_DOWNLOAD_SOURCES[order].map((base) => {
    const url = new URL(path, base).toString();
    if (!url.startsWith(base)) throw new Error(`Download path leaves its source: ${path}`);
    return url;
  });
}
