// FILE: browserPanelPreferences.ts
// Purpose: The browser panel's own settings that the main process enforces: the sites
//   local pages may open or load from ("Manage allowed sites…") and how long the
//   panel keeps cookies ("Keep cookies"). Stored as one small JSON file in the
//   desktop data folder.
// Layer: Desktop browser infrastructure

import * as FS from "node:fs";
import * as Path from "node:path";

import type { BrowserCookieRetention, BrowserPanelPreferences } from "@moss/contracts";

const PREFERENCES_FILE_NAME = "browser-panel-preferences.json";
const MAX_ALLOWED_SITES = 200;
export const DEFAULT_BROWSER_COOKIE_RETENTION: BrowserCookieRetention = "keep";

/**
 * The origin a person can allow: `https://example.com` or `http://localhost:5173`.
 * Anything else (other schemes, credentials, bare words) is refused.
 */
export function normalizeAllowedSiteOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    return null;
  }
  if (!url.hostname || !/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i.test(url.hostname)) return null;
  return url.origin;
}

function parsePreferences(raw: unknown): BrowserPanelPreferences {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const allowedSites = Array.isArray(record.allowedSites)
    ? [
        ...new Set(
          record.allowedSites
            .filter((entry): entry is string => typeof entry === "string")
            .map(normalizeAllowedSiteOrigin)
            .filter((entry): entry is string => entry !== null),
        ),
      ].slice(0, MAX_ALLOWED_SITES)
    : [];
  const cookieRetention: BrowserCookieRetention =
    record.cookieRetention === "untilQuit" ? "untilQuit" : DEFAULT_BROWSER_COOKIE_RETENTION;
  return { allowedSites, cookieRetention };
}

export class BrowserPanelPreferenceStore {
  private current: BrowserPanelPreferences;
  private readonly filePath: string;

  constructor(baseDir: string) {
    this.filePath = Path.join(baseDir, PREFERENCES_FILE_NAME);
    this.current = this.readFromDisk();
  }

  private readFromDisk(): BrowserPanelPreferences {
    try {
      return parsePreferences(JSON.parse(FS.readFileSync(this.filePath, "utf8")));
    } catch {
      return parsePreferences(null);
    }
  }

  private persist(): void {
    try {
      FS.mkdirSync(Path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      FS.writeFileSync(temporary, `${JSON.stringify(this.current, null, 2)}\n`, "utf8");
      FS.renameSync(temporary, this.filePath);
    } catch {
      // A failed write keeps the in-memory value for this run; the next change retries.
    }
  }

  get(): BrowserPanelPreferences {
    return { ...this.current, allowedSites: [...this.current.allowedSites] };
  }

  allowedSites(): readonly string[] {
    return this.current.allowedSites;
  }

  isAllowedSite(url: string): boolean {
    const origin = normalizeAllowedSiteOrigin(url);
    return origin !== null && this.current.allowedSites.includes(origin);
  }

  addAllowedSite(value: string): BrowserPanelPreferences {
    const origin = normalizeAllowedSiteOrigin(value);
    if (!origin) throw new Error("Enter a web address such as https://example.com.");
    if (!this.current.allowedSites.includes(origin)) {
      this.current = {
        ...this.current,
        allowedSites: [...this.current.allowedSites, origin].slice(-MAX_ALLOWED_SITES),
      };
      this.persist();
    }
    return this.get();
  }

  removeAllowedSite(value: string): BrowserPanelPreferences {
    const origin = normalizeAllowedSiteOrigin(value) ?? value;
    if (this.current.allowedSites.includes(origin)) {
      this.current = {
        ...this.current,
        allowedSites: this.current.allowedSites.filter((entry) => entry !== origin),
      };
      this.persist();
    }
    return this.get();
  }

  setCookieRetention(value: BrowserCookieRetention): BrowserPanelPreferences {
    const next: BrowserCookieRetention = value === "untilQuit" ? "untilQuit" : "keep";
    if (next !== this.current.cookieRetention) {
      this.current = { ...this.current, cookieRetention: next };
      this.persist();
    }
    return this.get();
  }
}
