// FILE: EnvironmentAutomationsSection.browser.tsx
// Purpose: Browser-level regression tests for thread automation rows in the Environment panel.
// Layer: Vitest browser tests

import "../../../index.css";

import { AutomationId, ProjectId, ThreadId, type AutomationDefinition } from "@moss/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";

import { EnvironmentAutomationsSection } from "./EnvironmentAutomationsSection";

const baseAutomation = (overrides: Partial<AutomationDefinition> = {}): AutomationDefinition => ({
  id: AutomationId.makeUnsafe("automation-monitor-pr-220"),
  projectId: ProjectId.makeUnsafe("project-moss"),
  sourceThreadId: null,
  name: "Monitor PR #220 Codex review",
  prompt: "Monitor the pull request review status.",
  schedule: { type: "interval", everySeconds: 180 },
  enabled: true,
  nextRunAt: "2026-06-21T15:00:00.000Z",
  modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  worktreeMode: "worktree",
  mode: "heartbeat",
  targetThreadId: ThreadId.makeUnsafe("thread-pr-220"),
  maxIterations: null,
  stopAfterConsecutiveFailures: null,
  consecutiveFailureCount: 0,
  disabledReason: null,
  disabledAt: null,
  completionPolicy: { type: "none" },
  completionPolicyVersion: 1,
  completionPolicyUpdatedAt: "2026-06-21T14:00:00.000Z",
  minimumIntervalSeconds: 60,
  maxRuntimeSeconds: null,
  retryPolicy: { type: "none" },
  misfirePolicy: "coalesce",
  acknowledgedRisks: [],
  iterationCount: 0,
  createdAt: "2026-06-21T14:00:00.000Z",
  updatedAt: "2026-06-21T14:00:00.000Z",
  archivedAt: null,
  ...overrides,
});

describe("EnvironmentAutomationsSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the thread automation cadence and opens the editor callback", async () => {
    const definition = baseAutomation();
    const onOpenAutomation = vi.fn();

    await render(
      <EnvironmentAutomationsSection
        automations={[{ definition }]}
        onOpenAutomation={onOpenAutomation}
      />,
    );

    expect(page.getByText("Automations")).toBeInTheDocument();
    expect(page.getByText("Every 3m")).toBeInTheDocument();

    await page
      .getByRole("button", { name: "Open automation Monitor PR #220 Codex review" })
      .click();

    expect(onOpenAutomation).toHaveBeenCalledWith(definition);
  });

  it("names the automation row in Chinese from its own copy under zh-CN (walk N12-5)", async () => {
    // Rendered without the page translation: the row's name must come from the app's own
    // zh-CN copy, not from a regex that rewrites English after the fact.
    const definition = baseAutomation({ name: "每天看一下 index.js 的变化" });

    await render(
      <MossLocaleScope locale="zh-CN">
        <EnvironmentAutomationsSection automations={[{ definition }]} onOpenAutomation={vi.fn()} />
      </MossLocaleScope>,
    );

    await expect
      .element(
        page.getByRole("button", { name: "打开定时任务 每天看一下 index.js 的变化", exact: true }),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^Open automation/ }))
      .not.toBeInTheDocument();
  });
});
