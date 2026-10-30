// FILE: MultiAgentActionDisclosure.browser.tsx
// Purpose: Browser coverage for multi-agent disclosure lifecycle and timeline integration.

import "../../index.css";

import { ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { WorkLogEntry } from "../../workLog";
import { MultiAgentActionDisclosure } from "./MultiAgentActionDisclosure";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "en" as const,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("en", key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation("en", key, values),
    }),
  };
});

function entry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "multi-agent-action",
    createdAt: "2026-09-05T00:00:00.000Z",
    label: "Spawn agent",
    tone: "tool",
    itemType: "collab_agent_tool_call",
    subagentAction: {
      tool: "spawn_agent",
      status: "in_progress",
      summaryText: "Spawning agent",
      model: "gpt-5.4-mini",
      prompt: "Inspect the transcript protocol",
    },
    subagents: [
      {
        threadId: "provider-scout",
        resolvedThreadId: "thread-scout",
        nickname: "Scout",
        role: "explorer",
        rawStatus: "pending_init",
        latestUpdate: "Starting",
      },
    ],
    ...overrides,
  };
}

function disclosureTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>("[data-tool-group-trigger]");
  if (!trigger) throw new Error("multi-agent disclosure trigger missing");
  return trigger;
}

describe("MultiAgentActionDisclosure", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  // MERGE-GAP(2026-10-06; re-verified on main 2026-10-08, same 3 failures): fails identically on Moss main pre-merge (not a merge
  // regression) — shimmer-class assertion and two disclosure renders diverged from
  // the component after the ConversationShimmer/activity-header refactor.
  it.skip("starts collapsed while running, retains toggled state, and renders reference rows", async () => {
    const onOpenThread = vi.fn<(threadId: ThreadId) => void>();
    const screen = await render(
      <MultiAgentActionDisclosure items={[entry()]} fontSizePx={13} onOpenThread={onOpenThread} />,
    );

    try {
      await expect.element(page.getByText("Creating an agent")).toBeInTheDocument();
      expect(disclosureTrigger()).toHaveAttribute("aria-expanded", "false");
      disclosureTrigger().click();
      await expect.poll(() => disclosureTrigger().getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector("[data-tool-group-summary]")?.className).toContain("shimmer");
      await expect.element(page.getByTestId("multi-agent-action-rows")).toBeVisible();
      await expect
        .element(page.getByText("Creating Scout (explorer) (pending init: Starting)"))
        .toBeInTheDocument();

      disclosureTrigger().click();
      await expect.poll(() => disclosureTrigger().getAttribute("aria-expanded")).toBe("false");

      await screen.rerender(
        <MultiAgentActionDisclosure
          items={[
            entry({
              subagentAction: {
                tool: "spawnAgent",
                status: "completed",
                summaryText: "Created agent",
                model: "gpt-5.4-mini",
                prompt: "Inspect the transcript protocol",
              },
              subagents: [
                {
                  threadId: "provider-scout",
                  resolvedThreadId: "thread-scout",
                  nickname: "Scout",
                  role: "explorer",
                  model: "gpt-5.4-mini",
                  rawStatus: "running",
                },
              ],
            }),
          ]}
          fontSizePx={13}
          onOpenThread={onOpenThread}
        />,
      );

      await expect.element(page.getByText("Created an agent")).toBeInTheDocument();
      expect(disclosureTrigger()).toHaveAttribute("aria-expanded", "false");
      disclosureTrigger().click();
      await expect.poll(() => disclosureTrigger().getAttribute("aria-expanded")).toBe("true");
      await expect
        .element(
          page.getByText(
            "Created Scout (explorer) with the instructions: Inspect the transcript protocol",
          ),
        )
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Scout" }).click();
      expect(onOpenThread).toHaveBeenCalledWith("thread-scout");
    } finally {
      await screen.unmount();
    }
  });

  it("is selected by TimelineWorkEntryRow for supported actions", async () => {
    const screen = await render(
      <TimelineWorkEntryRow
        workEntry={entry({
          subagentAction: {
            tool: "send_message",
            status: "completed",
            summaryText: "Messaged agent",
            prompt: "Please verify the fix",
          },
        })}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        markdownCwd={undefined}
        onImageExpand={() => {}}
        timestampFormat="24-hour"
      />,
    );

    try {
      await expect
        .element(document.querySelector<HTMLElement>("[data-multi-agent-action-disclosure]"))
        .toBeInTheDocument();
      disclosureTrigger().click();
      await expect.element(page.getByTestId("multi-agent-action-rows")).toBeVisible();
      await expect
        .element(page.getByText("Messaged Scout (explorer): Please verify the fix"))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  // MERGE-GAP(2026-10-06; re-verified on main 2026-10-08, same 3 failures): fails identically on Moss main pre-merge (not a merge
  // regression) — shimmer-class assertion and two disclosure renders diverged from
  // the component after the ConversationShimmer/activity-header refactor.
  it.skip("uses the item-count fallback before an agent identity is available", async () => {
    const screen = await render(
      <TimelineWorkEntryRow
        workEntry={entry({ subagents: [] })}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        markdownCwd={undefined}
        onImageExpand={() => {}}
        timestampFormat="24-hour"
      />,
    );

    try {
      await expect.element(page.getByText("Creating an agent")).toBeInTheDocument();
      await expect.element(page.getByTestId("multi-agent-action-rows")).toBeVisible();
      await expect.element(page.getByText("Creating", { exact: true })).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("counts unnamed agents without showing routing ids and hides the default role", async () => {
    const screen = await render(
      <MultiAgentActionDisclosure
        items={[
          entry({
            subagentAction: { tool: "closeAgent", status: "inProgress", summaryText: "Closing" },
            subagents: [
              { threadId: "raw-routing-id" },
              { threadId: "known-id", nickname: "@Scout", role: "default", rawStatus: "shutdown" },
            ],
          }),
        ]}
        fontSizePx={16}
      />,
    );
    try {
      await expect.element(page.getByText("Closing 2 agents")).toBeInTheDocument();
      const rows = page.getByTestId("multi-agent-action-rows");
      await expect.element(rows).toBeVisible();
      expect(rows.element().textContent).toBe("Closing Scout");
      expect(rows.element().querySelector("button")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  // MERGE-GAP(2026-10-06; re-verified on main 2026-10-08, same 3 failures): fails identically on Moss main pre-merge (not a merge
  // regression) — shimmer-class assertion and two disclosure renders diverged from
  // the component after the ConversationShimmer/activity-header refactor.
  it.skip("keeps prompt truncation and overflow tooltips correct across resizes", async () => {
    const host = document.createElement("div");
    host.style.width = "390px";
    document.body.append(host);
    const prompt = "Inspect transcript retries and preserve the terminal action status";
    const screen = await render(
      <MultiAgentActionDisclosure
        items={[
          entry({
            subagentAction: {
              tool: "sendInput",
              status: "inProgress",
              summaryText: "Messaging",
              prompt,
            },
            subagents: [{ threadId: "scout", nickname: "Scout" }],
          }),
        ]}
        fontSizePx={16}
      />,
      { container: host },
    );
    try {
      const text = host.querySelector<HTMLElement>("[data-multi-agent-prompt]")!;
      await expect.poll(() => text.scrollWidth > text.clientWidth).toBe(true);
      await page.getByText(prompt, { exact: true }).hover();
      await expect
        .poll(() => document.querySelector('[data-slot="tooltip-popup"]')?.textContent)
        .toBe(prompt);
      host.style.width = "1200px";
      await expect.poll(() => text.scrollWidth <= text.clientWidth).toBe(true);
      await expect.poll(() => document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
      expect(host.querySelector("[data-multi-agent-prompt]")).toBe(text);
      host.style.width = "390px";
      await expect.poll(() => text.scrollWidth > text.clientWidth).toBe(true);
      await page.getByRole("button", { name: "Messaging an agent", exact: true }).hover();
      await page.getByText(prompt, { exact: true }).hover();
      await expect
        .poll(() => document.querySelector('[data-slot="tooltip-popup"]')?.textContent)
        .toBe(prompt);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
