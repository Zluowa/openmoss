import { describe, expect, it } from "vitest";

import { parseMossSurface, withMossSurface } from "./mossSurfaceState";

describe("mossSurfaceState", () => {
  it("accepts only shell destinations from URL search", () => {
    expect(parseMossSurface({ mossSurface: "images" })).toBe("images");
    expect(parseMossSurface({ mossSurface: "library" })).toBe("library");
    expect(parseMossSurface({ mossSurface: "plugins" })).toBeNull();
    expect(parseMossSurface(null)).toBeNull();
  });

  it("preserves unrelated search keys while setting and clearing the surface", () => {
    const base = { view: "editor", mossSurface: "images" } as Record<string, unknown>;
    expect(withMossSurface(base, "library")).toEqual({ view: "editor", mossSurface: "library" });
    expect(withMossSurface(base, null)).toEqual({ view: "editor" });
  });
});
