// FILE: providerUsage/types.ts
// Purpose: Shared contract for the server-side live provider-usage fetchers. Each provider
// implements ProviderUsageFetcher; the registry maps ProviderKind -> fetcher. Fetchers must
// never throw — they resolve to a snapshot whose `status` describes the outcome. Token
// freshness is the owning CLI's job where possible (Claude delegates to `claude auth status`);
// a fetcher that redeems a refresh token itself must persist the rotated pair back to the
// CLI's credential store, because providers rotate single-use refresh tokens.

import type {
  ProviderInstanceId,
  ProviderKind,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";

export interface CodexAppServerAccountUsage {
  readonly accountRef: string;
  readonly rateLimits: Record<string, unknown>;
  readonly tokenUsage: Record<string, unknown> | null;
  readonly planType: string | null;
  readonly capabilities: {
    readonly protocol: "codex-app-server-v2";
    readonly rateLimitsRead: true;
    readonly accountUsageRead: boolean;
  };
}

export interface ProviderUsageContext {
  /** Resolved user home directory (ServerConfig.homeDir). */
  readonly homeDir: string;
  /** Process environment (lets fetchers honor CODEX_HOME, CLAUDE_CONFIG_DIR, etc.). */
  readonly env: NodeJS.ProcessEnv;
  /** Host platform; keychain reads only run on darwin. */
  readonly platform: NodeJS.Platform;
  /** Reference "now" in epoch ms, used for token-expiry checks (kept injectable for tests). */
  readonly nowMs: number;
  /** Claude CLI binary (settings.providers.claudeAgent.binaryPath); defaults to "claude". */
  readonly claudeBinaryPath?: string;
  /** Codex CLI binary (settings.providers.codex.binaryPath); defaults to "codex". */
  readonly codexBinaryPath?: string;
  /** Server-owned Codex archive root (settings.providers.codex.homePath). */
  readonly codexHomePath?: string;
  /** Server-owned Claude account HOME (settings.providers.claudeAgent.homePath). */
  readonly claudeHomePath?: string;
  /** Selected provider identity; prevents cache/UI data from crossing configured instances. */
  readonly providerInstanceId?: ProviderInstanceId;
  /** Public app-server reader injected by the owning Codex adapter. */
  readonly readCodexAccountUsage?: () => Promise<CodexAppServerAccountUsage>;
  /** Test/transition-only escape hatch; production must use the public app-server protocol. */
  readonly allowLegacyCodexHttpUsage?: boolean;
}

export interface ProviderUsageFetcher {
  readonly provider: ProviderKind;
  /**
   * Resolve a non-secret identity for the currently selected credentials. A changed identity
   * invalidates the orchestration cache before its TTL expires. Null disables caching for the
   * request when credential identity cannot be read safely.
   */
  readonly cacheKey?: (ctx: ProviderUsageContext) => Promise<string | null>;
  /** Resolve credentials and fetch live usage. Never throws. */
  fetch(ctx: ProviderUsageContext): Promise<ServerProviderUsageSnapshot>;
}
