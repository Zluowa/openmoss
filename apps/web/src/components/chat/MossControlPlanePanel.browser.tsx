// FILE: MossControlPlanePanel.browser.tsx
// Purpose: Browser smoke coverage for the default-off Moss control-plane surface.
// Layer: Web chat control-plane smoke test

import "../../index.css";

import {
  EventId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type MossNormalizedSessionEvent,
  type NativeApi,
  type ProviderSession,
  type ProviderSubmitPermissionActionInput,
  type ProviderSubmitPermissionActionResult,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { setFeatureFlagEnabled, useFeatureFlags } from "../../featureFlags";
import { MossControlPlanePanel } from "./MossControlPlanePanel";
import {
  MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT,
  type MossLoopLedgerDashboardSnapshot,
} from "./mossLoopLedgerDashboard";

const THREAD_ID = ThreadId.makeUnsafe("thread-moss-control-plane-browser-smoke");
const SECONDARY_THREAD_ID = ThreadId.makeUnsafe("thread-moss-control-plane-browser-secondary");
const TURN_ID = TurnId.makeUnsafe("turn-moss-control-plane-browser-smoke");
const SESSION_ID = RuntimeSessionId.makeUnsafe("runtime-session-moss-control-plane-browser-smoke");
const SECONDARY_SESSION_ID = RuntimeSessionId.makeUnsafe(
  "runtime-session-moss-control-plane-browser-secondary",
);
const TERTIARY_THREAD_ID = ThreadId.makeUnsafe("thread-moss-control-plane-browser-tertiary");
const TERTIARY_SESSION_ID = RuntimeSessionId.makeUnsafe(
  "runtime-session-moss-control-plane-browser-tertiary",
);

interface NormalizedEventSubscriptionRecord {
  readonly input: { threadId: ThreadId };
  readonly onEvent: (event: MossNormalizedSessionEvent) => void;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  closed: boolean;
}

function MossControlPlaneSmokeHarness() {
  const featureFlags = useFeatureFlags();

  return (
    <main className="flex h-screen w-screen bg-background text-foreground">
      <section className="flex min-w-0 flex-1 flex-col" data-normal-chat-shell="">
        <header className="border-b border-border px-3 py-2 text-sm font-medium">
          Browser smoke thread
        </header>
        <div className="min-h-0 flex-1" />
        <form className="border-t border-border p-3" data-chat-composer-form="true">
          <label className="sr-only" htmlFor="moss-browser-smoke-composer">
            Message
          </label>
          <textarea
            aria-label="Message"
            className="h-20 w-full resize-none rounded-md border border-border bg-background p-2 text-sm"
            id="moss-browser-smoke-composer"
          />
        </form>
      </section>
      {import.meta.env.DEV && featureFlags["show-moss-control-plane"] ? (
        <MossControlPlanePanel threadId={THREAD_ID} />
      ) : null}
    </main>
  );
}

function installNativeProviderStub({
  failLoopLedgerDashboardSnapshot = false,
  normalizedEvents = defaultNormalizedEvents(),
  omitNormalizedEventSubscription = false,
  providerSessions = defaultProviderSessions(),
  submitPermissionAction,
  throwNormalizedEventSubscription = false,
}: {
  readonly failLoopLedgerDashboardSnapshot?: boolean;
  readonly normalizedEvents?: ReadonlyArray<MossNormalizedSessionEvent>;
  readonly omitNormalizedEventSubscription?: boolean;
  readonly providerSessions?: ReadonlyArray<ProviderSession>;
  readonly submitPermissionAction?: (
    input: ProviderSubmitPermissionActionInput,
  ) => Promise<ProviderSubmitPermissionActionResult>;
  readonly throwNormalizedEventSubscription?: boolean;
} = {}) {
  const normalizedEventSubscriptions: NormalizedEventSubscriptionRecord[] = [];
  const unsubscribe = vi.fn();
  const subscribeNormalizedSessionEvents = vi.fn(
    (input: { threadId: ThreadId }, onEvent: (event: MossNormalizedSessionEvent) => void) => {
      if (throwNormalizedEventSubscription) {
        throw new Error("Normalized event subscription failed");
      }

      const record: NormalizedEventSubscriptionRecord = {
        input,
        onEvent,
        unsubscribe: vi.fn(() => {
          record.closed = true;
          unsubscribe(input);
        }),
        closed: false,
      };
      normalizedEventSubscriptions.push(record);

      const inputThreadId = String(input.threadId);
      for (const event of normalizedEvents) {
        if (String(event.threadId) === inputThreadId) {
          onEvent(event);
        }
      }
      return record.unsubscribe;
    },
  );
  const getLaunchPlan = vi.fn(async (input: { threadId: ThreadId }) => ({
    threadId: input.threadId,
    planHash:
      String(input.threadId) === String(SECONDARY_THREAD_ID)
        ? "sha256:secondary-session-launch-plan"
        : null,
    launchPlan: null,
  }));
  const runtimeSnapshot: MossLoopLedgerDashboardSnapshot = {
    ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT,
    generatedAt: "2026-07-01T00:00:00.000Z",
    tasks: {
      ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.tasks,
      active: [
        {
          taskId: "moss-task-runtime-bridge",
          title: "Runtime bridge injected dashboard snapshot",
          owner: "UI Parity Engineer",
          status: "active",
          acceptanceCount: 3,
          evidenceCount: 1,
        },
      ],
    },
  };
  const getLoopLedgerDashboardSnapshot = vi.fn(async () => {
    if (failLoopLedgerDashboardSnapshot) {
      throw new Error("Runtime bridge failed");
    }

    return {
      threadId: THREAD_ID,
      snapshot: runtimeSnapshot,
    };
  });
  const listSessions = vi.fn(async () => ({
    sessions: providerSessions,
  }));
  const providerApi: Record<string, unknown> = {
    listSessions,
    getLaunchPlan,
    getLoopLedgerDashboardSnapshot,
    ...(submitPermissionAction ? { submitPermissionAction } : {}),
  };
  if (!omitNormalizedEventSubscription) {
    providerApi.subscribeNormalizedSessionEvents = subscribeNormalizedSessionEvents;
  }

  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    writable: true,
    value: {
      provider: providerApi,
    } as unknown as NativeApi,
  });

  return {
    emitNormalizedEvent(event: MossNormalizedSessionEvent) {
      for (const record of normalizedEventSubscriptions) {
        if (record.closed || String(record.input.threadId) !== String(event.threadId)) {
          continue;
        }
        record.onEvent(event);
      }
    },
    getLaunchPlan,
    getLoopLedgerDashboardSnapshot,
    listSessions,
    normalizedEventSubscriptions,
    subscribeNormalizedSessionEvents,
    submitPermissionAction,
    unsubscribe,
  };
}

