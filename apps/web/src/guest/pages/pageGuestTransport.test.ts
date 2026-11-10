import { PageId } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";

import { createHttpPageGuestTransport } from "./pageGuestTransport";

const request = {
  pageId: PageId.makeUnsafe("page-1"),
  revision: 2,
  itemId: "lib-one",
  visitor: "visitor-fixture",
  key: "fixture-secret",
};

describe("page media transport", () => {
  it("keeps credentials in POST body and accepts only bounded raster blobs", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    const transport = createHttpPageGuestTransport("share-fixture", fetcher);
    const result = await transport.media(request);
    expect(result.ok).toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("/v1/shares/share-fixture/guest/page-media");
    expect(String(url)).not.toContain(request.key);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(request);
    if (result.ok) expect(result.value.type).toBe("image/png");
  });

  it.each(["text/html", "image/svg+xml", "video/mp4"])(
    "refuses %s success bodies",
    async (type) => {
      const transport = createHttpPageGuestTransport(
        "fixture",
        async () => new Response("unsafe", { headers: { "content-type": type } }),
      );
      expect(await transport.media(request)).toEqual({
        ok: false,
        failure: { kind: "refused", reason: "unavailable" },
      });
    },
  );

  it("preserves current authorization failures from the owner", async () => {
    const transport = createHttpPageGuestTransport("fixture", async () =>
      Response.json({ reason: "forbidden" }, { status: 403 }),
    );
    expect(await transport.media(request)).toEqual({
      ok: false,
      failure: { kind: "refused", reason: "forbidden" },
    });
  });
});
