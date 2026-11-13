import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveLanOrigins } from "./lanOrigins";

const interfaces: Record<string, NetworkInterfaceInfo[]> = {
  lo: [
    {
      address: "127.0.0.1",
      family: "IPv4",
      internal: true,
      netmask: "255.0.0.0",
      mac: "00:00:00:00:00:00",
      cidr: "127.0.0.1/8",
    },
  ],
  docker0: [
    {
      address: "172.17.0.1",
      family: "IPv4",
      internal: false,
      netmask: "255.255.0.0",
      mac: "02:42:00:00:00:00",
      cidr: "172.17.0.1/16",
    },
  ],
  tailscale0: [
    {
      address: "100.101.1.2",
      family: "IPv4",
      internal: false,
      netmask: "255.255.255.255",
      mac: "00:00:00:00:00:00",
      cidr: "100.101.1.2/32",
    },
  ],
  en0: [
    {
      address: "fe80::1",
      family: "IPv6",
      internal: false,
      netmask: "ffff:ffff:ffff:ffff::",
      mac: "aa:bb:cc:dd:ee:ff",
      cidr: "fe80::1/64",
      scopeid: 4,
    },
    {
      address: "192.168.1.42",
      family: "IPv4",
      internal: false,
      netmask: "255.255.255.0",
      mac: "aa:bb:cc:dd:ee:ff",
      cidr: "192.168.1.42/24",
    },
  ],
};

describe("resolveLanOrigins", () => {
  it("has no LAN origin for a loopback listener", () => {
    expect(resolveLanOrigins({ host: "127.0.0.1", port: 3773, interfaces })).toEqual([]);
    expect(resolveLanOrigins({ host: "localhost", port: 3773, interfaces })).toEqual([]);
  });

  it("uses an explicit non-loopback host as is", () => {
    expect(resolveLanOrigins({ host: "100.101.1.2", port: 3773, interfaces })).toEqual([
      "http://100.101.1.2:3773",
    ]);
  });

  it("lists home-network IPv4 addresses first for a wildcard listener", () => {
    expect(resolveLanOrigins({ host: "0.0.0.0", port: 3773, interfaces })).toEqual([
      "http://192.168.1.42:3773",
      "http://100.101.1.2:3773",
    ]);
    expect(resolveLanOrigins({ host: undefined, port: 4000, interfaces })).toEqual([
      "http://192.168.1.42:4000",
      "http://100.101.1.2:4000",
    ]);
  });
});
