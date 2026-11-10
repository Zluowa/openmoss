export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const isLoopbackHost = (host: string | undefined): boolean => {
  // Omitting Node's listen host binds an unspecified/wildcard interface. It
  // must never be classified as loopback by access policy.
  if (!host) return false;
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
};

/** Main-process transports can keep the private startup credential out of URLs. */
export const isLoopbackStartupBearer = (input: {
  readonly host: string | undefined;
  readonly publicUrl: string | URL | undefined;
  readonly authToken: string | undefined;
  readonly authorization: string | undefined;
}): boolean =>
  isLoopbackHost(input.host) &&
  !input.publicUrl &&
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
