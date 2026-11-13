import { describe, expect, it } from "vitest";

import { cellHistoryEntries } from "./sheetCellHistory.logic";

const v = (
  revision: number,
  shown: string | null,
  author: "local-user" | "agent" = "local-user",
) => ({
  revision,
  createdAt: `2026-11-13T0${revision}:00:00.000Z`,
  author,
  shown,
});

describe("a cell's edit history", () => {
  it("keeps the versions where the cell changed, newest first", () => {
    const entries = cellHistoryEntries([
      v(6, "1,720", "agent"),
      v(5, "1,500"),
      v(4, "1,500"),
      v(3, null),
      v(2, "800"),
      v(1, null),
    ]);
    expect(entries.map((e) => [e.revision, e.shown, e.author])).toEqual([
      [6, "1,720", "agent"],
      // The cell came to hold 1,500 in version 4; version 5 left it as it was.
      [4, "1,500", "local-user"],
      [3, null, "local-user"],
      [2, "800", "local-user"],
    ]);
  });

  it("names the oldest version read only when the cell held something there", () => {
    expect(cellHistoryEntries([v(2, "x"), v(1, "x")]).map((e) => e.revision)).toEqual([1]);
    expect(cellHistoryEntries([v(1, null)])).toEqual([]);
  });
});
