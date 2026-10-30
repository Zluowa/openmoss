import "../../index.css";

import { StrictMode, useState } from "react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadSummaryToggle } from "./ThreadSummaryToggle";
import type { ThreadSummaryPanelState } from "./threadSummaryPanel.logic";

const OPEN_OVERLAY_STATE: ThreadSummaryPanelState = {
  displayMode: "overlay",
  isPinned: false,
  isPopoverOpen: true,
};

function SummaryToggleHarness() {
  const [state, setState] = useState(OPEN_OVERLAY_STATE);

  return (
    <>
      <ThreadSummaryToggle
        state={state}
        onToggle={() => {
          setState((current) => ({ ...current, isPopoverOpen: !current.isPopoverOpen }));
        }}
        onPopoverOpenChange={(isPopoverOpen) => {
          setState((current) => ({ ...current, isPopoverOpen }));
        }}
      >
        <div data-testid="thread-summary-content">Summary</div>
      </ThreadSummaryToggle>

      <section
        data-testid="right-dock-panel"
        style={{ position: "fixed", insetBlockStart: 80, insetInlineEnd: 8 }}
      >
        <button type="button" data-testid="right-dock-tab">
          Diff
        </button>
        <div role="tabpanel">
          <button type="button" data-testid="right-dock-panel-control">
            Refresh
          </button>
        </div>
      </section>

      <button
        type="button"
        data-testid="outside-summary-and-dock"
        style={{ position: "fixed", insetBlockEnd: 8, insetInlineStart: 8 }}
      >
        Outside
      </button>
      <output data-testid="thread-summary-open-state">{String(state.isPopoverOpen)}</output>
    </>
  );
}

function SummaryAvailabilityHarness() {
  const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState(OPEN_OVERLAY_STATE);

  return (
    <>
      <output data-testid="thread-summary-open-state">{String(state.isPopoverOpen)}</output>
      {enabled ? (
        <ThreadSummaryToggle
          state={state}
          onToggle={() => {
            setState((current) => ({ ...current, isPopoverOpen: !current.isPopoverOpen }));
          }}
          onPopoverOpenChange={(isPopoverOpen) => {
            setState((current) => ({ ...current, isPopoverOpen }));
          }}
        >
          <button type="button" data-testid="disable-summary" onClick={() => setEnabled(false)}>
            Disable summary
          </button>
        </ThreadSummaryToggle>
      ) : null}
    </>
  );
}

describe("ThreadSummaryToggle", () => {
  it("keeps the popover open while interacting with RightDock tabs and tabpanels", async () => {
    const screen = await render(<SummaryToggleHarness />);
    try {
      await page.getByTestId("right-dock-tab").click();
      expect(document.querySelector('[data-testid="thread-summary-open-state"]')?.textContent).toBe(
        "true",
      );

      await page.getByTestId("right-dock-panel-control").click();
      expect(document.querySelector('[data-testid="thread-summary-open-state"]')?.textContent).toBe(
        "true",
      );

      await page.getByTestId("outside-summary-and-dock").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-testid="thread-summary-open-state"]')?.textContent,
        ).toBe("false");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("clears open state when the summary feature is disabled and unmounted", async () => {
    const screen = await render(<SummaryAvailabilityHarness />);
    try {
      await page.getByTestId("disable-summary").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-testid="thread-summary-open-state"]')?.textContent,
        ).toBe("false");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("does not treat StrictMode's effect probe as a real unmount", async () => {
    const screen = await render(
      <StrictMode>
        <SummaryAvailabilityHarness />
      </StrictMode>,
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelector('[data-testid="thread-summary-open-state"]')?.textContent).toBe(
        "true",
      );
    } finally {
      await screen.unmount();
    }
  });
});
