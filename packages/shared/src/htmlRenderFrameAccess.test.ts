import { describe, expect, it } from "vitest";

import {
  HTML_RENDER_FRAME_ACCESS_TTL_MS,
  signHtmlRenderFrameAccess,
  verifyHtmlRenderFrameAccess,
} from "./htmlRenderFrameAccess";

const TOKEN = "startup-token";
const PAGE = "thread-a-00000000-0000-4000-8000-000000000001.html";
const NOW = 1_800_000_000_000;

async function signed(overrides: { relativePath?: string; expiresAtMs?: number } = {}) {
  const expiresAtMs = overrides.expiresAtMs ?? NOW + HTML_RENDER_FRAME_ACCESS_TTL_MS;
  return {
    expires: String(expiresAtMs),
    signature: await signHtmlRenderFrameAccess({
      token: TOKEN,
      relativePath: overrides.relativePath ?? PAGE,
      expiresAtMs,
    }),
  };
}

describe("html render frame access", () => {
  it("accepts a signature for the page it was signed for until it expires", async () => {
    const access = await signed();
    expect(
      await verifyHtmlRenderFrameAccess({
        token: TOKEN,
        relativePath: PAGE,
        ...access,
        nowMs: NOW,
      }),
    ).toBe(true);
    expect(
      await verifyHtmlRenderFrameAccess({
        token: TOKEN,
        relativePath: PAGE,
        ...access,
        nowMs: NOW + HTML_RENDER_FRAME_ACCESS_TTL_MS,
      }),
    ).toBe(false);
  });

  it("never carries the token itself", async () => {
    const access = await signed();
    expect(access.signature).not.toContain(TOKEN);
    expect(access.signature).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("rejects another page, another token, a changed expiry, and malformed input", async () => {
    const access = await signed();
    const verify = (input: {
      token?: string;
      relativePath?: string;
      expires?: string | null;
      signature?: string | null;
    }) =>
      verifyHtmlRenderFrameAccess({
        token: input.token ?? TOKEN,
        relativePath: input.relativePath ?? PAGE,
        expires: input.expires === undefined ? access.expires : input.expires,
        signature: input.signature === undefined ? access.signature : input.signature,
        nowMs: NOW,
      });

    expect(await verify({ relativePath: "thread-a-other.html" })).toBe(false);
    expect(await verify({ token: "other-token" })).toBe(false);
    expect(await verify({ token: "" })).toBe(false);
    expect(await verify({ expires: String(Number(access.expires) - 1) })).toBe(false);
    expect(await verify({ expires: null })).toBe(false);
    expect(await verify({ signature: null })).toBe(false);
    expect(await verify({ expires: "1e20" })).toBe(false);
    expect(await verify({ signature: "not base64url!" })).toBe(false);
  });

  it("rejects an expiry further out than one signing could ask for", async () => {
    const access = await signed({ expiresAtMs: NOW + 24 * 60 * 60_000 });
    expect(
      await verifyHtmlRenderFrameAccess({
        token: TOKEN,
        relativePath: PAGE,
        ...access,
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});
