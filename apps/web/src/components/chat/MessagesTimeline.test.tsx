// FILE: MessagesTimeline.test.tsx
// Purpose: Covers transcript row rendering and SSR-safe presentation contracts.
// Layer: Web chat component tests
// Depends on: renderToStaticMarkup and a mocked LegendList.

import { CheckpointRef, MessageId, ThreadId, TurnId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MossLocalizationProvider, MossLocaleScope } from "../../localization";
function renderChineseMarkup(node: React.ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MossLocaleScope locale="zh-CN">{node}</MossLocaleScope>
    </QueryClientProvider>,
  );
}
function renderEnglishMarkup(node: React.ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MossLocalizationProvider localeOverride="en">{node}</MossLocalizationProvider>
    </QueryClientProvider>,
  );
}
import { beforeAll, describe, expect, it, vi } from "vitest";
import { formatShortTimestamp } from "../../timestampFormat";
import { makeActivity } from "../../storeTestFixtures";
import { deriveTimelineEntries, deriveWorkLogEntries, type WorkLogEntry } from "../../workLog";
import { COLLAPSED_USER_MESSAGE_MAX_CHARS } from "./userMessageCollapse";
import { INLINE_COMMAND_CHIP_CLASS_NAME } from "./chatTypography";

const TOOLTIP_TRIGGER_MARKER = 'data-base-ui-tooltip-trigger=""';
// Every settled turn opens with a header carrying its final state.
const TURN_HEADER_MARKER = 'data-turn-header="completed"';
const FORK_SOURCE = {
  sourceThreadId: ThreadId.makeUnsafe("source-thread"),
  sourceTitle: "ciao (2)",
};

function makeForkImportedEntry() {
  return {
    id: "imported-entry",
    kind: "message" as const,
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe("imported-message"),
      role: "assistant" as const,
      text: "Imported history",
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming: false,
      source: "fork-import" as const,
    },
  };
}

function makeForkOwnedEntry() {
  return {
    id: "fork-entry",
    kind: "message" as const,
    createdAt: "2026-03-17T19:12:29.000Z",
    message: {
      id: MessageId.makeUnsafe("fork-message"),
      role: "user" as const,
      text: "Fork-only turn",
      createdAt: "2026-03-17T19:12:29.000Z",
      streaming: false,
      source: "native" as const,
    },
  };
}

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    },
    _ref: React.ForwardedRef<unknown>,
  ) {
    return (
      <div data-testid="legend-list">
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  });

  return { LegendList };
});

// Baseline MessagesTimeline props shared across render tests; spread the
// result and override individual props (or pass them as JSX after the spread).
function makeTimelineBaseProps(nowIso: string | null = "2026-03-17T19:12:30.000Z") {
  return {
    hasMessages: true,
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    ...(nowIso === null ? {} : { nowIso }),
    expandedWorkGroups: {},
    onToggleWorkGroup: () => {},
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
  };
}

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { origin: "http://localhost" },
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
    // flushStorageBeforePageHide registers visibilitychange at module load of
    // the MessagesTimeline import chain (via composerDraftStore).
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

// Warm the component module once: the first dynamic import pays the whole
// component-graph transform, which exceeds the 5s per-test timeout on slow CI
// runners (observed >10s under a full parallel suite). beforeAll keeps that
// cost off any single test's clock; the explicit timeout keeps it off the
// default 10s hook clock too.
beforeAll(async () => {
  await import("./MessagesTimeline");
}, 120_000);

