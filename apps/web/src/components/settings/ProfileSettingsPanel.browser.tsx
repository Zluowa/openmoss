// FILE: ProfileSettingsPanel.browser.tsx
// Purpose: Guard the clean-room Codex profile hierarchy while retaining Moss's
// provider-agnostic token/model telemetry.
// Layer: Browser UI test

import "../../index.css";

import type { ProfileHeatmapCell, ProfileStats, ProfileTokenStats } from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ProfileContent } from "./ProfileSettingsPanel";

function heatmapCells(): ProfileHeatmapCell[] {
  const start = new Date("2025-09-07T00:00:00.000Z");
  return Array.from({ length: 361 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const count = index >= 180 && index % 4 !== 0 ? ((index * 137) % 12_000) + 500 : 0;
    return {
      day: date.toISOString().slice(0, 10),
      count,
      weekday: date.getUTCDay(),
      intensity: count === 0 ? 0 : Math.min(4, Math.ceil((count / 12_000) * 4)),
    };
  });
}

const stats: ProfileStats = {
  generatedAt: "2026-09-02T00:00:00.000Z",
  timezone: { utcOffsetMinutes: 480, today: "2026-09-02" },
  identity: { homeDirBasename: "moss", initials: "MO", defaultHandle: "@moss" },
  activity: {
    currentStreakDays: 3,
    longestStreakDays: 16,
    totalPromptsSent: 4_555,
    totalThreads: 89,
    promptsToday: 8,
    heatmapMetric: "prompts",
    heatmap: heatmapCells(),
  },
  activeHours: { startHour: 1, endHour: null, turnCount: 140, label: "1 AM" },
  insights: {
    topProvider: "codex",
    topProviderPercent: 50,
    topReasoning: "high",
    topReasoningPercent: 78,
    skillsExplored: 8,
    totalSkillsUsed: 1_174,
  },
  providerModels: [],
  skills: [
    { name: "superpowers", displayName: "superpowers", kind: "skill", runCount: 230 },
    {
      name: "codex-frontend-standard",
      displayName: "codex-frontend-standard",
      kind: "skill",
      runCount: 98,
    },
  ],
  mostUsedSkill: {
    name: "superpowers",
    displayName: "superpowers",
    kind: "skill",
    runCount: 230,
  },
  mostWorkedProject: null,
  quota: {
    status: "unavailable",
    provider: null,
    window: null,
    usedPercent: null,
    resetsAt: null,
    planName: null,
  },
};

const tokenStats: ProfileTokenStats = {
  available: true,
  lifetimeTotalTokens: 4_019_000_000,
  peakDayTokens: 194_000_000,
  peakDay: "2026-08-20",
  providers: ["codex", "cursor", "grok", "claudeAgent", "gemini", "antigravity", "droid", "kilo"],
  unavailableProviders: [],
  topProvider: "codex",
  topProviderPercent: 50,
  models: [
    {
      provider: "codex",
      instanceId: "codex",
      model: "GPT-5.6",
      tokens: 2_411_400_000,
      percent: 50,
    },
    {
      provider: "cursor",
      instanceId: "cursor",
      model: "Composer 1.5",
      tokens: 1_004_750_000,
      percent: 20,
    },
    {
      provider: "grok",
      instanceId: "grok",
      model: "Grok 4.1",
      tokens: 602_850_000,
      percent: 10,
    },
    {
      provider: "claudeAgent",
      instanceId: "claude",
      model: "Claude Opus 4.1",
      tokens: 337_590_000,
      percent: 7,
    },
    {
      provider: "gemini",
      instanceId: "gemini",
      model: "Gemini 2.5 Pro",
      tokens: 241_135_000,
      percent: 5,
    },
    {
      provider: "antigravity",
      instanceId: "antigravity",
      model: "Antigravity Default",
      tokens: 144_681_000,
      percent: 3,
    },
    {
      provider: "droid",
      instanceId: "droid",
      model: "Droid Default",
      tokens: 144_681_000,
      percent: 3,
    },
    {
      provider: "kilo",
      instanceId: "kilo",
      model: "Kilo Default",
      tokens: 96_454_000,
      percent: 2,
    },
  ],
  heatmapMetric: "tokens",
  heatmap: heatmapCells(),
};

describe("ProfileSettingsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uses the Codex profile hierarchy without dropping multi-provider token usage", async () => {
    await page.viewport(1_218, 878);
    const screen = await render(
      <ProfileContent stats={stats} tokenStats={tokenStats} tokensPending={false} />,
    );

    await expect.element(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Token activity" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Daily" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByRole("button", { name: "Weekly" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Cumulative" })).toBeVisible();

    await expect.element(page.getByText("GPT-5.6")).toBeVisible();
    await expect.element(page.getByText("Composer 1.5")).toBeVisible();
    await expect.element(page.getByText("Grok 4.1")).toBeVisible();
    await expect.element(page.getByText("Claude Opus 4.1")).toBeVisible();
    await expect.element(page.getByText("Gemini 2.5 Pro")).toBeVisible();
    await expect.element(page.getByText("Antigravity Default")).toBeVisible();
    await expect.element(page.getByText("Droid Default")).toBeVisible();
    await expect.element(page.getByText("Kilo Default")).toBeVisible();
    expect(page.getByText("Moss Key").length).toBe(0);

    await userEvent.click(page.getByRole("button", { name: "Weekly" }));
    await expect
      .element(page.getByRole("button", { name: "Weekly" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('[data-profile-activity-view="weekly"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-profile-activity-level="4"]').length).toBeGreaterThan(
      0,
    );
    expect(document.querySelectorAll('[data-profile-activity-level="0"]').length).toBeGreaterThan(
      0,
    );

    await userEvent.click(page.getByRole("button", { name: "Cumulative" }));
    await expect
      .element(page.getByRole("button", { name: "Cumulative" }))
      .toHaveAttribute("aria-pressed", "true");

    await page.viewport(390, 780);
    await expect.element(page.getByRole("heading", { name: "Token activity" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    await screen.unmount();
  });
});
