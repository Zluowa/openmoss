import { describe, expect, it } from "vitest";

import { isImeComposingKeyEvent } from "./imeKeyEvent";

// The fields a DOM KeyboardEvent carries (unit tests run without a DOM).
function keydown(
  init: { key: string; isComposing?: boolean },
  keyCode: number,
): { key: string; isComposing: boolean; keyCode: number; which: number } {
  return { key: init.key, isComposing: init.isComposing ?? false, keyCode, which: keyCode };
}

describe("isImeComposingKeyEvent", () => {
  it("knows the Windows confirming key (Process, 229)", () => {
    expect(isImeComposingKeyEvent(keydown({ key: "Process" }, 229))).toBe(true);
  });

  it("knows the macOS and Linux confirming key (Enter while composing, 229)", () => {
    expect(isImeComposingKeyEvent(keydown({ key: "Enter", isComposing: true }, 229))).toBe(true);
  });

  it("knows Safari's confirming key after compositionend (229, not composing)", () => {
    expect(isImeComposingKeyEvent(keydown({ key: "Enter", isComposing: false }, 229))).toBe(true);
  });

  it("reads React's synthetic event through nativeEvent", () => {
    const nativeEvent = keydown({ key: "Enter", isComposing: true }, 229);
    expect(isImeComposingKeyEvent({ key: "Enter", keyCode: 229, nativeEvent })).toBe(true);
    expect(isImeComposingKeyEvent({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(true);
  });

  it("lets a plain Enter, Tab, Escape or arrow through", () => {
    for (const key of ["Enter", "Tab", "Escape", "ArrowDown"]) {
      const keyCode = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40 }[key]!;
      expect(isImeComposingKeyEvent(keydown({ key }, keyCode)), key).toBe(false);
      expect(
        isImeComposingKeyEvent({ key, keyCode, nativeEvent: keydown({ key }, keyCode) }),
        key,
      ).toBe(false);
    }
  });
});
