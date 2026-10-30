import {
  EventId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type MossNormalizedSessionEvent,
} from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  deriveMossNormalizedEventDetail,
  deriveMossNormalizedEventFilterOptions,
  deriveMossNormalizedErrorSummary,
  deriveMossNormalizedFinishSummary,
  deriveMossNormalizedEventTraceFields,
  deriveMossNormalizedPermissionActionShell,
  deriveMossNormalizedPermissionState,
  deriveMossNormalizedSessionRunState,
  deriveMossNormalizedTextSummary,
  deriveMossNormalizedTimelineState,
  deriveMossNormalizedToolLifecycleStates,
  deriveMossNormalizedUsageSummary,
  deriveMossNormalizedWorkEntries,
  filterMossNormalizedEvents,
  filterMossNormalizedEventsByScope,
  mossNormalizedSubscriptionState,
  MossNormalizedEventTimeline,
} from "./mossNormalizedTimeline";

const threadId = ThreadId.makeUnsafe("thread-1");
const turnId = TurnId.makeUnsafe("turn-1");
const sessionId = RuntimeSessionId.makeUnsafe("runtime-session-1");

function event(
  type: MossNormalizedSessionEvent["type"],
  payload: Record<string, unknown>,
  index: number,
  overrides: Partial<Pick<MossNormalizedSessionEvent, "sessionId" | "threadId">> = {},
): MossNormalizedSessionEvent {
  return {
    eventId: EventId.makeUnsafe(`moss-normalized-${index}`),
    type,
    provider: "codex",
    sessionId,
    threadId,
    turnId,
    createdAt: `2026-07-01T00:00:0${index}.000Z`,
    rawEventId: EventId.makeUnsafe(`raw-${index}`),
    payload,
    ...overrides,
  };
}

function withoutRawEventRef(event: MossNormalizedSessionEvent): MossNormalizedSessionEvent {
  const { rawEventId: _rawEventId, ...rest } = event;
  return rest;
}

