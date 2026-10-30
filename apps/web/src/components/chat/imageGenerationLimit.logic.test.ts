import {
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { initialState } from "../../storeState";
import {
  GENERATED_IMAGE_ARTIFACT_KIND,
  IMAGE_GENERATION_LIMIT_ID,
  IMAGE_GENERATION_USAGE_LIMIT_KIND,
  createImageGenerationLimitThreadSelector,
  formatImageGenerationResetDate,
  getImageGenerationLimitResetDelayMs,
  imageGenerationFailureIdentity,
  normalizeImageGenerationPlanName,
  parseImageGenerationCompletionActivity,
  parseImageGenerationLimitActivity,
  resolveImageGenerationAccountSource,
  resolveImageGenerationLimitPresentation,
  selectComposerBannerPriority,
  selectImageGenerationLimitState,
  shouldShowImageGenerationLimitBanner,
} from "./imageGenerationLimit.logic";

const THREAD_ID = ThreadId.makeUnsafe("thread-image-limit");
const PROVIDER_A = "codex" as ProviderInstanceId;
const PROVIDER_B = "codex_work" as ProviderInstanceId;
const NOW_SECONDS = 1_800_000_000;

type ActivityOverrides = {
  id?: string;
  tone?: OrchestrationThreadActivity["tone"];
  kind?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  turnId?: string | null;
  sequence?: number;
  createdAt?: string;
};

function makeActivity(overrides: ActivityOverrides = {}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id ?? "activity-image"),
    tone: overrides.tone ?? "error",
    kind: overrides.kind ?? "tool.completed",
    summary: overrides.summary ?? "image activity",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId === null ? null : TurnId.makeUnsafe(overrides.turnId ?? "turn-image"),
    ...(overrides.sequence === undefined ? {} : { sequence: overrides.sequence }),
    createdAt: overrides.createdAt ?? "2026-12-01T00:00:00.000Z",
  } as OrchestrationThreadActivity;
}

function failure(overrides: ActivityOverrides = {}): OrchestrationThreadActivity {
  const { payload: payloadOverrides, ...activityOverrides } = overrides;
  return makeActivity({
    payload: Object.assign(
      {
        itemType: "image_generation",
        status: "failed",
        providerInstanceId: PROVIDER_A,
        data: {
          kind: IMAGE_GENERATION_USAGE_LIMIT_KIND,
          type: "usageLimitExceeded",
          limitId: IMAGE_GENERATION_LIMIT_ID,
          resetsAt: null,
        },
      },
      payloadOverrides,
    ),
    ...activityOverrides,
  });
}

function success(overrides: ActivityOverrides = {}): OrchestrationThreadActivity {
  const { payload: payloadOverrides, ...activityOverrides } = overrides;
  return makeActivity({
    payload: Object.assign(
      {
        itemType: "image_generation",
        status: "completed",
        providerInstanceId: PROVIDER_A,
        data: {
          kind: GENERATED_IMAGE_ARTIFACT_KIND,
          path: "/tmp/generated.png",
        },
      },
      payloadOverrides,
    ),
    ...activityOverrides,
  });
}

function stateFor(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  overrides: {
    nowEpochSeconds?: number;
    dismissedFailureIdentity?: string | null | undefined;
  } = {},
) {
  const input = {
    slices: [{ threadId: THREAD_ID, activities }],
    providerInstanceId: PROVIDER_A,
    nowEpochSeconds: NOW_SECONDS,
    ...(overrides.nowEpochSeconds === undefined
      ? {}
      : { nowEpochSeconds: overrides.nowEpochSeconds }),
    ...(overrides.dismissedFailureIdentity === undefined
      ? {}
      : { dismissedFailureIdentity: overrides.dismissedFailureIdentity }),
  };
  return selectImageGenerationLimitState(input);
}

