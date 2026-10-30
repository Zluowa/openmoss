import "../../index.css";

import type { SVGProps } from "react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { CheckIcon, XIcon } from "~/lib/icons";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import type { ComposerPickerSize } from "../chat/composerPickerSize";
import { PickerTriggerButton } from "../chat/PickerTriggerButton";
import { Button } from "./button";
import { IconButton } from "./icon-button";
import { Menu, MenuItem, MenuSub, MenuSubPopup, MenuSubTrigger } from "./menu";
import { Toggle } from "./toggle";

// UI glyphs render as `span[data-slot=central-icon]`, brand marks as `<svg>`. These read computed
// styles, so they fail both when a selector names only `svg` and when Tailwind never generated the
// rule. Keep primitive class names out of this file: the Tailwind scan reads it too, and a class
// spelled here would be generated even if the component's own copy were broken.

function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" height="24" viewBox="0 0 24 24" width="24" {...props}>
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

function byTestId(testId: string): HTMLElement | SVGElement {
  const element = document.querySelector<HTMLElement | SVGElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`Missing ${testId}`);
  return element;
}

function rem(value: number): string {
  return `${value * parseFloat(getComputedStyle(document.documentElement).fontSize)}px`;
}

// vitest-browser-react unmounts the previous render before each test, so a failed assertion
// cannot leave a fixture behind for the next one.

describe("icon rules in Button and Toggle", () => {
  it("gives a glyph and a brand mark the Button's inset and leaves hit-testing to the button", async () => {
    await render(
      <Button>
        <CheckIcon data-testid="glyph" />
        Save
        <BrandMark data-testid="mark" />
      </Button>,
    );

    for (const testId of ["glyph", "mark"]) {
      const style = getComputedStyle(byTestId(testId));
      expect(style.marginLeft, testId).toBe(rem(-0.125));
      expect(style.marginRight, testId).toBe(rem(-0.125));
      expect(style.pointerEvents, testId).toBe("none");
      expect(style.flexShrink, testId).toBe("0");
    }
  });

  it("keeps a glyph's own size and tone where the svg fallbacks resize or dim a brand mark", async () => {
    await render(
      <Button size="icon-chip">
        <CheckIcon data-testid="glyph" />
        <BrandMark data-testid="mark" />
      </Button>,
    );

    const glyph = getComputedStyle(byTestId("glyph"));
    const mark = getComputedStyle(byTestId("mark"));
    // The glyph keeps its default 16px and the text colour; only an unsized svg takes the
    // chip's 12px fallback and the 80% dimming.
    expect(glyph.width).toBe(rem(1));
    expect(glyph.opacity).toBe("1");
    expect(mark.width).toBe(rem(0.75));
    expect(mark.opacity).toBe("0.8");
  });

  it("lets IconButton, chrome-outline and picker triggers drop the inset for glyphs", async () => {
    await render(
      <div className="flex flex-col items-start gap-2">
        <IconButton label="Close">
          <XIcon data-testid="icon-button-glyph" />
        </IconButton>
        <Button variant="chrome-outline">
          <CheckIcon data-testid="chrome-outline-glyph" />
          Review
        </Button>
        <PickerTriggerButton
          data-testid="picker-trigger"
          icon={<CheckIcon data-testid="picker-glyph" />}
          label="Model"
        />
      </div>,
    );

    for (const testId of ["icon-button-glyph", "chrome-outline-glyph", "picker-glyph"]) {
      const style = getComputedStyle(byTestId(testId));
      expect(style.marginLeft, testId).toBe("0px");
      expect(style.marginRight, testId).toBe("0px");
    }
    // The picker's own trailing chevron is a glyph too.
    const pickerGlyphs = byTestId("picker-trigger").querySelectorAll('[data-slot="central-icon"]');
    expect(pickerGlyphs.length).toBe(2);
    for (const glyph of pickerGlyphs) expect(getComputedStyle(glyph).marginRight).toBe("0px");
  });

  it("gives a glyph in a Toggle the same inset and hit-testing", async () => {
    await render(
      <Toggle aria-label="Bold">
        <CheckIcon data-testid="glyph" />
      </Toggle>,
    );

    const style = getComputedStyle(byTestId("glyph"));
    expect(style.marginLeft).toBe(rem(-0.125));
    expect(style.pointerEvents).toBe("none");
  });
});

function SubmenuRowFixture({ size }: { size: ComposerPickerSize }) {
  const anchor = { getBoundingClientRect: () => new DOMRect(24, 24, 0, 0) };
  return (
    <Menu open>
      <ComposerPickerMenuPopup anchor={anchor} align="start" side="bottom" fixedWidth size={size}>
        <MenuSub>
          <MenuSubTrigger data-testid="row">
            <BrandMark data-testid="mark" className="size-3 shrink-0" />
            Codex
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem>GPT</MenuItem>
          </MenuSubPopup>
        </MenuSub>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

describe("composer picker submenu row", () => {
  it.each([
    ["normal", 0.75],
    ["small", 0.75],
  ] as const)(
    "ends a %s row with the chevron and leaves a leading brand mark alone",
    async (size, chevronRem) => {
      await render(<SubmenuRowFixture size={size} />);
      await expect.element(page.getByText("Codex", { exact: true })).toBeVisible();

      const row = byTestId("row");
      const chevron = row.lastElementChild as HTMLElement;
      expect(chevron.dataset.slot).toBe("central-icon");
      const chevronStyle = getComputedStyle(chevron);
      expect(chevronStyle.width).toBe(rem(chevronRem));
      expect(chevronStyle.opacity).toBe("0.8");

      const rowRect = row.getBoundingClientRect();
      const rowStyle = getComputedStyle(row);
      const contentLeft = rowRect.left + parseFloat(rowStyle.paddingLeft);
      const contentRight = rowRect.right - parseFloat(rowStyle.paddingRight);
      // Pushed to the row's end; its -2px end margin and the glyph's optical scale let it overhang
      // the padding slightly.
      expect(Math.abs(chevron.getBoundingClientRect().right - contentRight)).toBeLessThanOrEqual(3);

      const mark = byTestId("mark");
      expect(getComputedStyle(mark).width).toBe(rem(0.75));
      expect(Math.abs(mark.getBoundingClientRect().left - contentLeft)).toBeLessThanOrEqual(2.5);
    },
  );
});
