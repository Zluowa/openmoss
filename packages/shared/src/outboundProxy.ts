import { execFileSync } from "node:child_process";

/**
 * Outbound HTTP(S)/ALL/NO_PROXY inheritance for provider CLIs.
 *
 * Turbo strict mode and Dock-launched desktop apps both drop the user's proxy
 * unless Moss copies it through. Grok (and other CLIs) only honor these env
 * vars, so a Mac that must leave via 127.0.0.1:7897 otherwise sits on
 * Thinking forever.
 *
 * @module outboundProxy
 */

export const OUTBOUND_PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

export type OutboundProxyEnvName = (typeof OUTBOUND_PROXY_ENV_NAMES)[number];

const PROXY_VALUE_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export function hasOutboundProxy(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
): boolean {
  return PROXY_VALUE_NAMES.some((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function pickOutboundProxyEnv(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {};
  for (const name of OUTBOUND_PROXY_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      picked[name] = value.trim();
    }
  }
  return picked;
}

function scutilEnabled(values: ReadonlyMap<string, string>, key: string): boolean {
  const raw = values.get(key)?.trim();
  return raw === "1" || raw === "true";
}

function scutilProxyUrl(
  values: ReadonlyMap<string, string>,
  hostKey: string,
  portKey: string,
  scheme: "http" | "socks5",
): string | undefined {
  const host = values.get(hostKey)?.trim();
  const port = values.get(portKey)?.trim();
  if (!host || !port || !/^\d+$/u.test(port)) return undefined;
  return `${scheme}://${host}:${port}`;
}

/**
 * Parse `scutil --proxy` into the env vars Grok and other CLIs understand.
 * PAC URLs are ignored: provider binaries do not evaluate them.
 */
export function parseMacOsScutilProxy(text: string): NodeJS.ProcessEnv {
  const values = new Map<string, string>();
  const exceptions: string[] = [];
  let inExceptions = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "}" && inExceptions) {
      inExceptions = false;
      continue;
    }
    const pair = /^([A-Za-z]+)\s*:\s*(.+)$/u.exec(line);
    if (pair) {
      const key = pair[1] ?? "";
      const value = (pair[2] ?? "").trim();
      values.set(key, value);
      if (key === "ExceptionsList") inExceptions = true;
      continue;
    }
    if (inExceptions) {
      const exception = /^\d+\s*:\s*(\S+)$/u.exec(line);
      if (exception?.[1]) exceptions.push(exception[1]);
    }
  }

  const env: NodeJS.ProcessEnv = {};
  if (scutilEnabled(values, "HTTPSEnable")) {
    const httpsProxy = scutilProxyUrl(values, "HTTPSProxy", "HTTPSPort", "http");
    if (httpsProxy) {
      env.HTTPS_PROXY = httpsProxy;
      env.https_proxy = httpsProxy;
    }
  }
  if (scutilEnabled(values, "HTTPEnable")) {
    const httpProxy = scutilProxyUrl(values, "HTTPProxy", "HTTPPort", "http");
    if (httpProxy) {
      env.HTTP_PROXY = httpProxy;
      env.http_proxy = httpProxy;
    }
  }
  if (scutilEnabled(values, "SOCKSEnable") && !env.HTTPS_PROXY && !env.HTTP_PROXY) {
    const socksProxy = scutilProxyUrl(values, "SOCKSProxy", "SOCKSPort", "socks5");
    if (socksProxy) {
      env.ALL_PROXY = socksProxy;
      env.all_proxy = socksProxy;
    }
  }
  const noProxy = ["127.0.0.1", "localhost", "::1", ...exceptions].join(",");
  if (hasOutboundProxy(env)) {
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }
  return env;
}

export function readMacOsSystemProxy(
  readCommand: (command: string, args: readonly string[]) => string = defaultReadScutil,
): NodeJS.ProcessEnv {
  try {
    return parseMacOsScutilProxy(readCommand("scutil", ["--proxy"]));
  } catch {
    return {};
  }
}

function defaultReadScutil(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

const SYSTEM_PROXY_CACHE_TTL_MS = 60_000;

/**
 * `scutil --proxy` is a blocking child process, and provider env builds run on
 * every health probe, terminal and session start. Without a proxy configured
 * nothing short-circuits the read, so cache the result for a minute.
 */
export function createCachedSystemProxyReader(
  read: () => NodeJS.ProcessEnv,
  options: { readonly ttlMs?: number; readonly now?: () => number } = {},
): () => NodeJS.ProcessEnv {
  const ttlMs = options.ttlMs ?? SYSTEM_PROXY_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { readonly env: NodeJS.ProcessEnv; readonly readAt: number } | undefined;
  return () => {
    const at = now();
    if (cached === undefined || at - cached.readAt >= ttlMs) {
      cached = { env: read(), readAt: at };
    }
    return cached.env;
  };
}

const readCachedMacOsSystemProxy = createCachedSystemProxyReader(() => readMacOsSystemProxy());

export function withOutboundProxyEnv(
  env: NodeJS.ProcessEnv,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly readSystemProxy?: () => NodeJS.ProcessEnv;
  } = {},
): NodeJS.ProcessEnv {
  if (hasOutboundProxy(env)) return env;
  const platform = options.platform ?? process.platform;
  const systemProxy =
    options.readSystemProxy?.() ?? (platform === "darwin" ? readCachedMacOsSystemProxy() : {});
  if (!hasOutboundProxy(systemProxy)) return env;
  return { ...env, ...pickOutboundProxyEnv(systemProxy) };
}

export function applyOutboundProxyEnv(
  env: NodeJS.ProcessEnv,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly readSystemProxy?: () => NodeJS.ProcessEnv;
  } = {},
): NodeJS.ProcessEnv {
  const next = withOutboundProxyEnv(env, options);
  if (next === env) return env;
  for (const [name, value] of Object.entries(next)) {
    if (value !== undefined && env[name] === undefined) {
      env[name] = value;
    }
  }
  return env;
}
