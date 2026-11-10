// FILE: localLibraries.test.ts
// Purpose: Exact local library versions preserve HTML and reject unavailable substitutions.
// Layer: Server app tests

import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { readInlineVisualizationLibrary } from "../../inlineVisualizationAccess";
import { PAGE_APP_LOCAL_LIBRARIES, preparePageAppLibraries } from "./localLibraries";

const d3 = PAGE_APP_LOCAL_LIBRARIES[0].urls[0];
const chart = PAGE_APP_LOCAL_LIBRARIES[1].urls[0];
const source = (url: string, attributes = "") => `<script src="${url}" ${attributes}></script>`;
const prepare = (html: string) =>
  preparePageAppLibraries(html, undefined, readInlineVisualizationLibrary);

describe("page app local libraries", () => {
  it("inlines the exact shipped D3 and Chart versions with their licenses", async () => {
    const original = `${source(d3)}${source(chart)}<script>window.ready=true;</script>`;
    const result = await prepare(original);
    expect(result.offlineReady).toBe(true);
    expect(result.html).toContain('data-moss-local-library="D3@7.9.0"');
    expect(result.html).toContain('data-moss-local-library="Chart.js@4.5.1"');
    expect(result.html).toContain("Copyright 2010-2023 Mike Bostock");
    expect(result.html).toContain("Released under the MIT License");
    expect(result.html).toContain("<script>window.ready=true;</script>");
    expect(result.html).not.toContain('src="https:');
    expect(original).toContain(source(d3));
  });

  it.each([
    d3.replace("7.9.0", "7"),
    d3.replace("7.9.0", "8.0.0"),
    `${d3}?module`,
    `${d3}#fragment`,
    d3.replace("cdn.jsdelivr.net", "cdn.jsdelivr.net.evil.invalid"),
    d3.replace("https://", "https://user:secret@"),
    d3.replace("dist/d3.min.js", "../private.js"),
  ])("never substitutes another version, host or URL: %s", async (url) => {
    const read = vi.fn(async () => null);
    const html = source(url);
    expect(await preparePageAppLibraries(html, undefined, read)).toEqual({
      html,
      offlineReady: false,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    "defer",
    "async",
    'onload="ready()"',
    'onerror="failed()"',
    'integrity="sha256-example"',
    'type="module"',
  ])(
    "preserves %s loading semantics and marks it as requiring external resources",
    async (attribute) => {
      const html = source(d3, attribute);
      expect(await prepare(html)).toEqual({ html, offlineReady: false });
    },
  );

  it("does not treat comments, attribute values or script text as resource tags", async () => {
    const read = vi.fn(async () => null);
    const html = `<!--${source(d3)}--><script data-note="src='${d3}'">const text=${JSON.stringify(source(d3).replace("</script>", "<\\/script>"))};</script>`;
    expect((await preparePageAppLibraries(html, undefined, read)).html).toBe(html);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not remove only the first of duplicate src attributes", async () => {
    const html = source(d3, `src="https://outside.invalid/second.js"`);
    expect(await prepare(html)).toEqual({ html, offlineReady: false });
  });

  it.each([
    "textarea",
    "title",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "noscript",
    "style",
    "template",
  ])("does not rewrite or count script text inside %s in a full page", async (tag) => {
    const read = vi.fn(async () => null);
    const html = `<!doctype html><html><head><title>Example</title></head><body><${tag}>${source(d3)}</${tag}></body></html>`;
    expect(await preparePageAppLibraries(html, undefined, read)).toEqual({
      html,
      offlineReady: true,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps nested templates byte-identical while localizing the following active script", async () => {
    const inert = `<template><template>${source(d3)}</template>${source(chart)}</template>`;
    const html = `<!doctype html><html><head></head><body>${inert}${source(d3)}</body></html>`;
    const read = vi.fn(readInlineVisualizationLibrary);
    const result = await preparePageAppLibraries(html, undefined, read);
    expect(result.html).toContain(inert);
    expect(result.html.match(/data-moss-local-library=/gu)).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.offlineReady).toBe(true);
  });

  it("still counts active stylesheet URLs as external resources", async () => {
    const html =
      "<html><head><style>p{background:url(https://outside.invalid/image.png)}</style></head><body></body></html>";
    expect(await prepare(html)).toEqual({ html, offlineReady: false });
  });

  it.each(["url(//cdn.example/image.png)", "@import '//cdn.example/style.css';"])(
    "counts protocol-relative CSS resources: %s",
    async (css) => {
      const html = `<html><head><style>${css}</style></head><body></body></html>`;
      expect(await prepare(html)).toEqual({ html, offlineReady: false });
    },
  );

  it("does not transform a script literal inside a legitimate tag attribute", async () => {
    const html = `<html><head></head><body><div data-example="<script src='${d3}'></script>"></div></body></html>`;
    const read = vi.fn(async () => null);
    expect((await preparePageAppLibraries(html, undefined, read)).html).toBe(html);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {
      contents: new TextEncoder().encode("different package bytes"),
      contentType: "text/javascript",
    },
  ])("keeps missing or modified assets explicitly non-offline", async (file) => {
    const html = source(d3);
    expect(await preparePageAppLibraries(html, undefined, async () => file)).toEqual({
      html,
      offlineReady: false,
    });
  });

  it("reads each approved asset once and bounds expanded responses", async () => {
    const read = vi.fn(readInlineVisualizationLibrary);
    const result = await preparePageAppLibraries(source(d3).repeat(30), undefined, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.html).toContain('data-moss-local-library="D3@7.9.0"');
    expect(Buffer.byteLength(result.html)).toBeLessThan(4.1 * 1024 * 1024);
    expect(result.offlineReady).toBe(false);
  });

  it("uses the configured packaged static directory", async () => {
    const staticDir = fileURLToPath(new URL("../../../../web/public/", import.meta.url));
    const read = vi.fn(readInlineVisualizationLibrary);
    const result = await preparePageAppLibraries(source(d3), staticDir, read);
    expect(read).toHaveBeenCalledWith("d3.min.js", staticDir);
    expect(result.offlineReady).toBe(true);
  });
});
