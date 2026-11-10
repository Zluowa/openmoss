// FILE: accountTokenVerifier.ts
// Purpose: Verifies a Moss account access token against a Supabase-compatible auth service,
//          caching results by token digest. The share relay and the server's page-room control
//          plane both use it.
// Layer: Shared runtime utility (Web Crypto and fetch only, so it runs on Node and in a Worker)
// Exports: bearerToken, RemoteAccountVerifier, DevInsecureAccountVerifier, their types, limits

/** A verified account token is trusted for this long before the auth service is asked again. */
export const ACCOUNT_TOKEN_CACHE_TTL_MS = 60_000;
/** A rejected token is remembered briefly so a bad client cannot hammer the auth service. */
export const ACCOUNT_TOKEN_NEGATIVE_CACHE_TTL_MS = 10_000;
export const ACCOUNT_TOKEN_CACHE_MAX_ENTRIES = 10_000;
export const ACCOUNT_AUTH_TIMEOUT_MS = 8_000;

const encoder = new TextEncoder();

/** base64url (no padding) SHA-256, so cache keys never hold the token itself. */
async function sha256Base64Url(input: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type AccountVerification =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly reason: "unauthorized" | "unavailable" };

export interface AccountVerifier {
  verify(token: string): Promise<AccountVerification>;
}

const BEARER = /^Bearer ([\x21-\x7e]{1,16384})$/;

export function bearerToken(headers: Headers): string | null {
  const value = headers.get("authorization");
  if (value === null) return null;
  return BEARER.exec(value)?.[1] ?? null;
}

interface CacheEntry {
  readonly result: AccountVerification;
  readonly expiresAt: number;
}

export interface RemoteAccountVerifierOptions {
  readonly url: string;
  readonly publishableKey: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly negativeTtlMs?: number;
}

/**
 * Verifies a Moss access token against the Supabase-compatible auth service of the relay's realm.
 * Results are cached by token digest; the token itself is never stored or logged.
 */
export class RemoteAccountVerifier implements AccountVerifier {
  readonly #options: Required<Omit<RemoteAccountVerifierOptions, "url" | "publishableKey">> &
    Pick<RemoteAccountVerifierOptions, "url" | "publishableKey">;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #pending = new Map<string, Promise<AccountVerification>>();

  constructor(options: RemoteAccountVerifierOptions) {
    this.#options = {
      url: options.url,
      publishableKey: options.publishableKey,
      // Cloudflare's platform fetch throws `Illegal invocation` when it is later called as a
      // method of this options object, so bind it to the global scope here. Node does not care,
      // which is why this only ever failed on the Worker.
      fetch: options.fetch ?? fetch.bind(globalThis),
      now: options.now ?? Date.now,
      ttlMs: options.ttlMs ?? ACCOUNT_TOKEN_CACHE_TTL_MS,
      negativeTtlMs: options.negativeTtlMs ?? ACCOUNT_TOKEN_NEGATIVE_CACHE_TTL_MS,
    };
  }

  async verify(token: string): Promise<AccountVerification> {
    const key = await sha256Base64Url(token);
    const now = this.#options.now();
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > now) return cached.result;
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const task = this.#lookup(token)
      .then((result) => {
        if (result.ok || result.reason === "unauthorized") {
          const ttl = result.ok ? this.#options.ttlMs : this.#options.negativeTtlMs;
          this.#remember(key, { result, expiresAt: this.#options.now() + ttl });
        }
        return result;
      })
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, task);
    return task;
  }

  #remember(key: string, entry: CacheEntry): void {
    if (this.#cache.size >= ACCOUNT_TOKEN_CACHE_MAX_ENTRIES) {
      const now = this.#options.now();
      for (const [cachedKey, cached] of this.#cache) {
        if (cached.expiresAt <= now) this.#cache.delete(cachedKey);
      }
      // Still full: the cache is insertion-ordered, so the oldest entries go first.
      let overflow = this.#cache.size - ACCOUNT_TOKEN_CACHE_MAX_ENTRIES + 1;
      for (const cachedKey of this.#cache.keys()) {
        if (overflow <= 0) break;
        this.#cache.delete(cachedKey);
        overflow -= 1;
      }
    }
    this.#cache.set(key, entry);
  }

  async #lookup(token: string): Promise<AccountVerification> {
    let response: Response;
    try {
      response = await this.#options.fetch(`${this.#options.url}/auth/v1/user`, {
        method: "GET",
        headers: {
          accept: "application/json",
          apikey: this.#options.publishableKey,
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(ACCOUNT_AUTH_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "unauthorized" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "unavailable" };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    const id =
      typeof payload === "object" && payload !== null && "id" in payload
        ? (payload as { id?: unknown }).id
        : undefined;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) {
      return { ok: false, reason: "unavailable" };
    }
    return { ok: true, accountId: id };
  }
}

/** Development only: every non-empty bearer is its own account. */
export class DevInsecureAccountVerifier implements AccountVerifier {
  async verify(token: string): Promise<AccountVerification> {
    const digest = await sha256Base64Url(token);
    return { ok: true, accountId: `dev:${digest.slice(0, 16)}` };
  }
}
