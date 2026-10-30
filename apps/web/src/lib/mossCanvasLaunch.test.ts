import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeMossCanvasIntegration,
  launchMossCanvasDesktop,
  MOSS_CANVAS_APP_CANDIDATES,
  MOSS_CANVAS_SOURCE_HOME,
  probeMossCanvasDevEmbed,
} from "./mossCanvasLaunch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mossCanvasLaunch", () => {
  it("points at the real moss-canvas source home", () => {
    expect(MOSS_CANVAS_SOURCE_HOME).toContain("moss-canvas");
    expect(MOSS_CANVAS_APP_CANDIDATES[0]).toBe("/Applications/Moss Canvas.app");
    expect(describeMossCanvasIntegration().toLowerCase()).not.toContain("draft-card");
  });

  it("prefers mossCanvasBridge.open", async () => {
    const open = vi.fn(async () => undefined);
    vi.stubGlobal("window", { mossCanvasBridge: { open }, dispatchEvent: vi.fn() });
    await expect(launchMossCanvasDesktop("images")).resolves.toEqual({
      ok: true,
      via: "mossCanvasBridge",
    });
    expect(open).toHaveBeenCalledWith({ source: "moss-synara", surface: "images" });
  });

  it("uses desktopBridge.openMossCanvasApp when bridge APIs are absent", async () => {
    const openMossCanvasApp = vi.fn(async () => true);
    vi.stubGlobal("window", {
      desktopBridge: { openMossCanvasApp },
      dispatchEvent: vi.fn(),
    });
    await expect(launchMossCanvasDesktop()).resolves.toEqual({
      ok: true,
      via: "desktopIpc",
    });
    expect(openMossCanvasApp).toHaveBeenCalled();
  });

  it("falls back to the legacy open-hoola-canvas event", async () => {
    const dispatchEvent = vi.fn(() => true);
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "CustomEvent",
      class CustomEvent {
        type: string;
        detail: unknown;
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
    );
    await expect(launchMossCanvasDesktop("images")).resolves.toEqual({
      ok: true,
      via: "legacyEvent",
    });
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open-hoola-canvas" }),
    );
  });
});

describe("probeMossCanvasDevEmbed", () => {
  it("rejects opaque no-cors style success: requires readable CORS body", async () => {
    const fetchImpl = vi.fn(async () => {
      // Simulate a TypeError that cors mode throws when blocked — must be false, not opaque-true.
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(probeMossCanvasDevEmbed("http://127.0.0.1:5173", fetchImpl)).resolves.toEqual({
      shellReachable: false,
      projectsEmbedReady: false,
      detail: expect.stringContaining("vite probe failed"),
    });
  });

  it("marks Moss Canvas shell HTML reachable but projectsEmbedReady false", async () => {
    const html =
      '<!doctype html><html><head><title>Moss Canvas</title></head><body><div id="root"></div></body></html>';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("__moss/project-info")) {
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const result = await probeMossCanvasDevEmbed("http://127.0.0.1:5173", fetchImpl);
    expect(result.shellReachable).toBe(true);
    expect(result.projectsEmbedReady).toBe(false);
    expect(result.detail.toLowerCase()).toContain("electron");
  });

  it("accepts project-info JSON as shellReachable without enabling bare iframe projects", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, projectDir: "/tmp" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const result = await probeMossCanvasDevEmbed("http://127.0.0.1:5173", fetchImpl);
    expect(result.shellReachable).toBe(true);
    expect(result.projectsEmbedReady).toBe(false);
  });

  it("fails loudly when HTML is not Moss Canvas", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("<html><title>Other</title><body>hi</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const result = await probeMossCanvasDevEmbed("http://127.0.0.1:5173", fetchImpl);
    expect(result.shellReachable).toBe(false);
    expect(result.projectsEmbedReady).toBe(false);
  });
});
