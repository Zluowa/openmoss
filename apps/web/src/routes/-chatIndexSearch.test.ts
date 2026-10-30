import { describe, expect, it } from "vitest";

import { parseChatIndexSearch } from "./_chat.index";

describe("parseChatIndexSearch", () => {
  it("keeps the shell destination while normalizing landing search", () => {
    expect(parseChatIndexSearch({ space: "space-1", fresh: "1", mossSurface: "library" })).toEqual({
      space: "space-1",
      fresh: true,
      mossSurface: "library",
    });
  });

  it("drops invalid shell destinations", () => {
    expect(parseChatIndexSearch({ mossSurface: "plugins", fresh: "0" })).toEqual({});
  });
});
