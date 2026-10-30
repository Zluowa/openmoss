import { describe, expect, it, vi } from "vitest";

import {
  createSingleFlightPluginExternalOpener,
  normalizePluginExternalUrl,
} from "./pluginExternalLink";

describe("plugin external links", () => {
  it("accepts only absolute HTTP(S) setup URLs", () => {
    expect(normalizePluginExternalUrl("https://example.com/connect")).toBe(
      "https://example.com/connect",
    );
    expect(normalizePluginExternalUrl("http://localhost:3000/connect")).toBe(
      "http://localhost:3000/connect",
    );
    expect(normalizePluginExternalUrl("javascript:alert(1)")).toBeNull();
    expect(normalizePluginExternalUrl("file:///tmp/token")).toBeNull();
    expect(normalizePluginExternalUrl("example.com/connect")).toBeNull();
  });

  it("coalesces repeated opens until the desktop opener settles", async () => {
    let release: ((value: boolean) => void) | undefined;
    const open = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const singleFlight = createSingleFlightPluginExternalOpener(open);
    const first = singleFlight("https://example.com/connect");
    const second = singleFlight("https://example.com/connect");

    expect(first).toBe(second);
    expect(open).toHaveBeenCalledTimes(1);
    release?.(true);
    await first;
  });
});