function normalizedEvent(
  type: MossNormalizedSessionEvent["type"],
  payload: Record<string, unknown>,
  index: number,
  overrides: Partial<Pick<MossNormalizedSessionEvent, "sessionId" | "threadId">> = {},
): MossNormalizedSessionEvent {
  const seconds = String(index).padStart(2, "0");
  return {
    eventId: EventId.makeUnsafe(`moss-browser-normalized-${index}`),
    type,
    provider: "codex",
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    createdAt: `2026-07-01T00:00:${seconds}.000Z`,
    rawEventId: EventId.makeUnsafe(`moss-browser-raw-${index}`),
    payload,
    ...overrides,
  };
}

function defaultNormalizedEvents(): ReadonlyArray<MossNormalizedSessionEvent> {
  return [
    normalizedEvent(
      "text",
      {
        text: "browser assistant text",
        streamKind: "assistant_text",
        launchPlanHash: "sha256:browser-launch-plan",
        rawSource: "codex.eventmsg",
      },
      1,
    ),
    normalizedEvent(
      "tool-call",
      {
        status: "running",
        title: "Run shell",
        itemId: "browser-tool-shell",
        toolName: "exec_command",
        rawSource: "codex.tool-call",
      },
      2,
    ),
    normalizedEvent(
      "tool-result",
      {
        status: "completed",
        title: "Run shell",
        itemId: "browser-tool-shell",
        toolName: "exec_command",
        detail: "shell ok",
      },
      3,
    ),
    normalizedEvent(
      "permission-request",
      {
        status: "pending",
        requestType: "exec_command_approval",
        detail: "Approve browser smoke command",
        rawSource: "codex.approval",
      },
      4,
    ),
    normalizedEvent(
      "usage",
      {
        usage: { inputTokens: 2400, outputTokens: 600, totalTokens: 3000 },
        model: "gpt-5-mini",
        totalCostUsd: 0.0246,
        cumulativeCostUsd: 0.075,
        rawSource: "codex.usage",
      },
      5,
    ),
    normalizedEvent(
      "finish",
      {
        state: "completed",
        stopReason: "stop",
        rawSource: "codex.finish",
      },
      6,
    ),
    normalizedEvent(
      "error",
      {
        message: "browser provider crashed",
        class: "provider_error",
        code: "E_BROWSER_PROVIDER",
        severity: "error",
        retryable: true,
        rawSource: "codex.error",
      },
      7,
    ),
    normalizedEvent(
      "text",
      {
        text: "secondary session assistant text",
        streamKind: "assistant_text",
        launchPlanHash: "sha256:secondary-session-launch-plan",
        rawSource: "claude.eventmsg",
      },
      8,
      { threadId: SECONDARY_THREAD_ID, sessionId: SECONDARY_SESSION_ID },
    ),
  ];
}

function defaultProviderSessions(): ReadonlyArray<ProviderSession> {
  return [
    {
      provider: "codex",
      status: "running",
      runtimeMode: "full-access",
      cwd: "/Users/moss/Codex/tools/moss",
      model: "gpt-5.3-codex",
      threadId: THREAD_ID,
      activeTurnId: TURN_ID,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:07.000Z",
    },
    {
      provider: "claudeAgent",
      status: "ready",
      runtimeMode: "approval-required",
      cwd: "/Users/moss/Codex/tools/other-agent",
      model: "claude-sonnet-4-6",
      threadId: SECONDARY_THREAD_ID,
      createdAt: "2026-07-01T00:00:02.000Z",
      updatedAt: "2026-07-01T00:00:03.000Z",
    },
  ];
}

function subscriptionRecordsForThread(
  records: ReadonlyArray<NormalizedEventSubscriptionRecord>,
  threadId: ThreadId,
): NormalizedEventSubscriptionRecord[] {
  return records.filter((record) => String(record.input.threadId) === String(threadId));
}

function openSubscriptionRecordsForThread(
  records: ReadonlyArray<NormalizedEventSubscriptionRecord>,
  threadId: ThreadId,
): NormalizedEventSubscriptionRecord[] {
  return subscriptionRecordsForThread(records, threadId).filter((record) => !record.closed);
}

