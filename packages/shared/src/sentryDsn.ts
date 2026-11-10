// FILE: sentryDsn.ts
// Purpose: Validates a Sentry DSN.
// Layer: Shared runtime configuration
// Depends on: Web URL parsing only. Release scripts load this directly in Node, so it imports nothing.

/**
 * Sentry DSNs contain a public project key in URL user-info, so that field is
 * deliberately allowed. Passwords, query strings and fragments are not valid
 * for Moss and would make accidental secret/data exfiltration easier.
 */
export function normalizeSentryDsn(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.includes("\u0000")) return undefined;

  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith("/")
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
