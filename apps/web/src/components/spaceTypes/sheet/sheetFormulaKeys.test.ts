import { describe, expect, it } from "vitest";

import { toggleReferenceAt } from "./sheetFormulaKeys";

const cycle = (text: string, caret: number, times: number) => {
  let now = { text, caret };
  const seen: string[] = [];
  for (let i = 0; i < times; i++) {
    now = toggleReferenceAt(now.text, now.caret) ?? now;
    seen.push(now.text);
  }
  return seen;
};

describe("F4 in the formula field", () => {
  it("steps the reference at the caret through the four anchorings", () => {
    expect(cycle("=A1+B2", 2, 4)).toEqual(["=$A$1+B2", "=A$1+B2", "=$A1+B2", "=A1+B2"]);
  });

  it("moves both ends of a range together and keeps the caret after it", () => {
    expect(toggleReferenceAt("=SUM(B2:C9)", 8)).toEqual({ text: "=SUM($B$2:$C$9)", caret: 14 });
    expect(toggleReferenceAt("=SUM($B$2:$C$9)", 14)?.text).toBe("=SUM(B$2:C$9)");
  });

  it("works on a reference to another sheet", () => {
    expect(toggleReferenceAt("=Sheet2!D4*2", 9)?.text).toBe("=Sheet2!$D$4*2");
  });

  it("leaves names, function calls, strings and plain text alone", () => {
    expect(toggleReferenceAt("=LOG10(100)", 5)).toBeNull();
    expect(toggleReferenceAt('="A1"&B1', 3)).toBeNull();
    expect(toggleReferenceAt("A1", 1)).toBeNull();
    expect(toggleReferenceAt("=1+2", 3)).toBeNull();
  });
});
