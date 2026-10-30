import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveInlineVisualizationFrameUrl } from "./inlineVisualizationFrameUrl";

afterEach(() => vi.unstubAllGlobals());

describe("resolveInlineVisualizationFrameUrl", () => {
  it("returns only the server-issued content-locked URL", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              url: "http://localhost:5173/api/inline-visualization/frame?sha256=abc",
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      resolveInlineVisualizationFrameUrl({ threadId: "thread-1", path: "/tmp/chart.html" }),
    ).resolves.toContain("sha256=abc");
  });

  it("does not request a missing marker path", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      resolveInlineVisualizationFrameUrl({ threadId: "thread-1", path: undefined }),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
