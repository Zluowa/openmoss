import assert from "node:assert/strict";

import { describe, it } from "vitest";

import nodePath from "node:path";

import { devCentralIconFile, devServerRedirectUrl } from "./http.ts";

describe("devServerRedirectUrl", () => {
  const devUrl = new URL("http://localhost:5733/");

  it("keeps the path, so the page editor's icon masks reach the file", () => {
    assert.equal(
      devServerRedirectUrl(devUrl, new URL("http://localhost:3773/central-icons-reversed/h1.svg")),
      "http://localhost:5733/central-icons-reversed/h1.svg",
    );
  });

  it("keeps the query and sends the root to the root", () => {
    assert.equal(
      devServerRedirectUrl(devUrl, new URL("http://localhost:3773/settings?section=plugins")),
      "http://localhost:5733/settings?section=plugins",
    );
    assert.equal(devServerRedirectUrl(devUrl, new URL("http://localhost:3773/")), devUrl.href);
  });

  it("never leaves the dev origin", () => {
    const target = new URL(
      devServerRedirectUrl(devUrl, new URL("http://localhost:3773//evil.example/x")),
    );
    assert.equal(target.origin, devUrl.origin);
  });
});

describe("devCentralIconFile", () => {
  it("maps the page editor's icon paths into the web app's public folder", () => {
    assert.equal(
      devCentralIconFile("/central-icons-reversed/h1.svg", "/repo/apps/web/public"),
      nodePath.join("/repo/apps/web/public", "central-icons-reversed", "h1.svg"),
    );
    assert.equal(
      devCentralIconFile("/central-icons-fill/sparkles-two.svg", "/p"),
      nodePath.join("/p", "central-icons-fill", "sparkles-two.svg"),
    );
  });

  it("refuses anything that is not one plain icon file", () => {
    for (const pathname of [
      "/central-icons-reversed/../../secrets.svg",
      "/central-icons-reversed/%2e%2e/x.svg",
      "/central-icons-reversed/h1.png",
      "/central-icons-reversed/sub/h1.svg",
      "/other/h1.svg",
      "/",
    ]) {
      assert.equal(devCentralIconFile(pathname, "/p"), null, pathname);
    }
  });

  it("points at a folder that holds the icons in this checkout", async () => {
    const { access } = await import("node:fs/promises");
    await access(devCentralIconFile("/central-icons-reversed/h1.svg")!);
  });
});
