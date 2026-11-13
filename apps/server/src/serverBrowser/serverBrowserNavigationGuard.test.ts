import { describe, expect, it } from "vitest";

import { isServerBrowserNavigable, serverBrowserHost } from "./serverBrowserNavigationGuard.ts";

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";

/** A resolver that answers from a table and fails for anything else. */
const resolver = (table: Record<string, ReadonlyArray<string>>) => async (host: string) => {
  const addresses = table[host];
  if (!addresses)
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

const navigable = (url: string, table: Record<string, ReadonlyArray<string>> = {}) =>
  isServerBrowserNavigable(new URL(url), { lookup: resolver(table) });

describe("isServerBrowserNavigable", () => {
  it("refuses loopback, by address and by name", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://127.1.2.3:8080/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://0.0.0.0/",
      "http://localhost:3773/",
      "http://LOCALHOST./",
      "http://moss.localhost/",
      "http://[::1]/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      expect(await navigable(url), url).toBe(false);
    }
  });

  it("refuses private IPv4 ranges", async () => {
    for (const url of [
      "http://10.0.0.1/",
      "http://10.255.255.255/",
      "http://172.16.0.1/",
      "http://172.31.255.254/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
    ]) {
      expect(await navigable(url), url).toBe(false);
    }
    // Just outside 172.16.0.0/12.
    expect(await navigable("http://172.32.0.1/")).toBe(true);
  });

  it("refuses link-local, including the cloud metadata address", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.0.1/",
      "http://[fe80::1]/",
    ]) {
      expect(await navigable(url), url).toBe(false);
    }
  });

  it("refuses IPv6 unique-local addresses", async () => {
    for (const url of ["http://[fc00::1]/", "http://[fd12:3456:789a::1]/"]) {
      expect(await navigable(url), url).toBe(false);
    }
  });

  it("refuses names that resolve to any local or private address", async () => {
    const table = {
      "metadata.example": ["169.254.169.254"],
      "intranet.example": ["10.1.2.3"],
      "mixed.example": [PUBLIC_V4, "192.168.0.10"],
      "v6-local.example": ["fd00::5"],
      "loop.example": ["127.0.0.1"],
    };
    for (const host of Object.keys(table)) {
      expect(await navigable(`https://${host}/`, table), host).toBe(false);
    }
  });

  it("lets public addresses and names through", async () => {
    expect(await navigable(`http://${PUBLIC_V4}/`)).toBe(true);
    expect(await navigable(`https://[${PUBLIC_V6}]/`)).toBe(true);
    expect(
      await navigable("https://example.com/path?q=1", { "example.com": [PUBLIC_V4, PUBLIC_V6] }),
    ).toBe(true);
  });

  it("lets a fake-ip DNS answer through for names only", async () => {
    expect(await navigable("https://example.com/", { "example.com": ["198.18.0.7"] })).toBe(true);
    expect(await navigable("http://198.18.0.7/")).toBe(false);
  });

  it("leaves an unresolvable name to the browser's own error page", async () => {
    expect(await navigable("https://no-such-host.example/")).toBe(true);
  });

  it("refuses anything but http and https", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/",
      "chrome://version",
      "data:text/html,hi",
    ]) {
      expect(await navigable(url), url).toBe(false);
    }
  });
});

describe("serverBrowserHost", () => {
  it("names the host the browser would use", () => {
    expect(serverBrowserHost(new URL("http://[::1]:8080/"))).toBe("::1");
    expect(serverBrowserHost(new URL("http://Example.COM./"))).toBe("example.com");
    expect(serverBrowserHost(new URL("http://2130706433/"))).toBe("127.0.0.1");
  });
});