describe("MessagesTimeline", () => {
  it("opts user and assistant transcript markdown into automatic direction mode", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "bidi-user",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("bidi-user"),
              role: "user",
              text: "مرحبا بالعالم",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "bidi-assistant",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("bidi-assistant"),
              role: "assistant",
              text: "[مرحبا](https://example.com)",
              createdAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup.match(/data-direction-mode="auto-blocks"/g)).toHaveLength(2);
  });

  it("keeps a reply without folded work plain and renders the live Resumed clock when the provider reuses its turn id", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.makeUnsafe("same-turn");
    const launchAt = "2026-03-17T19:12:00.000Z";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps("2026-03-17T19:12:23.000Z")}
        isWorking
        activeTurnInProgress
        activeTurnId={turnId}
        activeTurnStartedAt={launchAt}
        timelineEntries={[
          {
            id: "request",
            kind: "message",
            createdAt: launchAt,
            message: {
              id: MessageId.makeUnsafe("request"),
              role: "user",
              text: "Launch delayed echo",
              createdAt: launchAt,
              streaming: false,
              turnId,
            },
          },
          {
            id: "launch",
            kind: "message",
            createdAt: "2026-03-17T19:12:04.000Z",
            message: {
              id: MessageId.makeUnsafe("launch"),
              role: "assistant",
              text: "Launched.",
              createdAt: "2026-03-17T19:12:04.000Z",
              completedAt: "2026-03-17T19:12:04.000Z",
              streaming: false,
              turnId,
            },
          },
          {
            id: "done",
            kind: "work",
            createdAt: "2026-03-17T19:12:21.000Z",
            entry: {
              id: "done",
              createdAt: "2026-03-17T19:12:21.000Z",
              tone: "info",
              label: "Done",
              backgroundTaskCompletion: {
                taskId: "task",
                taskType: null,
                description: "Delayed echo",
                outcome: "finished",
              },
            },
          },
          {
            id: "resumed",
            kind: "message",
            createdAt: "2026-03-17T19:12:22.000Z",
            message: {
              id: MessageId.makeUnsafe("resumed"),
              role: "assistant",
              text: "Echo done.",
              createdAt: "2026-03-17T19:12:22.000Z",
              streaming: true,
              turnId,
            },
          },
        ]}
        turnTimingByTurnId={
          new Map([
            [
              turnId,
              {
                startedAt: launchAt,
                completedAt: "2026-03-17T19:12:04.000Z",
                interrupted: false,
              },
            ],
          ])
        }
      />,
    );
    expect(markup).not.toContain(TURN_HEADER_MARKER);
    expect(markup).toContain("Resumed: “Delayed echo” finished · ");
    expect(markup).toContain('class="tabular-nums">2s</span>');
    expect(markup.indexOf("Launched.")).toBeLessThan(markup.indexOf("Resumed:"));
    expect(markup.match(/data-turn-header="live"/g)).toHaveLength(1);
  });

  it.each(["stopped", "interrupted"] as const)(
    "renders the %s header after its request when the turn produced no content",
    async (outcome) => {
      const { MessagesTimeline } = await import("./MessagesTimeline");
      const turnId = TurnId.makeUnsafe("empty-turn");
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...makeTimelineBaseProps()}
          timelineEntries={[
            {
              id: "empty-request",
              kind: "message",
              createdAt: "2026-03-17T19:12:28.000Z",
              message: {
                id: MessageId.makeUnsafe("empty-request"),
                role: "user",
                text: "Inspect the repository",
                createdAt: "2026-03-17T19:12:28.000Z",
                streaming: false,
                turnId,
              },
            },
          ]}
          turnTimingByTurnId={
            new Map([
              [
                turnId,
                {
                  startedAt: "2026-03-17T19:12:28.000Z",
                  completedAt: "2026-03-17T19:12:30.000Z",
                  interrupted: true,
                  stoppedByUser: outcome === "stopped",
                },
              ],
            ])
          }
        />,
      );
      const label = outcome === "stopped" ? "Stopped by you after 2.0s" : "Interrupted after 2.0s";
      expect(markup).toContain(`data-turn-header="${outcome}"`);
      expect(markup).toContain(label);
      expect(markup.indexOf(label)).toBeGreaterThan(markup.indexOf("Inspect the repository"));
    },
  );

  it("shows the literal failed command, exit code and stderr even when the provider uses an error tone", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderEnglishMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "failed-command",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "failed-command",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Bash",
              tone: "error",
              activityKind: "tool.completed",
              itemType: "command_execution",
              toolStatus: "failed",
              command: "missing-command --check",
              toolDetails: {
                kind: "command",
                title: "Bash",
                command: "missing-command --check",
                output: { exitCode: 127, stderr: "missing-command: command not found" },
              },
            },
          },
        ]}
      />,
    );
    expect(markup).toContain('data-command-literal="true"');
    expect(markup).toContain("missing-command --check");
    expect(markup).toContain("Failed · exit 127");
    expect(markup).toContain("missing-command: command not found");
  });
  // The first test pays the full dynamic-import cost of the MessagesTimeline
  // module graph, which can exceed 10s under CI thread contention.
  it("renders an accent deep link to the immediate fork source", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[makeForkImportedEntry(), makeForkOwnedEntry()]}
        forkSource={FORK_SOURCE}
        onOpenThread={() => {}}
      />,
    );

    expect(markup).toContain('data-fork-source-divider="true"');
    expect(markup).toContain('href="/source-thread"');
    expect(markup).toContain("Continued from chat");
    expect(markup).toContain("text-[var(--color-text-accent)]");
    expect(markup.indexOf("Imported history")).toBeLessThan(
      markup.indexOf('data-fork-source-divider="true"'),
    );
    expect(markup.indexOf('data-fork-source-divider="true"')).toBeLessThan(
      markup.indexOf("Fork-only turn"),
    );
  }, 30_000);

  it("renders session-context lifecycle evidence as a compact expandable row", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "context-restart-row",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "context-restart-entry",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "The session's history was lost, so the model continues from a summary.",
              tone: "error",
              activityKind: "provider.context.changed",
              providerContextLifecycle: {
                provider: "opencode",
                nativeHistory: "unavailable",
                restartReason: "native-resume-failed",
                sessionRestarted: true,
                recapInjected: true,
                recapCharacters: 4_200,
                recapPreview: "Bounded summary preview",
                recapPreviewTruncated: true,
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("history was lost, so the model continues from a summary.");
    expect(markup).toContain('data-tool-detail-trigger="true"');
    expect(markup).not.toContain('data-provider-context-lifecycle-details="true"');
    expect(markup).not.toContain("Bounded summary preview");
  });

  it("labels only the first message when another task created the conversation", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        crossTaskOrigin={{
          sourceThreadId: ThreadId.makeUnsafe("source-thread"),
          sourceProvider: "codex",
        }}
        timelineEntries={[
          {
            id: "entry-first-user",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("first-user-message"),
              role: "user",
              text: "Inspect the repository",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-second-user",
            kind: "message",
            createdAt: "2026-03-17T19:13:28.000Z",
            message: {
              id: MessageId.makeUnsafe("second-user-message"),
              role: "user",
              text: "Continue",
              createdAt: "2026-03-17T19:13:28.000Z",
              streaming: false,
            },
          },
        ]}
        nowIso="2026-03-17T19:14:30.000Z"
        onOpenThread={() => {}}
        resolvedTheme="light"
      />,
    );

    expect(markup.match(/data-cross-task-origin="true"/g)).toHaveLength(1);
    expect(markup).toContain("Sent by Moss from another thread");
    expect(markup).toContain('aria-label="Open source thread"');
    expect(markup.indexOf("Sent by Moss from another thread")).toBeLessThan(
      markup.indexOf("Inspect the repository"),
    );
  });

  it("shows only the cross-task label (not the agent chip) when both apply", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        crossTaskOrigin={{
          sourceThreadId: ThreadId.makeUnsafe("source-thread"),
          sourceProvider: "codex",
        }}
        timelineEntries={[
          {
            id: "entry-first-user",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("first-user-message"),
              role: "user",
              text: "Inspect the repository",
              dispatchOrigin: "agent",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        nowIso="2026-03-17T19:14:30.000Z"
        onOpenThread={() => {}}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain("Sent by Moss from another thread");
    expect(markup).not.toContain("Sent by agent");
  });

  it("names the group when a group coordinator started the thread", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        crossTaskOrigin={{
          sourceThreadId: ThreadId.makeUnsafe("source-thread"),
          sourceProvider: "codex",
          coordinatorGroupName: "Release Moss",
        }}
        timelineEntries={[
          {
            id: "entry-first-user",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("first-user-message"),
              role: "user",
              text: "Inspect the repository",
              dispatchOrigin: "agent",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        nowIso="2026-03-17T19:14:30.000Z"
        onOpenThread={() => {}}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain("Sent by the Release Moss coordinator");
    expect(markup).toContain('aria-label="Open coordinator"');
    expect(markup).not.toContain("Sent by Moss from another thread");
  });

  it("renders edit beside copy for user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-editable-user",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-editable-user"),
              role: "user",
              text: "adjust this prompt",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-editable-assistant",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-editable-assistant"),
              role: "assistant",
              text: "",
              turnId: TurnId.makeUnsafe("turn-editable-user"),
              createdAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
            },
          },
        ]}
        revertTurnCountByUserMessageId={
          new Map([[MessageId.makeUnsafe("message-editable-user"), 0]])
        }
        onEditUserMessage={() => true}
        editableUserMessageId={MessageId.makeUnsafe("message-editable-user")}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain('aria-label="Copy message"');
    expect(markup).toContain('aria-label="Edit message"');
    expect(markup).toContain('aria-label="Revert to this message"');
    expect(markup).toContain("size-[1.125em]");
  });

  it("keeps edit available and hides undo before a revert checkpoint exists", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-user-no-checkpoint",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-no-checkpoint"),
              role: "user",
              text: "still waiting on undo",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-assistant-no-checkpoint",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-no-checkpoint"),
              role: "assistant",
              text: "",
              turnId: TurnId.makeUnsafe("turn-user-no-checkpoint"),
              createdAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
            },
          },
        ]}
        onEditUserMessage={() => true}
        editableUserMessageId={MessageId.makeUnsafe("message-user-no-checkpoint")}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain('aria-label="Edit message"');
    expect(markup).not.toContain('aria-label="Revert to this message"');
    expect(markup).not.toContain('title="Edit message"');
    expect(markup).not.toContain('title="Revert to this message"');
  });

  it("keeps edit available while an assistant turn is running", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={TurnId.makeUnsafe("turn-user-running")}
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        timelineEntries={[
          {
            id: "entry-user-running",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-running"),
              role: "user",
              text: "change this while it runs",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        nowIso="2026-03-17T19:12:32.000Z"
        revertTurnCountByUserMessageId={
          new Map([[MessageId.makeUnsafe("message-user-running"), 1]])
        }
        onEditUserMessage={() => true}
        editableUserMessageId={MessageId.makeUnsafe("message-user-running")}
        resolvedTheme="light"
      />,
    );

    const editButtonMarkup = markup.match(/<button[^>]*aria-label="Edit message"[^>]*>/)?.[0] ?? "";
    expect(markup).toContain('aria-label="Edit message"');
    expect(editButtonMarkup).not.toContain('disabled=""');
    expect(markup).not.toContain('title="Edit message"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Revert to this message"/);
  });

  it("renders a 'Sent by agent' chip above agent-dispatched user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-agent-user-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-agent-user"),
              role: "user",
              text: "status check from the coordinator",
              dispatchOrigin: "agent",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain("Sent by agent");
    expect(markup).not.toContain("Sent via Automation");
    expect(markup).not.toContain("Steering conversation");
  });

  it("renders assistant selection chips from hidden prompt markup when attachments are missing", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-user-selection-fallback",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-selection-fallback"),
              role: "user",
              text: [
                "please use this",
                "",
                "<assistant_selection>",
                "- assistant message assistant-1:",
                "  selected line from assistant",
                "</assistant_selection>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain("please use this");
    expect(markup).toContain("1 selection");
    expect(markup).not.toContain("&lt;assistant_selection&gt;");
  });

  it("keeps the generic working copy alongside the active compaction entry", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const [compactionEntry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "work-compacting",
          createdAt: "2026-03-17T19:12:28.000Z",
          kind: "context-compaction",
          summary: "Compacting context",
          tone: "info",
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            data: { item: { type: "contextCompaction", id: "compaction-1" } },
          },
        }),
      ],
      undefined,
    );
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-compacting",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: compactionEntry!,
          },
        ]}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain("Compacting context");
    expect(markup).toContain("/central-icons-reversed/arrows-hide.svg");
    expect(markup).toContain(">Working for <");
    expect(markup).not.toContain("h-px flex-1 bg-border");
  });

  it("localizes exact provider runtime messages in Chinese transcript rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-provider-runtime",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-provider-runtime",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Provider task stop failed",
              detail: "No active provider session is bound to this thread.",
              tone: "error",
            },
          },
          {
            id: "entry-provider-task-summary",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-provider-task-summary",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "2 tasks: 审核 provider-x, /原始/path",
              tone: "info",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("停止服务商任务失败");
    expect(markup).toContain("此线程未绑定活动的服务商会话。");
    expect(markup).not.toContain("Provider task stop failed");
    expect(markup).not.toContain("No active provider session is bound to this thread.");
    expect(markup).toContain("2 个任务：审核 provider-x, /原始/path");
    expect(markup).not.toContain("2 tasks: 审核 provider-x, /原始/path");
  });

  it("localizes hidden subagent counts without changing agent labels", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const firstThreadId = "subagent:thread-main:tool-1";
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-subagent-overflow",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-subagent-overflow",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Agent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              subagents: [
                {
                  threadId: "tool-1",
                  resolvedThreadId: firstThreadId,
                  nickname: "原始 Agent One",
                  isActive: true,
                },
                { threadId: "tool-2", nickname: "原始 Agent Two", isActive: true },
                { threadId: "tool-3", nickname: "原始 Agent Three", isActive: true },
                { threadId: "tool-4", nickname: "原始 Agent Four", isActive: true },
              ],
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("原始 Agent One、原始 Agent Two 和 另外 2 个 已开始工作");
    expect(markup).toContain("原始 Agent One");
    expect(markup).not.toContain("and 1 other subagent");
  });

  it("uses the Codex transcript subagent status vocabulary in Chinese", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-subagent-statuses",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-subagent-statuses",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Agent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              subagents: [
                {
                  threadId: "tool-running",
                  nickname: "Running Agent",
                  rawStatus: "in_progress",
                  statusLabel: "Running",
                  isActive: true,
                  latestUpdate: "正在检查时间线",
                },
                {
                  threadId: "tool-completed",
                  nickname: "Completed Agent",
                  rawStatus: "completed",
                  statusLabel: "Completed",
                  isActive: false,
                },
                {
                  threadId: "tool-failed",
                  nickname: "Failed Agent",
                  rawStatus: "failed",
                  statusLabel: "Failed",
                  isActive: false,
                },
              ],
            },
          },
          {
            id: "entry-subagent-session-statuses",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-subagent-session-statuses",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Agent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              subagents: [
                {
                  threadId: "tool-connecting",
                  nickname: "Connecting Agent",
                  statusLabel: "Connecting",
                  isActive: true,
                },
                {
                  threadId: "tool-closed",
                  nickname: "Closed Agent",
                  statusLabel: "Closed",
                  isActive: false,
                },
                {
                  threadId: "tool-vendor-status",
                  nickname: "Vendor Agent",
                  rawStatus: "vendor_warmup",
                  statusLabel: "Vendor warmup",
                  isActive: false,
                },
              ],
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(
      "Running Agent、Completed Agent 和 Failed Agent 已完成，但出现错误</span>",
    );
    expect(markup).toContain("Connecting Agent、Closed Agent 和 Vendor Agent 已开始工作</span>");
    expect(markup).not.toContain(">Vendor warmup</span>");
    expect(markup).not.toContain(">最新</span>");
    expect(markup).not.toContain(">Running</span>");
    expect(markup).not.toContain(">Completed</span>");
    expect(markup).not.toContain(">Failed</span>");
    expect(markup).not.toContain(">Connecting</span>");
    expect(markup).not.toContain(">Closed</span>");
    expect(markup).not.toContain(">Latest</span>");
    expect(markup).not.toContain(">已更新</span>");
    expect(markup).not.toContain(">已完成</span>");
  });

  it("never localizes a subagent prompt that matches a provider runtime message", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const prompt = "Provider task stop failed";
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-subagent-prompt",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-subagent-prompt",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Agent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              subagentAction: {
                tool: "task",
                status: "completed",
                summaryText: "Agent activity",
                prompt,
              },
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(prompt);
    expect(markup).not.toContain("停止服务商任务失败");
  });

  it("keeps the generic working copy alongside a recorded active compaction entry", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderEnglishMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-compacting",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-compacting",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Compacting context",
              tone: "info",
              activityKind: "context-compaction",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Compacting context");
    expect(markup).toContain("/central-icons-reversed/arrows-hide.svg");
    expect(markup).toContain(">Working for <");
    expect(markup).not.toContain("h-px flex-1 bg-border");
  });

  it("does not reserve a timestamp footer between live status updates and Thinking", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const activeTurnId = TurnId.makeUnsafe("turn-live-status");
    const assistantCreatedAt = "2026-03-17T19:12:29.000Z";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={activeTurnId}
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-tasks-updated",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.500Z",
            entry: {
              id: "work-tasks-updated",
              createdAt: "2026-03-17T19:12:28.500Z",
              label: "Tasks updated",
              tone: "info",
              turnId: activeTurnId,
            },
          },
          {
            id: "entry-live-assistant",
            kind: "message",
            createdAt: assistantCreatedAt,
            message: {
              id: MessageId.makeUnsafe("message-live-assistant"),
              role: "assistant",
              text: "",
              createdAt: assistantCreatedAt,
              streaming: false,
              turnId: activeTurnId,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Tasks updated");
    expect(markup).toContain("Thinking");
    expect(markup).not.toContain(formatShortTimestamp(assistantCreatedAt, "locale"));
    expect(markup).toMatch(/class="[^"]*\bpb-1\b[^"]*"[^>]*data-timeline-row-kind="message"/);
  });

  it("folds work log summaries above the next assistant message footer", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderEnglishMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-work-inline",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "turn",
              tone: "info",
            },
          },
          {
            id: "entry-assistant-inline",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain(formatShortTimestamp("2026-03-17T19:12:29.000Z", "locale"));
    expect(markup).toContain("Worked for 1.0s");
    expect(markup).not.toContain("data-scroll-anchor-ignore");
    expect(markup).not.toContain(
      `${formatShortTimestamp("2026-03-17T19:12:29.000Z", "locale")} • 1.0s`,
    );
    expect(markup).not.toContain("Work log");
  });

  it("renders Claude agent task output through the shared markdown renderer", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-05-09T16:31:20.000Z"
        timelineEntries={[
          {
            id: "entry-claude-agent-task",
            kind: "work",
            createdAt: "2026-05-09T16:31:20.000Z",
            entry: {
              id: "work-claude-agent-task",
              createdAt: "2026-05-09T16:31:20.000Z",
              label: "Agent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolTitle: "Map file-icon logic in file-changes",
              detail: [
                "## Complete File-Icon Rendering Map",
                "",
                "```tsx",
                'const iconName = "react";',
                "```",
              ].join("\n"),
            },
          },
        ]}
        nowIso="2026-05-09T16:31:25.000Z"
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain("<h2>Complete File-Icon Rendering Map</h2>");
    expect(markup).toContain("chat-markdown-codeblock");
    expect(markup).not.toContain("```tsx");
  });

  it("renders a lone reasoning update as iconless tool text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const activeTurnId = TurnId.makeUnsafe("turn-reasoning-lone");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps(null)}
        isWorking
        activeTurnInProgress
        activeTurnId={activeTurnId}
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-reasoning-trace",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "reasoning-trace",
              createdAt: "2026-03-17T19:12:28.100Z",
              turnId: activeTurnId,
              label: "Reasoning trace",
              toolTitle: "Reasoning trace",
              detail: "**Inspecting apps/web/src/store.ts**\n\n<!-- -->",
              tone: "tool",
            },
          },
        ]}
        resolvedTheme="light"
      />,
    );

    expect(markup.match(/data-codex-status-row="true"/g) ?? []).toHaveLength(1);
    expect(markup).not.toContain('data-work-entry-icon="true"');
    expect(markup).toContain("Inspecting apps/web/src/store.ts");
    expect(markup).not.toContain("Reasoning trace Inspecting");
  });

  it.each([
    {
      provider: "Codex",
      expectedSurface: 'data-command-literal="true"',
      expectedText: "git status --short</code>",
      activity: makeActivity({
        id: "codex-live-tool",
        createdAt: "2026-03-17T19:12:28.100Z",
        turnId: "turn-provider-live-tool",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Ran command",
          data: {
            item: {
              type: "commandExecution",
              id: "codex-tool-1",
              command: "/bin/zsh -lc 'git status --short'",
              status: "inProgress",
              commandActions: [{ type: "unknown", command: "git status --short" }],
            },
          },
        },
      }),
    },
  ])(
    "renders $provider tool activity beside live Working",
    async ({ activity, expectedText, expectedSurface }) => {
      const { MessagesTimeline } = await import("./MessagesTimeline");
      const activeTurnId = TurnId.makeUnsafe("turn-provider-live-tool");
      const markup = renderEnglishMarkup(
        <MessagesTimeline
          {...makeTimelineBaseProps()}
          isWorking
          activeTurnInProgress
          activeTurnId={activeTurnId}
          activeTurnStartedAt="2026-03-17T19:12:28.000Z"
          timelineEntries={deriveWorkLogEntries([activity], activeTurnId).map((entry) => ({
            id: entry.id,
            kind: "work" as const,
            createdAt: entry.createdAt,
            entry,
          }))}
        />,
      );

      expect(markup).toContain('data-timeline-row-kind="work"');
      expect(markup).toContain('data-work-entry-display-text="true"');
      expect(markup).toContain(expectedSurface);
      expect(markup).toContain(">Working for <");
      expect(markup).toContain(expectedText);
    },
  );

  it("shows Loading when a new local send has no server turn id yet", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const previousTurnId = TurnId.makeUnsafe("turn-previous");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        workingLabel="Loading"
        activeTurnInProgress
        activeTurnId={null}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-user-previous",
            kind: "message",
            createdAt: "2026-03-17T19:12:20.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-previous"),
              role: "user",
              text: "Previous request",
              createdAt: "2026-03-17T19:12:20.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-reasoning-previous",
            kind: "work",
            createdAt: "2026-03-17T19:12:21.000Z",
            entry: {
              id: "reasoning-previous",
              createdAt: "2026-03-17T19:12:21.000Z",
              turnId: previousTurnId,
              label: "Reasoning",
              toolTitle: "Reasoning",
              tone: "info",
            },
          },
          {
            id: "entry-assistant-previous",
            kind: "message",
            createdAt: "2026-03-17T19:12:22.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-previous"),
              role: "assistant",
              turnId: previousTurnId,
              text: "Previous answer",
              createdAt: "2026-03-17T19:12:22.000Z",
              completedAt: "2026-03-17T19:12:23.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-user-current",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-current"),
              role: "user",
              text: "Current request",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(">Loading<");
  });

  it("attaches trailing tool rows to the last assistant reply after completion", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderEnglishMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-assistant-final",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-final"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-trailing-tool-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.100Z",
            entry: {
              id: "work-trailing-tool-1",
              createdAt: "2026-03-17T19:12:30.100Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-trailing-tool-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.200Z",
            entry: {
              id: "work-trailing-tool-2",
              createdAt: "2026-03-17T19:12:30.200Z",
              label: "tool 2",
              tone: "tool",
            },
          },
        ]}
        nowIso="2026-03-17T19:12:31.000Z"
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain("Worked for ");
    expect(markup).toContain(">done</p>");
    // Trailing work folds into the terminal reply's collapsed disclosure rather
    // than leaving a detached work row at the end of the transcript.
    expect(markup).not.toContain("Tool 1");
    expect(markup).not.toContain("Tool 2");
    expect(markup).not.toContain('data-timeline-row-kind="work"');
  });

  it("keeps the divider after imported history while waiting for the first fork turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        hasMessages
        timelineEntries={[makeForkImportedEntry()]}
        forkSource={FORK_SOURCE}
        onOpenThread={() => {}}
      />,
    );

    expect(markup.indexOf("Imported history")).toBeLessThan(
      markup.indexOf('data-fork-source-divider="true"'),
    );
  });

  it("keeps small transcripts on the simple non-virtualized path", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-message-1"),
              role: "assistant",
              text: "stable transcript body",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-index="0"');
    expect(markup).not.toContain('class="relative" style="height:');
    expect(markup).toContain('data-timeline-row-kind="message"');
  });

  it("renders assistant math through the shared markdown renderer", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-assistant-math",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-message-math"),
              role: "assistant",
              text: ["Inline $a^2 + b^2 = c^2$", "", "$$", "\\sum_{n=1}^{4} n", "$$"].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('class="katex"');
    expect(markup).toContain("katex-display");
  });

  it("renders user message metadata outside the bubble shell", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-1"),
              role: "user",
              text: "ship the fix",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map([[MessageId.makeUnsafe("message-1"), 1]])}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("flex w-full justify-end");
    expect(markup).toContain("group flex flex-col items-end gap-px max-w-[80%]");
    // Upstream shell design: the bubble surface comes from the shared
    // --app-user-message-background token instead of Moss's old black bubble.
    expect(markup).toContain(
      "w-max max-w-full min-w-0 self-end bg-[var(--app-user-message-background)]",
    );
    expect(markup).toContain("rounded-[var(--radius-user-message)]");
    expect(markup).toContain('data-user-message-bubble="true"');
    expect(markup).toContain("px-3.5 py-2.5");
    expect(markup).toContain("group-hover:opacity-100");
  });

  it("keeps user-bubble file and folder mention icons from being overridden by plugin names", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const baseProps = { ...makeTimelineBaseProps(), resolvedTheme: "light" as const };

    const folderMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-folder-mention",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-folder-mention"),
              role: "user",
              text: "Use @linear",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    // Folders render the shared outline folder glyph.
    expect(folderMarkup).toContain('data-slot="central-icon"');
    expect(folderMarkup).toContain("/central-icons-reversed/folder-2.svg");
    expect(folderMarkup).not.toContain("/central-icons-reversed/puzzle.svg");

    const tsxMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-tsx-file-mention",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-tsx-file-mention"),
              role: "user",
              text: "Use @src/App.tsx",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(tsxMarkup).toContain("/central-icons-reversed/react.svg");
    expect(tsxMarkup).not.toContain("/central-icons-reversed/folder-2.svg");

    const pluginMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-plugin-mention",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-plugin-mention"),
              role: "user",
              text: "Use @linear",
              mentions: [{ name: "linear", path: "plugin://linear@openai-curated" }],
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(pluginMarkup).toContain("/central-icons-reversed/puzzle.svg");
  });

  it("keeps assistant actions localized, ordered, and scoped to settled replies", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const firstAssistantId = MessageId.makeUnsafe("message-action-first");
    const secondAssistantId = MessageId.makeUnsafe("message-action-second");
    const streamingAssistantId = MessageId.makeUnsafe("message-action-streaming");
    const actionEntries = [
      {
        id: "entry-action-user-1",
        kind: "message" as const,
        createdAt: "2026-03-17T19:12:28.000Z",
        message: {
          id: MessageId.makeUnsafe("message-action-user-1"),
          role: "user" as const,
          text: "first question",
          createdAt: "2026-03-17T19:12:28.000Z",
          streaming: false,
        },
      },
      {
        id: "entry-action-assistant-1",
        kind: "message" as const,
        createdAt: "2026-03-17T19:12:29.000Z",
        message: {
          id: firstAssistantId,
          role: "assistant" as const,
          text: "first answer",
          completedAt: "2026-03-17T19:12:30.000Z",
          createdAt: "2026-03-17T19:12:29.000Z",
          streaming: false,
        },
      },
      {
        id: "entry-action-user-2",
        kind: "message" as const,
        createdAt: "2026-03-17T19:12:31.000Z",
        message: {
          id: MessageId.makeUnsafe("message-action-user-2"),
          role: "user" as const,
          text: "second question",
          createdAt: "2026-03-17T19:12:31.000Z",
          streaming: false,
        },
      },
      {
        id: "entry-action-assistant-2",
        kind: "message" as const,
        createdAt: "2026-03-17T19:12:32.000Z",
        message: {
          id: secondAssistantId,
          role: "assistant" as const,
          text: "second answer",
          completedAt: "2026-03-17T19:12:33.000Z",
          createdAt: "2026-03-17T19:12:32.000Z",
          streaming: false,
        },
      },
      {
        id: "entry-action-user-3",
        kind: "message" as const,
        createdAt: "2026-03-17T19:12:34.000Z",
        message: {
          id: MessageId.makeUnsafe("message-action-user-3"),
          role: "user" as const,
          text: "third question",
          createdAt: "2026-03-17T19:12:34.000Z",
          streaming: false,
        },
      },
      {
        id: "entry-action-assistant-3",
        kind: "message" as const,
        createdAt: "2026-03-17T19:12:35.000Z",
        message: {
          id: streamingAssistantId,
          role: "assistant" as const,
          text: "still answering",
          createdAt: "2026-03-17T19:12:35.000Z",
          streaming: true,
        },
      },
    ];
    const actionProps = {
      ...makeTimelineBaseProps(),
      timelineEntries: actionEntries,
      onTogglePinMessage: () => {},
      onForkFromMessage: () => {},
      canPinMessage: () => true,
    };
    const markup = renderToStaticMarkup(<MessagesTimeline {...actionProps} />);
    const copyLabel = 'aria-label="Copy message"';
    const pinLabel = 'aria-label="Pin message"';
    const forkLabel = 'aria-label="Fork this thread into local or a new worktree"';
    expect(markup.match(new RegExp(copyLabel, "g")) ?? []).toHaveLength(5);
    expect(markup.match(new RegExp(pinLabel, "g")) ?? []).toHaveLength(2);
    expect(markup.match(new RegExp(forkLabel, "g")) ?? []).toHaveLength(2);
    const actionRowStarts = [...markup.matchAll(/data-message-action-row="true"/g)].map(
      (match) => match.index ?? -1,
    );
    const actionRowMarkup = actionRowStarts.map((rowStart, index) => {
      const rowEnd = actionRowStarts[index + 1] ?? markup.length;
      return markup.slice(rowStart, rowEnd);
    });
    const actionableRows = actionRowMarkup.filter(
      (rowMarkup) => rowMarkup.includes(pinLabel) || rowMarkup.includes(forkLabel),
    );
    expect(actionableRows).toHaveLength(2);
    for (const rowMarkup of actionableRows) {
      expect(rowMarkup.indexOf(copyLabel)).toBeGreaterThanOrEqual(0);
      expect(rowMarkup.indexOf(pinLabel)).toBeGreaterThanOrEqual(0);
      expect(rowMarkup.indexOf(forkLabel)).toBeGreaterThanOrEqual(0);
      expect(rowMarkup.indexOf(copyLabel)).toBeLessThan(rowMarkup.indexOf(pinLabel));
      expect(rowMarkup.indexOf(pinLabel)).toBeLessThan(rowMarkup.indexOf(forkLabel));
    }
    const streamingRowStart = markup.indexOf(`data-message-id="${streamingAssistantId}"`);
    expect(streamingRowStart).toBeGreaterThanOrEqual(0);
    const streamingRow = markup.slice(streamingRowStart);
    expect(streamingRow).not.toContain(copyLabel);
    expect(streamingRow).not.toContain(pinLabel);
    expect(streamingRow).not.toContain(forkLabel);
    expect(markup).toContain("mt-1.5 flex h-5 items-center justify-start gap-0.5");
    expect(
      actionableRows.filter((rowMarkup) =>
        rowMarkup.includes('data-message-action-row-visibility="hover"'),
      ),
    ).toHaveLength(1);
    expect(
      actionableRows.filter((rowMarkup) =>
        rowMarkup.includes('data-message-action-row-visibility="always"'),
      ),
    ).toHaveLength(1);

    const forkWithoutPinMarkup = renderToStaticMarkup(
      <MessagesTimeline {...actionProps} canPinMessage={() => false} />,
    );
    expect(forkWithoutPinMarkup.match(new RegExp(pinLabel, "g")) ?? []).toHaveLength(0);
    expect(forkWithoutPinMarkup.match(new RegExp(forkLabel, "g")) ?? []).toHaveLength(2);
  });

  it("renders a steering chip above steered user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-steered-user-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-steered-user"),
              role: "user",
              text: "hello",
              dispatchMode: "steer",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Steering conversation");
    expect(markup).toContain("mb-1.5");
  });

  it("renders a 'Sent via Automation' chip above automation-dispatched user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-automation-user-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-automation-user"),
              role: "user",
              text: "hello",
              dispatchOrigin: "automation",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Sent via Automation");
    expect(markup).not.toContain("Steering conversation");
  });

  it("pushes the steering chip higher when the user message has chips or photos", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-steered-user-message-media",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-steered-user-media"),
              role: "user",
              text: "hello",
              dispatchMode: "steer",
              attachments: [
                {
                  id: "assistant-selection-1",
                  type: "assistant-selection",
                  assistantMessageId: MessageId.makeUnsafe("assistant-1"),
                  text: "draft this",
                },
                {
                  id: "image-1",
                  type: "image",
                  name: "image.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Steering conversation");
    expect(markup).toContain("mb-3");
  });

  it("renders user text as markdown with hard line breaks", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-plain-user-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-plain-user"),
              role: "user",
              text: "tl\ndr",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("chat-markdown--user");
    // remark-breaks keeps the user's single newline as a hard break.
    expect(markup).toContain("tl<br/>\ndr");
    expect(markup).not.toContain("<pre");
  });

  it("clamps long user messages visually and renders a separate Show more button", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const hiddenTail = "TAIL_SHOULD_STAY_HIDDEN";
    const longText = `${"a".repeat(COLLAPSED_USER_MESSAGE_MAX_CHARS)}${hiddenTail}`;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-long-user-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-long-user"),
              role: "user",
              text: longText,
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Show more");
    // The full text stays rendered; collapsing is a visual max-height clamp with
    // a fade mask, so markdown structures are never sliced mid-syntax.
    expect(markup).toContain(hiddenTail);
    expect(markup).toContain('data-user-message-clamp="true"');
    expect(markup).toContain("max-height:");
    expect(markup).toContain("mask-image:linear-gradient");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toMatch(/aria-controls="[^"]+"/);
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-2"),
              role: "user",
              text: [
                "yoo what's **bold** @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain('data-slot="central-icon"');
    expect(markup).toContain("/central-icons-reversed/console.svg");
    expect(markup).toContain("yoo what&#x27;s ");
    expect(markup).toContain("<strong>bold</strong>");
  });

  it("renders trailing user skill tokens with the composer skill pill UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-user-skill-pill",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-skill"),
              role: "user",
              text: "$check-code",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain("Check Code");
    expect(markup).toContain("text-[var(--info-foreground)]");
    expect(markup).not.toContain("$check-code</div>");
  });

  it("renders trailing user subagent mentions with the composer agent pill UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-user-agent-pill",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-agent"),
              role: "user",
              text: "@spark(check the UI)",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("@spark");
    expect(markup).toContain("inline-flex max-w-full select-none items-center gap-0.5");
    expect(markup).toContain("mx-0.5");
    expect(markup).toContain("rounded-md px-1.5 py-0.5");
    expect(markup).toContain("(check the UI)");
    expect(markup).not.toContain("@spark(check the UI)</div>");
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
              activityKind: "context-compaction",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("上下文已压缩");
    expect(markup).not.toContain("Work log");
  });

  it("renders a stopped compaction with its terminal display text", async () => {
    const stoppedCompactionEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-progress-stopped",
          createdAt: "2026-03-17T19:12:28.000Z",
          kind: "context-compaction",
          summary: "Context automatically compacting",
          tone: "info",
          turnId: "stopped-compaction-turn",
          payload: {
            source: "automatic",
            operationId: "compaction-stopped-1",
          },
        }),
      ],
      undefined,
      {
        activeTurnId: null,
        activeTurnStartedAt: "2026-03-17T19:12:28.000Z",
        latestTurnState: null,
        latestTurnCompletedAt: null,
      },
    );
    const stoppedCompactionEntry = stoppedCompactionEntries[0];
    expect(stoppedCompactionEntry).toMatchObject({
      label: "Context compaction cancelled",
      toolTitle: "Context compaction cancelled",
    });

    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "timeline-stopped-compaction",
            kind: "work",
            createdAt: stoppedCompactionEntry!.createdAt,
            entry: stoppedCompactionEntry!,
          },
        ]}
      />,
    );

    expect(markup).toContain(
      '<span data-work-entry-display-text="true" data-translation-skip="true">Context compaction cancelled</span>',
    );
    expect(markup).not.toContain("Context automatically compacting");
  });

  it("attaches trailing work log summaries to the last assistant reply after completion", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-assistant-trailing",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-trailing"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-work-trailing",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "work-trailing-1",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "turn",
              tone: "info",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:31.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(">done</p>");
    expect(markup).not.toContain("Work log");
    expect(markup).not.toContain('data-timeline-row-kind="work"');
  });

  it("collapses every completed-turn tool call behind a single Worked-for toggle", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-tools",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-tool-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "work-inline-tool-2",
              createdAt: "2026-03-17T19:12:28.100Z",
              label: "tool 2",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.200Z",
            entry: {
              id: "work-inline-tool-3",
              createdAt: "2026-03-17T19:12:28.200Z",
              label: "tool 3",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.300Z",
            entry: {
              id: "work-inline-tool-4",
              createdAt: "2026-03-17T19:12:28.300Z",
              label: "tool 4",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.400Z",
            entry: {
              id: "work-inline-tool-5",
              createdAt: "2026-03-17T19:12:28.400Z",
              label: "tool 5",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-6",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.500Z",
            entry: {
              id: "work-inline-tool-6",
              createdAt: "2026-03-17T19:12:28.500Z",
              label: "tool 6",
              tone: "tool",
            },
          },
          {
            id: "entry-assistant-inline-tools",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline-tools"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("已工作");
    expect(markup).toContain(">done</p>");
    // Completed turns fold all tool work behind the single collapsed disclosure,
    // which stays unmounted until expanded, so no inline tool rows leak out.
    expect(markup).not.toContain("+2 more tool calls");
    expect(markup).not.toContain("Tool 1");
    expect(markup).not.toContain("Tool 5");
  });

  it("does not count a bodyless terminal answer in the Worked-for fallback", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const renderImageTurn = (assistantText: string) =>
      renderChineseMarkup(
        <MessagesTimeline
          {...makeTimelineBaseProps()}
          timelineEntries={[
            {
              id: "entry-generated-image",
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: "generated-image",
                createdAt: "2026-03-17T19:12:28.000Z",
                label: "Generated image",
                tone: "tool",
                itemType: "image_generation",
                activityKind: "tool.completed",
              },
            },
            {
              id: "entry-bodyless-terminal",
              kind: "message",
              createdAt: "2026-03-17T19:12:29.000Z",
              message: {
                id: MessageId.makeUnsafe("bodyless-terminal"),
                role: "assistant",
                text: assistantText,
                createdAt: "2026-03-17T19:12:29.000Z",
                streaming: false,
              },
            },
          ]}
        />,
      );

    const bodylessMarkup = renderImageTurn("");
    expect(bodylessMarkup).toContain("之前的 1 条消息");
    expect(bodylessMarkup).not.toContain("之前的 2 条消息");
    expect(bodylessMarkup).not.toContain("(empty response)");

    const finalAnswerMarkup = renderImageTurn("Final answer");
    expect(finalAnswerMarkup).toContain("之前的 2 条消息");
  });

  it("renders Cursor-style inline tool rows with a uniform label", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-05-09T16:31:20.000Z"
        timelineEntries={[
          {
            id: "entry-cursor-search",
            kind: "work",
            createdAt: "2026-05-09T16:31:20.000Z",
            entry: {
              id: "work-cursor-search",
              createdAt: "2026-05-09T16:31:20.000Z",
              label: "Tool",
              tone: "tool",
              itemType: "dynamic_tool_call",
              toolTitle: "Searched",
              detail: "2 files found",
            },
          },
          {
            id: "entry-cursor-assistant",
            kind: "message",
            createdAt: "2026-05-09T16:31:24.000Z",
            message: {
              id: MessageId.makeUnsafe("message-cursor-assistant"),
              role: "assistant",
              text: "done",
              createdAt: "2026-05-09T16:31:24.000Z",
              completedAt: "2026-05-09T16:31:25.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-05-09T16:31:25.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(
      '<span data-work-entry-display-text="true" data-translation-skip="true">已搜索 2 个文件</span>',
    );
    expect(markup).not.toContain("data-work-entry-action-word");
  });

  it("renders the complete task-list progress heading", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const activeTurnId = TurnId.makeUnsafe("turn-task-progress");
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "tasks-live",
          kind: "turn.tasks.updated",
          summary: "Tasks updated",
          tone: "info",
          turnId: activeTurnId,
          payload: {
            tasks: [
              { task: "Implement inline editing", status: "completed" },
              { task: "Run verification", status: "inProgress" },
              { task: "Ship", status: "pending" },
            ],
          },
        }),
      ],
      activeTurnId,
    );
    const timelineEntries = deriveTimelineEntries([], [], workEntries);

    const markup = renderChineseMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={activeTurnId}
        activeTurnStartedAt="2026-05-09T16:31:20.000Z"
        timelineEntries={timelineEntries}
      />,
    );

    expect(markup).toContain('data-timeline-row-kind="todo-plan"');
    expect(markup).toContain('data-todo-plan-row="true"');
    expect(markup).toContain(">第 2 / 3 步<");
    expect(markup).not.toContain('data-timeline-row-kind="work"');
  });

  it("collapses a leading tool run behind its summary once the assistant text follows, even mid-turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-inline-tools-live-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-live-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "work-inline-live-2",
              createdAt: "2026-03-17T19:12:28.100Z",
              label: "tool 2",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.200Z",
            entry: {
              id: "work-inline-live-3",
              createdAt: "2026-03-17T19:12:28.200Z",
              label: "tool 3",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.300Z",
            entry: {
              id: "work-inline-live-4",
              createdAt: "2026-03-17T19:12:28.300Z",
              label: "tool 4",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.400Z",
            entry: {
              id: "work-inline-live-5",
              createdAt: "2026-03-17T19:12:28.400Z",
              label: "tool 5",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-6",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.500Z",
            entry: {
              id: "work-inline-live-6",
              createdAt: "2026-03-17T19:12:28.500Z",
              label: "tool 6",
              tone: "tool",
            },
          },
          {
            id: "entry-assistant-inline-tools-live",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline-tools-live"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    // The assistant's text block already follows the run, so it compacts
    // behind the summary row even while the turn is still live. The summary
    // sentence follows the current native summary copy in an explicit Chinese
    // scope; the group retains all six calls behind its disclosure.
    expect(markup).toContain("调用了工具");
    expect(markup).toContain('data-tool-group-phase="collapsed"');
    expect(markup).toContain('aria-hidden="true" inert=""');
    // Upstream mount-on-open: a closed group leaves its rows out of the DOM
    // until the disclosure is toggled.
    expect(markup).not.toContain("Tool 1");
    expect(markup).not.toContain("Tool 6");
    expect(markup).not.toContain("+2 more tool calls");
  });

  it("renders reasoning activity as iconless tool text while Thinking remains live", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const activeTurnId = TurnId.makeUnsafe("turn-reasoning-live");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps(null)}
        isWorking
        activeTurnInProgress
        activeTurnId={activeTurnId}
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-reasoning-trace",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "reasoning-trace",
              createdAt: "2026-03-17T19:12:28.100Z",
              turnId: activeTurnId,
              label: "Reasoning trace",
              toolTitle: "Reasoning trace",
              detail: "**Inspecting apps/web/src/store.ts**\n\n<!-- -->",
              tone: "tool",
            },
          },
          {
            id: "entry-mcp-tool",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.200Z",
            entry: {
              id: "mcp-tool",
              createdAt: "2026-03-17T19:12:28.200Z",
              turnId: activeTurnId,
              label: "MCP tool call",
              toolTitle: "MCP tool call",
              toolName: "mcp__docs__search",
              itemType: "mcp_tool_call",
              tone: "tool",
            },
          },
          {
            id: "entry-reasoning-summary",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.300Z",
            entry: {
              id: "reasoning-summary",
              createdAt: "2026-03-17T19:12:28.300Z",
              turnId: activeTurnId,
              label: "Reasoning summary",
              toolTitle: "Reasoning summary",
              preview: "Updating the adapter",
              tone: "tool",
            },
          },
          {
            id: "entry-command-execution",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.400Z",
            entry: {
              id: "command-execution",
              createdAt: "2026-03-17T19:12:28.400Z",
              turnId: activeTurnId,
              label: "Ran command",
              toolTitle: "Ran command",
              itemType: "command_execution",
              preview: "Running the focused tests",
              tone: "tool",
            },
          },
        ]}
        resolvedTheme="light"
      />,
    );

    // Upstream fold: reasoning updates that are not the transcript tail join
    // the ordinary work run, which collapses to one live line wearing the
    // newest call while Thinking stays live; no dedicated reasoning row and
    // no raw reasoning detail leaks into the markup.
    expect(markup).toContain('data-tool-group-disclosure="true"');
    expect(markup).toContain('data-tool-group-live="true"');
    expect(markup).toContain("Running the focused tests");
    expect(markup).toContain(">Thinking<");
    expect(markup).not.toContain('data-reasoning-row="true"');
    expect(markup).not.toContain("Reasoning trace Inspecting");
  });

  it("folds a live inline tool run to a single line wearing the newest call", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          // The message comes first so the tools are the turn's live inline
          // tail: the run folds to one live line wearing the newest call.
          {
            id: "entry-assistant-inline-tools-expanded",
            kind: "message",
            createdAt: "2026-03-17T19:12:27.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline-tools-expanded"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:27.000Z",
              streaming: true,
            },
          },
          {
            id: "entry-inline-tools-expanded",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-expanded-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "work-inline-expanded-2",
              createdAt: "2026-03-17T19:12:28.100Z",
              label: "tool 2",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.200Z",
            entry: {
              id: "work-inline-expanded-3",
              createdAt: "2026-03-17T19:12:28.200Z",
              label: "tool 3",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.300Z",
            entry: {
              id: "work-inline-expanded-4",
              createdAt: "2026-03-17T19:12:28.300Z",
              label: "tool 4",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.400Z",
            entry: {
              id: "work-inline-expanded-5",
              createdAt: "2026-03-17T19:12:28.400Z",
              label: "tool 5",
              tone: "tool",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{ "entry-inline-tools-expanded": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    // Upstream fold: the live tail wears the newest call on one line; the
    // older rows stay behind the disclosure and there is no +N cap toggle.
    expect(markup).toContain('data-tool-group-live="true"');
    expect(markup).toContain("Tool 5");
    expect(markup).not.toContain("Tool 1");
    expect(markup).not.toContain("+2 more tool calls");
    expect(markup).not.toContain("Show less");
  });

  it("localizes command execution copy while preserving the literal command", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-localized-command-target",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-localized-command-target",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Compared",
              command: "git diff",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("已运行");
    expect(markup).toContain("git diff");
    expect(markup).not.toContain("Compared");
  });

  it("uses the GitHub logo for git and GitHub CLI command rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    // Each command renders alone: a singleton run has nothing to summarize, so
    // its row stays open and wears its own tool icon. (Consecutive command
    // rows fold into a single summary line that renders no per-row icons.)
    const renderCommandRow = (id: string, toolTitle: string, command: string) =>
      renderToStaticMarkup(
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnInProgress={true}
          activeTurnStartedAt={null}
          timelineEntries={[
            {
              id: `entry-${id}`,
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: `work-${id}`,
                createdAt: "2026-03-17T19:12:28.000Z",
                label: "Ran command",
                tone: "tool",
                itemType: "command_execution",
                toolTitle,
                command,
              },
            },
          ]}
          turnDiffSummaryByAssistantMessageId={new Map()}
          nowIso="2026-03-17T19:12:30.000Z"
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />,
      );

    const gitMarkup = renderCommandRow("git-command", "Checked", "git status --short");
    const ghMarkup = renderCommandRow("gh-command", "Ran", "gh pr view 274 --repo owner/repo");

    expect(gitMarkup.match(/data-tool-icon="github"/g)).toHaveLength(1);
    expect(ghMarkup.match(/data-tool-icon="github"/g)).toHaveLength(1);
    expect(gitMarkup).not.toContain("/central-icons-reversed/git.svg");
    expect(ghMarkup).not.toContain("/central-icons-reversed/git.svg");
  });

  it("marks command rows with captured details as clickable", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-command-details",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-command-details",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Searched",
              command: `rg -n "toolDetails" apps/web/src`,
              toolDetails: {
                kind: "command",
                title: "Searched",
                command: `rg -n "toolDetails" apps/web/src`,
                output: {
                  stdout: "apps/web/src/session-logic.ts:55: toolDetails",
                },
              },
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-tool-detail-trigger="true"');
    expect(markup).toContain('aria-expanded="false"');
    // Upstream mount-on-open disclosure: the captured command output stays out
    // of the DOM until the row is opened.
    expect(markup).not.toContain('data-tool-details-inline="true"');
    expect(markup).not.toContain("apps/web/src/session-logic.ts:55: toolDetails");
    expect(markup).toContain("已搜索");
  });

  it("renders command text even when commandActions provide a short preview", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-command-actions",
            kind: "work",
            createdAt: "2026-05-09T10:06:54.443Z",
            entry: {
              id: "work-inline-command-actions",
              createdAt: "2026-05-09T10:06:54.443Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Listed",
              preview: "web",
              command: "find apps/web/src -maxdepth 2 -type d",
              rawCommand: `/bin/zsh -lc "find apps/web/src -maxdepth 2 -type d | sort | sed -n '1,120p'"`,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-05-09T10:07:00.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("已运行");
    expect(markup).toContain("find apps/web/src -maxdepth 2 -type d | sort | sed -n");
    expect(markup).not.toContain("data-work-entry-action-word");
    expect(markup).toContain("web/src");
    expect(markup).toContain(TOOLTIP_TRIGGER_MARKER);
    expect(markup).not.toContain(">已列出 web<");
  });

  it("renders plain location details as file basenames", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-read-location",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-read-location",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read",
              tone: "tool",
              itemType: "dynamic_tool_call",
              toolTitle: "Read",
              detail: "apps/web/src/session-logic.ts:12",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onOpenTurnDiff={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("已读取");
    expect(markup).toContain("session-logic.ts");
    expect(markup).not.toContain("apps/web/src/session-logic.ts:12");
  });

  it("renders read target files without edit-row treatment", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-read-target",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-read-target",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read",
              tone: "tool",
              itemType: "dynamic_tool_call",
              toolTitle: "Read",
              changedFiles: ["apps/web/src/session-logic.ts"],
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onOpenTurnDiff={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("已读取");
    expect(markup).toContain("session-logic.ts");
    expect(markup).not.toContain("data-file-change-row");
  });

  it("shows a globe icon next to compact web-search rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-web-search",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-web-search",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Web search",
              tone: "tool",
              itemType: "web_search",
              toolTitle: "Searched the web",
              detail: "48 files found",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("已搜索网页");
    expect(markup).toContain("48 个文件");
    expect(markup).toContain("/central-icons-reversed/globe.svg");
    expect(markup).not.toContain("tabler-icon-world");
  });

  it("shows a GitHub icon next to compact GitHub MCP rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-github-mcp",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-github-mcp",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "mcp_tool_call",
              toolTitle: "Codex Apps: Github Fetch Pr",
              toolName: "mcp__codex_apps__github__fetch_pr",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Codex Apps: Github Fetch Pr");
    expect(markup).toContain('data-tool-icon="github"');
  });

  it("shows an MCP icon next to compact non-GitHub MCP rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-mcp",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-mcp",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "mcp_tool_call",
              toolTitle: "Codex Apps: Slack Search",
              toolName: "mcp__codex_apps__slack__search",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Codex Apps: Slack Search");
    expect(markup).toContain('data-tool-icon="mcp"');
  });

  it("uses the browser icon and action name for Moss browser calls", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderChineseMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-inline-moss-browser",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-moss-browser",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "mcp_tool_call",
              toolName: "mcp__moss__browser_open",
              toolStatus: "completed",
              liveActivity: {
                state: "completed",
                label: "Moss: Browser Open",
                startedAt: "2026-03-17T19:12:27.000Z",
                lastActivityAt: "2026-03-17T19:12:28.000Z",
                elapsedSeconds: 1,
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-tool-icon="browser"');
    expect(markup).toContain("打开浏览器标签页");
    // A settled call reads as its action alone — no lifecycle or timing tail.
    expect(markup).not.toContain("elapsed");
    expect(markup).not.toContain("Completed tool");
    expect(markup).not.toContain("Moss: Browser Open");

    const presentationOnlyMarkup = renderChineseMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-presentation-only-browser",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-presentation-only-browser",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Open browser tab",
              tone: "tool",
              itemType: "mcp_tool_call",
              toolTitle: "Open browser tab",
              toolStatus: "completed",
              activityKind: "tool.completed",
            },
          },
        ]}
      />,
    );
    expect(presentationOnlyMarkup).toContain('data-tool-icon="browser"');
  });

  it("keeps browser tools from other MCP servers generic", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-inline-other-browser",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-other-browser",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "mcp_tool_call",
              toolName: "mcp__other__browser_open",
              toolStatus: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-tool-icon="mcp"');
    expect(markup).not.toContain('data-tool-icon="moss"');
    expect(markup).not.toContain("moss-logo-coral.png");
  });

  it("renders inline file-change tool calls as edited rows with diff stats", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-inline-edit");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-inline-file-change",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-file-change",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File Change",
              tone: "tool",
              requestKind: "file-change",
              changedFiles: ["apps/web/src/components/chat/MessagesTimeline.test.tsx"],
              toolDetails: {
                kind: "file-change",
                title: "Edited",
                diff: [
                  "diff --git a/apps/web/src/components/chat/MessagesTimeline.test.tsx b/apps/web/src/components/chat/MessagesTimeline.test.tsx",
                  "-old",
                  "+new",
                ].join("\n"),
                files: ["apps/web/src/components/chat/MessagesTimeline.test.tsx"],
              },
            },
          },
          {
            id: "entry-assistant-inline-edit",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-inline-edit-1"),
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.test.tsx",
                    additions: 1,
                    deletions: 1,
                  },
                ],
              },
            ],
          ])
        }
      />,
    );

    expect(markup).toContain("Edited");
    expect(markup).toContain("MessagesTimeline.test.tsx");
    expect(markup).toContain("+1");
    expect(markup).toContain("-1");
    expect(markup).not.toContain(
      "File Change - apps/web/src/components/chat/MessagesTimeline.test.tsx",
    );
  });

  it("marks visible file-change rows with captured details as clickable", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-file-change-details",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-file-change-details",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File Change",
              tone: "tool",
              requestKind: "file-change",
              changedFiles: ["apps/web/src/components/chat/MessagesTimeline.test.tsx"],
              toolDetails: {
                kind: "file-change",
                title: "Edited",
                diff: "-old\n+new",
                files: ["apps/web/src/components/chat/MessagesTimeline.test.tsx"],
              },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-tool-detail-trigger="true"');
    expect(markup).toContain(TOOLTIP_TRIGGER_MARKER);
    expect(markup).not.toContain('data-tool-details-inline="true"');
    expect(markup).not.toContain("Diff");
    expect(markup).not.toContain("Details");
  });

  it("renders command rows with the literal command and styled hover tooltip trigger", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderEnglishMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-inline-command",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-command",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Searched",
              command: `rg -n "ProjectionSnapshotQuery" apps/server/src`,
              rawCommand: `/bin/zsh -lc 'rg -n "ProjectionSnapshotQuery" apps/server/src'`,
            },
          },
        ]}
      />,
    );

    // The command shows verbatim (minus the shell wrapper) instead of a guessed
    // sentence, and the search wears the magnifier.
    expect(markup).toContain(
      `Ran <code class="${INLINE_COMMAND_CHIP_CLASS_NAME}" data-command-literal="true">rg -n &quot;ProjectionSnapshotQuery&quot; apps/server/src</code>`,
    );
    expect(markup).toContain("magnifying-glass.svg");
    expect(markup).not.toContain("data-work-entry-action-word");
    expect(markup).toContain(TOOLTIP_TRIGGER_MARKER);
    expect(markup).not.toContain(
      `title="/bin/zsh -lc &#x27;rg -n &quot;ProjectionSnapshotQuery&quot; apps/server/src&#x27;"`,
    );
    expect(markup).not.toContain("&gt;/bin/zsh -lc");
  });

  it("shows the Moss mark for every provider-specific tool row shape", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const baseProps = makeTimelineBaseProps();

    // Provider-style server/tool identifier while the call is active.
    const claudeMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-inline-moss-claude",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-moss-claude",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "dynamic_tool_call",
              toolTitle: "Moss__moss_create_thread",
              toolName: "Moss__moss_create_thread",
              detail: "Moss__moss_create_thread",
              activityKind: "tool.started",
            },
          },
        ]}
      />,
    );
    expect(claudeMarkup).toContain('data-tool-icon="moss"');
    expect(claudeMarkup).not.toContain('data-tool-icon="mcp"');
    expect(claudeMarkup).toContain("Moss is creating a thread");
    expect(claudeMarkup).not.toContain("Moss__moss_create_thread");

    // A provider may misclassify an MCP action containing "create" or "list"
    // as a file change. Tool identity still wins over that transport category.
    const codexMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-inline-moss-codex",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-moss-codex",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "file_change",
              toolTitle: "mcp__Moss__moss_list_threads",
              detail: "mcp__Moss__moss_list_threads",
            },
          },
        ]}
      />,
    );
    expect(codexMarkup).toContain('data-tool-icon="moss"');
    expect(codexMarkup).toContain("Moss listed threads");
    expect(codexMarkup).not.toContain("mcp__Moss__moss_list_threads");

    const failedMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-inline-moss-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-moss-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "mcp_tool_call",
              toolName: "mcp__moss__moss_create_threads",
              toolStatus: "failed",
              detail: "Claude rejected reasoningEffort",
              activityKind: "tool.completed",
            },
          },
        ]}
      />,
    );
    expect(failedMarkup).toContain("Moss couldn&#x27;t create threads");
    expect(failedMarkup).toContain("Claude rejected reasoningEffort");
  });

  it.each(["computer_click", "computer_browser_click"])(
    "uses the requested cursor and contextual label for %s",
    async (toolName) => {
      const { MessagesTimeline } = await import("./MessagesTimeline");
      const [entry] = deriveWorkLogEntries(
        [
          makeActivity({
            id: "computer-human-label",
            kind: "tool.completed",
            summary: "Tool",
            payload: {
              itemType: "mcp_tool_call",
              toolName,
              arguments: { label: "Search", app: "Safari", x: 123, y: 456 },
            },
          }),
        ],
        undefined,
      );
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...makeTimelineBaseProps()}
          timelineEntries={[
            {
              id: "computer-row",
              kind: "work",
              createdAt: entry!.createdAt,
              entry: entry!,
            },
          ]}
        />,
      );
      expect(markup).toContain('data-tool-icon="computer"');
      // The computer-use glyph comes from the shared outline family.
      expect(markup).toContain('data-slot="central-icon"');
      expect(markup).toContain("/central-icons-reversed/computer-use.svg");
      expect(markup).toContain(
        toolName.includes("browser") ? "Click in the browser" : "Click on “Search” in Safari",
      );
      expect(markup).not.toContain("Moss clicked the desktop");
      expect(markup).not.toContain("123, 456");
      expect(markup).not.toContain('data-tool-icon="mcp"');
    },
  );

  it("hides raw `ToolName: {json}` argument details behind the humanized heading", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const baseProps = makeTimelineBaseProps();

    const renderSingleToolRow = (entry: WorkLogEntry) =>
      renderToStaticMarkup(
        <MessagesTimeline
          {...baseProps}
          timelineEntries={[
            {
              id: `entry-${entry.id}`,
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry,
            },
          ]}
        />,
      );

    const readThreadMarkup = renderSingleToolRow({
      id: "work-moss-read-thread-args",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "MCP tool call",
      tone: "tool",
      itemType: "mcp_tool_call",
      toolName: "mcp__moss__moss_read_thread",
      detail: 'mcp__moss__moss_read_thread: {"threadId":"c357d8c5-b4c1-47d0"}',
      activityKind: "tool.completed",
    });
    expect(readThreadMarkup).toContain("Moss read a thread");
    expect(readThreadMarkup).not.toContain("mcp__moss__moss_read_thread:");
    expect(readThreadMarkup).not.toContain("threadId");

    const diagnoseMarkup = renderSingleToolRow({
      id: "work-moss-diagnose-args",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "MCP tool call",
      tone: "tool",
      itemType: "mcp_tool_call",
      toolName: "mcp__moss__moss_diagnose_thread",
      detail: 'mcp__moss__moss_diagnose_thread: {"threadId":"09a1615d-084f-40b9"}',
      activityKind: "tool.completed",
    });
    expect(diagnoseMarkup).toContain("Moss diagnosed a thread");
    expect(diagnoseMarkup).not.toContain("mcp__moss__moss_diagnose_thread:");
    expect(diagnoseMarkup).not.toContain("threadId");

    const dynamicToolMarkup = renderSingleToolRow({
      id: "work-dynamic-tool-args",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "ToolSearch",
      tone: "tool",
      itemType: "dynamic_tool_call",
      toolName: "ToolSearch",
      toolTitle: "ToolSearch",
      detail: 'ToolSearch: {"query":"select:mcp__moss__moss_read_thread_events"}',
      activityKind: "tool.completed",
    });
    expect(dynamicToolMarkup).toContain("ToolSearch");
    expect(dynamicToolMarkup).not.toContain("&quot;query&quot;");

    // Failed calls are exempt: the JSON-shaped detail may be the only place
    // the error surfaces, so it stays visible inline.
    const failedArgsMarkup = renderSingleToolRow({
      id: "work-moss-failed-args",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "MCP tool call",
      tone: "tool",
      itemType: "mcp_tool_call",
      toolName: "mcp__moss__moss_create_threads",
      toolStatus: "failed",
      detail: 'McpError: {"code":-32602,"message":"Invalid params"}',
      activityKind: "tool.completed",
    });
    expect(failedArgsMarkup).toContain("Moss couldn&#x27;t create threads");
    expect(failedArgsMarkup).toContain("Invalid params");
  });

  it("keeps Moss tool calls and adds a thread creation recap at the end of the turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-moss-recap");
    const workEntries = [
      {
        id: "entry-moss-create-tool",
        kind: "work",
        createdAt: "2026-03-17T19:12:28.000Z",
        entry: {
          id: "work-moss-create-tool",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "MCP tool call",
          tone: "tool",
          itemType: "mcp_tool_call",
          toolName: "mcp__moss__moss_create_threads",
          toolTitle: "Moss created threads",
          activityKind: "tool.completed",
        },
      },
      {
        id: "entry-moss-create-recap",
        kind: "work",
        createdAt: "2026-03-17T19:12:29.000Z",
        entry: {
          id: "work-moss-create-recap",
          createdAt: "2026-03-17T19:12:29.000Z",
          label: "Created 2 Moss threads",
          tone: "info",
          activityKind: "moss.threads.created",
          mossThreadCreation: {
            operationId: "gateway:create:two-workers",
            requestedCount: 2,
            createdCount: 2,
            threads: [
              {
                threadId: "thread-terra",
                title: "Explain the repository with Terra",
                provider: "codex",
                model: "gpt-5.6-terra",
                environment: "local",
                status: "task_dispatched",
              },
              {
                threadId: "thread-claude",
                title: "Explain the repository with Claude",
                provider: "claudeAgent",
                model: "claude-sonnet-5",
                environment: "worktree",
                status: "task_dispatched",
              },
            ],
          },
        },
      },
    ] as const;
    const baseProps = {
      ...makeTimelineBaseProps(),
      nowIso: "2026-03-17T19:12:31.000Z",
      onOpenThread: () => {},
    };
    const liveMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        isWorking
        activeTurnInProgress
        timelineEntries={[...workEntries]}
      />,
    );
    expect(liveMarkup).toContain("Moss created threads");
    expect(liveMarkup).not.toContain('data-moss-thread-creation-card="true"');

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          ...workEntries,
          {
            id: "entry-moss-recap-assistant",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Both threads are running.",
              createdAt: "2026-03-17T19:12:30.000Z",
              completedAt: "2026-03-17T19:12:31.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    // The original MCP tool call is preserved inside the settled turn's
    // turn header disclosure; the recap is an additional final artifact.
    expect(markup).toContain(TURN_HEADER_MARKER);
    expect(markup).toContain('data-moss-thread-creation-card="true"');
    expect(markup).toContain("2 threads created");
    expect(markup).toContain("2/2 requested threads created");
    expect(markup).toContain("Explain the repository with Terra");
    expect(markup).toContain("Explain the repository with Claude");
    expect(markup).toContain("GPT-5.6 Terra");
    expect(markup).toContain("Claude Sonnet 5");
    expect(markup.indexOf("Both threads are running.")).toBeLessThan(
      markup.indexOf('data-moss-thread-creation-card="true"'),
    );
  });

  it("shows the Computer setup card after the answer instead of inside the settled fold", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <MessagesTimeline
          {...makeTimelineBaseProps()}
          nowIso="2026-03-17T19:12:31.000Z"
          timelineEntries={[
            {
              id: "entry-computer-tool",
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: "work-computer-tool",
                createdAt: "2026-03-17T19:12:28.000Z",
                label: "MCP tool call",
                tone: "tool",
                itemType: "mcp_tool_call",
                toolTitle: "Listed windows",
                activityKind: "tool.completed",
              },
            },
            {
              id: "entry-computer-setup",
              kind: "work",
              createdAt: "2026-03-17T19:12:29.000Z",
              entry: {
                id: "work-computer-setup",
                createdAt: "2026-03-17T19:12:29.000Z",
                label: "Computer setup required",
                tone: "error",
                computerSetupRequired: { missing: ["screenRecording"] },
              },
            },
            {
              id: "entry-computer-setup-assistant",
              kind: "message",
              createdAt: "2026-03-17T19:12:30.000Z",
              message: {
                id: MessageId.makeUnsafe("message-computer-setup"),
                role: "assistant",
                text: "Moss needs macOS permissions first.",
                createdAt: "2026-03-17T19:12:30.000Z",
                completedAt: "2026-03-17T19:12:31.000Z",
                streaming: false,
              },
            },
          ]}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain(TURN_HEADER_MARKER);
    expect(markup.match(/Computer control needs Screen Recording/g)).toHaveLength(1);
    expect(markup.indexOf("Moss needs macOS permissions first.")).toBeLessThan(
      markup.indexOf("Computer control needs Screen Recording"),
    );
  });

  it("anchors the changed-files summary at the end of a collapsed file-change turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-inline-multi-edit");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-inline-multi-file-change",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-multi-file-change",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File Change",
              tone: "tool",
              requestKind: "file-change",
              changedFiles: [
                "apps/web/src/components/chat/MessagesTimeline.test.tsx",
                "apps/web/src/components/chat/MessagesTimeline.tsx",
              ],
            },
          },
          {
            id: "entry-assistant-inline-multi-edit",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-inline-multi-edit-1"),
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.test.tsx",
                    additions: 1,
                    deletions: 1,
                  },
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
                    additions: 2,
                    deletions: 0,
                  },
                ],
              },
            ],
          ])
        }
      />,
    );

    // The tool work collapses, but the changed-files summary stays anchored at
    // the end of the turn with every file from the turn diff.
    expect(markup).toContain(TURN_HEADER_MARKER);
    expect(markup).toContain("Edited 2 files");
    expect(markup).toContain("apps/web/src/components/chat/MessagesTimeline.test.tsx");
    expect(markup).toContain("apps/web/src/components/chat/MessagesTimeline.tsx");
    expect(markup).toContain("+1");
    expect(markup).toContain("-1");
    expect(markup).toContain("+2");
    expect(markup).not.toContain(">apps/web/src/components/chat<");
  });

  it("renders inline edited rows from the turn summary when the file-change tool call has no filenames", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-inline-summary-fallback");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-inline-summary-fallback",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-summary-fallback",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File Change",
              tone: "tool",
              requestKind: "file-change",
            },
          },
          {
            id: "entry-assistant-inline-summary-fallback",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-inline-summary-fallback-1"),
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  {
                    path: "apps/web/src/components/chat/ProviderHealth.ts",
                    additions: 63,
                    deletions: 4,
                  },
                  {
                    path: "apps/web/src/components/ChatView.tsx",
                    additions: 41,
                    deletions: 5,
                  },
                ],
              },
            ],
          ])
        }
      />,
    );

    expect(markup).toContain("Edited");
    expect(markup).toContain("ProviderHealth.ts");
    expect(markup).toContain("ChatView.tsx");
    expect(markup).toContain("+63");
    expect(markup).toContain("-4");
    expect(markup).toContain("+41");
    expect(markup).toContain("-5");
    expect(markup).not.toContain(">File Change<");
  });

  it("renders a collapsible changed files header with ui-font filenames", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-diff");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "entry-assistant-diff",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-diff-1"),
                checkpointTurnCount: 1,
                checkpointTurnCounts: [1],
                checkpointRef: CheckpointRef.makeUnsafe("refs/moss/checkpoints/thread/turn/1"),
                status: "ready",
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  { path: "apps/web/src/components/Sidebar.tsx", additions: 6, deletions: 5 },
                ],
              },
            ],
          ])
        }
        onUndoTurnFiles={() => {}}
      />,
    );

    expect(markup).toContain("Edited a file");
    expect(markup).toContain("Undo");
    expect(markup).toContain("View changes");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-edited-file-row="true"');
    expect(markup).toContain('aria-label="Open apps/web/src/components/Sidebar.tsx options"');
    expect(markup).toContain("apps/web/src/components/Sidebar.tsx");
    expect(markup.indexOf('aria-label="Copy message"')).toBeGreaterThan(
      markup.indexOf("Edited a file"),
    );
  });

  it("renders an automation-dispatched coordinator prompt as a normal user row", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        conversationOnly
        timelineEntries={[
          {
            id: "checkin-row",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("checkin-message"),
              role: "user",
              text: "Automation: Alpha events\nAutomation ID: automation-1\nRun: manual\n\nCoordinator events",
              createdAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
              source: "native",
              dispatchOrigin: "automation",
            },
          },
        ]}
      />,
    );

    // Check-in turns are suppressed upstream in deriveWorkLogEntries; the
    // timeline no longer has a compact check-in row, so the prompt renders as
    // a normal user bubble.
    expect(markup).not.toContain("Coordinator check-in");
    expect(markup).toContain("--app-user-message-background");
    expect(markup).toContain("Sent via Automation");
  });

  it("keeps automation-origin user messages as bubbles outside coordinator conversations", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        timelineEntries={[
          {
            id: "automation-row",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("automation-message"),
              role: "user",
              text: "Automation: Alpha events\nRun: scheduled",
              createdAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
              source: "native",
              dispatchOrigin: "automation",
            },
          },
        ]}
      />,
    );

    expect(markup).not.toContain("Coordinator check-in");
    expect(markup).toContain("--app-user-message-background");
    expect(markup).toContain("Sent via Automation");
  });

  it("renders a server-posted worker settle row as a compact pill", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        conversationOnly
        timelineEntries={[
          {
            id: "monitor-settle-row",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "monitor-settle-entry",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "✓ Mars rocket research finished",
              tone: "info",
              mossWorkerNotice: {
                kind: "settled",
                marker: "✓",
                phrase: "finished",
                threads: [
                  {
                    threadId: "thread-mars",
                    title: "Mars rocket research",
                    outcome: "completed",
                    result: null,
                    pr: null,
                    projectId: null,
                  },
                ],
              },
            },
          },
        ]}
        onOpenThread={() => {}}
      />,
    );

    expect(markup).toContain('data-worker-monitor-kind="settled"');
    expect(markup).toContain("Mars rocket research");
    expect(markup).toContain("finished");
    expect(markup).toContain("<button");
  });

  it("renders the batch roll-up as a chat message with per-thread links and outcomes", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        conversationOnly
        timelineEntries={[
          {
            id: "monitor-rollup-row",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "monitor-rollup-entry",
              createdAt: "2026-03-17T19:12:29.000Z",
              label:
                "All 3 threads settled: Alpha research ✓, Beta survey ✓, Gamma page ⚠ needs approval",
              tone: "info",
              mossWorkerNotice: {
                kind: "rollup",
                marker: null,
                phrase: null,
                threads: [
                  {
                    threadId: "thread-a",
                    title: "Alpha research",
                    outcome: "completed",
                    result: null,
                    pr: null,
                    projectId: null,
                  },
                  {
                    threadId: "thread-b",
                    title: "Beta survey",
                    outcome: "completed",
                    result: null,
                    pr: null,
                    projectId: null,
                  },
                  {
                    threadId: "thread-c",
                    title: "Gamma page",
                    outcome: "waiting-approval",
                    result: null,
                    pr: null,
                    projectId: null,
                  },
                ],
              },
            },
          },
        ]}
        onOpenThread={() => {}}
      />,
    );

    expect(markup).toContain('data-worker-monitor-kind="rollup"');
    expect(markup).toContain("All 3 threads settled:");
    expect(markup).toContain("Alpha research");
    expect(markup).toContain("Beta survey");
    expect(markup).toContain("Gamma page");
    expect(markup).toContain("needs your approval");
    // Three thread links — no full work-entry chrome around them.
    expect(markup.match(/<button/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