describe("image-generation limit activity parsing", () => {
  it("accepts only the exact structured B3.1 failure", () => {
    const parsed = parseImageGenerationLimitActivity(failure(), THREAD_ID);
    expect(parsed).toMatchObject({
      kind: "failure",
      providerInstanceId: PROVIDER_A,
      threadId: THREAD_ID,
      turnId: "turn-image",
      resetsAt: null,
    });
    expect(parsed && "failureIdentity" in parsed).toBe(false);
  });

  it.each([
    ["kind", { data: { type: "usageLimitExceeded", limitId: "image_gen", resetsAt: null } }],
    [
      "type",
      {
        data: {
          kind: IMAGE_GENERATION_USAGE_LIMIT_KIND,
          type: "other",
          limitId: "image_gen",
          resetsAt: null,
        },
      },
    ],
    [
      "limit id",
      {
        data: {
          kind: IMAGE_GENERATION_USAGE_LIMIT_KIND,
          type: "usageLimitExceeded",
          limitId: "text_gen",
          resetsAt: null,
        },
      },
    ],
    ["status", { status: "completed" }],
    ["item type", { itemType: "command_execution" }],
    ["provider instance", { providerInstanceId: "" }],
    [
      "reset type",
      {
        data: {
          kind: IMAGE_GENERATION_USAGE_LIMIT_KIND,
          type: "usageLimitExceeded",
          limitId: "image_gen",
          resetsAt: "1800000000",
        },
      },
    ],
    [
      "negative reset",
      {
        data: {
          kind: IMAGE_GENERATION_USAGE_LIMIT_KIND,
          type: "usageLimitExceeded",
          limitId: "image_gen",
          resetsAt: -1,
        },
      },
    ],
    ["text only", { data: undefined }],
  ])("fails closed for wrong %s or text-only lookalikes", (_label, override) => {
    const payload = {
      ...(failure().payload as Record<string, unknown>),
      ...(override as Record<string, unknown>),
    };
    expect(parseImageGenerationLimitActivity(makeActivity({ payload }), THREAD_ID)).toBeNull();
  });

  it("accepts only canonical generated-image completion data for clearing", () => {
    expect(parseImageGenerationCompletionActivity(success(), THREAD_ID)).toMatchObject({
      kind: "success",
      providerInstanceId: PROVIDER_A,
    });
    expect(
      parseImageGenerationCompletionActivity(
        success({ payload: { data: { kind: "other", path: "/tmp/generated.png" } } }),
        THREAD_ID,
      ),
    ).toBeNull();
    expect(
      parseImageGenerationCompletionActivity(
        success({ payload: { data: { kind: GENERATED_IMAGE_ARTIFACT_KIND, path: "" } } }),
        THREAD_ID,
      ),
    ).toBeNull();
    expect(
      parseImageGenerationCompletionActivity(success({ payload: { status: "failed" } }), THREAD_ID),
    ).toBeNull();
  });
});

