import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { PAGE_APP_PREVIEW_CONTEXT_HEADERS, PAGE_APP_PREVIEW_LIMITS } from "@moss/contracts";
import type { GuestRelayRequest } from "../../guestShare/shareRelayHostClient.ts";
import {
  handlePageGuestRequest,
  pageGuestFailure,
  readBoundedBytes,
  type PageGuestOperations,
} from "./pageGuestHandler.ts";

const issuer = {
  shareId: "A".repeat(22),
  parentOrigin: "https://share.example",
  contentOrigin: "https://apps.example",
};
const token = "A".repeat(43);
const bytes = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
const request = (kind: "open" | "document", text: string): GuestRelayRequest => ({
  method: "POST",
  route: `page-app-preview-${kind}`,
  query: "",
  signal: new AbortController().signal,
  headers: {
    [PAGE_APP_PREVIEW_CONTEXT_HEADERS.parent]: issuer.parentOrigin,
    [PAGE_APP_PREVIEW_CONTEXT_HEADERS.content]: issuer.contentOrigin,
    [PAGE_APP_PREVIEW_CONTEXT_HEADERS.kind]: kind,
    "content-type": kind === "open" ? "application/json" : "application/x-www-form-urlencoded",
  },
  body: bytes(text),
});
const harness = () => {
  const open = vi.fn(() => Effect.fail(pageGuestFailure("unavailable")));
  const document = vi.fn(() =>
    Effect.succeed({
      bytes: new TextEncoder().encode("<h1>Coral</h1>"),
      headers: { "content-type": "text/html; charset=utf-8" },
      declaredResourcesOffline: true,
    }),
  );
  const unavailable = () => Effect.fail(pageGuestFailure("unavailable"));
  const operations: PageGuestOperations = {
    view: unavailable,
    media: unavailable,
    comments: unavailable,
    access: unavailable,
    preview: { issuer: () => issuer, open, document },
  };
  return { operations, open, document };
};
describe("readonly preview request decoding", () => {
  it("accepts only two bounded form fields, without putting them in the returned HTML", async () => {
    const { operations, document } = harness();
    const result = await Effect.runPromise(
      handlePageGuestRequest(
        operations,
        request("document", new URLSearchParams({ ticket: token, frameSecret: token }).toString()),
      ),
    );
    expect(result.status).toBe(200);
    expect(document).toHaveBeenCalledWith({ ticket: token, frameSecret: token });
    const html = await new Response(result.body).text();
    expect(html).toBe("<h1>Coral</h1>");
    expect(html).not.toContain(token);
  });
  it.each([
    ["duplicate", `ticket=${token}&ticket=${token}&frameSecret=${token}`],
    ["extra", `ticket=${token}&frameSecret=${token}&path=private`],
    ["missing", `ticket=${token}`],
    ["malformed", "ticket=short&frameSecret=short"],
    ["oversized", "x".repeat(PAGE_APP_PREVIEW_LIMITS.documentBodyBytes + 1)],
  ])("rejects %s form fields", async (_label, form) => {
    const { operations, document } = harness();
    const result = await Effect.runPromise(
      handlePageGuestRequest(operations, request("document", form)),
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(document).not.toHaveBeenCalled();
  });
  it("rejects URL credentials, wrong methods/types and missing trusted context before decoding", async () => {
    const { operations, document } = harness();
    for (const change of [
      { query: "ticket=fixture" },
      { method: "GET" as const },
      { headers: { "content-type": "text/html" } },
    ]) {
      const result = await Effect.runPromise(
        handlePageGuestRequest(operations, { ...request("document", "invalid"), ...change }),
      );
      expect(result.status).toBeGreaterThanOrEqual(400);
    }
    expect(document).not.toHaveBeenCalled();
  });
  it("cancels a slow bounded reader and releases its stream lock", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const abort = new AbortController();
    const promise = Effect.runPromise(readBoundedBytes(body, 16), { signal: abort.signal });
    const rejected = expect(promise).rejects.toBeDefined();
    await Promise.resolve();
    abort.abort();
    await rejected;
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
