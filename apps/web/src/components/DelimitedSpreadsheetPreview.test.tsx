import { describe, expect, it } from "vitest";

import { parseDelimited } from "~/lib/preview/workbookModel";

describe("parseDelimited", () => {
  it("handles quoted commas, escaped quotes, and CRLF rows", () => {
    expect(parseDelimited('name,value\r\n"Pass17, fixture","a ""quoted"" value"\r\n', ",")).toEqual(
      [
        ["name", "value"],
        ["Pass17, fixture", 'a "quoted" value'],
      ],
    );
  });

  it("supports tab separated values", () => {
    expect(parseDelimited("name\tvalue\nPass17\t1\n", "\t")).toEqual([
      ["name", "value"],
      ["Pass17", "1"],
    ]);
  });
});
