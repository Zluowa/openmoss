import "../../index.css";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { QueuedComposerTurn } from "../../composerDraftStore";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { ComposerQueuedHeader } from "./ComposerQueuedHeader";

const queuedTurn: QueuedComposerTurn = {
  id: "queued-during-compaction",
  kind: "plan-follow-up",
  createdAt: "2026-10-29T12:00:00.000Z",
  previewText: "Hey I want to keep going",
  text: "Hey I want to keep going",
  interactionMode: "default",
  selectedProvider: "codex",
  selectedModel: null,
  selectedPromptEffort: null,
  modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
};

describe("ComposerQueuedHeader Steer tooltip", () => {
  it.each([
    { steerSkipsCompaction: true, tooltip: "Skip compaction and send this message." },
    {
      steerSkipsCompaction: false,
      tooltip: "Send this follow-up now to redirect the current work.",
    },
  ])(
    "explains Steer when steerSkipsCompaction is $steerSkipsCompaction",
    async ({ steerSkipsCompaction, tooltip }) => {
      const screen = await render(
        <div style={{ width: 736, padding: 24 }}>
          <ComposerColumnFrame>
            <ComposerQueuedHeader
              queuedTurns={[queuedTurn]}
              onSteer={() => {}}
              onRemove={() => {}}
              onEdit={() => {}}
              steerSkipsCompaction={steerSkipsCompaction}
            />
          </ComposerColumnFrame>
        </div>,
      );
      try {
        await page.getByRole("button", { name: "Steer", exact: true }).hover();
        await expect.poll(() => document.body.textContent).toContain(tooltip);
      } finally {
        await screen.unmount();
      }
    },
  );
});
