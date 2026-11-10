// FILE: EnvironmentContextSection.browser.tsx
// Purpose: The summary card's Context line shows the provider's real numbers and is
//          left out when there are none.
// Layer: Environment panel component tests

import "../../../index.css";

import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";

import { EnvironmentContextSection } from "./EnvironmentContextSection";

const SHOTS_DIR =
  import.meta.env.VITE_ALIGNED_PREVIEW_SHOTS === "1" ? "__screenshots__/aligned-preview" : null;

function snapshot(overrides: Partial<ContextWindowSnapshot>): ContextWindowSnapshot {
  return {
    claudeCache: null,
    cumulativeUsage: null,
    usedTokens: 64_000,
    usedPercent: null,
    totalProcessedTokens: null,
    tokenAccountingVersion: null,
    maxTokens: 500_000,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: null,
    remainingTokens: 436_000,
    usedPercentage: 12.8,
    remainingPercentage: 87.2,
    updatedAt: "2026-11-03T10:00:00.000Z",
    ...overrides,
  };
}

it("shows used / window with a bar, and the exact counts on hover", async () => {
  await page.viewport(420, 220);
  const screen = await render(
    <div className="w-72 p-2">
      <EnvironmentContextSection usage={snapshot({})} />
    </div>,
  );
  try {
    await expect.element(page.getByText("64k / 500k", { exact: true })).toBeVisible();
    const bar = page.getByRole("progressbar");
    await expect.element(bar).toHaveAttribute("aria-valuenow", "13");
    if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/summary-context-line.png` });
    await page.getByLabelText("Context: 64k / 500k").hover();
    await expect.element(page.getByText("64,000 of 500,000 tokens", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("shows only the used tokens when the window size is unknown, and warns near the limit", async () => {
  const screen = await render(
    <div className="w-72 p-2">
      <EnvironmentContextSection
        usage={snapshot({ maxTokens: null, usedPercentage: null, usedTokens: 1_500 })}
      />
      <EnvironmentContextSection usage={snapshot({ usedTokens: 460_000, usedPercentage: 92 })} />
    </div>,
  );
  try {
    await expect.element(page.getByText("1.5k", { exact: true })).toBeVisible();
    expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    const nearFull = page.getByText("460k / 500k", { exact: true });
    await expect.element(nearFull).toHaveClass(/text-destructive-foreground/);
  } finally {
    await screen.unmount();
  }
});

it("renders nothing without a provider report", async () => {
  const screen = await render(
    <div data-testid="host">
      <EnvironmentContextSection usage={null} />
    </div>,
  );
  try {
    expect(document.querySelector("[data-environment-context]")).toBeNull();
  } finally {
    await screen.unmount();
  }
});
