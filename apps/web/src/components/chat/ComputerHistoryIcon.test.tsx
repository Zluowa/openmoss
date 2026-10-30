// FILE: ComputerHistoryIcon.test.tsx
// Purpose: Locks the branded Computer History mention mark used by chat chips.
// Layer: web UI tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComputerHistoryIcon } from "./ComputerHistoryIcon";
import { MentionChipIcon } from "./MentionChipIcon";

describe("ComputerHistoryIcon", () => {
  it("renders a bounded teal Moss mark instead of a generic clock", () => {
    const markup = renderToStaticMarkup(<ComputerHistoryIcon className="size-[1em] mr-1" />);

    expect(markup).toContain('data-computer-history-icon="true"');
    expect(markup).toContain("moss-logo-coral.png");
    expect(markup).toContain("size-4");
    expect(markup).toContain("radial-gradient");
    expect(markup).not.toContain("clock");
  });

  it("uses the Moss history mark in the shared mention renderer", () => {
    const markup = renderToStaticMarkup(
      <MentionChipIcon
        path="moss://computer-history"
        kind="history"
        theme="dark"
        className="size-[1em]"
      />,
    );

    expect(markup).toContain('data-computer-history-icon="true"');
    expect(markup).toContain("moss-logo-coral.png");
    expect(markup).not.toContain("central-icons-fill/clock.svg");
  });
});