function createPermissionActionDeferred() {
  let resolve: (result: ProviderSubmitPermissionActionResult) => void = () => undefined;
  const promise = new Promise<ProviderSubmitPermissionActionResult>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("MossControlPlanePanel browser smoke", () => {
  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it("keeps the panel disabled by default and mounts it when the feature flag is enabled", async () => {
    await page.viewport(1_280, 900);
    const nativeApi = installNativeProviderStub();

    const disabled = await render(<MossControlPlaneSmokeHarness />);
    try {
      expect(document.querySelector("[data-moss-control-plane]")).toBeNull();
      expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
      expect(document.body.textContent ?? "").toContain("Browser smoke thread");
    } finally {
      await disabled.unmount();
    }

    setFeatureFlagEnabled("show-moss-control-plane", true);

    const enabled = await render(<MossControlPlaneSmokeHarness />);
    try {
      await vi.waitFor(
        () => {
          const panel = document.querySelector<HTMLElement>("[data-moss-control-plane]");
          expect(panel).toBeTruthy();
          expect(panel!.getBoundingClientRect().width).toBeGreaterThan(0);
          expect(panel!.textContent ?? "").toContain("Moss Control");
          expect(panel!.querySelector("[data-moss-control-plane-summary]")).toBeTruthy();
          expect(
            panel!.querySelector(
              "[data-moss-control-plane-session-list][data-source='runtime'][data-status='ready']",
            ),
          ).toBeTruthy();
          expect(
            panel!.querySelector(
              "[data-moss-session-list-row][data-active-thread='true'][data-session-source='runtime'][data-event-count='7']",
            ),
          ).toBeTruthy();
          expect(
            panel!.querySelector(
              "[data-moss-session-list-row][data-active-thread='true'][data-selected-session='true']",
            ),
          ).toBeTruthy();
          expect(panel!.textContent ?? "").toContain("Sessions");
          expect(panel!.textContent ?? "").toContain("Codex");
          expect(panel!.textContent ?? "").toContain("gpt-5.3-codex");
          expect(panel!.textContent ?? "").toContain("/Users/moss/Codex/tools/moss");
          expect(panel!.textContent ?? "").toContain("browser assistant text");
          expect(panel!.textContent ?? "").toContain("Run shell");
          expect(panel!.textContent ?? "").toContain("shell ok");
          expect(panel!.textContent ?? "").toContain("Approve browser smoke command");
          expect(panel!.textContent ?? "").toContain("gpt-5-mini");
          expect(panel!.textContent ?? "").toContain("Completed");
          expect(panel!.textContent ?? "").toContain("browser provider crashed");
          expect(panel!.querySelector("[data-moss-control-plane-events]")).toBeTruthy();
          expect(
            panel!.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='active-thread'][data-subscription-thread-id='${String(
                THREAD_ID,
              )}'][data-subscription-event-count='7']`,
            ),
          ).toBeTruthy();
          expect(
            panel!.querySelector(
              "[data-moss-normalized-run-state][data-run-state='failed'][data-run-state-event-count='7'][data-run-state-pending-permissions='1'][data-run-state-running-tools='0'][data-run-state-errors='1'][data-run-state-last-event-type='error'][data-run-state-last-finish-state='completed']",
            ),
          ).toBeTruthy();
          expect(panel!.querySelectorAll("[data-moss-normalized-row]")).toHaveLength(7);
          expect(panel!.querySelectorAll("[data-moss-normalized-trace]")).toHaveLength(7);
          expect(panel!.querySelectorAll("[data-moss-normalized-text-summary]")).toHaveLength(1);
          expect(panel!.querySelectorAll("[data-moss-normalized-tool-lifecycle]")).toHaveLength(2);
          expect(
            panel!.querySelectorAll(
              "[data-moss-normalized-row][data-tool-lifecycle-id='browser-tool-shell'][data-tool-lifecycle-state='succeeded']",
            ),
          ).toHaveLength(2);
          expect(panel!.querySelectorAll("[data-moss-normalized-permission-state]")).toHaveLength(
            1,
          );
          expect(
            panel!.querySelectorAll("[data-moss-normalized-permission-action-shell]"),
          ).toHaveLength(1);
          expect(panel!.querySelectorAll("[data-moss-normalized-usage-summary]")).toHaveLength(1);
          expect(panel!.querySelectorAll("[data-moss-normalized-finish-summary]")).toHaveLength(1);
          expect(panel!.querySelectorAll("[data-moss-normalized-error-summary]")).toHaveLength(1);
          expect(
            panel!.querySelector(
              "[data-moss-normalized-row][data-event-type='text'][data-text-stream-kind='assistant_text'][data-text-role='assistant']",
            ),
          ).toBeTruthy();
          expect(
            panel!.querySelector(
              "[data-moss-normalized-row][data-permission-state='pending'][data-permission-kind='command']",
            ),
          ).toBeTruthy();
          expect(panel!.textContent ?? "").toContain("sha256:browser-launch-plan");
          expect(panel!.textContent ?? "").not.toContain("codex.eventmsg");
          expect(panel!.textContent ?? "").not.toContain("codex.tool-call");
          expect(panel!.textContent ?? "").not.toContain("codex.approval");
          expect(panel!.textContent ?? "").not.toContain("codex.usage");
          expect(panel!.textContent ?? "").not.toContain("codex.finish");
          expect(panel!.textContent ?? "").not.toContain("codex.error");
          expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(nativeApi.subscribeNormalizedSessionEvents).toHaveBeenCalledWith(
        { threadId: THREAD_ID },
        expect.any(Function),
      );
      expect(nativeApi.listSessions).toHaveBeenCalledTimes(1);

      document
        .querySelector<HTMLButtonElement>(
          "[data-moss-normalized-event-inspect='moss-browser-normalized-1']",
        )
        ?.click();
      await vi.waitFor(
        () => {
          const inspector = document.querySelector<HTMLElement>(
            "[data-moss-normalized-event-detail-inspector][data-selected-event-id='moss-browser-normalized-1'][data-selected-event-type='text'][data-selected-event-provider='codex']",
          );
          expect(inspector).toBeTruthy();
          expect(inspector!.textContent ?? "").toContain("Assistant text");
          expect(inspector!.textContent ?? "").toContain("browser assistant text");
          expect(inspector!.textContent ?? "").toContain("assistant_text");
          expect(inspector!.textContent ?? "").not.toContain("codex.eventmsg");
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>("[data-moss-normalized-event-detail-close]")
        ?.click();
      await vi.waitFor(
        () => {
          expect(
            document.querySelector("[data-moss-normalized-event-detail-inspector]"),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>(
          "[data-moss-normalized-event-inspect='moss-browser-normalized-4']",
        )
        ?.click();
      await vi.waitFor(
        () => {
          const inspector = document.querySelector<HTMLElement>(
            "[data-moss-normalized-event-detail-inspector][data-selected-event-id='moss-browser-normalized-4'][data-selected-event-type='permission-request']",
          );
          expect(inspector).toBeTruthy();
          expect(
            inspector!.querySelector(
              "[data-moss-normalized-permission-action-shell][data-permission-action-status='runtime-bridge-missing'][data-permission-action-enabled='false'][data-permission-action-state='pending'][data-permission-action-kind='command']",
            ),
          ).toBeTruthy();
          expect(
            inspector!.querySelector("[data-permission-action-intent='approve']"),
          ).toBeTruthy();
          expect(inspector!.querySelector("[data-permission-action-intent='deny']")).toBeTruthy();
          expect(inspector!.querySelector("[data-permission-action-intent='defer']")).toBeTruthy();
          expect(
            inspector!.querySelector<HTMLButtonElement>("[data-permission-action-intent='approve']")
              ?.disabled,
          ).toBe(true);
          expect(inspector!.textContent ?? "").toContain("Runtime action bridge missing");
          expect(inspector!.textContent ?? "").not.toContain("codex.approval");
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>("[data-moss-normalized-event-detail-close]")
        ?.click();
      await vi.waitFor(
        () => {
          expect(
            document.querySelector("[data-moss-normalized-event-detail-inspector]"),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>("[data-moss-normalized-event-filter='text']")
        ?.click();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("[data-moss-normalized-row]")).toHaveLength(1);
          expect(
            document.querySelector(
              "[data-moss-normalized-row][data-event-type='text'][data-text-stream-kind='assistant_text'][data-text-role='assistant']",
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").not.toContain("codex.eventmsg");
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>("[data-moss-normalized-event-filter='tool-call']")
        ?.click();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("[data-moss-normalized-row]")).toHaveLength(1);
          expect(
            document.querySelector(
              "[data-moss-normalized-row][data-event-type='tool-call'][data-tool-lifecycle-id='browser-tool-shell'][data-tool-lifecycle-state='succeeded'][data-tool-lifecycle-has-result='true']",
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").not.toContain("codex.tool-call");
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>("[data-moss-normalized-event-filter='error']")
        ?.click();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("[data-moss-normalized-row]")).toHaveLength(1);
          expect(
            document.querySelector(
              "[data-moss-normalized-row][data-event-type='error'][data-error-class='provider_error'][data-error-code='E_BROWSER_PROVIDER'][data-error-severity='error'][data-error-retryable='true']",
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("browser provider crashed");
          expect(document.body.textContent ?? "").not.toContain("codex.error");
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>("[data-moss-normalized-event-filter='usage']")
        ?.click();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("[data-moss-normalized-row]")).toHaveLength(1);
          expect(
            document.querySelector(
              "[data-moss-normalized-row][data-event-type='usage'][data-usage-input-tokens='2400'][data-usage-output-tokens='600'][data-usage-used-tokens='3000'][data-usage-model='gpt-5-mini']",
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").not.toContain("codex.usage");
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>("[data-moss-normalized-event-filter='finish']")
        ?.click();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("[data-moss-normalized-row]")).toHaveLength(1);
          expect(
            document.querySelector(
              "[data-moss-normalized-row][data-event-type='finish'][data-finish-state='completed'][data-finish-status='completed'][data-finish-stop-reason='stop']",
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").not.toContain("codex.finish");
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(nativeApi.getLoopLedgerDashboardSnapshot).not.toHaveBeenCalled();

      document.querySelector<HTMLButtonElement>("[title='Sessions']")?.click();
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-moss-control-plane-sessions]")).toBeTruthy();
          expect(
            document.querySelector(
              `[data-moss-session-list-row][data-thread-id='${String(SECONDARY_THREAD_ID)}']`,
            ),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>(
          `[data-moss-session-list-row][data-thread-id='${String(SECONDARY_THREAD_ID)}']`,
        )
        ?.click();
      await vi.waitFor(
        () => {
          const panel = document.querySelector<HTMLElement>("[data-moss-control-plane]");
          expect(
            panel!.querySelector(
              `[data-moss-session-list-row][data-thread-id='${String(
                SECONDARY_THREAD_ID,
              )}'][data-selected-session='true'][data-active-thread='false']`,
            ),
          ).toBeTruthy();
          expect(
            panel!.querySelector(
              `[data-moss-session-drilldown][data-selected-thread-id='${String(
                SECONDARY_THREAD_ID,
              )}']`,
            ),
          ).toBeTruthy();
          expect(panel!.textContent ?? "").toContain(String(THREAD_ID));
          expect(panel!.textContent ?? "").toContain("claude-sonnet-4-6");
          expect(panel!.textContent ?? "").toContain("/Users/moss/Codex/tools/other-agent");
          expect(panel!.textContent ?? "").toContain("not loaded");
          expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      document.querySelector<HTMLButtonElement>("[title='Events']")?.click();
      await vi.waitFor(
        () => {
          const panel = document.querySelector<HTMLElement>("[data-moss-control-plane]");
          expect(panel!.querySelector("[data-moss-control-plane-events]")).toBeTruthy();
          expect(
            panel!.querySelector(
              `[data-moss-normalized-session-scope][data-scope-thread-id='${String(
                SECONDARY_THREAD_ID,
              )}'][data-scope-active-thread='false']`,
            ),
          ).toBeTruthy();
          expect(
            panel!.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='selected-session'][data-subscription-thread-id='${String(
                SECONDARY_THREAD_ID,
              )}'][data-subscription-event-count='1']`,
            ),
          ).toBeTruthy();
          expect(panel!.querySelectorAll("[data-moss-normalized-row]")).toHaveLength(1);
          expect(
            panel!.querySelector(
              "[data-moss-normalized-row][data-event-type='text'][data-text-stream-kind='assistant_text'][data-text-role='assistant']",
            ),
          ).toBeTruthy();
          expect(panel!.textContent ?? "").toContain("secondary session assistant text");
          expect(panel!.textContent ?? "").not.toContain("browser assistant text");
          expect(panel!.textContent ?? "").not.toContain("claude.eventmsg");
          expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(nativeApi.subscribeNormalizedSessionEvents).toHaveBeenCalledWith(
        { threadId: SECONDARY_THREAD_ID },
        expect.any(Function),
      );

      document.querySelector<HTMLButtonElement>("[title='Launch']")?.click();
      await vi.waitFor(
        () => {
          expect(nativeApi.getLaunchPlan).toHaveBeenCalledWith({ threadId: SECONDARY_THREAD_ID });
          expect(document.querySelector("[data-moss-control-plane-launch-plan]")).toBeTruthy();
          expect(
            document.querySelector(
              "[data-moss-control-plane-session-list][data-source='runtime'][data-status='ready']",
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("Codex");
          expect(document.body.textContent ?? "").toContain("sha256:secondary-session-launch-plan");
          expect(document.body.textContent ?? "").toContain(String(SECONDARY_THREAD_ID));
          expect(document.body.textContent ?? "").toContain(String(THREAD_ID));
          expect(document.body.textContent ?? "").not.toContain("codex.eventmsg");
        },
        { timeout: 8_000, interval: 16 },
      );

      document.querySelector<HTMLButtonElement>("[title='Ledger']")?.click();
      await vi.waitFor(
        () => {
          expect(nativeApi.getLoopLedgerDashboardSnapshot).toHaveBeenCalledWith({
            threadId: THREAD_ID,
          });
          expect(document.body.textContent ?? "").toContain("moss-task-runtime-bridge");
          expect(document.body.textContent ?? "").toContain(
            "Runtime bridge injected dashboard snapshot",
          );
          expect(document.body.textContent ?? "").toContain("Runtime");
          expect(document.body.textContent ?? "").toContain("Ready");
          expect(
            document.querySelector(
              "[data-moss-control-plane-summary][data-ledger-source='runtime']",
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              "[data-moss-control-plane-session-list][data-source='runtime'][data-status='ready']",
            ),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByLabelText("Refresh ledger snapshot").click();
      await vi.waitFor(
        () => {
          expect(nativeApi.getLoopLedgerDashboardSnapshot).toHaveBeenCalledTimes(2);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await enabled.unmount();
    }
  });

  it("cleans up scoped normalized event subscriptions when clearing and switching sessions", async () => {
    await page.viewport(1_280, 900);
    const activeInitialEvent = normalizedEvent(
      "text",
      {
        text: "active lifecycle initial text",
        streamKind: "assistant_text",
        rawSource: "codex.lifecycle.initial",
      },
      1,
    );
    const secondaryInitialEvent = normalizedEvent(
      "text",
      {
        text: "secondary lifecycle initial text",
        streamKind: "assistant_text",
        rawSource: "claude.lifecycle.initial",
      },
      2,
      { threadId: SECONDARY_THREAD_ID, sessionId: SECONDARY_SESSION_ID },
    );
    const tertiaryInitialEvent = normalizedEvent(
      "text",
      {
        text: "tertiary lifecycle initial text",
        streamKind: "assistant_text",
        rawSource: "opencode.lifecycle.initial",
      },
      3,
      { threadId: TERTIARY_THREAD_ID, sessionId: TERTIARY_SESSION_ID },
    );
    const nativeApi = installNativeProviderStub({
      normalizedEvents: [activeInitialEvent, secondaryInitialEvent, tertiaryInitialEvent],
      providerSessions: [
        ...defaultProviderSessions(),
        {
          provider: "opencode",
          status: "running",
          runtimeMode: "full-access",
          cwd: "/Users/moss/Codex/tools/tertiary-agent",
          model: "opencode-qwen3-coder",
          threadId: TERTIARY_THREAD_ID,
          createdAt: "2026-07-01T00:00:04.000Z",
          updatedAt: "2026-07-01T00:00:04.000Z",
        },
      ],
    });
    setFeatureFlagEnabled("show-moss-control-plane", true);

    const enabled = await render(<MossControlPlaneSmokeHarness />);
    try {
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-moss-control-plane-events]")).toBeTruthy();
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='active-thread'][data-subscription-thread-id='${String(
                THREAD_ID,
              )}'][data-subscription-event-count='1']`,
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("active lifecycle initial text");
          expect(document.body.textContent ?? "").not.toContain("secondary lifecycle initial text");
          expect(document.body.textContent ?? "").not.toContain("tertiary lifecycle initial text");
        },
        { timeout: 8_000, interval: 16 },
      );

      const activeSubscription = openSubscriptionRecordsForThread(
        nativeApi.normalizedEventSubscriptions,
        THREAD_ID,
      )[0];
      expect(activeSubscription).toBeTruthy();
      expect(
        subscriptionRecordsForThread(nativeApi.normalizedEventSubscriptions, THREAD_ID),
      ).toHaveLength(1);
      expect(activeSubscription!.unsubscribe).not.toHaveBeenCalled();
      expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();

      document.querySelector<HTMLButtonElement>("[title='Sessions']")?.click();
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              `[data-moss-session-list-row][data-thread-id='${String(SECONDARY_THREAD_ID)}']`,
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              `[data-moss-session-list-row][data-thread-id='${String(TERTIARY_THREAD_ID)}']`,
            ),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>(
          `[data-moss-session-list-row][data-thread-id='${String(SECONDARY_THREAD_ID)}']`,
        )
        ?.click();
      document.querySelector<HTMLButtonElement>("[title='Events']")?.click();
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              `[data-moss-normalized-session-scope][data-scope-thread-id='${String(
                SECONDARY_THREAD_ID,
              )}'][data-scope-active-thread='false']`,
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='selected-session'][data-subscription-thread-id='${String(
                SECONDARY_THREAD_ID,
              )}'][data-subscription-event-count='1']`,
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("secondary lifecycle initial text");
          expect(document.body.textContent ?? "").not.toContain("active lifecycle initial text");
          expect(document.body.textContent ?? "").not.toContain("tertiary lifecycle initial text");
        },
        { timeout: 8_000, interval: 16 },
      );

      const firstSecondarySubscription = openSubscriptionRecordsForThread(
        nativeApi.normalizedEventSubscriptions,
        SECONDARY_THREAD_ID,
      )[0];
      expect(firstSecondarySubscription).toBeTruthy();
      expect(
        subscriptionRecordsForThread(nativeApi.normalizedEventSubscriptions, SECONDARY_THREAD_ID),
      ).toHaveLength(1);
      expect(
        openSubscriptionRecordsForThread(nativeApi.normalizedEventSubscriptions, THREAD_ID),
      ).toEqual([activeSubscription]);
      expect(activeSubscription!.unsubscribe).not.toHaveBeenCalled();

      nativeApi.emitNormalizedEvent(
        normalizedEvent(
          "text",
          {
            text: "secondary lifecycle live text",
            streamKind: "assistant_text",
            rawSource: "claude.lifecycle.live",
          },
          4,
          { threadId: SECONDARY_THREAD_ID, sessionId: SECONDARY_SESSION_ID },
        ),
      );
      await vi.waitFor(
        () => {
          expect(
            document.querySelector("[data-event-id='moss-browser-normalized-4']"),
          ).toBeTruthy();
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='selected-session'][data-subscription-thread-id='${String(
                SECONDARY_THREAD_ID,
              )}'][data-subscription-event-count='2']`,
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("secondary lifecycle live text");
          expect(document.querySelectorAll("[data-moss-normalized-row]")).toHaveLength(2);
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>(
          `[data-moss-session-list-row][data-thread-id='${String(SECONDARY_THREAD_ID)}']`,
        )
        ?.click();
      expect(
        subscriptionRecordsForThread(nativeApi.normalizedEventSubscriptions, SECONDARY_THREAD_ID),
      ).toHaveLength(1);
      expect(document.body.textContent ?? "").not.toContain("claude.lifecycle.live");

      document
        .querySelector<HTMLButtonElement>("[data-moss-normalized-session-scope-clear]")
        ?.click();
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              `[data-moss-normalized-session-scope][data-scope-thread-id='${String(
                THREAD_ID,
              )}'][data-scope-active-thread='true']`,
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='active-thread'][data-subscription-thread-id='${String(
                THREAD_ID,
              )}'][data-subscription-event-count='1']`,
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("active lifecycle initial text");
          expect(document.body.textContent ?? "").not.toContain("secondary lifecycle live text");
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(firstSecondarySubscription!.unsubscribe).toHaveBeenCalledTimes(1);
      expect(firstSecondarySubscription!.closed).toBe(true);
      expect(activeSubscription!.unsubscribe).not.toHaveBeenCalled();
      expect(
        openSubscriptionRecordsForThread(nativeApi.normalizedEventSubscriptions, THREAD_ID),
      ).toEqual([activeSubscription]);

      nativeApi.emitNormalizedEvent(
        normalizedEvent(
          "text",
          {
            text: "secondary lifecycle after clear leak",
            streamKind: "assistant_text",
            rawSource: "claude.lifecycle.after-clear",
          },
          5,
          { threadId: SECONDARY_THREAD_ID, sessionId: SECONDARY_SESSION_ID },
        ),
      );
      expect(document.body.textContent ?? "").not.toContain("secondary lifecycle after clear leak");

      document
        .querySelector<HTMLButtonElement>(
          `[data-moss-session-list-row][data-thread-id='${String(SECONDARY_THREAD_ID)}']`,
        )
        ?.click();
      await vi.waitFor(
        () => {
          expect(
            openSubscriptionRecordsForThread(
              nativeApi.normalizedEventSubscriptions,
              SECONDARY_THREAD_ID,
            ),
          ).toHaveLength(1);
          expect(document.body.textContent ?? "").toContain("secondary lifecycle initial text");
        },
        { timeout: 8_000, interval: 16 },
      );
      const reopenedSecondarySubscription = openSubscriptionRecordsForThread(
        nativeApi.normalizedEventSubscriptions,
        SECONDARY_THREAD_ID,
      )[0];
      expect(reopenedSecondarySubscription).toBeTruthy();
      expect(reopenedSecondarySubscription).not.toBe(firstSecondarySubscription);

      document
        .querySelector<HTMLButtonElement>(
          `[data-moss-session-list-row][data-thread-id='${String(TERTIARY_THREAD_ID)}']`,
        )
        ?.click();
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              `[data-moss-normalized-session-scope][data-scope-thread-id='${String(
                TERTIARY_THREAD_ID,
              )}'][data-scope-active-thread='false']`,
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='selected-session'][data-subscription-thread-id='${String(
                TERTIARY_THREAD_ID,
              )}'][data-subscription-event-count='1']`,
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("tertiary lifecycle initial text");
          expect(document.body.textContent ?? "").not.toContain("secondary lifecycle initial text");
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(reopenedSecondarySubscription!.unsubscribe).toHaveBeenCalledTimes(1);
      expect(reopenedSecondarySubscription!.closed).toBe(true);
      expect(
        openSubscriptionRecordsForThread(
          nativeApi.normalizedEventSubscriptions,
          SECONDARY_THREAD_ID,
        ),
      ).toHaveLength(0);
      expect(
        openSubscriptionRecordsForThread(
          nativeApi.normalizedEventSubscriptions,
          TERTIARY_THREAD_ID,
        ),
      ).toHaveLength(1);
      expect(
        openSubscriptionRecordsForThread(nativeApi.normalizedEventSubscriptions, THREAD_ID),
      ).toEqual([activeSubscription]);

      nativeApi.emitNormalizedEvent(
        normalizedEvent(
          "text",
          {
            text: "secondary lifecycle after switch leak",
            streamKind: "assistant_text",
            rawSource: "claude.lifecycle.after-switch",
          },
          6,
          { threadId: SECONDARY_THREAD_ID, sessionId: SECONDARY_SESSION_ID },
        ),
      );
      nativeApi.emitNormalizedEvent(
        normalizedEvent(
          "text",
          {
            text: "tertiary lifecycle live text",
            streamKind: "assistant_text",
            rawSource: "opencode.lifecycle.live",
          },
          7,
          { threadId: TERTIARY_THREAD_ID, sessionId: TERTIARY_SESSION_ID },
        ),
      );
      await vi.waitFor(
        () => {
          expect(
            document.querySelector("[data-event-id='moss-browser-normalized-7']"),
          ).toBeTruthy();
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='selected-session'][data-subscription-thread-id='${String(
                TERTIARY_THREAD_ID,
              )}'][data-subscription-event-count='2']`,
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("tertiary lifecycle live text");
          expect(document.body.textContent ?? "").not.toContain(
            "secondary lifecycle after switch leak",
          );
          expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.body.textContent ?? "").not.toContain("claude.lifecycle.initial");
      expect(document.body.textContent ?? "").not.toContain("claude.lifecycle.after-clear");
      expect(document.body.textContent ?? "").not.toContain("claude.lifecycle.after-switch");
      expect(document.body.textContent ?? "").not.toContain("opencode.lifecycle.initial");
      expect(document.body.textContent ?? "").not.toContain("opencode.lifecycle.live");
    } finally {
      await enabled.unmount();
    }
  });

  it("surfaces normalized event subscription bridge missing and error states", async () => {
    await page.viewport(1_280, 900);
    const emptyReplayApi = installNativeProviderStub({
      normalizedEvents: [],
    });
    setFeatureFlagEnabled("show-moss-control-plane", true);

    const emptyReplay = await render(<MossControlPlaneSmokeHarness />);
    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='empty-replay'][data-subscription-scope='active-thread'][data-subscription-thread-id='${String(
                THREAD_ID,
              )}'][data-subscription-event-count='0']`,
            ),
          ).toBeTruthy();
          expect(document.querySelector("[data-moss-normalized-empty]")).toBeTruthy();
          expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(emptyReplayApi.subscribeNormalizedSessionEvents).toHaveBeenCalledWith(
        { threadId: THREAD_ID },
        expect.any(Function),
      );
    } finally {
      await emptyReplay.unmount();
    }

    const missingBridgeApi = installNativeProviderStub({
      normalizedEvents: [],
      omitNormalizedEventSubscription: true,
    });

    const missingBridge = await render(<MossControlPlaneSmokeHarness />);
    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='bridge-missing'][data-subscription-scope='active-thread'][data-subscription-thread-id='${String(
                THREAD_ID,
              )}'][data-subscription-event-count='0']`,
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("Bridge missing");
          expect(document.querySelector("[data-moss-normalized-empty]")).toBeTruthy();
          expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(missingBridgeApi.subscribeNormalizedSessionEvents).not.toHaveBeenCalled();
    } finally {
      await missingBridge.unmount();
    }

    const errorApi = installNativeProviderStub({
      normalizedEvents: [],
      throwNormalizedEventSubscription: true,
    });
    const errored = await render(<MossControlPlaneSmokeHarness />);
    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='error'][data-subscription-scope='active-thread'][data-subscription-thread-id='${String(
                THREAD_ID,
              )}'][data-subscription-event-count='0']`,
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("Subscription error");
          expect(document.body.textContent ?? "").toContain("Normalized event subscription failed");
          expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(errorApi.subscribeNormalizedSessionEvents).toHaveBeenCalledWith(
        { threadId: THREAD_ID },
        expect.any(Function),
      );
      expect(errorApi.normalizedEventSubscriptions).toHaveLength(0);
    } finally {
      await errored.unmount();
    }
  });

  it("submits permission actions through the typed Moss bridge and surfaces unsupported state", async () => {
    await page.viewport(1_280, 900);
    const submitPermissionAction = vi.fn(async (input: ProviderSubmitPermissionActionInput) => ({
      ...input,
      status: "unsupported" as const,
      message: "Adapter action handler unavailable.",
    }));
    installNativeProviderStub({ submitPermissionAction });
    setFeatureFlagEnabled("show-moss-control-plane", true);

    const enabled = await render(<MossControlPlaneSmokeHarness />);
    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              "[data-event-id='moss-browser-normalized-4'] [data-moss-normalized-permission-action-shell][data-permission-action-status='ready'][data-permission-action-enabled='true']",
            ),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      const approveButton = document.querySelector<HTMLButtonElement>(
        "[data-event-id='moss-browser-normalized-4'] [data-permission-action-intent='approve']",
      );
      expect(approveButton).toBeTruthy();
      expect(approveButton!.disabled).toBe(false);
      approveButton!.click();

      await vi.waitFor(
        () => {
          expect(submitPermissionAction).toHaveBeenCalledWith({
            threadId: THREAD_ID,
            sessionId: SESSION_ID,
            normalizedEventId: EventId.makeUnsafe("moss-browser-normalized-4"),
            intent: "approve",
          });
          expect(
            document.querySelector(
              "[data-event-id='moss-browser-normalized-4'] [data-moss-normalized-permission-action-shell][data-permission-action-status='unsupported'][data-permission-action-enabled='false']",
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("Adapter action handler unavailable.");
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>(
          "[data-moss-normalized-event-inspect='moss-browser-normalized-4']",
        )
        ?.click();
      await vi.waitFor(
        () => {
          const inspector = document.querySelector<HTMLElement>(
            "[data-moss-normalized-event-detail-inspector][data-selected-event-id='moss-browser-normalized-4']",
          );
          expect(inspector).toBeTruthy();
          expect(
            inspector!.querySelector(
              "[data-moss-normalized-permission-action-shell][data-permission-action-status='unsupported']",
            ),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await enabled.unmount();
    }
  });

  it("shows accepted, rejected, and in-flight permission action states through the typed bridge", async () => {
    await page.viewport(1_280, 900);
    const approveEvent = normalizedEvent(
      "permission-request",
      {
        status: "pending",
        requestType: "exec_command_approval",
        detail: "Approve accepted command",
        rawSource: "codex.approval.accepted",
      },
      1,
    );
    const denyEvent = normalizedEvent(
      "permission-request",
      {
        status: "pending",
        requestType: "file_change_approval",
        detail: "Deny rejected edit",
        rawSource: "codex.approval.rejected",
      },
      2,
    );
    const resolvedEvent = normalizedEvent(
      "permission-request",
      {
        status: "resolved",
        requestType: "exec_command_approval",
        decision: "accepted by provider",
        detail: "Already resolved command",
        rawSource: "codex.approval.resolved",
      },
      3,
    );
    const deferred = createPermissionActionDeferred();
    const submitPermissionAction = vi.fn(async (input: ProviderSubmitPermissionActionInput) => {
      if (String(input.normalizedEventId) === String(approveEvent.eventId)) {
        return {
          ...input,
          status: "accepted" as const,
          message: "Permission action accepted by provider.",
        };
      }

      return deferred.promise;
    });
    installNativeProviderStub({
      normalizedEvents: [approveEvent, denyEvent, resolvedEvent],
      submitPermissionAction,
    });
    setFeatureFlagEnabled("show-moss-control-plane", true);

    const enabled = await render(<MossControlPlaneSmokeHarness />);
    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              "[data-event-id='moss-browser-normalized-1'] [data-moss-normalized-permission-action-shell][data-permission-action-status='ready'][data-permission-action-enabled='true']",
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              "[data-event-id='moss-browser-normalized-2'] [data-moss-normalized-permission-action-shell][data-permission-action-status='ready'][data-permission-action-enabled='true']",
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              "[data-event-id='moss-browser-normalized-3'] [data-moss-normalized-permission-action-shell][data-permission-action-status='not-applicable'][data-permission-action-enabled='false']",
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              "[data-event-id='moss-browser-normalized-3'] [data-permission-action-intent]",
            ),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>(
          "[data-event-id='moss-browser-normalized-1'] [data-permission-action-intent='approve']",
        )
        ?.click();
      await vi.waitFor(
        () => {
          expect(submitPermissionAction).toHaveBeenCalledWith({
            threadId: THREAD_ID,
            sessionId: SESSION_ID,
            normalizedEventId: approveEvent.eventId,
            intent: "approve",
          });
          expect(
            document.querySelector(
              "[data-event-id='moss-browser-normalized-1'] [data-moss-normalized-permission-action-shell][data-permission-action-status='accepted'][data-permission-action-enabled='false']",
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain(
            "Permission action accepted by provider.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      document
        .querySelector<HTMLButtonElement>(
          "[data-event-id='moss-browser-normalized-2'] [data-permission-action-intent='deny']",
        )
        ?.click();
      await vi.waitFor(
        () => {
          expect(submitPermissionAction).toHaveBeenCalledWith({
            threadId: THREAD_ID,
            sessionId: SESSION_ID,
            normalizedEventId: denyEvent.eventId,
            intent: "deny",
          });
          expect(
            document.querySelector(
              "[data-event-id='moss-browser-normalized-2'] [data-moss-normalized-permission-action-shell][data-permission-action-status='submitting'][data-permission-action-enabled='false']",
            ),
          ).toBeTruthy();
          expect(
            document.querySelector<HTMLButtonElement>(
              "[data-event-id='moss-browser-normalized-2'] [data-permission-action-intent='deny']",
            )?.disabled,
          ).toBe(true);
          expect(
            document.querySelector<HTMLButtonElement>(
              "[data-event-id='moss-browser-normalized-2'] [data-permission-action-intent='approve']",
            )?.disabled,
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      deferred.resolve({
        threadId: THREAD_ID,
        sessionId: SESSION_ID,
        normalizedEventId: denyEvent.eventId,
        intent: "deny",
        status: "rejected",
        message: "Provider rejected the deny action.",
      });
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              "[data-event-id='moss-browser-normalized-2'] [data-moss-normalized-permission-action-shell][data-permission-action-status='rejected'][data-permission-action-enabled='false']",
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("Provider rejected the deny action.");
          expect(submitPermissionAction).toHaveBeenCalledTimes(2);
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(document.body.textContent ?? "").not.toContain("codex.approval.accepted");
      expect(document.body.textContent ?? "").not.toContain("codex.approval.rejected");
      expect(document.body.textContent ?? "").not.toContain("codex.approval.resolved");
    } finally {
      await enabled.unmount();
    }
  });

  it("shows runtime bridge errors while keeping the fallback dashboard refreshable", async () => {
    await page.viewport(1_280, 900);
    const nativeApi = installNativeProviderStub({ failLoopLedgerDashboardSnapshot: true });
    setFeatureFlagEnabled("show-moss-control-plane", true);

    const enabled = await render(<MossControlPlaneSmokeHarness />);
    try {
      document.querySelector<HTMLButtonElement>("[title='Ledger']")?.click();
      await vi.waitFor(
        () => {
          expect(nativeApi.getLoopLedgerDashboardSnapshot).toHaveBeenCalledTimes(1);
          expect(document.body.textContent ?? "").toContain("Fallback");
          expect(document.body.textContent ?? "").toContain("Error");
          expect(document.body.textContent ?? "").toContain("Runtime bridge failed");
          expect(document.body.textContent ?? "").toContain("moss-task-0019");
          expect(
            document.querySelector("[data-moss-control-plane-summary][data-ledger-status='error']"),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByLabelText("Refresh ledger snapshot").click();
      await vi.waitFor(
        () => {
          expect(nativeApi.getLoopLedgerDashboardSnapshot).toHaveBeenCalledTimes(2);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await enabled.unmount();
    }
  });
});
