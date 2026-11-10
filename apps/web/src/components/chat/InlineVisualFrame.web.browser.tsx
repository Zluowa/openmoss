// Owns the HTTP-hosted client execution boundary for agent HTML: a browser never builds a
// `srcdoc` frame (it would inherit the page's policy and has no navigation guard); it loads the
// document the server serves, under the page's own `frame-src`.
import "../../index.css";
import { ThreadId, type NativeApi } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { setInlineVisualHost } from "~/lib/inlineVisualHosting";

import { InlineVisualFrame } from "./InlineVisualFrame";

vi.mock("~/env", () => ({ isElectron: false }));
afterEach(() => {
  vi.unstubAllGlobals();
  setInlineVisualHost(null);
});

const VISUAL_ID = `vis_${"a".repeat(32)}`;
const SERVED = "about:blank#served-visual";

function renderVisual(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <InlineVisualFrame
        threadId={ThreadId.makeUnsafe("browser-visual")}
        visual={{
          visualId: VISUAL_ID,
          title: "Untrusted document",
          height: 100,
          byteLength: 30,
          sha256: "a".repeat(64),
        }}
      />
    </QueryClientProvider>,
  );
}

it("loads the server's document instead of building a srcdoc frame in an HTTP-hosted browser", async () => {
  const getInlineVisual = vi.fn(async () => ({
    visualId: VISUAL_ID,
    html: "<script>parent.postMessage({ probeExecuted: true }, '*')</script>",
  }));
  vi.stubGlobal("nativeApi", { orchestration: { getInlineVisual } } as unknown as NativeApi);
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ url: SERVED }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const client = new QueryClient();
  const screen = await renderVisual(client);
  try {
    await expect
      .poll(() => document.querySelector("iframe[data-inline-visual-frame]")?.getAttribute("src"))
      .toBe(SERVED);
    const frame = document.querySelector("iframe[data-inline-visual-frame]")!;
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(requests.some((url) => url.includes("/api/inline-visual?"))).toBe(true);
    expect(requests.some((url) => url.includes(`visualId=${VISUAL_ID}`))).toBe(true);
    expect(document.body.textContent).not.toContain("HTML visuals are available in Moss desktop");
  } finally {
    await screen.unmount();
    client.clear();
  }
});

it("loads a shared conversation's visual through the host the guest page installs", async () => {
  const frameUrl = vi.fn(async () => "about:blank#shared-visual");
  setInlineVisualHost({ source: async () => "<p>shared</p>", frameUrl });
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const client = new QueryClient();
  const screen = await renderVisual(client);
  try {
    await expect
      .poll(() => document.querySelector("iframe[data-inline-visual-frame]")?.getAttribute("src"))
      .toBe("about:blank#shared-visual");
    expect(frameUrl).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "browser-visual", visualId: VISUAL_ID }),
    );
    // The owner's server is never asked for a frame.
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("/api/inline-visual"))).toBe(
      false,
    );
  } finally {
    await screen.unmount();
    client.clear();
  }
});

it("shows the unavailable notice when no document can be served", async () => {
  setInlineVisualHost({ source: async () => "", frameUrl: async () => null });
  const client = new QueryClient();
  const screen = await renderVisual(client);
  try {
    await expect.element(screen.getByText("Visual unavailable.")).toBeVisible();
    expect(document.querySelector("iframe[data-inline-visual-frame]")).toBeNull();
  } finally {
    await screen.unmount();
    client.clear();
  }
});
