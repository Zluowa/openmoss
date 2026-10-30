export type ChromeHistoryWindowMode = "normal" | "incognito";

export interface ChromeHistoryAdapterPayload {
  readonly mode: unknown;
  readonly url: unknown;
  readonly title: unknown;
}

export interface ChromeHistoryAdapterObservation {
  readonly mode: ChromeHistoryWindowMode;
  readonly url: string;
  readonly title: string;
  readonly privateBrowsing: boolean;
}

/**
 * Parse the locale-independent values returned by Chrome's scripting
 * dictionary. The mode is an enum, never a localized title heuristic.
 */
export function parseChromeHistoryAdapterPayload(
  payload: ChromeHistoryAdapterPayload,
): ChromeHistoryAdapterObservation | null {
  if (payload.mode !== "normal" && payload.mode !== "incognito") return null;
  if (typeof payload.url !== "string" || payload.url.trim() === "") return null;
  if (typeof payload.title !== "string" || payload.title.trim() === "") return null;
  return {
    mode: payload.mode,
    url: payload.url,
    title: payload.title,
    privateBrowsing: payload.mode === "incognito",
  };
}
