import "../../index.css";
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
} from "../../theme/theme.logic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { makeActivity } from "../../storeTestFixtures";
import type { ThreadSession } from "../../types";
import { deriveWorkLogEntries, type WorkLogEntry } from "../../workLog";
import { ConversationConnectionBanner } from "./ConversationConnectionBanner";
import { ComposerRunLocationControl } from "./ComposerRunLocationControl";
import { MultiAgentActionDisclosure } from "./MultiAgentActionDisclosure";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { ComposerQueuedHeader } from "./ComposerQueuedHeader";
import type { QueuedComposerTurn } from "../../composerDraftStore";

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

const now = "2026-09-05T00:00:00.000Z";
const session = (status: ThreadSession["orchestrationStatus"]): ThreadSession => ({
  provider: "codex",
  status: status === "starting" ? "connecting" : status === "running" ? "running" : "ready",
  orchestrationStatus: status,
  createdAt: now,
  updatedAt: now,
});
const shot = (name: string) =>
  page.screenshot({ path: `../../../../../.tmp/ui-parity/parity5/pass5-moss-${name}.png` });
const motion = commands as unknown as {
  emulateReducedMotion: (value: "reduce" | "no-preference") => Promise<void>;
};

let previousRootStyle: string | null;
beforeEach(async () => {
  previousRootStyle = document.documentElement.getAttribute("style");
  const { variables } = buildThemeCssVariables(
    resolveThemePack(DEFAULT_THEME_STATE, "light"),
    "light",
  );
  for (const [name, value] of Object.entries(variables))
    document.documentElement.style.setProperty(name, value);
  await page.viewport(960, 720);
  await motion.emulateReducedMotion("reduce");
});
afterEach(async () => {
  vi.useRealTimers();
  if (previousRootStyle === null) document.documentElement.removeAttribute("style");
  else document.documentElement.setAttribute("style", previousRootStyle);
  await motion.emulateReducedMotion("no-preference");
  vi.restoreAllMocks();
});