describe("image-generation limit lifecycle", () => {
  it("rejects stale failure and stale success by durable completion order", () => {
    const latestFailure = failure({
      id: "failure-new",
      createdAt: "2026-12-01T00:02:00.000Z",
    });
    const staleFailure = failure({
      id: "failure-old",
      createdAt: "2026-12-01T00:01:00.000Z",
    });
    expect(stateFor([latestFailure, staleFailure])?.activityId).toBe("failure-new");

    const laterSuccess = success({
      id: "success-new",
      createdAt: "2026-12-01T00:03:00.000Z",
      turnId: "turn-next",
    });
    expect(stateFor([laterSuccess, latestFailure])).toBeNull();
    expect(stateFor([latestFailure, laterSuccess, staleFailure])).toBeNull();
  });

  it("keeps same-turn success visible and clears on a newer different-turn success", () => {
    const currentFailure = failure({
      id: "failure-current",
      createdAt: "2026-12-01T00:01:00.000Z",
      turnId: "turn-current",
    });
    const sameTurnSuccess = success({
      id: "success-same-turn",
      createdAt: "2026-12-01T00:02:00.000Z",
      turnId: "turn-current",
    });
    expect(stateFor([currentFailure, sameTurnSuccess])?.activityId).toBe("failure-current");
    expect(
      stateFor([
        currentFailure,
        sameTurnSuccess,
        success({
          id: "success-next-turn",
          createdAt: "2026-12-01T00:03:00.000Z",
          turnId: "turn-next",
        }),
      ]),
    ).toBeNull();
  });

  it("uses sequence and activity id as deterministic equal-time tie-breakers", () => {
    const first = failure({ id: "failure-a", sequence: 4 });
    const second = failure({ id: "failure-b", sequence: 5 });
    expect(stateFor([second, first])?.activityId).toBe("failure-b");
    const sameSequenceLaterId = failure({ id: "failure-z", sequence: 6 });
    const sameSequenceEarlierId = failure({ id: "failure-c", sequence: 6 });
    expect(stateFor([sameSequenceLaterId, sameSequenceEarlierId])?.activityId).toBe("failure-z");
  });

  it("expires reset times without mutating the durable state", () => {
    const resetNowSeconds = Date.parse("2026-12-01T00:00:00.000Z") / 1_000;
    const resetActivity = failure({
      payload: {
        data: {
          kind: IMAGE_GENERATION_USAGE_LIMIT_KIND,
          type: "usageLimitExceeded",
          limitId: IMAGE_GENERATION_LIMIT_ID,
          resetsAt: resetNowSeconds,
        },
      },
    });
    expect(stateFor([resetActivity], { nowEpochSeconds: resetNowSeconds - 1 })?.resetsAt).toBe(
      resetNowSeconds,
    );
    expect(stateFor([resetActivity], { nowEpochSeconds: resetNowSeconds })).toBeNull();
  });

  it("dismisses one identity and resurfaces a newer failure", () => {
    const first = stateFor([failure({ id: "failure-first" })]);
    expect(first).not.toBeNull();
    expect(
      stateFor([failure({ id: "failure-first" })], {
        dismissedFailureIdentity: first?.failureIdentity ?? null,
      }),
    ).toBeNull();
    const newer = stateFor(
      [
        failure({ id: "failure-first", createdAt: "2026-12-01T00:01:00.000Z" }),
        failure({ id: "failure-newer", createdAt: "2026-12-01T00:02:00.000Z" }),
      ],
      { dismissedFailureIdentity: first?.failureIdentity ?? null },
    );
    expect(newer?.activityId).toBe("failure-newer");
  });

  it("isolates provider-instance switching", () => {
    const providerBFailure = failure({
      id: "failure-b",
      payload: { providerInstanceId: PROVIDER_B },
    });
    const slices = [{ threadId: THREAD_ID, activities: [failure(), providerBFailure] }];
    expect(
      selectImageGenerationLimitState({ slices, providerInstanceId: PROVIDER_A }),
    ).not.toBeNull();
    expect(
      selectImageGenerationLimitState({ slices, providerInstanceId: PROVIDER_B })?.activityId,
    ).toBe("failure-b");
    expect(selectImageGenerationLimitState({ slices, providerInstanceId: "missing" })).toBeNull();
  });

  it("keeps the store selector reference stable for unrelated streaming activity", () => {
    const image = failure({ id: "failure-stable" });
    const unrelated = makeActivity({ id: "unrelated", kind: "tool.updated", payload: {} });
    const selector = createImageGenerationLimitThreadSelector();
    const state = {
      ...initialState,
      threadIds: [THREAD_ID],
      activityIdsByThreadId: { [THREAD_ID]: [image.id] },
      activityByThreadId: { [THREAD_ID]: { [image.id]: image } },
    };
    const first = selector(state);
    const second = selector({
      ...state,
      activityIdsByThreadId: { [THREAD_ID]: [image.id, unrelated.id] },
      activityByThreadId: { [THREAD_ID]: { [image.id]: image, [unrelated.id]: unrelated } },
    });
    expect(second).toBe(first);
    expect(second[0]?.activities).toEqual([image]);
  });

  it("selects hydrated sibling-thread failures and clears them from a later current-thread success", () => {
    const siblingFailure = failure({
      id: "failure-sibling",
      createdAt: "2026-12-01T00:01:00.000Z",
      turnId: "turn-sibling",
    });
    const currentThread = ThreadId.makeUnsafe("thread-current");
    const selector = createImageGenerationLimitThreadSelector();
    const firstState = {
      ...initialState,
      threadIds: [THREAD_ID, currentThread],
      activityIdsByThreadId: {
        [THREAD_ID]: [siblingFailure.id],
        [currentThread]: [],
      },
      activityByThreadId: {
        [THREAD_ID]: { [siblingFailure.id]: siblingFailure },
        [currentThread]: {},
      },
    };
    const firstSlices = selector(firstState);
    expect(firstSlices).toHaveLength(1);
    expect(
      selectImageGenerationLimitState({
        slices: firstSlices,
        providerInstanceId: PROVIDER_A,
      })?.threadId,
    ).toBe(THREAD_ID);

    const currentThreadSuccess = success({
      id: "success-current",
      createdAt: "2026-12-01T00:02:00.000Z",
      turnId: "turn-current",
    });
    const secondState = {
      ...firstState,
      activityIdsByThreadId: {
        [THREAD_ID]: [siblingFailure.id],
        [currentThread]: [currentThreadSuccess.id],
      },
      activityByThreadId: {
        [THREAD_ID]: { [siblingFailure.id]: siblingFailure },
        [currentThread]: { [currentThreadSuccess.id]: currentThreadSuccess },
      },
    };
    expect(
      selectImageGenerationLimitState({
        slices: selector(secondState),
        providerInstanceId: PROVIDER_A,
      }),
    ).toBeNull();
  });

  it("keeps the global result reference stable when an unrelated sibling activity streams", () => {
    const image = failure({ id: "failure-global-stable" });
    const unrelated = makeActivity({ id: "unrelated-sibling", kind: "tool.updated", payload: {} });
    const sibling = ThreadId.makeUnsafe("thread-sibling-stable");
    const selector = createImageGenerationLimitThreadSelector();
    const state = {
      ...initialState,
      threadIds: [THREAD_ID, sibling],
      activityIdsByThreadId: {
        [THREAD_ID]: [image.id],
        [sibling]: [],
      },
      activityByThreadId: {
        [THREAD_ID]: { [image.id]: image },
        [sibling]: {},
      },
    };
    const first = selector(state);
    const second = selector({
      ...state,
      activityIdsByThreadId: {
        [THREAD_ID]: [image.id],
        [sibling]: [unrelated.id],
      },
      activityByThreadId: {
        [THREAD_ID]: { [image.id]: image },
        [sibling]: { [unrelated.id]: unrelated },
      },
    });
    expect(second).toBe(first);
  });
});

