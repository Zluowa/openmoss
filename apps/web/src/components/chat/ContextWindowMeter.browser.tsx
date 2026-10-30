// Verify the actual tooltip keeps the applied mode separate from runtime usage.
import { EventId, type OrchestrationThreadActivity } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  deriveAppliedContextWindowSelection,
  deriveContextWindowSelectionStatus,
  deriveLatestContextWindowState,
} from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

// Moss defaults to zh-CN; pin English so the English assertions below hold.
const localizationTestState = vi.hoisted(() => ({
  locale: "en" as "en" | "zh-CN",
}));

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localizationTestState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localizationTestState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(localizationTestState.locale, key, values),
    }),
  };
});

it("shows Auto as applied with the 967k runtime threshold and no pending Auto", async () => {
  const activities: OrchestrationThreadActivity[] = [
    {
      id: EventId.makeUnsafe("config"),
      kind: "context-window.configured",
      tone: "info",
      summary: "Auto",
      payload: { cleared: true },
      turnId: null,
      createdAt: "2026-09-17T00:00:00Z",
    },
    {
      id: EventId.makeUnsafe("usage"),
      kind: "context-window.updated",
      tone: "info",
      summary: "Usage",
      payload: { usedTokens: 500_000, maxTokens: 967_000, usedPercent: 51.7 },
      turnId: null,
      createdAt: "2026-09-17T00:00:01Z",
    },
  ];
  const usage = deriveLatestContextWindowState(activities).snapshot!;
  const status = deriveContextWindowSelectionStatus({
    activeSnapshot: usage,
    selectedValue: "auto",
    appliedValue: deriveAppliedContextWindowSelection(activities),
  });
  await render(
    <ContextWindowMeter
      usage={usage}
      showClaudeCache
      activeWindowLabel={status.activeLabel}
      pendingWindowLabel={status.pendingSelectedLabel}
    />,
  );
  await page.getByRole("button", { name: "Context window 52% used" }).click();
  await expect.element(page.getByText("Auto-compact target: Auto")).toBeVisible();
  await expect.element(page.getByText("Model window: 967k tokens")).toBeVisible();
  await expect.element(page.getByText("Next turn:", { exact: false })).not.toBeInTheDocument();
});
