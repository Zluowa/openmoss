/**
 * Which pages the server browser may load: web pages on the public internet,
 * never the server's own machine or the network it sits on.
 *
 * The browser runs on the server, so a page it loads is fetched from there. A
 * person or an agent typing `http://169.254.169.254/` or `http://10.0.0.5/`
 * would otherwise read the cloud metadata service or the server's private
 * network and see it streamed back. Addresses are classified by the shared
 * outbound policy (`isPublicIpAddress`): loopback, private, link-local,
 * carrier-grade NAT, documentation, multicast and reserved IPv4 ranges, and
 * IPv6 loopback, link-local, unique-local and IPv4-mapped addresses are all
 * refused, as are this machine's own interface addresses.
 *
 * @module serverBrowserNavigationGuard
 */
import * as dns from "node:dns/promises";
import * as Net from "node:net";
import { networkInterfaces } from "node:os";

import { isBenchmarkIpAddress, isPublicIpAddress } from "@moss/shared/outboundHttpPolicy";

export type ServerBrowserLookup = (
  host: string,
) => Promise<ReadonlyArray<{ readonly address: string; readonly family: number }>>;

const lookupAll: ServerBrowserLookup = (host) => dns.lookup(host, { all: true, verbatim: true });

function ownAddresses(): Net.BlockList {
  const own = new Net.BlockList();
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (!entry) continue;
    const address = entry.address.split("%", 1)[0]!;
    if (Net.isIP(address)) own.addAddress(address, Net.isIP(address) === 6 ? "ipv6" : "ipv4");
  }
  return own;
}

function reachable(address: string, own: Net.BlockList, resolvedFromName: boolean): boolean {
  const bare = address.split("%", 1)[0]!;
  const family = Net.isIP(bare);
  if (family === 0) return false;
  if (own.check(bare, family === 6 ? "ipv6" : "ipv4")) return false;
  if (isPublicIpAddress(bare)) return true;
  // Fake-ip DNS (Clash, Surge) answers every name from 198.18.0.0/15 and its
  // proxy makes the real connection, so a name resolving there is not a local
  // destination. A literal address in that range stays refused.
  return resolvedFromName && isBenchmarkIpAddress(bare);
}

/** The URL's host as the browser will use it: no IPv6 brackets, no trailing dot, lower case. */
export function serverBrowserHost(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Whether the server browser may load `url`: http or https, to a host whose
 * every address is public and not this machine's own.
 *
 * A name is resolved first. A name that does not resolve here is let through:
 * the browser resolves with the same system resolver and shows its own "site
 * can't be reached" page, which is the honest answer for a typo.
 */
export async function isServerBrowserNavigable(
  url: URL,
  options: { readonly lookup?: ServerBrowserLookup } = {},
): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = serverBrowserHost(url);
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return false;
  const own = ownAddresses();
  if (Net.isIP(host)) return reachable(host, own, false);
  let addresses: ReadonlyArray<{ readonly address: string }>;
  try {
    addresses = await (options.lookup ?? lookupAll)(host);
  } catch {
    return true;
  }
  return addresses.every(({ address }) => reachable(address, own, true));
}
