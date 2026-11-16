import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationSession,
  type ServerSettings,
} from "@moss/contracts";
import { MOSS_ACCESS_LANES, mossLaneEngineModelIds } from "@moss/shared/mossRealmCatalog";
import { describe, expect, it } from "vitest";

import { COMPOSER_PREDICTION_CONTEXT_BUDGET } from "../git/textGenerationShared.ts";
import {
  buildComposerPredictionConversation,
  isComposerPredictionTurnCurrent,
  lowestSupportedEffort,
  COMPOSER_PREDICTION_DEFAULT_HEDGE_DELAY_MS,
  COMPOSER_PREDICTION_MIN_HEDGE_DELAY_MS,
  resolveComposerPredictionHedgeDelayMs,
  resolveComposerPredictionRouting,
  resolveComposerPredictionTurnBlocker,
  resolveMossManagedPredictionModel,
} from "./composerPrediction.ts";

const TURN = TurnId.makeUnsafe("turn-2");
const FINAL_REPLY = MessageId.makeUnsafe("assistant-final");
const NOW = "2026-11-10T10:00:00.000Z";

function session(overrides: Partial<OrchestrationSession> = {}): OrchestrationSession {
  return {
    threadId: ThreadId.makeUnsafe("thread-1"),
    status: "ready",
    providerName: "claudeAgent",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function settledThread(overrides: Record<string, unknown> = {}) {
  return {
    archivedAt: null,
    latestTurn: {
      turnId: TURN,
      state: "completed" as const,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: FINAL_REPLY,
    },
    session: session(),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

describe("isComposerPredictionTurnCurrent", () => {
  it("accepts the settled latest turn with a final reply", () => {
    expect(isComposerPredictionTurnCurrent(settledThread(), TURN)).toBe(true);
  });

  it.each([
    ["a missing thread", undefined],
    ["an archived thread", settledThread({ archivedAt: NOW })],
    [
      "a newer latest turn",
      settledThread({
        latestTurn: { ...settledThread().latestTurn, turnId: TurnId.makeUnsafe("turn-3") },
      }),
    ],
    [
      "a running turn",
      settledThread({
        latestTurn: { ...settledThread().latestTurn, state: "running", completedAt: null },
      }),
    ],
    [
      "an interrupted turn",
      settledThread({ latestTurn: { ...settledThread().latestTurn, state: "interrupted" } }),
    ],
    [
      "a failed turn",
      settledThread({ latestTurn: { ...settledThread().latestTurn, state: "error" } }),
    ],
    [
      "a turn without a final reply",
      settledThread({ latestTurn: { ...settledThread().latestTurn, assistantMessageId: null } }),
    ],
    ["a running session", settledThread({ session: session({ status: "running" }) })],
    ["a pending approval", settledThread({ hasPendingApprovals: true })],
    ["a pending user-input request", settledThread({ hasPendingUserInput: true })],
  ])("rejects %s", (_label, thread) => {
    expect(isComposerPredictionTurnCurrent(thread as never, TURN)).toBe(false);
  });
});

describe("resolveComposerPredictionTurnBlocker", () => {
  it("finds nothing in the way of the settled latest turn", () => {
    expect(resolveComposerPredictionTurnBlocker(settledThread(), TURN)).toBeNull();
  });

  it.each([
    ["thread-missing", undefined],
    ["thread-archived", settledThread({ archivedAt: NOW })],
    [
      "turn-not-latest",
      settledThread({
        latestTurn: { ...settledThread().latestTurn, turnId: TurnId.makeUnsafe("turn-3") },
      }),
    ],
    [
      "turn-incomplete",
      settledThread({ latestTurn: { ...settledThread().latestTurn, assistantMessageId: null } }),
    ],
    ["session-busy", settledThread({ session: session({ status: "starting" }) })],
    ["pending-approval", settledThread({ hasPendingApprovals: true })],
    ["pending-user-input", settledThread({ hasPendingUserInput: true })],
  ])("names %s", (reason, thread) => {
    expect(resolveComposerPredictionTurnBlocker(thread as never, TURN)).toBe(reason);
  });
});

type Message = Parameters<typeof buildComposerPredictionConversation>[0]["messages"][number];
let messageCounter = 0;
function message(role: Message["role"], text: string, overrides: Partial<Message> = {}): Message {
  messageCounter += 1;
  return {
    id: MessageId.makeUnsafe(`m-${messageCounter}`),
    role,
    text,
    streaming: false,
    ...overrides,
  };
}
const finalReply = (text: string, overrides: Partial<Message> = {}) =>
  message("assistant", text, { id: FINAL_REPLY, ...overrides });

describe("buildComposerPredictionConversation", () => {
  it("reads only visible user and assistant text, one closing reply per exchange", () => {
    const conversation = buildComposerPredictionConversation({
      finalReplyMessageId: FINAL_REPLY,
      messages: [
        message("assistant", "Orphan reply before the window"),
        message("user", "Investigate the red CI run"),
        message("assistant", "Looking at the logs..."),
        message("system", "Session restarted"),
        message("assistant", "The fixture is stale; `parser.test.ts` fails."),
        message("user", "   "),
        message("user", "Why is it stale?"),
        finalReply("It still encodes the old schema."),
      ],
    });

    expect(conversation).toBe(
      [
        "User: Investigate the red CI run",
        "Assistant: The fixture is stale; `parser.test.ts` fails.",
        "User: Why is it stale?",
        "Assistant: It still encodes the old schema.",
      ].join("\n\n"),
    );
  });

  it.each([
    ["the final reply is missing", [message("user", "Hi"), message("assistant", "Hello")]],
    [
      "the final reply is still streaming",
      [message("user", "Hi"), finalReply("Hel", { streaming: true })],
    ],
    ["the final reply is empty", [message("user", "Hi"), finalReply("  ")]],
    [
      "the user already wrote after it",
      [message("user", "Hi"), finalReply("Hello"), message("user", "Next")],
    ],
    ["there is no user request", [finalReply("Hello")]],
  ])("returns null when %s", (_label, messages) => {
    expect(
      buildComposerPredictionConversation({ finalReplyMessageId: FINAL_REPLY, messages }),
    ).toBeNull();
  });

  it("leaves out user-role messages an automation or another agent sent", () => {
    const conversation = buildComposerPredictionConversation({
      finalReplyMessageId: FINAL_REPLY,
      messages: [
        message("user", "Split the README check out to a subagent"),
        message("assistant", "Started a subagent for it."),
        message("user", "Delegated task (Read README) [completed]: the first line is a title.", {
          dispatchOrigin: "agent",
          dispatchSourceThreadId: ThreadId.makeUnsafe("thread-child"),
        }),
        message("user", "Scheduled run: check the build", { dispatchOrigin: "automation" }),
        finalReply("The README starts with the project title; nothing to change."),
      ],
    });

    expect(conversation).toBe(
      [
        "User: Split the README check out to a subagent",
        "Assistant: The README starts with the project title; nothing to change.",
      ].join("\n\n"),
    );
  });

  it("has nothing to predict when no message in the turn came from the person", () => {
    expect(
      buildComposerPredictionConversation({
        finalReplyMessageId: FINAL_REPLY,
        messages: [
          message("user", "Scheduled run: check the build", { dispatchOrigin: "automation" }),
          finalReply("The build is green."),
        ],
      }),
    ).toBeNull();
  });

  it("keeps at most the newest four exchanges", () => {
    const messages = [1, 2, 3, 4, 5].flatMap((index) => [
      message("user", `Request ${index}`),
      index === 5 ? finalReply(`Reply ${index}`) : message("assistant", `Reply ${index}`),
    ]);
    const conversation = buildComposerPredictionConversation({
      finalReplyMessageId: FINAL_REPLY,
      messages,
    });

    expect(conversation).not.toContain("Request 1");
    expect(conversation?.startsWith("User: Request 2")).toBe(true);
    expect(conversation?.endsWith("Assistant: Reply 5")).toBe(true);
  });

  it("drops older exchanges whole before trimming the latest one", () => {
    const longText = "x".repeat(6_000);
    const conversation = buildComposerPredictionConversation({
      finalReplyMessageId: FINAL_REPLY,
      messages: [
        message("user", `Oldest ${longText}`),
        message("assistant", "Oldest reply"),
        message("user", `Older ${longText}`),
        message("assistant", "Older reply"),
        message("user", "Latest request"),
        finalReply("Final reply"),
      ],
    })!;

    expect(conversation).not.toContain("Oldest");
    expect(conversation.startsWith("User: Older")).toBe(true);
    expect(conversation).toContain("User: Latest request\n\nAssistant: Final reply");
    expect(conversation.length).toBeLessThanOrEqual(COMPOSER_PREDICTION_CONTEXT_BUDGET.maxChars);
  });

  it("keeps the end of an oversized final reply and both ends of an oversized request", () => {
    const request = `ASK-START ${"r".repeat(20_000)} ASK-END`;
    const reply = `REPLY-START ${"a".repeat(20_000)} REPLY-END`;
    const conversation = buildComposerPredictionConversation({
      finalReplyMessageId: FINAL_REPLY,
      messages: [
        message("user", "Earlier request"),
        message("assistant", "Earlier reply"),
        message("user", request),
        finalReply(reply),
      ],
    })!;

    expect(conversation.length).toBeLessThanOrEqual(COMPOSER_PREDICTION_CONTEXT_BUDGET.maxChars);
    expect(conversation).not.toContain("Earlier request");
    expect(conversation).toContain("ASK-START");
    expect(conversation).toContain("ASK-END");
    expect(conversation).not.toContain("REPLY-START");
    expect(conversation.endsWith("REPLY-END")).toBe(true);
    expect(conversation.indexOf("Assistant: [...]")).toBeGreaterThan(0);
  });
});

describe("lowestSupportedEffort", () => {
  it.each([
    ["claudeAgent", "claude-opus-4-8", "low"],
    ["codex", "gpt-5.5", "low"],
    ["cursor", "gpt-5.6-sol", "none"],
    ["droid", "claude-opus-4-8", "off"],
    ["claudeAgent", "claude-haiku-4-5", null],
    ["opencode", "openai/gpt-5", null],
  ] as const)("picks the catalog minimum for %s %s", (provider, model, expected) => {
    expect(lowestSupportedEffort(provider, model)).toBe(expected);
  });
});

function settings(overrides: Partial<ServerSettings> = {}): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

const claudeChat = {
  modelSelection: {
    provider: "claudeAgent",
    instanceId: "claudeAgent",
    model: "claude-opus-4-8",
    options: { effort: "max", fastMode: true },
  } as ModelSelection,
  session: session({ providerInstanceId: "claudeAgent" }),
};

describe("resolveComposerPredictionRouting", () => {
  it("uses the Git-writing model when it resolves to the chat's own instance", () => {
    const configured = {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      model: "claude-haiku-4-5",
    } as ModelSelection;
    const routing = resolveComposerPredictionRouting({
      thread: claudeChat,
      settings: settings({ textGenerationModelSelection: configured }),
    });

    expect(routing).toMatchObject({ source: "git-writing-model", modelSelection: configured });
  });

  it("runs the Git-writing model at its lowest effort instead of the Git-writing default", () => {
    const routing = resolveComposerPredictionRouting({
      thread: {
        modelSelection: {
          provider: "codex",
          instanceId: "codex",
          model: "gpt-6-astra",
          options: { reasoningEffort: "high" },
        } as ModelSelection,
        session: session({ providerInstanceId: "codex" }),
      },
      settings: settings({
        textGenerationModelSelection: {
          provider: "codex",
          instanceId: "codex",
          model: "gpt-6-luna",
        } as ModelSelection,
      }),
    });

    expect(routing).toMatchObject({
      source: "git-writing-model",
      modelSelection: { model: "gpt-6-luna", options: { reasoningEffort: "low" } },
    });
  });

  it("lowers the effort when the options travel as a list of selections", () => {
    const routing = resolveComposerPredictionRouting({
      thread: {
        modelSelection: {
          provider: "claudeAgent",
          instanceId: "claudeAgent",
          model: "claude-opus-4-8",
          options: [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        } as unknown as ModelSelection,
        session: session({ providerInstanceId: "claudeAgent" }),
      },
      settings: settings(),
    });

    expect(routing?.modelSelection.options).toEqual([
      { id: "fastMode", value: true },
      { id: "effort", value: "low" },
    ]);
  });

  it("keeps the chat's model at its lowest effort when the Git-writing model is elsewhere", () => {
    const routing = resolveComposerPredictionRouting({ thread: claudeChat, settings: settings() });

    expect(routing).toMatchObject({
      source: "chat-model",
      modelSelection: {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model: "claude-opus-4-8",
        options: { effort: "low", fastMode: true },
      },
    });
  });

  it("does not use a Git-writing model from another account of the same provider", () => {
    const routing = resolveComposerPredictionRouting({
      thread: {
        modelSelection: {
          provider: "codex",
          instanceId: "codex_work",
          model: "gpt-5.5",
        } as ModelSelection,
        session: null,
      },
      settings: settings({
        providerInstances: {
          codex_work: { driver: "codex", enabled: true, config: { homePath: "/tmp/codex-work" } },
        } as ServerSettings["providerInstances"],
      }),
    });

    expect(routing).toMatchObject({
      source: "chat-model",
      modelSelection: {
        instanceId: "codex_work",
        model: "gpt-5.5",
        options: { reasoningEffort: "low" },
      },
      providerOptions: { codex: expect.objectContaining({ homePath: "/tmp/codex-work" }) },
      codexHomePath: "/tmp/codex-work",
    });
  });

  it.each([
    [
      "the chat provider has no dedicated text generation",
      {
        modelSelection: { provider: "grok", instanceId: "grok", model: "grok-4.6" },
        session: null,
      },
      settings(),
    ],
    [
      "the chat's instance is disabled",
      claudeChat,
      settings({
        providerInstances: {
          claudeAgent: { driver: "claudeAgent", enabled: false, config: {} },
        } as ServerSettings["providerInstances"],
      }),
    ],
    [
      "the chat's instance is not registered",
      {
        modelSelection: {
          provider: "claudeAgent",
          instanceId: "claude_gone",
          model: "claude-opus-4-8",
        },
        session: null,
      },
      settings(),
    ],
    [
      "the live session runs on another instance",
      { ...claudeChat, session: session({ providerInstanceId: "claude_other" }) },
      settings(),
    ],
  ])("returns null when %s", (_label, thread, serverSettings) => {
    expect(
      resolveComposerPredictionRouting({
        thread: thread as typeof claudeChat,
        settings: serverSettings,
      }),
    ).toBeNull();
  });
});

describe("resolveComposerPredictionRouting on Moss-managed lanes", () => {
  const managedSettings = settings({
    providerInstances: {
      codex_moss: { driver: "codex", enabled: true, config: {} },
      claude_moss: { driver: "claudeAgent", enabled: true, config: {} },
      opencode_moss: { driver: "opencode", enabled: true, config: {} },
    } as ServerSettings["providerInstances"],
    // A Git-writing model on the same managed instance is still not used: the cheapest
    // model of the chat's vendor is.
    textGenerationModelSelection: {
      provider: "codex",
      instanceId: "codex_moss",
      model: "gpt-5.6-sol",
    } as ModelSelection,
  });
  const route = (selection: Record<string, unknown>) =>
    resolveComposerPredictionRouting({
      thread: { modelSelection: selection as ModelSelection, session: null },
      settings: managedSettings,
    });

  it.each([
    [
      "codex",
      "codex_moss",
      "gpt-5.6-sol",
      { reasoningEffort: "high", fastMode: true },
      "gpt-5.6-luna",
      { reasoningEffort: "low" },
    ],
    [
      "codex",
      "codex_moss",
      "deepseek-v4-pro",
      { reasoningEffort: "max" },
      "deepseek-v4-flash",
      { reasoningEffort: "low" },
    ],
    ["codex", "codex_moss", "glm-5.3", {}, "glm-5.3-flash", { reasoningEffort: "low" }],
    [
      "claudeAgent",
      "claude_moss",
      "claude-opus-5",
      { effort: "max" },
      "claude-haiku-4-5-20251001",
      {},
    ],
    [
      "claudeAgent",
      "claude_moss",
      "deepseek-v4-pro",
      { effort: "high" },
      "deepseek-v4-flash",
      { effort: "low" },
    ],
    [
      "opencode",
      "opencode_moss",
      "moss/deepseek-v4-pro",
      { variant: "high" },
      "moss/deepseek-v4-flash",
      {},
    ],
    ["opencode", "opencode_moss", "moss/kimi-k3", {}, "moss/kimi-k3", {}],
  ] as const)(
    "runs a %s chat on %s with %s as %s",
    (provider, instanceId, model, options, expectedModel, expectedOptions) => {
      const routing = route({ provider, instanceId, model, options });

      expect(routing?.source).toBe("moss-managed-cheapest");
      // Only the effort survives: fast mode and other chat options would cost more.
      expect(routing?.modelSelection).toEqual({
        provider,
        instanceId,
        model: expectedModel,
        options: expectedOptions,
      });
    },
  );

  it("keeps the upstream rule for a person's own account of the same provider", () => {
    const routing = resolveComposerPredictionRouting({
      thread: {
        modelSelection: {
          provider: "codex",
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: { reasoningEffort: "high" },
        } as ModelSelection,
        session: null,
      },
      settings: managedSettings,
    });

    expect(routing).toMatchObject({
      source: "chat-model",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    });
  });

  it("gives Moss lanes without a text-generation path no route", () => {
    for (const [provider, instanceId] of [
      ["pi", "pi_moss"],
      ["grok", "grok_moss"],
      ["hermes", "hermes_moss"],
    ] as const) {
      expect(
        resolveComposerPredictionRouting({
          thread: {
            modelSelection: { provider, instanceId, model: "deepseek-v4-pro" } as ModelSelection,
            session: null,
          },
          settings: settings({
            providerInstances: {
              [instanceId]: { driver: provider, enabled: true, config: {} },
            } as ServerSettings["providerInstances"],
          }),
        }),
      ).toBeNull();
    }
  });

  it("only picks a model every lane serves wherever it serves the chat's model", () => {
    const engines = [
      ["codex_moss", "codex"],
      ["claude_moss", "claude-code"],
      ["opencode_moss", "opencode"],
    ] as const;
    for (const lane of MOSS_ACCESS_LANES) {
      for (const [instanceId, engine] of engines) {
        const served = new Set(mossLaneEngineModelIds(lane, engine));
        for (const chatModel of served) {
          const prefix = engine === "opencode" ? "moss/" : "";
          const predicted = resolveMossManagedPredictionModel({
            instanceId,
            chatModel: `${prefix}${chatModel}`,
          });
          expect(predicted?.slice(prefix.length), `${lane} ${engine} ${chatModel}`).toSatisfy(
            (model: string | undefined) => model !== undefined && served.has(model),
          );
        }
      }
    }
  });

  it("is not used for an instance Moss does not manage", () => {
    expect(
      resolveMossManagedPredictionModel({ instanceId: "codex", chatModel: "gpt-5.6-sol" }),
    ).toBeNull();
    expect(
      resolveMossManagedPredictionModel({ instanceId: "codex_moss", chatModel: "gpt-9-unknown" }),
    ).toBeNull();
  });
});

describe("resolveComposerPredictionHedgeDelayMs", () => {
  const timeoutMs = 20_000;

  it("waits the default delay on a route with no history", () => {
    expect(resolveComposerPredictionHedgeDelayMs({ recentDurationsMs: [], timeoutMs })).toBe(
      COMPOSER_PREDICTION_DEFAULT_HEDGE_DELAY_MS,
    );
  });

  it("never starts sooner than the minimum on a fast route", () => {
    expect(
      resolveComposerPredictionHedgeDelayMs({
        recentDurationsMs: [2_600, 2_400, 2_900],
        timeoutMs,
      }),
    ).toBe(COMPOSER_PREDICTION_MIN_HEDGE_DELAY_MS);
  });

  it("waits twice the usual time and ignores a single outlier", () => {
    expect(
      resolveComposerPredictionHedgeDelayMs({
        recentDurationsMs: [4_000, 17_000, 4_200],
        timeoutMs,
      }),
    ).toBe(8_400);
  });

  it("gives a slow route no second attempt", () => {
    expect(
      resolveComposerPredictionHedgeDelayMs({ recentDurationsMs: [9_000, 11_000], timeoutMs }),
    ).toBeNull();
  });
});