describe("Pass 5 connection and local run-location contracts", () => {
  it("loads initially, reconnects an established session, and clears on recovery", async () => {
    const banner = (status: ThreadSession["orchestrationStatus"]) => (
      <div style={{ width: 736, paddingTop: 24 }}>
        <ConversationConnectionBanner
          threadId="thread-a"
          providerKey="codex"
          session={session(status)}
          activities={[
            makeActivity({
              id: "connection",
              kind: "provider.session.connection",
              payload: { state: status, provider: "codex" },
            }),
          ]}
          isStarting={false}
          isResuming={false}
        />
      </div>
    );
    const screen = await render(banner("starting"));
    try {
      const status = () => document.querySelector("[data-conversation-connection-status]");
      await expect.element(page.getByRole("status")).toHaveTextContent("Loading task…");
      expect(status()).toHaveAttribute("aria-live", "polite");
      expect(status()).toHaveAttribute("data-conversation-connection-status", "loading");
      await shot("connection-loading");
      await screen.rerender(banner("ready"));
      await expect.poll(status).toBeNull();
      await screen.rerender(banner("starting"));
      await expect.element(page.getByRole("status")).toHaveTextContent("Reconnecting to ChatGPT…");
      expect(status()).toHaveAttribute("data-conversation-connection-status", "reconnecting");
      expect(
        getComputedStyle(status()!.querySelector('[data-slot="central-icon"]')!).animationName,
      ).toBe("none");
      await shot("connection-reconnecting");
      await screen.rerender(banner("running"));
      await expect.poll(status).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("scopes readiness to the thread and provider and keeps unknown-history resume loading", async () => {
    const banner = (
      threadId: string,
      providerKey: string,
      status: ThreadSession["orchestrationStatus"],
      isResuming = false,
    ) => (
      <ConversationConnectionBanner
        threadId={threadId}
        providerKey={providerKey}
        session={session(status)}
        activities={[]}
        isStarting={false}
        isResuming={isResuming}
      />
    );
    const screen = await render(banner("a", "codex-a", "ready"));
    try {
      await screen.rerender(banner("b", "codex-a", "starting", true));
      await expect.element(page.getByRole("status")).toHaveTextContent("Loading task…");
      await screen.rerender(banner("a", "codex-b", "starting"));
      await expect.element(page.getByRole("status")).toHaveTextContent("Loading task…");
      await screen.rerender(banner("a", "codex-a", "ready", true));
      expect(document.querySelector("[data-conversation-connection-status]")).toBeNull();
      await screen.rerender(banner("a", "codex-a", "error"));
      expect(document.querySelector("[data-conversation-connection-status]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("exposes Local and an unavailable Cloud option without changing routing", async () => {
    const screen = await render(
      <div style={{ padding: 40 }}>
        <ComposerRunLocationControl />
      </div>,
    );
    try {
      const trigger = page.getByRole("button", { name: "Where should this follow-up run?" });
      await expect.element(trigger).toHaveTextContent("Local");
      await expect
        .element(trigger)
        .toHaveAttribute("data-composer-navigation-target", "run-location");
      await trigger.click();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Local", exact: true }))
        .toHaveAttribute("aria-checked", "true");
      const cloud = page.getByRole("menuitemradio", { name: /Cloud/ });
      await expect.element(cloud).toHaveAttribute("aria-disabled", "true");
      await expect
        .element(cloud)
        .toHaveTextContent("Cloud follow-ups are unavailable. Moss runs locally.");
      await shot("run-location-local-cloud-unavailable");
      expect(
        document.querySelector('[data-composer-navigation-target="starting-state"]'),
      ).toBeNull();
      await page.getByRole("menuitemradio", { name: "Local", exact: true }).click();
      await expect.element(trigger).toHaveTextContent("Local");
    } finally {
      await screen.unmount();
    }
  });

  it("shows expanded partial stdout while the command is still running", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-05T00:00:19.000Z"));
    const command = String.raw`python3 -u -c "import time; print(\"pass5 partial stdout\", flush=True); [(print(\"pass5 tick\", i, flush=True), time.sleep(1)) for i in range(120)]; print(\"pass5 settled\", flush=True)"`;
    const entry: WorkLogEntry = {
      id: "pass5-exec",
      createdAt: now,
      label: "Run command",
      tone: "tool",
      itemType: "command_execution",
      command,
      toolDetails: {
        kind: "command",
        title: "Shell",
        command,
        cwd: "/workspace/codex-conversation-re",
        output: {
          stdout:
            "pass5 partial stdout\npass5 tick 14\npass5 tick 15\npass5 tick 16\npass5 tick 17\npass5 tick 18\npass5 tick 19\n",
        },
      },
      liveActivity: {
        state: "running_tool",
        label: "Run command",
        startedAt: now,
        lastActivityAt: now,
      },
    };
    const screen = await render(
      <div style={{ width: 784, padding: 24 }}>
        <TimelineWorkEntryRow
          workEntry={entry}
          chatMetaFontSizePx={12}
          textFontSizePx={16}
          density="compact"
          onImageExpand={() => {}}
          markdownCwd={undefined}
          timestampFormat="locale"
        />
      </div>,
    );
    try {
      document.querySelector<HTMLButtonElement>("[data-tool-detail-trigger]")!.click();
      await expect
        .poll(() => document.querySelector("[data-shell-output-scroll]")?.textContent)
        .toContain("pass5 tick 19");
      await expect
        .element(page.getByText("pass5 partial stdout", { exact: false }).last())
        .toBeVisible();
      expect(document.querySelector("[data-tool-detail-trigger]")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      // The expanded live row reports duration; its Shell detail retains argv.
      const displayTextEl = document.querySelector("[data-work-entry-display-text]");
      expect(displayTextEl?.firstChild?.textContent).toBe("Running command for 19s");
      const sweep = displayTextEl?.querySelector<HTMLElement>(".codex-text-shimmer-sweep");
      expect(sweep).toHaveAttribute("aria-hidden", "true");
      expect(sweep?.inert).toBe(true);
      expect(document.querySelector("[data-command-literal]")).toBeNull();
      expect(document.querySelector("[data-shell-command] code")?.textContent).toBe(command);
      expect(displayTextEl?.hasAttribute("data-conversation-shimmer")).toBe(true);
      await shot("midrun-expanded-partial-stdout");
    } finally {
      await screen.unmount();
      vi.useRealTimers();
    }
  });

  it("retains an expanded native command row through real activity projection updates", async () => {
    const item = {
      type: "commandExecution",
      id: "native-pass5-command",
      command: "python3 capture.py",
      cwd: "/workspace/capture",
      aggregatedOutput: null,
      exitCode: null,
    };
    const started = makeActivity({
      id: "native-start",
      kind: "tool.started",
      turnId: "native-turn",
      tone: "tool",
      sequence: 1,
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Ran command",
        detail: "python3 capt...",
        data: { item },
      },
    });
    const update = (text: string, sequence: number) =>
      makeActivity({
        id: "native-output",
        kind: "tool.updated",
        turnId: "native-turn",
        tone: "tool",
        sequence,
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          data: { toolCallId: item.id, rawOutput: { output: text } },
        },
      });
    const rows = (activities: Parameters<typeof deriveWorkLogEntries>[0]) => (
      <div style={{ width: 784, padding: 24 }}>
        {deriveWorkLogEntries(activities, undefined).map((entry) => (
          <TimelineWorkEntryRow
            key={entry.id}
            workEntry={entry}
            chatMetaFontSizePx={12}
            textFontSizePx={16}
            density="compact"
            onImageExpand={() => {}}
            markdownCwd={undefined}
            timestampFormat="locale"
          />
        ))}
      </div>
    );
    const screen = await render(rows([started]));
    try {
      const trigger = document.querySelector<HTMLButtonElement>("[data-tool-detail-trigger]")!;
      trigger.click();
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector("[data-shell-output-scroll]")?.textContent).not.toContain(
        "python3 capt...",
      );
      for (const [text, sequence] of [
        ["pass5 tick 1\n", 2],
        ["pass5 tick 1\npass5 tick 2\n", 3],
      ] as const) {
        await screen.rerender(rows([started, update(text, sequence)]));
        expect(document.querySelector("[data-tool-detail-trigger]")).toBe(trigger);
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect
          .poll(() => document.querySelector("[data-shell-output-scroll]")?.textContent)
          .toContain(text.trim());
        expect(document.querySelectorAll("[data-shell-output-scroll]")).toHaveLength(1);
      }
      await shot("native-activity-midrun-stdout");
      const completed = makeActivity({
        id: "native-completed",
        kind: "tool.completed",
        turnId: "native-turn",
        tone: "tool",
        sequence: 4,
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          data: {
            item: {
              ...item,
              aggregatedOutput: "pass5 tick 1\npass5 tick 2\npass5 settled\n",
              exitCode: 0,
            },
          },
        },
      });
      await screen.rerender(rows([started, update("pass5 tick 1\npass5 tick 2\n", 3), completed]));
      expect(document.querySelector("[data-tool-detail-trigger]")).toBe(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect
        .poll(() => document.querySelector("[data-shell-output-scroll]")?.textContent)
        .toContain("pass5 settled");
      expect(document.querySelector("[data-shell-footer]")).toHaveAttribute(
        "data-shell-footer",
        "success",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps old queued follow-ups actionable as steering without inventing safety buffering", async () => {
    const queuedTurn: QueuedComposerTurn = {
      id: "pass5-queue",
      kind: "plan-follow-up",
      createdAt: "2020-01-01T00:00:00.000Z",
      previewText: "Inspect the directory names",
      text: "Inspect the directory names",
      interactionMode: "default",
      selectedProvider: "codex",
      selectedModel: null,
      selectedPromptEffort: null,
      modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
    };
    const onSteer = vi.fn();
    const onRemove = vi.fn();
    const screen = await render(
      <div style={{ width: 736, padding: 24 }}>
        <ComposerColumnFrame>
          <ComposerQueuedHeader
            queuedTurns={[queuedTurn]}
            onSteer={onSteer}
            onRemove={onRemove}
            onEdit={() => {}}
          />
        </ComposerColumnFrame>
      </div>,
    );
    try {
      await expect.element(page.getByTestId("queued-follow-up-row")).toBeVisible();
      expect(document.body.textContent).not.toMatch(/Buffered|faster model|safety buffering/i);
      expect(document.querySelector("[data-conversation-connection-status]")).toBeNull();
      await shot("queued-follow-up-steer");
      await page.getByRole("button", { name: "Steer", exact: true }).click();
      expect(onSteer).toHaveBeenCalledWith(queuedTurn);
      await page.getByRole("button", { name: "Delete queued follow-up" }).click();
      expect(onRemove).toHaveBeenCalledWith(queuedTurn.id);
    } finally {
      await screen.unmount();
    }
  });

  it("captures the Creating action header and its rows, then Messaging", async () => {
    const entry: WorkLogEntry = {
      id: "pass5-spawn",
      createdAt: now,
      label: "Spawn agent",
      tone: "tool",
      itemType: "collab_agent_tool_call",
      subagentAction: {
        tool: "spawnAgent",
        status: "in_progress",
        summaryText: "Creating an agent",
        prompt: "Inspect workspace directory names",
      },
      subagents: [{ threadId: "cedar", nickname: "Cedar", rawStatus: "pending_init" }],
    };
    const screen = await render(
      <div style={{ width: 784, padding: 24 }}>
        <MultiAgentActionDisclosure items={[entry]} fontSizePx={16} />
      </div>,
    );
    try {
      await expect.element(page.getByText("Creating an agent")).toBeVisible();
      await expect.element(page.getByTestId("multi-agent-action-rows")).toBeVisible();
      expect(
        document
          .querySelector("[data-tool-group-summary]")
          ?.querySelector("[data-conversation-shimmer='true']"),
      ).not.toBeNull();
      await shot("multi-agent-action-creating");
      await screen.rerender(
        <div style={{ width: 784, padding: 24 }}>
          <MultiAgentActionDisclosure
            items={[{ ...entry, subagentAction: { ...entry.subagentAction!, tool: "sendInput" } }]}
            fontSizePx={16}
          />
        </div>,
      );
      await expect.element(page.getByText("Messaging an agent")).toBeVisible();
      await shot("multi-agent-action-messaging");
    } finally {
      await screen.unmount();
    }
  });
});
