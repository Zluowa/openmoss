export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const isLoopbackHost = (host: string | undefined): boolean => {
  // Omitting Node's listen host binds an unspecified/wildcard interface. It
  // must never be classified as loopback by access policy.
  if (!host) return false;
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
};

/** The slice of one request that tells whether it came straight from this computer. */
export interface RequestPeer {
  readonly remoteAddress: string | null | undefined;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
}

export const isLoopbackPeerAddress = (remoteAddress: string | null | undefined): boolean => {
  const normalized = remoteAddress?.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
};

// A reverse proxy on this computer (Tailscale Serve, nginx) also connects from
// loopback, on behalf of a device elsewhere. Every one of them names that device
// in at least one of these headers, and a client behind the proxy cannot remove them.
const FORWARDED_REQUEST_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "tailscale-user-login",
] as const;

/** Reads the peer off a server request (Effect's or Node's shape). */
export const requestPeer = (request: {
  readonly remoteAddress?: string | undefined;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
}): RequestPeer => ({ remoteAddress: request.remoteAddress, headers: request.headers });

/** The TCP peer is this computer, and no proxy relayed the request for someone else. */
export const isDirectLoopbackRequest = (peer: RequestPeer): boolean =>
  isLoopbackPeerAddress(peer.remoteAddress) &&
  FORWARDED_REQUEST_HEADERS.every((name) => peer.headers[name] === undefined);

export interface LocalAccessConfig {
  readonly mode?: "web" | "desktop" | undefined;
  readonly host: string | undefined;
  readonly publicUrl: string | URL | undefined;
  readonly desktopPhoneAccess?: boolean | undefined;
}

/**
 * Whether a request keeps the standing of "this computer only": the desktop's
 * startup credential, and the features Moss offers only on the computer running it.
 *
 * A loopback-only server grants it to every request, because nothing else can
 * connect. A desktop that also lets phones connect (`desktopPhoneAccess`) is
 * reachable from the network, so there it is decided per request: only one that
 * arrived straight from this computer keeps it. A phone never does.
 */
export const isLocalOnlyAccess = (
  config: LocalAccessConfig,
  peer: RequestPeer | undefined,
): boolean => {
  if (isLoopbackHost(config.host) && !config.publicUrl) return true;
  return (
    config.mode === "desktop" &&
    config.desktopPhoneAccess === true &&
    (isLoopbackHost(config.host) || isWildcardHost(config.host)) &&
    peer !== undefined &&
    isDirectLoopbackRequest(peer)
  );
};

/** Main-process transports can keep the private startup credential out of URLs. */
export const isLoopbackStartupBearer = (
  input: LocalAccessConfig & {
    readonly authToken: string | undefined;
    readonly authorization: string | undefined;
    readonly peer?: RequestPeer | undefined;
  },
): boolean =>
  isLocalOnlyAccess(input, input.peer) &&
  Boolean(input.authToken) &&
  input.authorization === `Bearer ${input.authToken}`;

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export const resolveListeningPort = (address: unknown, fallbackPort: number): number => {
  if (
    typeof address === "object" &&
    address !== null &&
    "port" in address &&
    typeof address.port === "number"
  ) {
    return address.port;
  }
  return fallbackPort;
};
