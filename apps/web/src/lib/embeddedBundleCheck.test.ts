import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isEmbeddedBundleVerified,
  resetEmbeddedBundleChecks,
  verifyEmbeddedBundle,
} from "./embeddedBundleCheck";

const A = "http://127.0.0.1:3773/canvas/?moss_host=1&moss_thread=a";
const B = "http://127.0.0.1:3773/canvas/?moss_host=1&moss_thread=b";

beforeEach(() => resetEmbeddedBundleChecks());
afterEach(() => vi.unstubAllGlobals());

describe("embedded bundle check", () => {
  it("remembers a served bundle for every conversation sharing it", async () => {
    const fetchMock = vi.fn(async () => new Response("canvas", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(isEmbeddedBundleVerified(A)).toBe(false);
    expect(await verifyEmbeddedBundle(A)).toBe(true);
    // Another conversation's frame (only the query differs) can start at once.
    expect(isEmbeddedBundleVerified(B)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(A, { method: "GET", credentials: "omit" });
  });

  it("forgets a bundle that is no longer served, so the failure is shown", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("canvas", { status: 200 }))
      .mockResolvedValueOnce(new Response("missing", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await verifyEmbeddedBundle(A)).toBe(true);
    expect(await verifyEmbeddedBundle(B)).toBe(false);
    expect(isEmbeddedBundleVerified(A)).toBe(false);
    expect(await verifyEmbeddedBundle(A)).toBe(false);
  });

  it("checks a bundle served from another origin separately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("canvas", { status: 200 })),
    );
    await verifyEmbeddedBundle(A);
    expect(isEmbeddedBundleVerified("http://127.0.0.1:4000/canvas/?moss_host=1")).toBe(false);
  });
});