describe("image-generation account, priority, and reset helpers", () => {
  it("normalizes the supported personal plan variants without guessing", () => {
    expect(normalizeImageGenerationPlanName("  Pro   Lite ")).toBe("pro lite");
    expect(normalizeImageGenerationPlanName("Business")).toBe("business");
    expect(
      resolveImageGenerationLimitPresentation({ sourceKind: "personal", planName: "Free" }),
    ).toMatchObject({
      variant: "upgrade-plus",
      action: "personal-usage",
    });
    for (const planName of ["Go", "Plus", "ProLite", "Pro Lite", "Pro 2x", "Pro (2x)", "Pro"]) {
      expect(
        resolveImageGenerationLimitPresentation({ sourceKind: "personal", planName }),
      ).not.toMatchObject({
        variant: "retry",
      });
    }
    expect(
      resolveImageGenerationLimitPresentation({ sourceKind: "personal", planName: "Pro" }),
    ).toMatchObject({
      variant: "add-credits",
    });
    for (const planName of [
      undefined,
      null,
      "Business",
      "Enterprise",
      "API key",
      "Paid",
      "unknown",
    ]) {
      expect(
        resolveImageGenerationLimitPresentation({ sourceKind: "personal", planName }),
      ).toMatchObject({
        variant: "retry",
        action: null,
      });
    }
  });

  it("keeps managed Moss and profile copy/actions inside their source boundary", () => {
    expect(
      resolveImageGenerationAccountSource({ instanceId: "codex_moss", provider: "codex" }),
    ).toBe("moss");
    expect(
      resolveImageGenerationAccountSource({ instanceId: "openrouter_codex", provider: "codex" }),
    ).toBe("personal");
    expect(resolveImageGenerationLimitPresentation({ sourceKind: "moss" })).toMatchObject({
      variant: "managed",
      action: "managed-usage",
    });
    expect(resolveImageGenerationLimitPresentation({ sourceKind: "profile" })).toMatchObject({
      variant: "retry",
      action: null,
    });
  });

  it("prioritizes blocking core/workspace/health, then image, model, warning", () => {
    expect(selectComposerBannerPriority({ hasImageGenerationLimit: true, showWarning: true })).toBe(
      "image",
    );
    expect(
      selectComposerBannerPriority({
        hasImageGenerationLimit: true,
        showWarning: true,
        showProviderHealthLimit: true,
      }),
    ).toBe("blocking");
    expect(selectComposerBannerPriority({ showModelLimit: true, showWarning: true })).toBe("model");
    expect(selectComposerBannerPriority({ showWarning: true })).toBe("warning");
    expect(selectComposerBannerPriority({})).toBeNull();
  });

  it("hides image when Moss quota, hard rate limit, or durable provider health blocks", () => {
    expect(shouldShowImageGenerationLimitBanner({ hasImageGenerationLimit: true })).toBe(true);
    expect(
      shouldShowImageGenerationLimitBanner({
        hasImageGenerationLimit: true,
        showMossQuotaExhausted: true,
      }),
    ).toBe(false);
    expect(
      shouldShowImageGenerationLimitBanner({ hasImageGenerationLimit: true, hardRateLimit: true }),
    ).toBe(false);
    expect(
      shouldShowImageGenerationLimitBanner({
        hasImageGenerationLimit: true,
        providerHealthUnavailable: true,
      }),
    ).toBe(false);
  });

  it("formats same-day reset as time and another day with date and time", () => {
    const nowMs = Date.parse("2026-12-01T08:00:00.000Z");
    const sameDay = formatImageGenerationResetDate(
      Date.parse("2026-12-01T10:30:00.000Z") / 1_000,
      "en-US",
      nowMs,
    );
    const otherDay = formatImageGenerationResetDate(
      Date.parse("2026-12-02T10:30:00.000Z") / 1_000,
      "en-US",
      nowMs,
    );
    expect(sameDay).toBe(
      new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(
        new Date("2026-12-01T10:30:00.000Z"),
      ),
    );
    expect(otherDay).toBe(
      new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date("2026-12-02T10:30:00.000Z"),
      ),
    );
    expect(formatImageGenerationResetDate(-1, "en-US", nowMs)).toBeNull();
  });

  it("builds a stable identity from provider, thread, turn, activity, and completion time", () => {
    expect(
      imageGenerationFailureIdentity({
        providerInstanceId: PROVIDER_A,
        threadId: THREAD_ID,
        turnId: "turn-image",
        activityId: "failure-id",
        completionTimeMs: 123,
      }),
    ).toContain("failure-id");
  });

  it("returns a one-shot reset delay only while a reset is in the future", () => {
    const nowMs = NOW_SECONDS * 1_000;
    expect(getImageGenerationLimitResetDelayMs(NOW_SECONDS + 5, nowMs)).toBe(5_000);
    expect(getImageGenerationLimitResetDelayMs(NOW_SECONDS + 2_147_483_648, nowMs)).toBe(
      2_147_483_647,
    );
    expect(getImageGenerationLimitResetDelayMs(NOW_SECONDS, nowMs)).toBeNull();
    expect(getImageGenerationLimitResetDelayMs(NOW_SECONDS - 5, nowMs)).toBeNull();
    expect(getImageGenerationLimitResetDelayMs(null, nowMs)).toBeNull();
  });
});
