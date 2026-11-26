import { describe, expect, it } from "vitest";

import {
  parsePageAppDesktopConfig,
  readPageAppDesktopPermissions,
  readPageAppManifest,
  writePageAppManifest,
} from "./pageAppManifest";

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

  it("parses and filters desktop capability config and permissions whitelist", () => {
    const html = `<script type="application/json" id="moss-app-manifest">${JSON.stringify({
      title: "Desktop Timer",
      capabilities: {
        desktop: {
          permissions: [
            "notifications",
            "bogus-perm",
            "shortcuts",
            "overlay",
            "menu-bar",
            "full-access",
            "notifications",
            `overlay${"x".repeat(60)}`,
          ],
          window: { width: 420, height: 320, frame: false },
        },
      },
    })}</script>`;

    const manifest = readPageAppManifest(html);
    expect(manifest.permissions).toEqual([
      "notifications",
      "shortcuts",
      "overlay",
      "menu-bar",
      "full-access",
    ]);
    expect(manifest.desktop).toEqual({
      permissions: ["notifications", "shortcuts", "overlay", "menu-bar", "full-access"],
      window: { width: 420, height: 320, frame: false },
    });
    expect(readPageAppDesktopPermissions(html)).toEqual([
      "notifications",
      "shortcuts",
      "overlay",
      "menu-bar",
      "full-access",
    ]);
  });

  it("caps permissions at 32 items and ignores manifests exceeding 16,000 chars", () => {
    const over32 = [...Array.from({ length: 32 }, (_, i) => `invalid-${i}`), "notifications"];
    expect(parsePageAppDesktopConfig({ permissions: over32 })).toEqual({ permissions: [] });

    const oversizedPayload = JSON.stringify({
      title: "Too Big",
      description: "a".repeat(16_001),
      capabilities: { desktop: { permissions: ["notifications"] } },
    });
    const oversizedHtml = `<title>Fallback</title><script type="application/json" id="moss-app-manifest">${oversizedPayload}</script>`;
    expect(readPageAppManifest(oversizedHtml)).toEqual({ title: "Fallback" });
  });

  it("round-trips top-level desktop permissions cleanly", () => {
    const html = "<html><head></head><body></body></html>";
    const written = writePageAppManifest(html, {
      title: "HUD",
      capabilities: { desktop: { permissions: ["overlay", "menu-bar"] } },
      permissions: ["overlay", "menu-bar"],
    });
    const read = readPageAppManifest(written);
    expect(read.permissions).toEqual(["overlay", "menu-bar"]);
    expect(read.capabilities?.desktop).toEqual({ permissions: ["overlay", "menu-bar"] });
  });
});
