export type MossGoogleOAuthPurpose = "login" | "add-account";

const STORAGE_KEY = "moss:google-oauth-purpose:v1";

type StoredGoogleOAuthPurpose = {
  readonly flowId: string;
  readonly purpose: MossGoogleOAuthPurpose;
  readonly expiresAt: string;
};

function isPurpose(value: unknown): value is MossGoogleOAuthPurpose {
  return value === "login" || value === "add-account";
}

/** Persists only opaque flow correlation and navigation intent, never codes or tokens. */
export function recordMossGoogleOAuthPurpose(input: StoredGoogleOAuthPurpose): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(input));
  } catch {
    // Navigation intent is best-effort. Authentication itself remains authoritative on the server.
  }
}

/** Consumes an exact, unexpired flow correlation once. */
export function consumeMossGoogleOAuthPurpose(
  flowId: string,
  now: () => number = Date.now,
): MossGoogleOAuthPurpose | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredGoogleOAuthPurpose>;
    const expiresAt = typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : NaN;
    if (
      typeof parsed.flowId !== "string" ||
      !isPurpose(parsed.purpose) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now()
    ) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (parsed.flowId !== flowId) return null;
    window.localStorage.removeItem(STORAGE_KEY);
    return parsed.purpose;
  } catch {
    return null;
  }
}
