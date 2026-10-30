// FILE: SidebarStatusTrailingGlyph.test.tsx
// Purpose: Keeps the background-work glyph distinct from the unread-completion dot.
// Layer: Component rendering tests
// Depends on: SidebarStatusTrailingGlyph and React server rendering.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ThreadStatusPill } from "./Sidebar.logic";
import { SidebarStatusTrailingGlyph } from "./SidebarStatusTrailingGlyph";

const inBackground: ThreadStatusPill = {
  label: "In Background",
  colorClass: "text-sky-600 dark:text-sky-300/80",
  dotClass: "bg-sky-500 dark:bg-sky-300/80",
  pulse: false,
  dismissible: false,
  backgroundTaskCount: 2,
};

const pendingApproval: ThreadStatusPill = {
  label: "Pending Approval",
  colorClass: "text-emerald-700 dark:text-emerald-400",
  dotClass: "bg-emerald-500 dark:bg-emerald-400",
  pulse: false,
  dismissible: true,
  dismissalKey: "pending",
};

describe("SidebarStatusTrailingGlyph", () => {
  it("draws background work as a slow dashed ring, not a coloured dot", () => {
    const markup = renderToStaticMarkup(<SidebarStatusTrailingGlyph status={inBackground} />);

    expect(markup).toContain('title="In background · 2 tasks"');
    expect(markup).toContain("animate-spin-stepped-slow");
    expect(markup).toContain('stroke-dasharray="2 2.6"');
    expect(markup).not.toContain("bg-sky-500");
  });

  it("draws a pending approval as the gray working spinner, not the green dot", () => {
    const markup = renderToStaticMarkup(<SidebarStatusTrailingGlyph status={pendingApproval} />);

    expect(markup).toContain('aria-label="Pending Approval"');
    expect(markup).toContain("animate-spin-stepped");
    expect(markup).not.toContain("bg-emerald-500");
  });

  it("uses the singular for one background task", () => {
    const markup = renderToStaticMarkup(
      <SidebarStatusTrailingGlyph status={{ ...inBackground, backgroundTaskCount: 1 }} />,
    );

    expect(markup).toContain('aria-label="In background · 1 task"');
  });
});
