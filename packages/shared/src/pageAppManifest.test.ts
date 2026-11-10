import { describe, expect, it } from "vitest";

import { readPageAppManifest, writePageAppManifest } from "./pageAppManifest";

describe("page app manifest", () => {
  it("reads the manifest block, falling back to <title> and meta description", () => {
    const html = `<!doctype html><html><head><title>Fallback &amp; title</title>
      <meta name="description" content="From meta">
      <script type="application/json" id="moss-app-manifest">{"capabilities":{"db":{}}}</script></head></html>`;
    expect(readPageAppManifest(html)).toEqual({
      title: "Fallback & title",
      description: "From meta",
      capabilities: { db: {} },
    });
  });

  it("ignores a malformed manifest", () => {
    const html = `<script type="application/json" id="moss-app-manifest">{nope</script><title>T</title>`;
    expect(readPageAppManifest(html)).toEqual({ title: "T" });
  });

  it("writes into <head>, replaces an existing block and cannot be broken out of", () => {
    const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
    const once = writePageAppManifest(html, {
      title: "</script><b>",
      description: "",
      capabilities: { ai: {} },
    });
    expect(once).toContain('<script type="application/json" id="moss-app-manifest">');
    expect(once.indexOf("moss-app-manifest")).toBeLessThan(once.indexOf("</head>"));
    expect(once).not.toContain("</script><b>");
    expect(readPageAppManifest(once)).toEqual({
      title: "</script><b>",
      description: "",
      capabilities: { ai: {} },
    });
    const twice = writePageAppManifest(once, { title: "New", capabilities: {} });
    expect(twice.match(/moss-app-manifest/g)).toHaveLength(1);
    expect(readPageAppManifest(twice).title).toBe("New");
  });

  it("handles fragments without a head", () => {
    const out = writePageAppManifest("<div>hi</div>", { title: "Frag" });
    expect(out.startsWith("<script")).toBe(true);
    expect(readPageAppManifest(out).title).toBe("Frag");
  });
});
