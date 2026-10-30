import {
  buildPinnedRequestTarget,
  encodeOutboundMultipart,
  invokePinnedDnsLookup,
  OutboundHttpError,
  resolveOutboundProxyUrl,
} from "@synara/shared/outboundHttp";
import {
  assertJsonWithinLimits,
  assertOutboundUrlAllowed,
  isPublicIpAddress,
  OutboundPolicyError,
} from "@synara/shared/outboundHttpPolicy";
import { describe, expect, it } from "vitest";

describe("outbound HTTP policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.5",
    "::1",
    "fc00::1",
    "fe80::1",
    "64:ff9b::127.0.0.1",
    "2001:db8::1",
  ])("rejects private or reserved address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it("pins requests to an exact HTTPS origin", () => {
    expect(
      assertOutboundUrlAllowed({
        url: "https://api.x.ai/v1/language-models",
        allowedOrigins: ["https://api.x.ai"],
      }).pathname,
    ).toBe("/v1/language-models");
    expect(() =>
      assertOutboundUrlAllowed({
        url: "https://attacker.example/language-models",
        allowedOrigins: ["https://api.x.ai"],
      }),
    ).toThrowError(OutboundPolicyError);
    expect(() =>
      assertOutboundUrlAllowed({
        url: "http://api.x.ai/language-models",
        allowedOrigins: ["https://api.x.ai"],
      }),
    ).toThrowError(OutboundPolicyError);
  });

  it("bounds parsed JSON depth and node count", () => {
    expect(() =>
      assertJsonWithinLimits({ a: { b: { c: true } } }, { maxDepth: 2, maxNodes: 20 }),
    ).toThrowError(/depth limit/u);
    expect(() => assertJsonWithinLimits([1, 2, 3], { maxDepth: 2, maxNodes: 3 })).toThrowError(
      /node limit/u,
    );
  });

  it("encodes multipart bodies under an explicit byte budget", () => {
    const multipart = encodeOutboundMultipart(
      [
        {
          name: "file",
          filename: "voice.wav",
          contentType: "audio/wav",
          body: new Uint8Array([1, 2, 3]),
        },
      ],
      { maxBytes: 1_024 },
    );
    const body = new TextDecoder().decode(multipart.body);
    expect(multipart.contentType).toMatch(/^multipart\/form-data; boundary=Moss-/u);
    expect(body).toContain('name="file"; filename="voice.wav"');
    expect(() =>
      encodeOutboundMultipart([{ name: "file", body: "oversize" }], { maxBytes: 4 }),
    ).toThrowError(OutboundHttpError);
    expect(() =>
      encodeOutboundMultipart(
        [{ name: "file", contentType: "audio/wav\r\nx-credential: leak", body: "x" }],
        { maxBytes: 1_024 },
      ),
    ).toThrowError(/content type is invalid/u);
  });
});

describe("invokePinnedDnsLookup", () => {
  const pinned = { address: "1.2.3.4", family: 4 as const };

  it("returns the legacy single-address form when all is not requested", async () => {
    const result = await new Promise((resolve) => {
      invokePinnedDnsLookup(pinned, {}, (err, address, family) => {
        resolve({ err, address, family });
      });
    });
    expect(result).toEqual({ err: null, address: "1.2.3.4", family: 4 });
  });

  it("returns the array form when Happy Eyeballs requests all addresses", async () => {
    const result = await new Promise((resolve) => {
      invokePinnedDnsLookup(pinned, { all: true }, (err, address, family) => {
        resolve({ err, address, family });
      });
    });
    expect(result).toEqual({
      err: null,
      address: [{ address: "1.2.3.4", family: 4 }],
      family: undefined,
    });
  });

  it("offers every pinned address to Happy Eyeballs so IPv4 still works without IPv6", async () => {
    const dualStack = [
      { address: "2606:4700::1", family: 6 as const },
      { address: "104.18.42.230", family: 4 as const },
    ];
    const all = await new Promise((resolve) => {
      invokePinnedDnsLookup(dualStack, { all: true }, (err, address) => {
        resolve({ err, address });
      });
    });
    expect(all).toEqual({ err: null, address: dualStack });
    const single = await new Promise((resolve) => {
      invokePinnedDnsLookup(dualStack, {}, (err, address, family) => {
        resolve({ err, address, family });
      });
    });
    expect(single).toEqual({ err: null, address: "2606:4700::1", family: 6 });
  });
});

describe("buildPinnedRequestTarget", () => {
  it("keeps the logical Host and TLS SNI while connecting to the pinned IP", () => {
    expect(
      buildPinnedRequestTarget(
        new URL("https://api2.cursor.sh:8443/usage/current?format=credits"),
        { address: "1.2.3.4", family: 4 },
      ),
    ).toEqual({
      hostname: "1.2.3.4",
      port: 8443,
      path: "/usage/current?format=credits",
      hostHeader: "api2.cursor.sh:8443",
      servername: "api2.cursor.sh",
    });
  });
});

describe("resolveOutboundProxyUrl", () => {
  it("uses an HTTPS proxy for a remote provider endpoint", () => {
    expect(
      resolveOutboundProxyUrl("https://cli-chat-proxy.grok.com/v1/billing", {
        HTTPS_PROXY: "http://127.0.0.1:3128",
      }),
    ).toBe("http://127.0.0.1:3128/");
  });

  it("honors exact, suffix, wildcard, and port-scoped NO_PROXY entries", () => {
    const target = "https://api2.cursor.sh/usage";
    for (const noProxy of ["api2.cursor.sh", ".cursor.sh", "*.cursor.sh", "*"]) {
      expect(
        resolveOutboundProxyUrl(target, {
          HTTPS_PROXY: "http://127.0.0.1:3128",
          NO_PROXY: noProxy,
        }),
      ).toBeUndefined();
    }
    expect(
      resolveOutboundProxyUrl(target, {
        HTTPS_PROXY: "http://127.0.0.1:3128",
        NO_PROXY: "api2.cursor.sh:8443",
      }),
    ).toBe("http://127.0.0.1:3128/");
  });

  it("rejects unsupported or path-bearing proxy URLs", () => {
    expect(
      resolveOutboundProxyUrl("https://api2.cursor.sh/usage", {
        HTTPS_PROXY: "socks5://127.0.0.1:1080",
      }),
    ).toBeUndefined();
    expect(
      resolveOutboundProxyUrl("https://api2.cursor.sh/usage", {
        HTTPS_PROXY: "https://proxy.example.test/unexpected-path",
      }),
    ).toBeUndefined();
  });
});
