import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PagesReadResult, PagesRpcError } from "./pages";
import { WebSocketRequest, WS_METHODS } from "./ws";

describe("Pages wire contract", () => {
  it("preserves mutation discriminants and CAS fields in the tagged WebSocket union", () => {
    const common = {
      requestId: "retry-this-write",
      scopeSpaceId: null,
      pageId: "page",
      expectedRevision: 3,
    };
    const operations = [
      {
        op: "create-space",
        requestId: "space-once",
        scopeSpaceId: null,
        title: "Research",
        richContent: "[]",
      },
      {
        op: "create",
        requestId: "page-once",
        scopeSpaceId: null,
        title: "Notes",
        parentPageId: null,
        spaceId: null,
      },
      { op: "update", ...common, content: "Saved body", richContent: null },
      { op: "move", ...common, parentPageId: null, spaceId: null },
      { op: "pin", ...common, pinned: true },
      ...["trash", "restore", "trash-space", "restore-space"].map((op) => ({ op, ...common })),
      { op: "restore-version", ...common, revision: 1 },
      { op: "comment", ...common, content: "Reviewed" },
    ];
    for (const operation of operations) {
      const request = { id: "wire-request", body: { _tag: WS_METHODS.pagesMutate, ...operation } };
      expect(Schema.decodeUnknownSync(WebSocketRequest)(request)).toEqual(request);
    }
    expect(() =>
      Schema.decodeUnknownSync(WebSocketRequest)({
        id: "request",
        body: {
          _tag: WS_METHODS.pagesMutate,
          op: "update",
          requestId: "r",
          scopeSpaceId: null,
          pageId: "page",
          content: "No CAS",
        },
      }),
    ).toThrow();
  });

  it("round-trips a definite conflict with its current revision and excludes internal storage causes", () => {
    const error = new PagesRpcError({
      code: "conflict",
      message: "Page changed",
      currentRevision: 4,
    });
    const encoded = Schema.encodeSync(PagesRpcError)(error);
    const decoded = Schema.decodeUnknownSync(PagesRpcError)(JSON.parse(JSON.stringify(encoded)));
    expect(decoded._tag).toBe("PagesRpcError");
    expect(decoded.code).toBe("conflict");
    expect(decoded.currentRevision).toBe(4);
    expect("cause" in encoded).toBe(false);
  });

  it("retains the optional canonical rich source alongside its readable projection", () => {
    const record = {
      page: {
        id: "page",
        scopeSpaceId: null,
        spaceId: null,
        parentPageId: null,
        rootPageId: "page",
        title: "Rich",
        revision: 1,
        pinned: false,
        trashedAt: null,
        sourceThreadId: null,
        assetIds: [],
        automationIds: [],
        createdAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      },
      content: "# Rich text",
      richContent: '[{"type":"h1","children":[{"text":"Rich text"}]}]',
    };
    expect(Schema.decodeUnknownSync(PagesReadResult)(record)).toEqual(record);
  });
});
