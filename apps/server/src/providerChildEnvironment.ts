// FILE: providerChildEnvironment.ts
// Purpose: Builds provider child environments without Moss control-plane authority.
// Layer: Server provider process security

export type ProviderChildKind =
  | "acp"
  | "antigravity"
  | "claude"
  | "codex"
  | "cursor"
  | "gemini"
  | "devin"
  | "droid"
  | "grok"
  | "opencode"
  | "pi"
  | "hermes"
  | "omp"
  | "kimi"
  | "minimax"
  | "zcode";

const PROVIDER_CREDENTIAL_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "FACTORY_API_KEY",
  "CURSOR_API_KEY",
  "DEVIN_API_KEY",
  "WINDSURF_API_KEY",
  "DOCKER_AUTH_CONFIG",
]);

export function registerProviderCredentialKey(key: string): void {
  const normalized = key.trim().toUpperCase();
  if (/^[A-Z0-9_.-]+$/u.test(normalized)) {
    PROVIDER_CREDENTIAL_KEYS.add(normalized);
  }
}

export function isProviderCredentialKey(key: string): boolean {
  return PROVIDER_CREDENTIAL_KEYS.has(key.trim().toUpperCase());
}

/** Removes ambient provider credentials while retaining ordinary process state. */
export function withoutProviderCredentialEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isProviderCredentialKey(key)));
}

const PROVIDER_CREDENTIAL_GRANTS: Record<ProviderChildKind, "all" | ReadonlySet<string>> = {
  antigravity: new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]),
  claude: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ]),
  cursor: new Set(["CURSOR_API_KEY"]),
  gemini: new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]),
  devin: new Set(["DEVIN_API_KEY", "WINDSURF_API_KEY"]),
  droid: new Set(["FACTORY_API_KEY"]),
  grok: new Set(["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]),
  // These profiles deliberately support arbitrary upstream model providers.
  acp: "all",
  codex: "all",
  opencode: "all",
  pi: "all",
  hermes: "all",
  omp: "all",
  kimi: "all",
  minimax: "all",
  zcode: "all",
};

export function providerCredentialKeysFor(provider: ProviderChildKind): readonly string[] {
  const grants = PROVIDER_CREDENTIAL_GRANTS[provider];
  return [...(grants === "all" ? PROVIDER_CREDENTIAL_KEYS : grants)];
}

/**
 * The only inherited state a Moss-managed CLI child gets: process discovery,
 * temp/locale, and proxy settings. Everything else (user credentials, the
 * user's own CLI homes, shell customizations) stays out so the managed
 * gateway key is the child's sole upstream route.
 */
export function mossManagedChildBaseEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    TMPDIR: env.TMPDIR,
    LANG: env.LANG,
    TERM: "dumb",
    HTTP_PROXY: env.HTTP_PROXY,
    HTTPS_PROXY: env.HTTPS_PROXY,
    ALL_PROXY: env.ALL_PROXY,
    http_proxy: env.http_proxy,
    https_proxy: env.https_proxy,
    all_proxy: env.all_proxy,
  };
}

/** Inherited NO_PROXY plus loopback, so the Moss MCP gateway is never proxied. */
export function mossManagedChildNoProxy(env: NodeJS.ProcessEnv = process.env): string {
  return [env.NO_PROXY, env.no_proxy, "localhost,127.0.0.1,::1"].filter(Boolean).join(",");
}

const INHERITED_NATIVE_CAPABILITY_KEYS = new Set([
  "BUN_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS",
]);

const isTestHarnessKey = (key: string, env: NodeJS.ProcessEnv): boolean =>
  Boolean(env.VITEST) &&
  (key.startsWith("MOSS_FAKE_") ||
    key.startsWith("MOSS_ACP_") ||
    key.startsWith("MOSS_FAKE_") ||
    key.startsWith("MOSS_ACP_"));

export function buildProviderChildEnvironment(input: {
  readonly provider: ProviderChildKind;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly inheritedMossKeys?: ReadonlyArray<string>;
  readonly inheritedNativeCapabilityKeys?: ReadonlyArray<string>;
  readonly overrides?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const baseEnv = {
    ...(input.baseEnv ?? process.env),
    ...input.overrides,
  };
  const allowedMossKeys = new Set(input.inheritedMossKeys ?? []);
  const allowedNativeCapabilities = new Set(input.inheritedNativeCapabilityKeys ?? []);
  const credentialGrants = PROVIDER_CREDENTIAL_GRANTS[input.provider];
  const childEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      // Control-plane credentials use the MOSS_ wire prefix in this repo;
      // MOSS_ covers upstream-authored harness keys. Both stay server-only
      // unless a validated provider boundary explicitly grants inheritance.
      (key.startsWith("MOSS_") || key.startsWith("MOSS_")) &&
      !allowedMossKeys.has(key) &&
      !isTestHarnessKey(key, baseEnv)
    ) {
      continue;
    }
    if (INHERITED_NATIVE_CAPABILITY_KEYS.has(key) && !allowedNativeCapabilities.has(key)) {
      continue;
    }
    if (
      isProviderCredentialKey(key) &&
      credentialGrants !== "all" &&
      !credentialGrants.has(key.toUpperCase())
    ) {
      continue;
    }
    childEnv[key] = value;
  }

  return childEnv;
}