describe("mossNormalizedTimeline", () => {
  it("maps all normalized session event types into renderable work entries", () => {
    const events: MossNormalizedSessionEvent[] = [
      event(
        "text",
        {
          text: "hello from assistant",
          streamKind: "assistant_text",
          rawSource: "codex.eventmsg",
        },
        1,
      ),
      event(
        "tool-call",
        {
          toolKind: "mcp_tool_call",
          status: "inProgress",
          title: "Read file",
          itemId: "tool-1",
          data: { name: "filesystem.readFile" },
        },
        2,
      ),
      event(
        "tool-result",
        {
          toolKind: "mcp_tool_call",
          status: "completed",
          title: "Read file",
          itemId: "tool-1",
          data: { output: "ok" },
        },
        3,
      ),
      event(
        "usage",
        {
          usage: { inputTokens: 1200, outputTokens: 300 },
          totalCostUsd: 0.0123,
        },
        4,
      ),
      event(
        "permission-request",
        {
          status: "pending",
          requestType: "exec_command_approval",
          detail: "Run bun test",
        },
        5,
      ),
      event("finish", { state: "completed", stopReason: "stop" }, 6),
      event("error", { message: "provider crashed", class: "provider_error" }, 7),
    ];

    const entries = deriveMossNormalizedWorkEntries(events);

    expect(entries.map((entry) => entry.toolTitle ?? entry.label)).toEqual([
      "Assistant text",
      "Read file",
      "Read file",
      "Usage",
      "Permission request",
      "Finished",
      "Error",
    ]);
    expect(entries[1]).toMatchObject({
      tone: "tool",
      itemType: "mcp_tool_call",
      toolName: "filesystem.readFile",
      toolCallId: "tool-1",
    });
    expect(entries[3]?.preview).toBe("1,200 in / 300 out - $0.0123");
    expect(entries[4]).toMatchObject({
      requestKind: "command",
      detail: "Run bun test",
    });
    expect(entries[6]).toMatchObject({
      tone: "error",
      detail: "provider crashed",
    });
    expect(
      entries.map((entry) => `${entry.toolTitle ?? entry.label} ${entry.preview ?? ""}`).join("\n"),
    ).not.toContain("codex.eventmsg");

    const timelineState = deriveMossNormalizedTimelineState(events);
    expect(timelineState.timelineEntries).toHaveLength(events.length);
    expect(timelineState.timelineEntries.every((entry) => entry.kind === "work")).toBe(true);
  });

  it("renders a lightweight normalized event timeline for internal views", () => {
    const markup = renderToStaticMarkup(
      <MossNormalizedEventTimeline
        events={[
          event("text", { text: "streamed text", streamKind: "assistant_text" }, 1),
          event("error", { message: "provider crashed" }, 2),
        ]}
      />,
    );

    expect(markup).toContain("data-moss-normalized-timeline");
    expect(markup).toContain("data-moss-normalized-trace");
    expect(markup).toContain("data-moss-normalized-event-filters");
    expect(markup).toContain('data-moss-normalized-event-filter="all"');
    expect(markup).toContain('data-moss-normalized-event-filter="text"');
    expect(markup).toContain('data-moss-normalized-event-filter="tool-call"');
    expect(markup).toContain('data-moss-normalized-event-filter="tool-result"');
    expect(markup).toContain('data-moss-normalized-event-filter="usage"');
    expect(markup).toContain('data-moss-normalized-event-filter="permission-request"');
    expect(markup).toContain('data-moss-normalized-event-filter="finish"');
    expect(markup).toContain('data-moss-normalized-event-filter="error"');
    expect(markup).toContain("Assistant text");
    expect(markup).toContain("provider crashed");
  });

  it("renders typed subscription state without provider raw payloads", () => {
    const liveSubscription = {
      ...mossNormalizedSubscriptionState({
        status: "live",
        threadId,
        eventCount: 1,
      }),
      scope: "active-thread" as const,
      scopeLabel: "Active thread",
    };
    const liveMarkup = renderToStaticMarkup(
      <MossNormalizedEventTimeline
        events={[
          event(
            "text",
            {
              text: "streamed text",
              streamKind: "assistant_text",
              rawSource: "codex.subscription.raw",
            },
            1,
          ),
        ]}
        subscription={liveSubscription}
      />,
    );

    expect(liveMarkup).toContain("data-moss-normalized-subscription-state");
    expect(liveMarkup).toContain('data-subscription-status="live"');
    expect(liveMarkup).toContain('data-subscription-scope="active-thread"');
    expect(liveMarkup).toContain(`data-subscription-thread-id="${String(threadId)}"`);
    expect(liveMarkup).toContain('data-subscription-event-count="1"');
    expect(liveMarkup).toContain("Active thread");
    expect(liveMarkup).toContain("Live events");
    expect(liveMarkup).not.toContain("codex.subscription.raw");

    const errorMarkup = renderToStaticMarkup(
      <MossNormalizedEventTimeline
        events={[]}
        subscription={{
          ...mossNormalizedSubscriptionState({
            status: "error",
            threadId: ThreadId.makeUnsafe("thread-selected"),
            eventCount: 0,
            error: new Error("subscription failed"),
          }),
          scope: "selected-session",
          scopeLabel: "Selected session",
        }}
      />,
    );

    expect(errorMarkup).toContain('data-subscription-status="error"');
    expect(errorMarkup).toContain('data-subscription-scope="selected-session"');
    expect(errorMarkup).toContain('data-subscription-thread-id="thread-selected"');
    expect(errorMarkup).toContain("Selected session");
    expect(errorMarkup).toContain("Subscription error");
    expect(errorMarkup).toContain("subscription failed");
  });

  it("filters only by Moss normalized event type", () => {
    const events: MossNormalizedSessionEvent[] = [
      event("text", { text: "text event", rawSource: "codex.text" }, 1),
      event("tool-call", { title: "Run shell", rawSource: "codex.tool" }, 2),
      event("tool-result", { title: "Run shell", rawSource: "codex.tool" }, 3),
      event("error", { message: "provider crashed", rawSource: "codex.error" }, 4),
    ];

    expect(filterMossNormalizedEvents(events, "all")).toHaveLength(4);
    expect(filterMossNormalizedEvents(events, "tool-call").map((entry) => entry.eventId)).toEqual([
      EventId.makeUnsafe("moss-normalized-2"),
    ]);
    expect(filterMossNormalizedEvents(events, "usage")).toEqual([]);

    const options = deriveMossNormalizedEventFilterOptions(events);
    expect(options.map((option) => [option.value, option.count])).toEqual([
      ["all", 4],
      ["text", 1],
      ["tool-call", 1],
      ["tool-result", 1],
      ["usage", 0],
      ["permission-request", 0],
      ["finish", 0],
      ["error", 1],
    ]);
  });

  it("filters normalized events by selected session scope", () => {
    const otherThreadId = ThreadId.makeUnsafe("thread-2");
    const otherSessionId = RuntimeSessionId.makeUnsafe("runtime-session-2");
    const events: MossNormalizedSessionEvent[] = [
      event("text", { text: "active text", rawSource: "codex.active" }, 1),
      event("text", { text: "active thread alternate session", rawSource: "codex.session" }, 2, {
        sessionId: otherSessionId,
      }),
      event("tool-call", { title: "secondary tool", rawSource: "codex.secondary" }, 3, {
        threadId: otherThreadId,
        sessionId: otherSessionId,
      }),
    ];

    expect(
      filterMossNormalizedEventsByScope(events, {
        threadId: String(otherThreadId),
        label: "Other",
        activeThread: false,
      }).map((entry) => String(entry.eventId)),
    ).toEqual(["moss-normalized-3"]);
    expect(
      filterMossNormalizedEventsByScope(events, {
        threadId: String(threadId),
        sessionId: String(otherSessionId),
        label: "Alternate session",
        activeThread: true,
      }).map((entry) => String(entry.eventId)),
    ).toEqual(["moss-normalized-2"]);

    const markup = renderToStaticMarkup(
      <MossNormalizedEventTimeline
        events={events}
        scope={{
          threadId: String(otherThreadId),
          label: "Claude / thread-2",
          activeThread: false,
          onClear: () => undefined,
        }}
      />,
    );

    expect(markup).toContain("data-moss-normalized-session-scope");
    expect(markup).toContain('data-scope-thread-id="thread-2"');
    expect(markup).toContain('data-scope-active-thread="false"');
    expect(markup).toContain("data-moss-normalized-session-scope-clear");
    expect(markup).toContain("secondary tool");
    expect(markup).not.toContain("active text");
    expect(markup).not.toContain("codex.secondary");
  });

  it("derives trace metadata without exposing raw provider payloads", () => {
    const traced = event(
      "text",
      {
        text: "visible text",
        launchPlanHash: "sha256:launch-plan-1",
        rawSource: "codex.eventmsg",
      },
      1,
    );
    const untraced = withoutRawEventRef(event("finish", { state: "completed" }, 2));

    expect(deriveMossNormalizedEventTraceFields(traced)).toEqual([
      { label: "Event", value: "moss-normalized-1" },
      { label: "Type", value: "text" },
      { label: "Provider", value: "codex" },
      { label: "Session", value: "runtime-session-1" },
      { label: "Turn", value: "turn-1" },
      { label: "Raw event", value: "raw-1" },
      { label: "Launch plan", value: "sha256:launch-plan-1" },
    ]);
    expect(deriveMossNormalizedEventTraceFields(untraced).map((field) => field.label)).toEqual([
      "Event",
      "Type",
      "Provider",
      "Session",
      "Turn",
    ]);

    const markup = renderToStaticMarkup(
      <MossNormalizedEventTimeline events={[traced, untraced]} />,
    );
    expect(markup).toContain("data-moss-normalized-trace");
    expect(markup).toContain("moss-normalized-1");
    expect(markup).toContain("sha256:launch-plan-1");
    expect(markup).toContain("raw-1");
    expect(markup).not.toContain("codex.eventmsg");
  });

  it("derives and renders permission request state affordances from normalized payloads", () => {
    const pendingCommand = event(
      "permission-request",
      {
        status: "pending",
        requestType: "exec_command_approval",
        detail: "Run bun test",
        rawSource: "codex.approval",
      },
      1,
    );
    const resolvedUserInput = event(
      "permission-request",
      {
        status: "resolved",
        requestType: "tool_user_input",
        resolution: "answered by user",
        rawSource: "claude.user-input",
      },
      2,
    );
    const deniedFileChange = event(
      "permission-request",
      {
        status: "denied",
        requestType: "file_change_approval",
        decision: "denied",
        detail: "Edit package.json",
        rawSource: "hermes.approval",
      },
      3,
    );

    expect(deriveMossNormalizedPermissionState(pendingCommand)).toMatchObject({
      status: "pending",
      state: "pending",
      label: "Pending",
      kind: "command",
      kindLabel: "Command",
      detail: "Run bun test",
    });
    expect(deriveMossNormalizedPermissionState(resolvedUserInput)).toMatchObject({
      status: "resolved",
      state: "resolved",
      label: "Resolved",
      kind: "user-input",
      kindLabel: "User input",
      decision: "answered by user",
    });
    expect(deriveMossNormalizedPermissionState(deniedFileChange)).toMatchObject({
      status: "denied",
      state: "denied",
      label: "Denied",
      kind: "file-change",
      kindLabel: "File change",
      decision: "denied",
    });

    const entries = deriveMossNormalizedWorkEntries([
      pendingCommand,
      resolvedUserInput,
      deniedFileChange,
    ]);
    expect(entries.map((entry) => entry.toolTitle)).toEqual([
      "Permission request",
      "User input resolved",
      "Permission denied",
    ]);
    expect(entries[0]).toMatchObject({
      requestKind: "command",
      preview: "Run bun test",
    });
    expect(entries[1]?.requestKind).toBeUndefined();
    expect(entries[2]).toMatchObject({
      requestKind: "file-change",
      preview: "denied - denied",
    });

    const markup = renderToStaticMarkup(
      <MossNormalizedEventTimeline
        events={[pendingCommand, resolvedUserInput, deniedFileChange]}
      />,
    );
    expect(markup.match(/data-moss-normalized-permission-state/g)).toHaveLength(3);
    expect(markup).toContain('data-permission-state="pending"');
    expect(markup).toContain('data-permission-kind="command"');
    expect(markup).toContain('data-permission-state="resolved"');
    expect(markup).toContain('data-permission-kind="user-input"');
    expect(markup).toContain('data-permission-state="denied"');
    expect(markup).toContain('data-permission-kind="file-change"');
    expect(markup).toContain('data-permission-decision="answered by user"');
    expect(markup).toContain('data-permission-decision="denied"');
    expect(markup).toContain("Run bun test");
    expect(markup).not.toContain("codex.approval");
    expect(markup).not.toContain("claude.user-input");
    expect(markup).not.toContain("hermes.approval");
  });

  it("derives and renders permission action shells without provider-specific actions", () => {
    const pendingCommand = event(
      "permission-request",
      {
        status: "pending",
        requestType: "exec_command_approval",
        detail: "Run bun test",
        rawSource: "codex.approval.raw",
      },
      1,
    );
    const resolvedUserInput = event(
      "permission-request",
      {
        status: "resolved",
        requestType: "tool_user_input",
        resolution: "answered by user",
        rawSource: "claude.user-input.raw",
      },
      2,
    );
    const deniedFileChange = event(
      "permission-request",
      {
        status: "denied",
        requestType: "file_change_approval",
        decision: "denied",
        detail: "Edit package.json",
        rawSource: "hermes.file-change.raw",
      },
      3,
    );

    expect(deriveMossNormalizedPermissionActionShell(pendingCommand)).toMatchObject({
      status: "runtime-bridge-missing",
      label: "Runtime bridge missing",
      enabled: false,
      disabledReason: "Runtime action bridge missing",
      permissionState: "pending",
      permissionKind: "command",
      intents: [
        {
          intent: "approve",
          label: "Approve",
          enabled: false,
          disabledReason: "Runtime action bridge missing",
        },
        {
          intent: "deny",
          label: "Deny",
          enabled: false,
          disabledReason: "Runtime action bridge missing",
        },
        {
          intent: "defer",
          label: "Defer",
          enabled: false,
          disabledReason: "Runtime action bridge missing",
        },
      ],
    });
    expect(
      deriveMossNormalizedPermissionActionShell(pendingCommand, {
        bridgeAvailable: true,
      }),
    ).toMatchObject({
      status: "ready",
      label: "Ready",
      enabled: true,
      disabledReason: "Runtime action bridge ready",
      intents: [
        { intent: "approve", enabled: true },
        { intent: "deny", enabled: true },
        { intent: "defer", enabled: true },
      ],
    });
    expect(
      deriveMossNormalizedPermissionActionShell(pendingCommand, {
        bridgeAvailable: true,
        submission: {
          intent: "deny",
          status: "submitting",
          message: "Submitting permission action",
        },
      }),
    ).toMatchObject({
      status: "submitting",
      label: "Submitting",
      enabled: false,
      disabledReason: "Submitting permission action",
      intents: [
        {
          intent: "approve",
          enabled: false,
          disabledReason: "Permission action in progress",
        },
        {
          intent: "deny",
          enabled: false,
          disabledReason: "Submitting permission action",
        },
        {
          intent: "defer",
          enabled: false,
          disabledReason: "Permission action in progress",
        },
      ],
    });
    expect(
      deriveMossNormalizedPermissionActionShell(pendingCommand, {
        bridgeAvailable: true,
        submission: {
          intent: "approve",
          status: "accepted",
          message: "Permission action accepted",
        },
      }),
    ).toMatchObject({
      status: "accepted",
      label: "Accepted",
      enabled: false,
      disabledReason: "Permission action accepted",
      intents: [
        {
          intent: "approve",
          enabled: false,
          disabledReason: "Permission action accepted",
        },
        {
          intent: "deny",
          enabled: false,
          disabledReason: "Permission action in progress",
        },
        {
          intent: "defer",
          enabled: false,
          disabledReason: "Permission action in progress",
        },
      ],
    });
    expect(
      deriveMossNormalizedPermissionActionShell(pendingCommand, {
        bridgeAvailable: true,
        submission: {
          intent: "approve",
          status: "unsupported",
          message: "Adapter action handler unavailable.",
        },
      }),
    ).toMatchObject({
      status: "unsupported",
      label: "Unsupported",
      enabled: false,
      disabledReason: "Adapter action handler unavailable.",
      intents: [
        {
          intent: "approve",
          enabled: false,
          disabledReason: "Adapter action handler unavailable.",
        },
        {
          intent: "deny",
          enabled: false,
          disabledReason: "Permission action in progress",
        },
        {
          intent: "defer",
          enabled: false,
          disabledReason: "Permission action in progress",
        },
      ],
    });
    expect(
      deriveMossNormalizedPermissionActionShell(pendingCommand, {
        bridgeAvailable: true,
        submission: {
          intent: "deny",
          status: "rejected",
          message: "Provider rejected the permission action.",
        },
      }),
    ).toMatchObject({
      status: "rejected",
      label: "Rejected",
      enabled: false,
      disabledReason: "Provider rejected the permission action.",
      intents: [
        {
          intent: "approve",
          enabled: false,
          disabledReason: "Permission action in progress",
        },
        {
          intent: "deny",
          enabled: false,
          disabledReason: "Provider rejected the permission action.",
        },
        {
          intent: "defer",
          enabled: false,
          disabledReason: "Permission action in progress",
        },
      ],
    });
    expect(deriveMossNormalizedPermissionActionShell(resolvedUserInput)).toMatchObject({
      status: "not-applicable",
      enabled: false,
      disabledReason: "Permission resolved",
      permissionState: "resolved",
      permissionKind: "user-input",
      intents: [],
    });
    expect(deriveMossNormalizedPermissionActionShell(deniedFileChange)).toMatchObject({
      status: "not-applicable",
      enabled: false,
      disabledReason: "Permission denied",
      permissionState: "denied",
      permissionKind: "file-change",
      intents: [],
    });

    const pendingMarkup = renderToStaticMarkup(
      <MossNormalizedEventTimeline
        events={[pendingCommand]}
        initialSelectedEventId="moss-normalized-1"
      />,
    );
    expect(pendingMarkup.match(/data-moss-normalized-permission-action-shell/g)).toHaveLength(2);
    expect(pendingMarkup).toContain('data-permission-action-status="runtime-bridge-missing"');
    expect(pendingMarkup).toContain('data-permission-action-enabled="false"');
    expect(pendingMarkup).toContain('data-permission-action-kind="command"');
    expect(pendingMarkup).toContain('data-permission-action-state="pending"');
    expect(pendingMarkup).toContain('data-permission-action-intent="approve"');
    expect(pendingMarkup).toContain('data-permission-action-intent="deny"');
    expect(pendingMarkup).toContain('data-permission-action-intent="defer"');
    expect(pendingMarkup).toContain('data-detail-section-kind="permission-action"');
    expect(pendingMarkup).toContain("Runtime action bridge missing");
    expect(pendingMarkup).not.toContain("codex.approval.raw");

    const resolvedMarkup = renderToStaticMarkup(
      <MossNormalizedEventTimeline
        events={[resolvedUserInput]}
        initialSelectedEventId="moss-normalized-2"
      />,
    );
    expect(resolvedMarkup).toContain('data-permission-action-status="not-applicable"');
    expect(resolvedMarkup).toContain("Permission resolved");
    expect(resolvedMarkup).not.toContain('data-permission-action-intent="approve"');
    expect(resolvedMarkup).not.toContain("claude.user-input.raw");

    const deniedMarkup = renderToStaticMarkup(
      <MossNormalizedEventTimeline
        events={[deniedFileChange]}
        initialSelectedEventId="moss-normalized-3"
      />,
    );
    expect(deniedMarkup).toContain('data-permission-action-status="not-applicable"');
    expect(deniedMarkup).toContain("Permission denied");
    expect(deniedMarkup).not.toContain('data-permission-action-intent="deny"');
    expect(deniedMarkup).not.toContain("hermes.file-change.raw");
  });

  it("derives and renders grouped tool lifecycle affordances from normalized events", () => {
    const matchedCall = event(
      "tool-call",
      {
        status: "running",
        title: "Read file",
        itemId: "tool-read",
        toolName: "filesystem.readFile",
        rawSource: "codex.tool-call",
      },
      1,
    );
    const pendingCall = event(
      "tool-call",
      {
        status: "pending",
        title: "Run shell",
        itemId: "tool-pending",
        toolName: "exec_command",
        rawSource: "codex.tool-call",
      },
      2,
    );
    const failedCall = event(
      "tool-call",
      {
        status: "running",
        title: "Apply patch",
        itemId: "tool-failed",
        toolName: "apply_patch",
      },
      3,
    );
    const failedResult = event(
      "tool-result",
      {
        status: "failed",
        title: "Apply patch",
        itemId: "tool-failed",
        toolName: "apply_patch",
        detail: "patch rejected",
      },
      4,
    );
    const matchedResult = event(
      "tool-result",
      {
        status: "completed",
        title: "Read file",
        itemId: "tool-read",
        toolName: "filesystem.readFile",
        detail: "ok",
      },
      5,
    );
    const orphanedResult = event(
      "tool-result",
      {
        status: "completed",
        title: "Unknown tool",
        itemId: "tool-orphan",
        toolName: "unknown_tool",
        detail: "late result",
      },
      6,
    );
    const events = [
      matchedCall,
      pendingCall,
      failedCall,
      failedResult,
      matchedResult,
      orphanedResult,
    ];

    const lifecycleByEventId = deriveMossNormalizedToolLifecycleStates(events);

    expect(lifecycleByEventId.get("moss-normalized-1")).toMatchObject({
      lifecycleId: "tool-read",
      state: "succeeded",
      label: "Succeeded",
      role: "call",
      hasCall: true,
      hasResult: true,
      toolName: "filesystem.readFile",
    });
    expect(lifecycleByEventId.get("moss-normalized-2")).toMatchObject({
      lifecycleId: "tool-pending",
      state: "pending",
      role: "call",
      hasCall: true,
      hasResult: false,
    });
    expect(lifecycleByEventId.get("moss-normalized-4")).toMatchObject({
      lifecycleId: "tool-failed",
      state: "failed",
      role: "result",
      hasCall: true,
      hasResult: true,
      status: "failed",
    });
    expect(lifecycleByEventId.get("moss-normalized-6")).toMatchObject({
      lifecycleId: "tool-orphan",
      state: "orphaned",
      label: "Orphaned",
      role: "result",
      hasCall: false,
      hasResult: true,
    });

    const entries = deriveMossNormalizedWorkEntries(events);
    expect(entries.map((entry) => entry.id)).toEqual([
      "moss-normalized-1",
      "moss-normalized-2",
      "moss-normalized-3",
      "moss-normalized-4",
      "moss-normalized-5",
      "moss-normalized-6",
    ]);

    const markup = renderToStaticMarkup(<MossNormalizedEventTimeline events={events} />);
    expect(markup.match(/data-moss-normalized-tool-lifecycle/g)).toHaveLength(6);
    expect(markup).toContain('data-tool-lifecycle-id="tool-read"');
    expect(markup).toContain('data-tool-lifecycle-state="succeeded"');
    expect(markup).toContain('data-tool-lifecycle-id="tool-pending"');
    expect(markup).toContain('data-tool-lifecycle-state="pending"');
    expect(markup).toContain('data-tool-lifecycle-id="tool-failed"');
    expect(markup).toContain('data-tool-lifecycle-state="failed"');
    expect(markup).toContain('data-tool-lifecycle-id="tool-orphan"');
    expect(markup).toContain('data-tool-lifecycle-state="orphaned"');
    expect(markup).toContain('data-tool-lifecycle-role="call"');
    expect(markup).toContain('data-tool-lifecycle-role="result"');
    expect(markup).toContain('data-tool-lifecycle-has-call="false"');
    expect(markup).toContain('data-tool-lifecycle-has-result="false"');
    expect(markup).not.toContain("codex.tool-call");
  });

  it("derives and renders usage and finish summary affordances from normalized events", () => {
    const usage = event(
      "usage",
      {
        usage: {
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
        },
        model: "gpt-5-mini",
        totalCostUsd: 0.0123,
        cumulativeCostUsd: 0.0456,
        rawSource: "codex.usage",
      },
      1,
    );
    const completedFinish = event(
      "finish",
      {
        state: "completed",
        stopReason: "stop",
        rawSource: "codex.finish",
      },
      2,
    );
    const interruptedFinish = event(
      "finish",
      {
        state: "interrupted",
        stopReason: "user interrupt",
        error: "User stopped the run",
        rawSource: "claude.finish",
      },
      3,
    );

    expect(deriveMossNormalizedUsageSummary(usage)).toMatchObject({
      label: "1,200 in / 300 out / 1,500 total - gpt-5-mini - $0.0123 - cum $0.0456",
      inputTokens: 1200,
      outputTokens: 300,
      usedTokens: 1500,
      model: "gpt-5-mini",
      totalCostUsd: 0.0123,
      cumulativeCostUsd: 0.0456,
    });
    expect(deriveMossNormalizedFinishSummary(completedFinish)).toMatchObject({
      status: "completed",
      state: "completed",
      label: "Completed",
      stopReason: "stop",
    });
    expect(deriveMossNormalizedFinishSummary(interruptedFinish)).toMatchObject({
      status: "interrupted",
      state: "interrupted",
      label: "Interrupted",
      stopReason: "user interrupt",
      error: "User stopped the run",
    });

    const entries = deriveMossNormalizedWorkEntries([usage, completedFinish, interruptedFinish]);
    expect(entries.map((entry) => entry.preview)).toEqual([
      "1,200 in / 300 out / 1,500 total - gpt-5-mini - $0.0123 - cum $0.0456",
      "completed - stop",
      "interrupted - user interrupt - User stopped the run",
    ]);

    const markup = renderToStaticMarkup(
      <MossNormalizedEventTimeline events={[usage, completedFinish, interruptedFinish]} />,
    );
    expect(markup).toContain("data-moss-normalized-usage-summary");
    expect(markup).toContain('data-usage-input-tokens="1200"');
    expect(markup).toContain('data-usage-output-tokens="300"');
    expect(markup).toContain('data-usage-used-tokens="1500"');
    expect(markup).toContain('data-usage-model="gpt-5-mini"');
    expect(markup).toContain('data-usage-total-cost-usd="0.0123"');
    expect(markup).toContain('data-usage-cumulative-cost-usd="0.0456"');
    expect(markup.match(/data-moss-normalized-finish-summary/g)).toHaveLength(2);
    expect(markup).toContain('data-finish-state="completed"');
    expect(markup).toContain('data-finish-status="completed"');
    expect(markup).toContain('data-finish-state="interrupted"');
    expect(markup).toContain('data-finish-stop-reason="user interrupt"');
    expect(markup).toContain('data-finish-error="User stopped the run"');
    expect(markup).not.toContain("codex.usage");
    expect(markup).not.toContain("codex.finish");
    expect(markup).not.toContain("claude.finish");
  });

  it("derives and renders text and error state affordances from normalized events", () => {
    const assistantText = event(
      "text",
      {
        text: "Assistant streamed a concise answer.",
        streamKind: "assistant_text",
        rawSource: "codex.assistant.delta",
      },
      1,
    );
    const reasoningText = event(
      "text",
      {
        delta: "Reasoning summary moved through a normalized event.",
        streamKind: "reasoning_summary_text",
        rawSource: "claude.reasoning.delta",
      },
      2,
    );
    const commandOutput = event(
      "text",
      {
        text: "bun test passed",
        streamKind: "command_output",
        rawSource: "codex.command.output",
      },
      3,
    );
    const providerError = event(
      "error",
      {
        message: "Provider process exited unexpectedly.",
        class: "provider_error",
        code: "E_PROVIDER_EXIT",
        severity: "fatal",
        retryable: false,
        rawSource: "codex.error",
      },
      4,
    );
    const retryableError = event(
      "error",
      {
        detail: "Rate limit window is still active.",
        errorClass: "rate_limit",
        code: "rate_limit_exceeded",
        severity: "warning",
        retryable: true,
        rawSource: "hermes.error",
      },
      5,
    );

    expect(deriveMossNormalizedTextSummary(assistantText)).toMatchObject({
      streamKind: "assistant_text",
      role: "assistant",
      label: "Assistant text",
      preview: "Assistant streamed a concise answer.",
      previewLength: 36,
    });
    expect(deriveMossNormalizedTextSummary(reasoningText)).toMatchObject({
      streamKind: "reasoning_summary_text",
      role: "reasoning",
      label: "Reasoning",
      preview: "Reasoning summary moved through a normalized event.",
    });
    expect(deriveMossNormalizedTextSummary(commandOutput)).toMatchObject({
      streamKind: "command_output",
      role: "command-output",
      label: "Command output",
      preview: "bun test passed",
      previewLength: 15,
    });
    expect(deriveMossNormalizedErrorSummary(providerError)).toMatchObject({
      severity: "fatal",
      label: "Fatal",
      message: "Provider process exited unexpectedly.",
      errorClass: "provider_error",
      code: "E_PROVIDER_EXIT",
      retryable: false,
    });
    expect(deriveMossNormalizedErrorSummary(retryableError)).toMatchObject({
      severity: "warning",
      label: "Warning",
      message: "Rate limit window is still active.",
      errorClass: "rate_limit",
      code: "rate_limit_exceeded",
      retryable: true,
    });

    const entries = deriveMossNormalizedWorkEntries([
      assistantText,
      reasoningText,
      commandOutput,
      providerError,
      retryableError,
    ]);
    expect(entries.map((entry) => entry.toolTitle)).toEqual([
      "Assistant text",
      "Reasoning",
      "Command output",
      "Error",
      "Error",
    ]);
    expect(entries.map((entry) => entry.preview)).toEqual([
      "Assistant streamed a concise answer.",
      "Reasoning summary moved through a normalized event.",
      "bun test passed",
      "Provider process exited unexpectedly.",
      "Rate limit window is still active.",
    ]);

    const markup = renderToStaticMarkup(
      <MossNormalizedEventTimeline
        events={[assistantText, reasoningText, commandOutput, providerError, retryableError]}
      />,
    );
    expect(markup.match(/data-moss-normalized-text-summary/g)).toHaveLength(3);
    expect(markup).toContain('data-text-stream-kind="assistant_text"');
    expect(markup).toContain('data-text-role="assistant"');
    expect(markup).toContain('data-text-stream-kind="reasoning_summary_text"');
    expect(markup).toContain('data-text-role="reasoning"');
    expect(markup).toContain('data-text-stream-kind="command_output"');
    expect(markup).toContain('data-text-role="command-output"');
    expect(markup).toContain('data-text-preview-length="15"');
    expect(markup.match(/data-moss-normalized-error-summary/g)).toHaveLength(2);
    expect(markup).toContain('data-error-class="provider_error"');
    expect(markup).toContain('data-error-code="E_PROVIDER_EXIT"');
    expect(markup).toContain('data-error-severity="fatal"');
    expect(markup).toContain('data-error-retryable="false"');
    expect(markup).toContain('data-error-class="rate_limit"');
    expect(markup).toContain('data-error-code="rate_limit_exceeded"');
    expect(markup).toContain('data-error-severity="warning"');
    expect(markup).toContain('data-error-retryable="true"');
    expect(markup).toContain("Provider process exited unexpectedly.");
    expect(markup).toContain("Rate limit window is still active.");
    expect(markup).not.toContain("codex.assistant.delta");
    expect(markup).not.toContain("claude.reasoning.delta");
    expect(markup).not.toContain("codex.command.output");
    expect(markup).not.toContain("codex.error");
    expect(markup).not.toContain("hermes.error");
  });

  it("derives and renders session run-state rollups from normalized events", () => {
    expect(deriveMossNormalizedSessionRunState([])).toMatchObject({
      state: "idle",
      label: "Idle",
      eventCount: 0,
      pendingPermissionCount: 0,
      runningToolCount: 0,
      errorCount: 0,
    });

    const runningTool = event(
      "tool-call",
      {
        status: "running",
        title: "Run shell",
        itemId: "tool-running",
        rawSource: "codex.tool-call",
      },
      1,
    );
    const pendingPermission = event(
      "permission-request",
      {
        status: "pending",
        requestType: "exec_command_approval",
        rawSource: "codex.approval",
      },
      2,
    );
    const completedFinish = event(
      "finish",
      {
        state: "completed",
        stopReason: "stop",
        rawSource: "codex.finish",
      },
      3,
    );
    const interruptedFinish = event(
      "finish",
      {
        state: "interrupted",
        stopReason: "user interrupt",
        rawSource: "claude.finish",
      },
      4,
    );
    const failedError = event(
      "error",
      {
        message: "provider crashed",
        class: "provider_error",
        rawSource: "hermes.error",
      },
      5,
    );

    expect(deriveMossNormalizedSessionRunState([runningTool])).toMatchObject({
      state: "running",
      label: "Running",
      eventCount: 1,
      runningToolCount: 1,
      lastEventType: "tool-call",
    });
    expect(deriveMossNormalizedSessionRunState([pendingPermission])).toMatchObject({
      state: "waiting-for-permission",
      label: "Waiting for permission",
      eventCount: 1,
      pendingPermissionCount: 1,
      lastEventType: "permission-request",
    });
    expect(deriveMossNormalizedSessionRunState([runningTool, completedFinish])).toMatchObject({
      state: "completed",
      label: "Completed",
      eventCount: 2,
      runningToolCount: 1,
      lastEventType: "finish",
      lastFinishState: "completed",
    });
    expect(deriveMossNormalizedSessionRunState([interruptedFinish])).toMatchObject({
      state: "interrupted",
      label: "Interrupted",
      lastEventType: "finish",
      lastFinishState: "interrupted",
    });
    expect(deriveMossNormalizedSessionRunState([completedFinish, failedError])).toMatchObject({
      state: "failed",
      label: "Failed",
      eventCount: 2,
      errorCount: 1,
      lastEventType: "error",
      lastFinishState: "completed",
    });

    const emptyMarkup = renderToStaticMarkup(<MossNormalizedEventTimeline events={[]} />);
    expect(emptyMarkup).toContain("data-moss-normalized-run-state");
    expect(emptyMarkup).toContain('data-run-state="idle"');
    expect(emptyMarkup).toContain('data-run-state-event-count="0"');

    const markup = renderToStaticMarkup(
      <MossNormalizedEventTimeline
        events={[runningTool, pendingPermission, completedFinish, failedError]}
      />,
    );
    expect(markup).toContain("data-moss-normalized-run-state");
    expect(markup).toContain('data-run-state="failed"');
    expect(markup).toContain('data-run-state-pending-permissions="1"');
    expect(markup).toContain('data-run-state-running-tools="1"');
    expect(markup).toContain('data-run-state-errors="1"');
    expect(markup).toContain('data-run-state-last-finish-state="completed"');
    expect(markup).toContain('data-run-state-last-event-type="error"');
    expect(markup).toContain("Failed");
    expect(markup).not.toContain("codex.tool-call");
    expect(markup).not.toContain("codex.approval");
    expect(markup).not.toContain("codex.finish");
    expect(markup).not.toContain("hermes.error");
  });

  it("derives and renders typed event detail inspector data without raw payload sources", () => {
    const text = event(
      "text",
      {
        text: "Assistant detail text",
        streamKind: "assistant_text",
        rawSource: "codex.text.raw",
        ledgerPath: ".moss/ledger/events.jsonl",
      },
      1,
    );
    const toolCall = event(
      "tool-call",
      {
        status: "running",
        title: "Read file",
        itemId: "detail-tool",
        toolName: "filesystem.readFile",
        rawSource: "codex.tool.raw",
      },
      2,
    );
    const toolResult = event(
      "tool-result",
      {
        status: "completed",
        title: "Read file",
        itemId: "detail-tool",
        toolName: "filesystem.readFile",
        detail: "read ok",
      },
      3,
    );
    const permission = event(
      "permission-request",
      {
        status: "denied",
        requestType: "file_change_approval",
        decision: "denied",
        detail: "Edit package.json",
        rawSource: "claude.permission.raw",
      },
      4,
    );
    const error = event(
      "error",
      {
        message: "Provider detail error",
        class: "provider_error",
        code: "E_DETAIL",
        severity: "fatal",
        retryable: false,
        rawSource: "hermes.error.raw",
      },
      5,
    );
    const events = [text, toolCall, toolResult, permission, error];

    expect(deriveMossNormalizedEventDetail(text, events)).toMatchObject({
      eventId: "moss-normalized-1",
      type: "text",
      provider: "codex",
      sessionId: "runtime-session-1",
      turnId: "turn-1",
      title: "Assistant text",
      preview: "Assistant detail text",
      sections: expect.arrayContaining([
        expect.objectContaining({ kind: "trace" }),
        expect.objectContaining({ kind: "row" }),
        expect.objectContaining({
          kind: "text",
          fields: expect.arrayContaining([
            { label: "Role", value: "Assistant" },
            { label: "Stream", value: "assistant_text" },
          ]),
        }),
      ]),
    });
    expect(deriveMossNormalizedEventDetail(toolCall, events).sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          fields: expect.arrayContaining([
            { label: "Lifecycle", value: "detail-tool" },
            { label: "State", value: "Succeeded" },
            { label: "Tool", value: "filesystem.readFile" },
          ]),
        }),
      ]),
    );
    expect(deriveMossNormalizedEventDetail(permission, events).sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "permission",
          fields: expect.arrayContaining([
            { label: "State", value: "Denied" },
            { label: "Kind", value: "File change" },
            { label: "Decision", value: "denied" },
          ]),
        }),
      ]),
    );
    expect(deriveMossNormalizedEventDetail(error, events).sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "error",
          fields: expect.arrayContaining([
            { label: "Severity", value: "Fatal" },
            { label: "Class", value: "provider_error" },
            { label: "Code", value: "E_DETAIL" },
            { label: "Message", value: "Provider detail error" },
          ]),
        }),
      ]),
    );

    const textMarkup = renderToStaticMarkup(
      <MossNormalizedEventTimeline events={events} initialSelectedEventId="moss-normalized-1" />,
    );
    expect(textMarkup).toContain("data-moss-normalized-event-detail-inspector");
    expect(textMarkup).toContain('data-selected-event-id="moss-normalized-1"');
    expect(textMarkup).toContain('data-selected-event-type="text"');
    expect(textMarkup).toContain('data-selected-event-provider="codex"');
    expect(textMarkup).toContain('data-selected-event-session="runtime-session-1"');
    expect(textMarkup).toContain('data-selected-event-turn="turn-1"');
    expect(textMarkup).toContain('data-detail-section-kind="text"');
    expect(textMarkup).toContain("Assistant detail text");
    expect(textMarkup).not.toContain("codex.text.raw");
    expect(textMarkup).not.toContain(".moss/ledger/events.jsonl");

    const toolMarkup = renderToStaticMarkup(
      <MossNormalizedEventTimeline events={events} initialSelectedEventId="moss-normalized-2" />,
    );
    expect(toolMarkup).toContain('data-selected-event-type="tool-call"');
    expect(toolMarkup).toContain('data-detail-section-kind="tool"');
    expect(toolMarkup).toContain("detail-tool");
    expect(toolMarkup).toContain("Succeeded");
    expect(toolMarkup).not.toContain("codex.tool.raw");

    const permissionMarkup = renderToStaticMarkup(
      <MossNormalizedEventTimeline events={events} initialSelectedEventId="moss-normalized-4" />,
    );
    expect(permissionMarkup).toContain('data-selected-event-type="permission-request"');
    expect(permissionMarkup).toContain('data-detail-section-kind="permission"');
    expect(permissionMarkup).toContain("File change");
    expect(permissionMarkup).toContain("denied");
    expect(permissionMarkup).not.toContain("claude.permission.raw");

    const errorMarkup = renderToStaticMarkup(
      <MossNormalizedEventTimeline events={events} initialSelectedEventId="moss-normalized-5" />,
    );
    expect(errorMarkup).toContain('data-selected-event-type="error"');
    expect(errorMarkup).toContain('data-detail-section-kind="error"');
    expect(errorMarkup).toContain("Provider detail error");
    expect(errorMarkup).toContain("E_DETAIL");
    expect(errorMarkup).not.toContain("hermes.error.raw");
  });
});
