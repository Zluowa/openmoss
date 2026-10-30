const SUPABASE_PROJECT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co$/u;
const OPAQUE_FLOW_ID = /^[A-Za-z0-9._~-]{32,512}$/u;
const PKCE_CHALLENGE = /^[A-Za-z0-9._~-]{43,128}$/u;

export class MossGoogleOAuthBoundaryError extends Error {
  readonly code: "authorization_result_invalid" | "authorization_open_failed";

  constructor(code: MossGoogleOAuthBoundaryError["code"], message: string) {
    super(message);
    this.name = "MossGoogleOAuthBoundaryError";
    this.code = code;
  }
}

function singleSearchValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

export function requireSupabaseGoogleAuthorizationUrl(input: {
  readonly authorizationUrl: string;
  readonly flowId: string;
  readonly expiresAt: string;
  readonly now?: () => number;
}): string {
  const invalid = () =>
    new MossGoogleOAuthBoundaryError(
      "authorization_result_invalid",
      "Google sign-in could not be started safely.",
    );
  if (
    input.authorizationUrl !== input.authorizationUrl.trim() ||
    input.authorizationUrl.length === 0 ||
    input.authorizationUrl.length > 4_096 ||
    !OPAQUE_FLOW_ID.test(input.flowId)
  ) {
    throw invalid();
  }

  let url: URL;
  try {
    url = new URL(input.authorizationUrl);
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "https:" ||
    !SUPABASE_PROJECT_HOST.test(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/auth/v1/authorize" ||
    url.hash !== "" ||
    singleSearchValue(url, "provider") !== "google" ||
    singleSearchValue(url, "redirect_to") !== `moss://auth/callback?flow_id=${input.flowId}` ||
    url.searchParams.has("state") ||
    singleSearchValue(url, "code_challenge_method") !== "s256" ||
    !PKCE_CHALLENGE.test(singleSearchValue(url, "code_challenge") ?? "")
  ) {
    throw invalid();
  }

  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (input.now ?? Date.now)()) {
    throw invalid();
  }
  return input.authorizationUrl;
}

export async function beginMossGoogleOAuth(input: {
  readonly start: () => Promise<{
    readonly authorizationUrl: string;
    readonly flowId: string;
    readonly expiresAt: string;
  }>;
  readonly openExternal: (url: string) => Promise<boolean | void>;
  readonly onFlowOpened?: (flow: {
    readonly flowId: string;
    readonly expiresAt: string;
  }) => void | Promise<void>;
  readonly now?: () => number;
}): Promise<void> {
  const result = await input.start();
  const authorizationUrl = requireSupabaseGoogleAuthorizationUrl({
    ...result,
    ...(input.now ? { now: input.now } : {}),
  });
  if ((await input.openExternal(authorizationUrl)) === false) {
    throw new MossGoogleOAuthBoundaryError(
      "authorization_open_failed",
      "Google sign-in could not be opened.",
    );
  }
  await input.onFlowOpened?.({ flowId: result.flowId, expiresAt: result.expiresAt });
}
