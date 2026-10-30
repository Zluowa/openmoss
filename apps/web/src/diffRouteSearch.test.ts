import { MessageId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { diffRouteSearchEquals, parseDiffRouteSearch } from "./diffRouteSearch";

describe("diffRouteSearchEquals", () => {
  it("detects editor route and selected file changes", () => {
    expect(diffRouteSearchEquals({}, { view: "editor" })).toBe(false);
    expect(
      diffRouteSearchEquals(
        { view: "editor", editorFilePath: "src/first.ts" },
        { view: "editor", editorFilePath: "src/second.ts" },
      ),
    ).toBe(false);
    expect(
      diffRouteSearchEquals(
        { view: "editor", editorFilePath: "src/first.ts" },
        { view: "editor", editorFilePath: "src/first.ts" },
      ),
    ).toBe(true);
  });

  it("detects Moss shell route changes", () => {
    expect(diffRouteSearchEquals({}, { mossShell: "1" })).toBe(false);
    expect(diffRouteSearchEquals({ mossShell: "1" }, { mossShell: "1" })).toBe(true);
  });

  it("detects shell destination changes", () => {
    expect(diffRouteSearchEquals({}, { mossSurface: "images" })).toBe(false);
    expect(diffRouteSearchEquals({ mossSurface: "library" }, { mossSurface: "library" })).toBe(
      true,
    );
  });
});

describe("parseDiffRouteSearch", () => {
  it("treats numeric and boolean diff toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      panel: "diff",
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: true,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      panel: "diff",
      diff: "1",
      diffTurnId: "turn-1",
    });
  });

  it("drops turn and file values when diff is closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("preserves file value for repo diff selections without a turn", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      panel: "diff",
      diff: "1",
      diffFilePath: "src/app.ts",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      panel: "diff",
      diff: "1",
    });
  });

  it("preserves split route state while normalizing unrelated values", () => {
    const parsed = parseDiffRouteSearch({
      panel: "browser",
      diffTurnId: "turn-1",
      splitViewId: " split-1 ",
    });

    expect(parsed).toEqual({
      panel: "browser",
      splitViewId: "split-1",
    });
  });

  it("parses Moss shell route toggles for explicit product access", () => {
    expect(parseDiffRouteSearch({ mossShell: "1" })).toEqual({ mossShell: "1" });
    expect(parseDiffRouteSearch({ mossShell: '"1"' })).toEqual({ mossShell: "1" });
    expect(parseDiffRouteSearch({ mossShell: "on" })).toEqual({ mossShell: "1" });
    expect(parseDiffRouteSearch({ mossShell: true })).toEqual({ mossShell: "1" });
  });

  it("preserves a valid Moss destination across thread route validation", () => {
    expect(parseDiffRouteSearch({ mossSurface: "images", panel: "browser" })).toEqual({
      mossSurface: "images",
      panel: "browser",
    });
    expect(parseDiffRouteSearch({ mossSurface: "unknown" })).toEqual({});
  });

  it("keeps the Moss shell route default-off for closed or invalid values", () => {
    expect(parseDiffRouteSearch({ mossShell: "0" })).toEqual({});
    expect(parseDiffRouteSearch({ mossShell: "off" })).toEqual({});
    expect(parseDiffRouteSearch({ mossShell: "  " })).toEqual({});
  });
});

it("preserves message deep links independently of side-panel state", () => {
  expect(parseDiffRouteSearch({ messageId: " earliest " })).toEqual({ messageId: "earliest" });
  expect(
    diffRouteSearchEquals(
      { messageId: MessageId.makeUnsafe("one") },
      { messageId: MessageId.makeUnsafe("two") },
    ),
  ).toBe(false);
});
