export type MossAccountView = "google";

export interface MossAccountRouteSearch {
  readonly accountView?: MossAccountView;
}

/**
 * Keeps the optional account sub-view explicit so a phone session can open the
 * global Google account surface without changing or replacing that session.
 */
export function parseMossAccountRouteSearch(search: unknown): MossAccountRouteSearch {
  if (!search || typeof search !== "object") return {};
  const record = search as Record<string, unknown>;
  return record.accountView === "google" ? { accountView: "google" } : {};
}
