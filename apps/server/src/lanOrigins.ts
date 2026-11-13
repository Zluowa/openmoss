// FILE: lanOrigins.ts
// Purpose: The plain-HTTP origins a phone or tablet on the same network can open.
// Layer: Server runtime (no Effect; pure besides the interface snapshot)

import os from "node:os";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "./startupAccess";

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>;

/** Interfaces that never lead to a nearby device (VPN-less link-local, Docker bridges). */
function isUsefulLanAddress(address: string, interfaceName: string): boolean {
  if (address.startsWith("169.254.")) return false;
  return !/^(docker|br-|veth|virbr|vmnet|utun|awdl|llw)/i.test(interfaceName);
}

/**
 * Lists `http://<address>:<port>` for every address the listener is reachable on
 * from the local network. A loopback listener is not reachable, so it has none.
 * A wildcard listener is reachable on each non-internal IPv4 interface; private
 * ranges (home Wi-Fi, Tailscale's 100.64/10) sort first.
 */
export function resolveLanOrigins(input: {
  readonly host: string | undefined;
  readonly port: number;
  readonly interfaces?: NetworkInterfaces;
}): ReadonlyArray<string> {
  const { host, port } = input;
  if (host && isLoopbackHost(host)) return [];
  if (host && !isWildcardHost(host)) return [`http://${formatHostForUrl(host)}:${port}`];
  // Omitting the listen host binds every interface, the same as 0.0.0.0.
  const interfaces = input.interfaces ?? os.networkInterfaces();
  const addresses = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      if (!isUsefulLanAddress(entry.address, name)) continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses]
    .toSorted((left, right) => lanAddressRank(left) - lanAddressRank(right))
    .map((address) => `http://${address}:${port}`);
}

function lanAddressRank(address: string): number {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 3;
  return 4;
}
