import { describe, expect, it, vi } from "vitest";
import { pageAppContentSecurityPolicy } from "@moss/shared/pageAppContentPolicy";
import type { AuthorizedReadonlyAppItem } from "./PageSharingService.ts";
import {
  preparePageAppPreviewDocument,
  APP_PREVIEW_DOCUMENT_MAX_BYTES,
} from "./pageAppPreviewDocument.ts";

const document: AuthorizedReadonlyAppItem = {
  source: { sourceKind: "page-item", pageId: "fixture", pageRevision: 1, dataRevision: 1 },
  html: "<!doctype html><h1>Coral 文档</h1>",
  publicMetadata: { title: "Coral", revision: 1 },
  availableCapabilities: [],
};
const context = {
  issuer: {
    shareId: "A".repeat(22),
    parentOrigin: "https://share.example",
    contentOrigin: "https://apps.example",
  },
  frameNonce: "frame-nonce-fixture",
  frameExpiresAt: "2026-11-06T12:05:00.000Z",
};
const signal = () => new AbortController().signal;

describe("readonly preview document preparation", () => {
  it("uses actual UTF-8 bytes, a capability-free SDK and a strict response CSP", async () => {
    const result = await preparePageAppPreviewDocument(document, context, signal());
    const html = new TextDecoder().decode(result.bytes);
    expect(html).toContain("Coral 文档");
    expect(html).toContain('kind":"loaded"');
    expect(html).toContain(context.frameNonce);
    expect(html).not.toContain("fixture-share-proof");
    expect(html).not.toContain("availableCapabilities");
    expect(Number(result.headers["content-length"])).toBe(Buffer.byteLength(html));
    expect(result.headers["content-security-policy"]).toContain(
      "frame-ancestors https://share.example",
    );
    expect(result.headers["content-security-policy"]).toContain(
      "sandbox allow-scripts allow-forms",
    );
    expect(result.headers["content-security-policy"]).not.toContain("allow-popups");
    expect(result.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(result.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(result.headers).not.toHaveProperty("set-cookie");
    expect(result.headers).not.toHaveProperty("x-frame-options");
    expect(
      pageAppContentSecurityPolicy({ parentOrigin: context.issuer.parentOrigin, opaque: true }),
    ).toContain("allow-popups");
  });
  it("reuses exact shipped D3 bytes and its license without making network requests", async () => {
    const result = await preparePageAppPreviewDocument(
      {
        ...document,
        html: '<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><h1>Chart</h1>',
      },
      context,
      signal(),
    );
    const html = new TextDecoder().decode(result.bytes);
    expect(html).toContain('data-moss-local-library="D3@7.9.0"');
    expect(html).toContain("Copyright 2010-2023 Mike Bostock");
    expect(result.declaredResourcesOffline).toBe(true);
  });
  it("does not claim unknown resource versions are offline", async () => {
    const readLibrary = vi.fn(async () => null);
    const result = await preparePageAppPreviewDocument(
      {
        ...document,
        html: '<script src="https://cdn.jsdelivr.net/npm/d3@999/dist/d3.min.js"></script>',
      },
      context,
      signal(),
      { readLibrary },
    );
    expect(result.declaredResourcesOffline).toBe(false);
    expect(readLibrary).not.toHaveBeenCalled();
  });
  it("rejects final UTF-8 overflow rather than returning a partial document", async () => {
    await expect(
      preparePageAppPreviewDocument(
        { ...document, html: "中".repeat(Math.floor(APP_PREVIEW_DOCUMENT_MAX_BYTES / 3)) },
        context,
        signal(),
      ),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("does not read static resources after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const readLibrary = vi.fn(async () => null);
    await expect(
      preparePageAppPreviewDocument(document, context, controller.signal, { readLibrary }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(readLibrary).not.toHaveBeenCalled();
  });
});
