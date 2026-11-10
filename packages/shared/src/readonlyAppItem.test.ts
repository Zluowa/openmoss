// FILE: readonlyAppItem.test.ts
// Purpose: Readonly source identity, capability absence and production CSP parity.
// Layer: Shared tests

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { blankHtmlNonMarkup } from "./htmlMarkup";
import { pageAppMetaContentSecurityPolicy } from "./pageAppContentPolicy";
import { buildPageAppFrameRuntime } from "./pageAppFrameRuntime";
import { isReadonlyAppItemDocument, prepareReadonlyAppItemHtml } from "./readonlyAppItem";

describe("readonly AppItem documents", () => {
  it("keeps the app revision separate from its host page and requires a versioned owner publication", () => {
    const source = {
      sourceKind: "page-app" as const,
      pageId: "p1",
      pageRevision: 2,
      appId: "a1",
      appRevision: 7,
      publicationId: "b9e11b56-935a-444e-83f4-a3ef31da8fd2",
      generation: 3,
    };
    const doc = {
      source,
      html: "<p>Published</p>",
      publicMetadata: { title: "Public", revision: 7 },
    };
    expect(isReadonlyAppItemDocument(doc)).toBe(true);
    expect(
      isReadonlyAppItemDocument({ ...doc, publicMetadata: { title: "Public", revision: 2 } }),
    ).toBe(false);
    expect(isReadonlyAppItemDocument({ ...doc, source: { ...source, generation: 0 } })).toBe(false);
  });
  it("requires a real typed-page data revision rather than a page_apps id", () => {
    const document = {
      source: {
        sourceKind: "page-item" as const,
        pageId: "page-one",
        pageRevision: 3,
        dataRevision: 2,
      },
      html: "<p>One</p>",
      publicMetadata: { title: "One", revision: 3 },
    };
    expect(isReadonlyAppItemDocument(document)).toBe(true);
    expect(
      isReadonlyAppItemDocument({ ...document, source: { ...document.source, dataRevision: 4 } }),
    ).toBe(false);
    expect(
      isReadonlyAppItemDocument({ ...document, publicMetadata: { title: "One", revision: 2 } }),
    ).toBe(false);
    expect(
      isReadonlyAppItemDocument({
        ...document,
        source: { sourceKind: "template-preview", templateId: "fixture" },
        publicMetadata: { title: "One", revision: null },
      }),
    ).toBe(true);
  });

  it("serves no capabilities and starts no broker timers, observers or network", async () => {
    const target = {};
    const timer = vi.fn();
    runInNewContext(buildPageAppFrameRuntime({ parentOrigin: "http://localhost", plugins: [] }), {
      window: target,
      setTimeout: timer,
    });
    const moss = (target as { moss?: { use: (name: string) => Promise<unknown> } }).moss!;
    for (const name of [
      "db",
      "ai",
      "downloads",
      "user",
      "permissions",
      "page",
      "assets",
      "room",
      "connectors",
    ])
      expect(await moss.use(name)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(target, "moss")?.writable).toBe(false);
    expect(timer).not.toHaveBeenCalled();
  });

  it("inserts policy and readonly runtime before real scripts, ignoring inert heads", () => {
    const html =
      "<!--<head>--><template><head>inert</head></template><html><head><script>app()</script></head></html>";
    const result = prepareReadonlyAppItemHtml(html);
    expect(result.indexOf('http-equiv="Content-Security-Policy"')).toBeGreaterThan(
      result.indexOf("<html><head>"),
    );
    expect(result.indexOf('Object.defineProperty(window,"moss"')).toBeLessThan(
      result.indexOf("app()"),
    );
    const early = prepareReadonlyAppItemHtml("<html><script>early()</script><head></head></html>");
    expect(early.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(
      early.indexOf("early()"),
    );
  });

  it("keeps the actual static host CSP identical to the shared production policy", () => {
    const html = readFileSync(
      new URL("../../../apps/web/public/space-app-preview.html", import.meta.url),
      "utf8",
    );
    const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/iu.exec(blankHtmlNonMarkup(html))?.[1] ?? "";
    const policies = [...head.matchAll(/<meta\s[^>]*>/giu)]
      .map(([tag]) => tag)
      .filter((tag) => /\shttp-equiv="Content-Security-Policy"/iu.test(tag))
      .map((tag) => /\scontent="([^"]*)"/iu.exec(tag)?.[1]);
    expect(policies).toEqual([pageAppMetaContentSecurityPolicy()]);
    expect(html).not.toContain("allow-same-origin");
  });
});
