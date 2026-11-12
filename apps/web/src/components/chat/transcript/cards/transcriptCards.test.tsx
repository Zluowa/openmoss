// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MessagesTimelineRow } from "../../MessagesTimeline.logic";
import { SLOW_PROVIDER_START_NOTICE_MS } from "../workingStatus";
import {
  TRANSCRIPT_CARDS,
  TranscriptCardBoundary,
  transcriptCardSpacingClassName,
} from "./transcriptCards";

afterEach(cleanup);

describe("TRANSCRIPT_CARDS", () => {
  it("gives every row kind a distinct moss.* card", () => {
    const ids = Object.values(TRANSCRIPT_CARDS).map((card) => card.id);
    expect(ids.length).toBe(19);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^moss\.[a-z_]+$/);
  });

  it("keeps the timeline's row spacing", () => {
    const assistant = (assistantTurnInProgress: boolean) =>
      ({
        kind: "message",
        message: { role: "assistant" },
        assistantTurnInProgress,
      }) as unknown as MessagesTimelineRow;
    expect(transcriptCardSpacingClassName(assistant(true))).toBe("pb-1");
    expect(transcriptCardSpacingClassName(assistant(false))).toBe("pb-2");
    expect(
      transcriptCardSpacingClassName({
        kind: "message",
        message: { role: "user" },
      } as unknown as MessagesTimelineRow),
    ).toBe("pb-4");
    expect(
      transcriptCardSpacingClassName({ kind: "working" } as unknown as MessagesTimelineRow),
    ).toBe("pb-1");
    expect(
      transcriptCardSpacingClassName({ kind: "turn-error" } as unknown as MessagesTimelineRow),
    ).toBe("pb-4");
  });
});

describe("TranscriptCardBoundary", () => {
  it("shows the section fallback for a failed card and draws it again on Retry", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = true;
    function Flaky() {
      if (broken) throw new Error("bad row");
      return <p>Recovered row</p>;
    }
    const view = render(
      <div>
        <p>Earlier row</p>
        <TranscriptCardBoundary cardId="moss.tool">
          <Flaky />
        </TranscriptCardBoundary>
      </div>,
    );
    const fallback = view.getByRole("alert");
    expect(fallback.getAttribute("data-transcript-card-fallback")).toBe("moss.tool");
    expect(fallback.textContent).toContain("Couldn’t show this section.");
    expect(view.getByText("Earlier row")).toBeTruthy();
    broken = false;
    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
    });
    expect(view.getByText("Recovered row")).toBeTruthy();
    expect(view.queryByRole("alert")).toBeNull();
    consoleError.mockRestore();
  });
});

describe("working line while a provider starts", () => {
  it("says the start is slow, and that Moss keeps waiting, after a few seconds", () => {
    vi.useFakeTimers();
    try {
      const Working = TRANSCRIPT_CARDS.working.Body;
      const env = {
        workingLabel: "Starting Codex…",
        workingIcon: () => null,
        typography: { chatPx: 14 },
      } as unknown as Parameters<typeof Working>[0]["env"];
      const row = { kind: "working", id: "working-indicator-row" } as Parameters<
        typeof Working
      >[0]["row"];
      const view = render(<Working row={row} env={env} />);
      expect(view.container.textContent).toBe("Starting Codex…");
      act(() => {
        vi.advanceTimersByTime(SLOW_PROVIDER_START_NOTICE_MS);
      });
      expect(view.container.textContent).toBe(
        "Codex is taking longer than usual to start. Moss keeps waiting (up to about two minutes) and sends your message as soon as it's ready.",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
