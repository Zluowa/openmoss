const SUPABASE_PROJECT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co$/u;
const OPAQUE_FLOW_ID = /^[A-Za-z0-9._~-]{32,512}$/u;
const PKCE_CHALLENGE = /^[A-Za-z0-9._~-]{43,128}$/u;

function singleSearchValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function configuredSupabaseOrigin(rawUrl: string | undefined): string | null {
  if (!rawUrl || rawUrl !== rawUrl.trim() || rawUrl.length > 2_048) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      !SUPABASE_PROJECT_HOST.test(url.hostname) ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isMossGoogleOAuthRedirect(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const flowId = singleSearchValue(url, "flow_id");
    return (
      url.protocol === "moss:" &&
      url.hostname === "auth" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/callback" &&
      url.hash === "" &&
      [...url.searchParams.keys()].every((name) => name === "flow_id") &&
      OPAQUE_FLOW_ID.test(flowId ?? "")
    );
  } catch {
    return false;
  }
}

/**
 * Identifies only the flow-bound Supabase Google URL issued by Moss. The
 * desktop uses this as a narrow signal to refresh its `moss:` callback
 * registration immediately before handing the authorization URL to the OS.
 */
export function isMossGoogleOAuthExternalUrl(
  rawUrl: string,
  configuredAuthUrl: string | undefined,
): boolean {
  const expectedOrigin = configuredSupabaseOrigin(configuredAuthUrl);
  if (!expectedOrigin || rawUrl !== rawUrl.trim() || rawUrl.length === 0 || rawUrl.length > 4_096) {
    return false;
  }

  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      url.origin === expectedOrigin &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/auth/v1/authorize" &&
      url.hash === "" &&
      singleSearchValue(url, "provider") === "google" &&
      isMossGoogleOAuthRedirect(singleSearchValue(url, "redirect_to") ?? "") &&
      !url.searchParams.has("state") &&
      singleSearchValue(url, "code_challenge_method") === "s256" &&
      PKCE_CHALLENGE.test(singleSearchValue(url, "code_challenge") ?? "")
    );
  } catch {
    return false;
  }
}
