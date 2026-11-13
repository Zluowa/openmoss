import { describe, expect, it } from "vitest";

import { filterMcpAppFrameSites, parseMcpAppFrameSite } from "./frameSites";

describe("MCP App frame site rules", () => {
  it("accepts https hosts and wildcards with optional ports", () => {
    expect(parseMcpAppFrameSite("https://maps.example.com")).toEqual({
      host: "maps.example.com",
      anySubdomain: false,
      port: "",
    });
    expect(parseMcpAppFrameSite("https://*.Example.com:8443")).toEqual({
      host: "example.com",
      anySubdomain: true,
      port: "8443",
    });
    expect(parseMcpAppFrameSite("https://example.com:443")?.port).toBe("");
  });

  it("refuses paths, other schemes, bare TLDs and numeric TLDs", () => {
    for (const value of [
      "http://example.com",
      "https://example.com/embed",
      "https://example.com?x=1",
      "https://com",
      "https://*.com",
      "https://127.0.0.1",
      "https://10.0.0.1:8443",
      "https://example.123",
      "wss://example.com",
      "https://user@example.com",
      "*",
      "https://*",
    ]) {
      expect(parseMcpAppFrameSite(value), value).toBe(null);
    }
  });

  it("refuses bad ports", () => {
    expect(parseMcpAppFrameSite("https://example.com:0443")).toBe(null);
    expect(parseMcpAppFrameSite("https://example.com:65536")).toBe(null);
    expect(parseMcpAppFrameSite("https://example.com:65535")?.port).toBe("65535");
  });

  it("refuses the reference vendor's hosts, Moss's hosts and their subdomains", () => {
    for (const value of [
      "https://claude.ai",
      "https://preview.claude.ai",
      "https://abc.claudemcpcontent.com",
      "https://anthropic.com",
      "https://*.claudeusercontent.com",
      "https://moss-update.comiction.cn",
      "https://moss-share.comiction.cn",
      "https://moss-devs.inkcomicai.com",
      "https://*.inkcomicai.com",
      "https://mossbotai.com",
      "https://share.mossbotai.com",
      "https://api.mossbotai.com",
      "https://*.mossbotai.com",
      "https://tishilabs.com",
      "https://www.tishilabs.com",
      "https://moss-global.supabase.co",
      "https://moss-cn.baseapi.memfiredb.com",
    ]) {
      expect(parseMcpAppFrameSite(value), value).toBe(null);
    }
    // Look-alike hosts are not subdomains.
    expect(parseMcpAppFrameSite("https://notclaude.ai")?.host).toBe("notclaude.ai");
    expect(parseMcpAppFrameSite("https://comiction.cn.example.com")?.host).toBe(
      "comiction.cn.example.com",
    );
    expect(parseMcpAppFrameSite("https://notmossbotai.com")?.host).toBe("notmossbotai.com");
    expect(parseMcpAppFrameSite("https://mossbotai.com.example.com")?.host).toBe(
      "mossbotai.com.example.com",
    );
  });

  it("refuses private-use suffixes", () => {
    for (const value of [
      "https://printer.local",
      "https://wiki.corp",
      "https://router.home.arpa",
      "https://intranet.internal",
      "https://x.localhost",
      "https://abc.onion",
      "https://test.invalid",
    ]) {
      expect(parseMcpAppFrameSite(value), value).toBe(null);
    }
  });

  it("refuses wildcards over shared public suffixes but not their subdomains", () => {
    expect(parseMcpAppFrameSite("https://*.github.io")).toBe(null);
    expect(parseMcpAppFrameSite("https://*.co.uk")).toBe(null);
    expect(parseMcpAppFrameSite("https://*.vercel.app")).toBe(null);
    expect(parseMcpAppFrameSite("https://me.github.io")?.host).toBe("me.github.io");
    expect(parseMcpAppFrameSite("https://*.me.github.io")?.anySubdomain).toBe(true);
    expect(parseMcpAppFrameSite("https://*.bbc.co.uk")?.host).toBe("bbc.co.uk");
  });

  it("filters a declared list into canonical, deduplicated sources", () => {
    expect(
      filterMcpAppFrameSites([
        "https://Maps.Example.com:443",
        "https://maps.example.com",
        "https://a.example.com https://b.example.com",
        "https://claude.ai",
        "http://plain.example.com",
      ]),
    ).toEqual({
      accepted: ["https://maps.example.com", "https://a.example.com", "https://b.example.com"],
      refused: ["https://claude.ai", "http://plain.example.com"],
    });
    expect(filterMcpAppFrameSites([])).toEqual({ accepted: [], refused: [] });
  });
});
