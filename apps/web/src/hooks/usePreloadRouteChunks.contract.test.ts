import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("route chunk preload contract", () => {
  it("warms route modules without creating disposable router matches", () => {
    const source = readFileSync(new URL("./usePreloadRouteChunks.ts", import.meta.url), "utf8");

    expect(source).not.toContain("router.preloadRoute");
    expect(source).not.toContain("chunk-preload");
    expect(source).toContain('import("../routes/_chat.$threadId?tsr-split=component")');
    expect(source).toContain('import("../routes/_chat.settings?tsr-split=component")');
  });
});
