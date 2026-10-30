// FILE: mossNormalizedTimeline.browser.tsx
// Purpose: Browser regression coverage for Moss normalized subscription state.
// Layer: Web chat control-plane hook smoke test

import {
  EventId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type MossNormalizedSessionEvent,
  type NativeApi,
} from "@synara/contracts";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useMossNormalizedSessionEvents } from "./mossNormalizedTimeline";

const ACTIVE_THREAD_ID = ThreadId.makeUnsafe("thread-moss-normalized-hook-active");
const SECONDARY_THREAD_ID = ThreadId.makeUnsafe("thread-moss-normalized-hook-secondary");
const TERTIARY_THREAD_ID = ThreadId.makeUnsafe("thread-moss-normalized-hook-tertiary");
const SESSION_ID = RuntimeSessionId.makeUnsafe("runtime-session-moss-normalized-hook");
const TURN_ID = TurnId.makeUnsafe("turn-moss-normalized-hook");

interface NormalizedHookSubscriptionRecord {
  readonly input: { threadId: ThreadId };
  readonly onEvent: (event: MossNormalizedSessionEvent) => void;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  closed: boolean;
}

function MossNormalizedTimelineHookHarness() {
  const [threadId, setThreadId] = useState<ThreadId | null>(ACTIVE_THREAD_ID);
  const timeline = useMossNormalizedSessionEvents({ threadId });

  return (
    <main>
      <nav>
        <button data-select-active="" onClick={() => setThreadId(ACTIVE_THREAD_ID)} type="button">
          Active
        </button>
        <button
          data-select-secondary=""
          onClick={() => setThreadId(SECONDARY_THREAD_ID)}
          type="button"
        >
          Secondary
        </button>
        <button
          data-select-tertiary=""
          onClick={() => setThreadId(TERTIARY_THREAD_ID)}
          type="button"
        >
          Tertiary
        </button>
        <button data-disable="" onClick={() => setThreadId(null)} type="button">
          Disabled
        </button>
      </nav>
      <section
        data-event-count={timeline.events.length}
        data-hook-thread-id={timeline.subscription.threadId ?? ""}
        data-moss-normalized-hook-status={timeline.subscription.status}
        data-subscription-event-count={timeline.subscription.eventCount}
      >
        <span data-hook-label="">{timeline.subscription.label}</span>
        {timeline.subscription.error ? (
          <span data-hook-error="">{timeline.subscription.error}</span>
        ) : null}
        <ol>
          {timeline.events.map((event) => (
            <li data-hook-event-id={String(event.eventId)} key={String(event.eventId)}>
              {typeof event.payload.text === "string" ? event.payload.text : event.type}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

function installNativeProviderHookStub({
  normalizedEvents = [],
  omitNormalizedEventSubscription = false,
  throwNormalizedEventSubscription = false,
}: {
  readonly normalizedEvents?: ReadonlyArray<MossNormalizedSessionEvent>;
  readonly omitNormalizedEventSubscription?: boolean;
  readonly throwNormalizedEventSubscription?: boolean;
} = {}) {
  const normalizedEventSubscriptions: NormalizedHookSubscriptionRecord[] = [];
  const subscribeNormalizedSessionEvents = vi.fn(
    (input: { threadId: ThreadId }, onEvent: (event: MossNormalizedSessionEvent) => void) => {
      if (throwNormalizedEventSubscription) {
        throw new Error("Hook subscription failed");
      }

      const record: NormalizedHookSubscriptionRecord = {
        input,
        onEvent,
        unsubscribe: vi.fn(() => {
          record.closed = true;
        }),
        closed: false,
      };
      normalizedEventSubscriptions.push(record);

      const threadId = String(input.threadId);
      for (const event of normalizedEvents) {
        if (String(event.threadId) === threadId) {
          onEvent(event);
        }
      }

      return record.unsubscribe;
    },
  );
  const providerApi: Record<string, unknown> = {};
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
    normalizedEventSubscriptions,
    subscribeNormalizedSessionEvents,
  };
}

function normalizedEvent(
  index: number,
  text: string,
  threadId: ThreadId = ACTIVE_THREAD_ID,
): MossNormalizedSessionEvent {
  return {
    eventId: EventId.makeUnsafe(`moss-normalized-hook-${index}`),
    type: "text",
    provider: "codex",
    sessionId: SESSION_ID,
    threadId,
    turnId: TURN_ID,
    createdAt: `2026-07-01T00:01:${String(index).padStart(2, "0")}.000Z`,
    rawEventId: EventId.makeUnsafe(`moss-normalized-hook-raw-${index}`),
    payload: {
      text,
      rawSource: `codex.raw.${index}`,
      streamKind: "assistant_text",
    },
  };
}

function subscriptionStatusSelector({
  count,
  status,
  threadId,
}: {
  readonly count: number;
  readonly status: string;
  readonly threadId: ThreadId;
}) {
  return `[data-moss-normalized-hook-status='${status}'][data-hook-thread-id='${String(
    threadId,
  )}'][data-subscription-event-count='${count}']`;
}

describe("mossNormalizedTimeline subscription hook browser gate", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it("tracks active and selected session subscription status without stale event leaks", async () => {
    await page.viewport(1_000, 700);
    const provider = installNativeProviderHookStub();

    const rendered = await render(<MossNormalizedTimelineHookHarness />);
    try {
      expect(
        document.querySelector(
          subscriptionStatusSelector({
            count: 0,
            status: "subscribed",
            threadId: ACTIVE_THREAD_ID,
          }),
        ),
      ).toBeTruthy();
      await vi.waitFor(() => {
        expect(
          document.querySelector(
            subscriptionStatusSelector({
              count: 0,
              status: "empty-replay",
              threadId: ACTIVE_THREAD_ID,
            }),
          ),
        ).toBeTruthy();
      });

      provider.emitNormalizedEvent(normalizedEvent(1, "active live event"));
      await vi.waitFor(() => {
        expect(
          document.querySelector(
            subscriptionStatusSelector({
              count: 1,
              status: "live",
              threadId: ACTIVE_THREAD_ID,
            }),
          ),
        ).toBeTruthy();
        expect(document.body.textContent ?? "").toContain("active live event");
      });

      document.querySelector<HTMLButtonElement>("[data-select-secondary]")?.click();
      await vi.waitFor(() => {
        expect(
          document.querySelector(
            subscriptionStatusSelector({
              count: 0,
              status: "empty-replay",
              threadId: SECONDARY_THREAD_ID,
            }),
          ),
        ).toBeTruthy();
      });
      const secondaryRecord = provider.normalizedEventSubscriptions.find(
        (record) => String(record.input.threadId) === String(SECONDARY_THREAD_ID),
      );
      expect(secondaryRecord).toBeTruthy();

      provider.emitNormalizedEvent(normalizedEvent(2, "secondary live event", SECONDARY_THREAD_ID));
      await vi.waitFor(() => {
        expect(
          document.querySelector(
            subscriptionStatusSelector({
              count: 1,
              status: "live",
              threadId: SECONDARY_THREAD_ID,
            }),
          ),
        ).toBeTruthy();
        expect(document.body.textContent ?? "").toContain("secondary live event");
        expect(document.body.textContent ?? "").not.toContain("active live event");
      });

      document.querySelector<HTMLButtonElement>("[data-select-tertiary]")?.click();
      await vi.waitFor(() => {
        expect(secondaryRecord!.closed).toBe(true);
        expect(
          document.querySelector(
            subscriptionStatusSelector({
              count: 0,
              status: "empty-replay",
              threadId: TERTIARY_THREAD_ID,
            }),
          ),
        ).toBeTruthy();
      });

      secondaryRecord!.onEvent(normalizedEvent(3, "stale secondary event", SECONDARY_THREAD_ID));
      provider.emitNormalizedEvent(normalizedEvent(4, "tertiary live event", TERTIARY_THREAD_ID));
      await vi.waitFor(() => {
        expect(
          document.querySelector(
            subscriptionStatusSelector({
              count: 1,
              status: "live",
              threadId: TERTIARY_THREAD_ID,
            }),
          ),
        ).toBeTruthy();
        expect(document.body.textContent ?? "").toContain("tertiary live event");
        expect(document.body.textContent ?? "").not.toContain("stale secondary event");
        expect(document.body.textContent ?? "").not.toContain("codex.raw");
      });

      document.querySelector<HTMLButtonElement>("[data-disable]")?.click();
      await vi.waitFor(() => {
        expect(
          document.querySelector(
            "[data-moss-normalized-hook-status='disabled'][data-hook-thread-id='']",
          ),
        ).toBeTruthy();
      });
    } finally {
      await rendered.unmount();
    }
  });

  it("surfaces missing bridge and subscription errors through typed status", async () => {
    await page.viewport(1_000, 700);
    const missingBridgeProvider = installNativeProviderHookStub({
      omitNormalizedEventSubscription: true,
    });

    const missingBridge = await render(<MossNormalizedTimelineHookHarness />);
    try {
      await vi.waitFor(() => {
        expect(
          document.querySelector(
            subscriptionStatusSelector({
              count: 0,
              status: "bridge-missing",
              threadId: ACTIVE_THREAD_ID,
            }),
          ),
        ).toBeTruthy();
        expect(document.body.textContent ?? "").toContain("Bridge missing");
      });
      expect(missingBridgeProvider.subscribeNormalizedSessionEvents).not.toHaveBeenCalled();
    } finally {
      await missingBridge.unmount();
    }

    const errorProvider = installNativeProviderHookStub({
      throwNormalizedEventSubscription: true,
    });
    const errored = await render(<MossNormalizedTimelineHookHarness />);
    try {
      await vi.waitFor(() => {
        expect(
          document.querySelector(
            subscriptionStatusSelector({
              count: 0,
              status: "error",
              threadId: ACTIVE_THREAD_ID,
            }),
          ),
        ).toBeTruthy();
        expect(document.body.textContent ?? "").toContain("Subscription error");
        expect(document.body.textContent ?? "").toContain("Hook subscription failed");
      });
      expect(errorProvider.subscribeNormalizedSessionEvents).toHaveBeenCalledWith(
        { threadId: ACTIVE_THREAD_ID },
        expect.any(Function),
      );
      expect(errorProvider.normalizedEventSubscriptions).toHaveLength(0);
    } finally {
      await errored.unmount();
    }
  });
});
