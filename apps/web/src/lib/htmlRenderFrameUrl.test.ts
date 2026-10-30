import { verifyHtmlRenderFrameAccess } from "@synara/shared/htmlRenderFrameAccess";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resetHtmlRenderFrameUrlCacheForTests,
  resolveHtmlRenderFrameUrl,
} from "./htmlRenderFrameUrl";

const PAGE = "thread-1-00000000-0000-4000-8000-000000000001";

afterEach(() => {
  vi.unstubAllGlobals();
  resetHtmlRenderFrameUrlCacheForTests();
});

describe("resolveHtmlRenderFrameUrl", () => {
  it("keeps a same-origin attachment URL when the session carries no startup token", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });

    await expect(resolveHtmlRenderFrameUrl(PAGE, 1_800_000_000_000)).resolves.toBe(
      `http://localhost:5173/attachments/${PAGE}.html`,
    );
  });

  it("replaces the desktop startup token with a signature for this page only", async () => {
    vi.stubGlobal("window", {
      location: { origin: "moss://app" },
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:3773/?token=desktop-secret" },
    });
    const nowMs = 1_800_000_000_000;

    const url = new URL((await resolveHtmlRenderFrameUrl(PAGE, nowMs)) ?? "");

    expect(url.origin).toBe("http://127.0.0.1:3773");
    expect(url.pathname).toBe(`/attachments/${PAGE}.html`);
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.toString()).not.toContain("desktop-secret");
    await expect(
      verifyHtmlRenderFrameAccess({
        token: "desktop-secret",
        relativePath: `${PAGE}.html`,
        expires: url.searchParams.get("expires"),
        signature: url.searchParams.get("signature"),
        nowMs,
      }),
    ).resolves.toBe(true);
  });

  it("reuses a signed page URL until it has less than five minutes remaining", async () => {
    vi.stubGlobal("window", {
      location: { origin: "moss://app" },
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:3773/?token=desktop-secret" },
    });
    const mintedAt = 1_800_000_000_000;

    const first = await resolveHtmlRenderFrameUrl(PAGE, mintedAt);
    const healthy = await resolveHtmlRenderFrameUrl(PAGE, mintedAt + 4 * 60_000);
    const nearExpiry = await resolveHtmlRenderFrameUrl(PAGE, mintedAt + 5 * 60_000 + 1);

    expect(healthy).toBe(first);
    expect(nearExpiry).not.toBe(first);
  });

  it("returns null when the page cannot be addressed", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });

    await expect(resolveHtmlRenderFrameUrl("../secret", 1_800_000_000_000)).resolves.toBeNull();
  });
});
