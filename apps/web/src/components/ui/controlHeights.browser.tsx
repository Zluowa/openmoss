import "../../index.css";

import { page } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Button } from "./button";
import { Input } from "./input";
import { Select, SelectTrigger, SelectValue } from "./select";

// A field and a button of one size share a toolbar row, so they must share a height.
const LADDER = [
  { size: "sm", heightPx: 28 },
  { size: "default", heightPx: 28 },
  { size: "lg", heightPx: 32 },
] as const;

function heightOf(selector: string): number {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element.getBoundingClientRect().height;
}

describe("control heights", () => {
  beforeEach(async () => {
    // The ladder applies from the `sm` breakpoint up; below it controls keep a taller touch step.
    await page.viewport(1200, 800);
  });

  it.each(LADDER)("keeps $size fields and buttons on $heightPx", async ({ size, heightPx }) => {
    await render(
      <div>
        <Input aria-label="Field" size={size} />
        <Button data-testid="button" size={size}>
          Save
        </Button>
        <Select>
          <SelectTrigger data-testid="select" aria-label="Choice" size={size}>
            <SelectValue placeholder="Pick" />
          </SelectTrigger>
        </Select>
      </div>,
    );

    expect(heightOf('[data-slot="input-control"]')).toBe(heightPx);
    expect(heightOf('[data-testid="button"]')).toBe(heightPx);
    expect(heightOf('[data-testid="select"]')).toBe(heightPx);
  });
});
