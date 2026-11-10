import { describe, it, expect, vi } from "vitest";
import { composerFocusBehavior } from "./chatBehavior";
describe("Threebot mobile composer focus", () => {
  it("requires a tap after entry and overlay focus restoration, supports accessibility click", () => {
    const target = { readOnly: false, focus: vi.fn(), blur: vi.fn() },
      focus = composerFocusBehavior(true);
    focus.onEntry(target);
    expect(target.readOnly).toBe(true);
    focus.onFocus(target);
    expect(target.blur).toHaveBeenCalledTimes(2);
    focus.onPointerDown(target);
    expect(target.readOnly).toBe(false);
    focus.onFocus(target);
    focus.onBlur(target);
    expect(target.readOnly).toBe(true);
    focus.onClick(target);
    expect(target.focus).toHaveBeenCalled();
    expect(target.readOnly).toBe(false);
  });
  it("restores desktop focus, and cancels a mobile tap without opening the keyboard", () => {
    const target = { readOnly: false, focus: vi.fn(), blur: vi.fn() };
    composerFocusBehavior(false).onEntry(target);
    expect(target.focus).toHaveBeenCalledOnce();
    const mobile = composerFocusBehavior(true);
    mobile.onEntry(target);
    mobile.onPointerDown(target);
    mobile.onPointerCancel(target);
    expect(target.readOnly).toBe(true);
  });
});
