import { PageId, PAGE_APP_PREVIEW_LIMITS } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";
import { createGuestAppPreviewTransport } from "./guestAppPreviewTransport";

const request = {
  visitor: "visitor-fixture",
  key: "private-proof-fixture",
  pageId: PageId.makeUnsafe("app-page"),
  expectedPageRevision: 1,
  frameSecretHash: "A".repeat(43),
  frameNonce: "nonce-fixture-123456",
};
const receipt = {
  ticket: "B".repeat(43),
  ticketExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  frameExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  source: { sourceKind: "page-item", pageId: request.pageId, pageRevision: 1, dataRevision: 1 },
  publicMetadata: { title: "Coral", revision: 1 },
};
describe("guest preview HTTP transport", () => {
  it("keeps proof/hash in an abortable bounded POST without cookies, redirects or URL secrets", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(receipt));
    const transport = createGuestAppPreviewTransport("A".repeat(22), fetcher);
    const abort = new AbortController();
    expect(await transport.open(request, abort.signal)).toEqual({ ok: true, value: receipt });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/v1/shares/${"A".repeat(22)}/guest/page-app-preview-open`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: abort.signal,
    });
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });
  it.each([
    null,
    {},
    { available: false, protocolVersion: 1, contentOrigin: "https://apps.example" },
    { available: true, protocolVersion: 2, contentOrigin: "https://apps.example" },
    { available: true, protocolVersion: 1, contentOrigin: 42 },
  ])("does not advertise invalid/disabled config %#", async (value) => {
    expect(
      await createGuestAppPreviewTransport("fixture", async () => Response.json(value)).config(
        new AbortController().signal,
      ),
    ).toBeNull();
  });
  it("accepts the current relay capability only", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ available: true, protocolVersion: 1, contentOrigin: "https://apps.example" }),
    );
    expect(
      await createGuestAppPreviewTransport("fixture", fetcher).config(new AbortController().signal),
    ).toEqual({ protocolVersion: 1, contentOrigin: "https://apps.example" });
    expect(fetcher.mock.calls[0]![0]).toBe("/v1/app-previews/config");
  });
  it.each(["text/html", "application/octet-stream"])(
    "never accepts a %s executable success body",
    async (type) => {
      const result = await createGuestAppPreviewTransport(
        "fixture",
        async () => new Response("<script>unsafe</script>", { headers: { "content-type": type } }),
      ).open(request, new AbortController().signal);
      expect(result.ok).toBe(false);
    },
  );
  it("cancels an oversized chunked response without trusting content-length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(PAGE_APP_PREVIEW_LIMITS.openBodyBytes + 1));
      },
      cancel,
    });
    const result = await createGuestAppPreviewTransport(
      "fixture",
      async () =>
        new Response(body, {
          headers: { "content-type": "application/json", "content-length": "1" },
        }),
    ).open(request, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it("refuses malformed receipts and abort/network/owner failures without exposing bodies", async () => {
    for (const response of [
      Response.json({ ...receipt, source: { ...receipt.source, dataRevision: 0 } }),
      Response.json({ reason: "forbidden", private: request.key }, { status: 403 }),
    ]) {
      expect(
        (
          await createGuestAppPreviewTransport("fixture", async () => response).open(
            request,
            new AbortController().signal,
          )
        ).ok,
      ).toBe(false);
    }
    expect(
      await createGuestAppPreviewTransport("fixture", async () => {
        throw new Error(request.key);
      }).open(request, new AbortController().signal),
    ).toEqual({ ok: false, failure: { kind: "network" } });
  });
});
