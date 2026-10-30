#!/usr/bin/env bun
// Official-SDK ACP subprocess used only by the transport conformance suite.

import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { z } from "zod";

const sessionId = "official-sdk-session-1";
const logPath = process.env.MOSS_ACP_CONFORMANCE_LOG_PATH;
const malformedPrefix = process.env.MOSS_ACP_CONFORMANCE_MALFORMED_PREFIX === "1";
const parsedEarlyUpdateCount = Number.parseInt(
  process.env.MOSS_ACP_CONFORMANCE_EARLY_UPDATE_COUNT ?? "1",
  10,
);
const earlyUpdateCount = Math.max(
  0,
  Math.min(10_000, Number.isNaN(parsedEarlyUpdateCount) ? 1 : parsedEarlyUpdateCount),
);
const earlyUpdateTextBytes = Math.max(
  0,
  Math.min(
    7 * 1024 * 1024,
    Number.parseInt(process.env.MOSS_ACP_CONFORMANCE_EARLY_UPDATE_TEXT_BYTES ?? "0", 10) || 0,
  ),
);
const loadReplayUpdateCount = Math.max(
  0,
  Math.min(
    10_000,
    Number.parseInt(process.env.MOSS_ACP_CONFORMANCE_LOAD_REPLAY_UPDATE_COUNT ?? "0", 10) || 0,
  ),
);
const preLoadStateUpdateCount = Math.max(
  0,
  Math.min(
    10_000,
    Number.parseInt(process.env.MOSS_ACP_CONFORMANCE_PRE_LOAD_STATE_UPDATE_COUNT ?? "0", 10) || 0,
  ),
);
const preInitializeStateUpdatesForever =
  process.env.MOSS_ACP_CONFORMANCE_PRE_INITIALIZE_STATE_UPDATES_FOREVER === "1";
const preNewStateUpdateCount = Math.max(
  0,
  Math.min(
    10_000,
    Number.parseInt(process.env.MOSS_ACP_CONFORMANCE_PRE_NEW_STATE_UPDATE_COUNT ?? "0", 10) || 0,
  ),
);
const preNewUpdatesForever = process.env.MOSS_ACP_CONFORMANCE_PRE_NEW_UPDATES_FOREVER === "1";
const postNewUpdatesForever = process.env.MOSS_ACP_CONFORMANCE_POST_NEW_UPDATES_FOREVER === "1";
const prePromptUpdatesForever = process.env.MOSS_ACP_CONFORMANCE_PRE_PROMPT_UPDATES_FOREVER === "1";
const prePromptResponseUpdateCount = Math.max(
  0,
  Math.min(
    10_000,
    Number.parseInt(process.env.MOSS_ACP_CONFORMANCE_PRE_PROMPT_RESPONSE_UPDATE_COUNT ?? "0", 10) ||
      0,
  ),
);
const exitAfterNewResponse = process.env.MOSS_ACP_CONFORMANCE_EXIT_AFTER_NEW_RESPONSE === "1";
const postPromptUpdatesForever =
  process.env.MOSS_ACP_CONFORMANCE_POST_PROMPT_UPDATES_FOREVER === "1";
const emitLoadModeUpdateAfterResponse =
  process.env.MOSS_ACP_CONFORMANCE_LOAD_MODE_UPDATE_AFTER_RESPONSE === "1";
const emitLoadModeAdmissionRace = process.env.MOSS_ACP_CONFORMANCE_LOAD_MODE_ADMISSION_RACE === "1";
const emitLoadModeSetup = emitLoadModeUpdateAfterResponse || emitLoadModeAdmissionRace;
const emitResumeUpdates = process.env.MOSS_ACP_CONFORMANCE_RESUME_UPDATES === "1";
const emitResumeStateUpdates = process.env.MOSS_ACP_CONFORMANCE_RESUME_STATE_UPDATES === "1";
const resumeUpdateCount = Math.max(
  0,
  Math.min(
    10_000,
    Number.parseInt(process.env.MOSS_ACP_CONFORMANCE_RESUME_UPDATE_COUNT ?? "0", 10) || 0,
  ),
);
const resumeUpdateTextBytes = Math.max(
  0,
  Math.min(
    7 * 1024 * 1024,
    Number.parseInt(process.env.MOSS_ACP_CONFORMANCE_RESUME_UPDATE_TEXT_BYTES ?? "0", 10) || 0,
  ),
);
const emitPreResumeModeUpdate = process.env.MOSS_ACP_CONFORMANCE_PRE_RESUME_MODE_UPDATE === "1";
const emitPreResumeConfigUpdate = process.env.MOSS_ACP_CONFORMANCE_PRE_RESUME_CONFIG_UPDATE === "1";
const emitRetryAuthConfigUpdate = process.env.MOSS_ACP_CONFORMANCE_RETRY_AUTH_CONFIG_UPDATE === "1";
const emitStaleResumeSetup =
  emitResumeStateUpdates || emitPreResumeConfigUpdate || emitRetryAuthConfigUpdate;
const failFirstResumeAfterUpdate =
  process.env.MOSS_ACP_CONFORMANCE_FAIL_FIRST_RESUME_AFTER_UPDATE === "1";
const emitDelayedFailedResumeUpdates =
  process.env.MOSS_ACP_CONFORMANCE_DELAYED_FAILED_RESUME_UPDATES === "1";
const failFirstResumeDelayMs = Math.max(
  0,
  Math.min(
    1_000,
    Number.parseInt(process.env.MOSS_ACP_CONFORMANCE_FAIL_FIRST_RESUME_DELAY_MS ?? "0", 10) || 0,
  ),
);

function log(type: string, payload: unknown): void {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ type, payload })}\n`, "utf8");
  }
}

function continueSendingUpdates(
  notify: (text: string) => Promise<void>,
  prefix: string,
  yieldEvery = 64,
  yieldDelayMs = 0,
): void {
  setImmediate(() => {
    void (async () => {
      for (let index = 0; ; index += 1) {
        await notify(`${prefix}-${String(index)}`);
        if ((index + 1) % yieldEvery === 0) {
          await new Promise<void>((resolve) =>
            yieldDelayMs > 0 ? setTimeout(resolve, yieldDelayMs) : setImmediate(resolve),
          );
        }
      }
    })().catch(() => undefined);
  });
}

function continueSendingStateUpdates(
  notify: (sequence: number) => Promise<void>,
  startSequence = 0,
): void {
  setImmediate(() => {
    void (async () => {
      for (let sequence = startSequence; ; sequence += 1) {
        await notify(sequence);
        if ((sequence + 1) % 64 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    })().catch(() => undefined);
  });
}

function availableCommandsUpdate(sequence: number) {
  return {
    sessionId,
    update: {
      sessionUpdate: "available_commands_update" as const,
      availableCommands: [
        {
          name: `state-command-${String(sequence)}`,
          description: "Zero-event conformance state update",
        },
      ],
    },
  };
}

let finishCancelledPrompt: (() => void) | undefined;
const responseBoundaryReleaseWaiters = new Map<string, () => void>();
const responseBoundaryReleased = new Set<string>();

function waitForResponseBoundaryRelease(label: string): Promise<void> {
  if (responseBoundaryReleased.delete(label)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    responseBoundaryReleaseWaiters.set(label, resolve);
  });
}

function releaseResponseBoundary(label: string): void {
  const resolve = responseBoundaryReleaseWaiters.get(label);
  if (resolve) {
    responseBoundaryReleaseWaiters.delete(label);
    resolve();
  } else {
    responseBoundaryReleased.add(label);
  }
}
let authenticateRequestCount = 0;
let resumeRequestCount = 0;

process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));

if (malformedPrefix) {
  process.stdout.write("{not-json}\n");
}

const app = agent({ name: "moss-official-sdk-conformance-agent" })
  .onRequest(methods.agent.initialize, (ctx) => {
    log("initialize", ctx.params);
    if (preInitializeStateUpdatesForever) {
      continueSendingStateUpdates((sequence) =>
        ctx.client.notify(methods.client.session.update, availableCommandsUpdate(sequence)),
      );
      return new Promise<never>(() => undefined);
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: loadReplayUpdateCount > 0 || preLoadStateUpdateCount > 0 || emitLoadModeSetup,
        ...(emitResumeUpdates ||
        emitResumeStateUpdates ||
        emitPreResumeConfigUpdate ||
        emitRetryAuthConfigUpdate ||
        failFirstResumeAfterUpdate ||
        resumeUpdateCount > 0
          ? { sessionCapabilities: { resume: {} } }
          : {}),
      },
      authMethods: [{ id: "test", name: "Test authentication" }],
      agentInfo: { name: "official-sdk-conformance-agent", version: "1.0.0" },
      _meta: {
        primitive: "initialize-meta",
        nested: { source: "official-sdk" },
      },
    };
  })
  .onRequest(methods.agent.authenticate, async (ctx) => {
    authenticateRequestCount += 1;
    log("authenticate", ctx.params);
    if (emitPreResumeModeUpdate && authenticateRequestCount === 1) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "pre-resume-mode",
        },
      });
    }
    if (emitPreResumeConfigUpdate && authenticateRequestCount === 1) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "pre-resume-model",
              name: "Pre-resume model",
              category: "model",
              type: "select",
              currentValue: "pre-resume-new",
              options: [{ value: "pre-resume-new", name: "Pre-resume new" }],
            },
          ],
        },
      });
    }
    if (emitRetryAuthConfigUpdate && authenticateRequestCount === 2) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "retry-resume-model",
              name: "Retry resume model",
              category: "model",
              type: "select",
              currentValue: "retry-resume-new",
              options: [{ value: "retry-resume-new", name: "Retry resume new" }],
            },
          ],
        },
      });
    }
    if (
      (authenticateRequestCount === 1 && (emitPreResumeModeUpdate || emitPreResumeConfigUpdate)) ||
      (authenticateRequestCount === 2 && emitRetryAuthConfigUpdate)
    ) {
      // Keep authenticate in flight long enough for the client's detached
      // notification handlers to commit these events before resume begins.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    return {};
  })
  .onRequest(methods.agent.session.new, async (ctx) => {
    log("session/new", ctx.params);
    for (let sequence = 0; sequence < preNewStateUpdateCount; sequence += 1) {
      await ctx.client.notify(methods.client.session.update, availableCommandsUpdate(sequence));
    }
    const earlyUpdateText = earlyUpdateTextBytes > 0 ? "x".repeat(earlyUpdateTextBytes) : undefined;
    for (let index = 0; index < earlyUpdateCount; index += 1) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: earlyUpdateText ?? (index === 0 ? "early-new" : `early-new-${String(index)}`),
          },
        },
      });
    }
    if (preNewUpdatesForever) {
      continueSendingUpdates(
        (text) =>
          ctx.client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          }),
        "pre-new",
      );
      await new Promise<never>(() => undefined);
    }
    if (postNewUpdatesForever) {
      continueSendingUpdates(
        (text) =>
          ctx.client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          }),
        "post-new",
      );
    }
    if (exitAfterNewResponse) {
      setImmediate(() => process.exit(17));
    }
    return {
      sessionId,
      modes: {
        currentModeId: "code",
        availableModes: [
          { id: "code", name: "Code" },
          { id: "review", name: "Review" },
        ],
      },
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "code",
          options: [
            { value: "code", name: "Code" },
            { value: "review", name: "Review" },
          ],
        },
      ],
      _meta: {
        primitive: 7,
        nested: { phase: "new" },
      },
    };
  })
  .onRequest(methods.agent.session.load, async (ctx) => {
    log("session/load", ctx.params);
    for (let sequence = 0; sequence < preLoadStateUpdateCount; sequence += 1) {
      await ctx.client.notify(methods.client.session.update, availableCommandsUpdate(sequence));
    }
    for (let index = 0; index < loadReplayUpdateCount; index += 1) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: `load-replay-${String(index)}` },
        },
      });
    }
    if (emitLoadModeUpdateAfterResponse) {
      setTimeout(() => {
        void ctx.client
          .notify(methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: " load-mode-after ",
            },
          })
          .then(() => log("session/load/post-response-mode-update", ctx.params))
          .catch(() => undefined);
      }, 100);
    }
    if (emitLoadModeAdmissionRace) {
      setTimeout(() => {
        void (async () => {
          for (const currentModeId of ["load-mode-before", "load-mode-after"]) {
            await ctx.client.notify(methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: {
                sessionUpdate: "current_mode_update",
                currentModeId,
              },
            });
          }
          await ctx.client.notify("conformance/load-mode-updates-admitted", {});
          log("session/load/mode-admission-race-ready", ctx.params);
        })().catch(() => undefined);
      }, 100);
    }
    return emitLoadModeSetup
      ? {
          modes: {
            currentModeId: "load-mode-before",
            availableModes: [
              {
                id: "load-mode-before",
                name: "Load mode before",
                description: "Mode returned by session/load",
              },
              {
                id: "load-mode-after",
                name: "Load mode after",
                description: "Mode announced after session/load",
              },
            ],
          },
        }
      : {};
  })
  .onRequest(methods.agent.session.resume, async (ctx) => {
    resumeRequestCount += 1;
    log("session/resume", ctx.params);
    if (failFirstResumeAfterUpdate && resumeRequestCount === 1) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "failed-resume-mode",
        },
      });
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "failed-resume-command", description: "Must not survive a failed resume" },
          ],
        },
      });
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "failed-resume-config",
              name: "Failed resume config",
              category: "model_config",
              type: "boolean",
              currentValue: true,
            },
          ],
        },
      });
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "failed-resume-stale" },
        },
      });
      if (failFirstResumeDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, failFirstResumeDelayMs));
      }
      if (emitDelayedFailedResumeUpdates) {
        setImmediate(() => {
          void (async () => {
            await ctx.client.notify(methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [
                  {
                    name: "delayed-failed-resume-command",
                    description: "Must never cross the failed resume generation",
                  },
                ],
              },
            });
            await ctx.client.notify(methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: {
                sessionUpdate: "config_option_update",
                configOptions: [
                  {
                    id: "delayed-failed-resume-config",
                    name: "Delayed failed resume config",
                    category: "model_config",
                    type: "boolean",
                    currentValue: true,
                  },
                ],
              },
            });
            log("session/resume/delayed-failed-updates", ctx.params);
          })().catch(() => undefined);
        });
      }
      throw new Error("Conformance resume failure after an early update");
    }
    for (let index = 0; index < resumeUpdateCount; index += 1) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              resumeUpdateTextBytes > 0
                ? "x".repeat(resumeUpdateTextBytes)
                : `resume-burst-${String(index)}`,
          },
        },
      });
    }
    if (emitResumeUpdates) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "resume-mode",
        },
      });
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "resume-during" },
        },
      });
      if (emitResumeStateUpdates) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: [
              {
                id: "resume-model",
                name: "Resume model",
                category: "model",
                type: "select",
                currentValue: "resume-new",
                options: [{ value: "resume-new", name: "Resume new" }],
              },
            ],
          },
        });
      }
      setImmediate(() => {
        void ctx.client
          .notify(methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "resume-after" },
            },
          })
          .then(() => log("session/resume/post-response-update", ctx.params))
          .catch(() => undefined);
      });
    }
    return {
      modes: {
        currentModeId: emitStaleResumeSetup ? "stale-response-mode" : "resume-mode",
        availableModes: [
          ...(emitStaleResumeSetup
            ? [
                {
                  id: "stale-response-mode",
                  name: "Stale response mode",
                  description: "Deliberately older than the live resume notification",
                },
              ]
            : []),
          ...(emitPreResumeModeUpdate
            ? [
                {
                  id: "pre-resume-mode",
                  name: "Pre-resume mode",
                  description: "Mode announced before the resume request",
                },
              ]
            : []),
          {
            id: "resume-mode",
            name: "Resume mode",
            description: "Mode advertised while resuming the conformance session",
          },
        ],
      },
      ...(emitStaleResumeSetup
        ? {
            configOptions: [
              {
                id: "stale-response-model",
                name: "Stale response model",
                category: "model" as const,
                type: "select" as const,
                currentValue: "resume-old",
                options: [{ value: "resume-old", name: "Resume old" }],
              },
            ],
          }
        : {}),
    };
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    log("session/prompt", ctx.params);
    const shouldWaitForCancel =
      ctx.params.prompt[0]?.type === "text" && ctx.params.prompt[0].text === "wait-for-cancel";

    if (shouldWaitForCancel) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "cancel-ready" },
        },
      });
      await new Promise<void>((resolve) => {
        finishCancelledPrompt = resolve;
      });
      return { stopReason: "cancelled" };
    }

    for (const text of ["prompt-one", "prompt-two"]) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    }
    // A prompt response is the causal end of its turn. Put the overflow burst
    // before that response so the client can deterministically attribute it to
    // this request; updates first written after the response cannot
    // retroactively change an already completed prompt.
    for (let index = 0; index < prePromptResponseUpdateCount; index += 1) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `pre-prompt-response-${String(index)}` },
        },
      });
    }
    if (prePromptUpdatesForever) {
      continueSendingUpdates(
        (text) =>
          ctx.client.notify(methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          }),
        "pre-prompt",
      );
      await new Promise<never>(() => undefined);
    }
    if (postPromptUpdatesForever) {
      continueSendingUpdates(
        (text) =>
          ctx.client.notify(methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          }),
        "post-prompt",
      );
    }
    return { stopReason: "end_turn" };
  })
  .onNotification(methods.agent.session.cancel, (ctx) => {
    log("session/cancel", ctx.params);
    finishCancelledPrompt?.();
    finishCancelledPrompt = undefined;
  })
  .onRequest("conformance/echo", z.unknown(), (ctx) => {
    log("conformance/echo", ctx.params);
    return {
      echo: ctx.params,
      _meta: {
        primitive: true,
        nested: { source: "official-sdk" },
      },
    };
  })
  .onRequest(
    "conformance/response-boundary",
    z.object({ label: z.enum(["first", "second"]) }),
    async (ctx) => {
      log("conformance/response-boundary", ctx.params);
      await ctx.client.notify("conformance/response-boundary-entered", {
        label: ctx.params.label,
      });
      await waitForResponseBoundaryRelease(ctx.params.label);
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `response-boundary-${ctx.params.label}`,
          },
        },
      });
      return { label: ctx.params.label };
    },
  )
  .onNotification(
    "conformance/release-response-boundary",
    z.object({ label: z.enum(["first", "second"]) }),
    (ctx) => {
      log("conformance/release-response-boundary", ctx.params);
      releaseResponseBoundary(ctx.params.label);
    },
  )
  .onNotification("conformance/notice", z.unknown(), (ctx) => {
    log("conformance/notice", ctx.params);
  })
  .onNotification(
    "conformance/send-update-burst",
    z.object({ prefix: z.string().min(1), count: z.number().int().positive().max(1_024) }),
    async (ctx) => {
      log("conformance/send-update-burst", ctx.params);
      for (let index = 0; index < ctx.params.count; index += 1) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `${ctx.params.prefix}-${String(index)}` },
          },
        });
      }
    },
  )
  .onNotification(
    "conformance/start-update-flood",
    z.object({ prefix: z.string().min(1) }),
    (ctx) => {
      log("conformance/start-update-flood", ctx.params);
      continueSendingUpdates(
        (text) =>
          ctx.client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          }),
        ctx.params.prefix,
      );
    },
  )
  .onNotification(
    "conformance/start-state-update-flood",
    z.object({ startSequence: z.number().int().nonnegative().optional() }),
    (ctx) => {
      log("conformance/start-state-update-flood", ctx.params);
      continueSendingStateUpdates(
        (sequence) =>
          ctx.client.notify(methods.client.session.update, availableCommandsUpdate(sequence)),
        ctx.params.startSequence,
      );
    },
  )
  .onNotification(
    "conformance/start-resume-post-response-burst",
    z.object({ count: z.number().int().positive().max(10_000) }),
    (ctx) => {
      log("conformance/start-resume-post-response-burst", ctx.params);
      void (async () => {
        await ctx.client.notify("conformance/resume-post-response-burst-started", {});
        for (let index = 0; index < ctx.params.count; index += 1) {
          await ctx.client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `resume-post-response-${String(index)}` },
            },
          });
        }
        await ctx.client.notify("conformance/resume-post-response-burst-complete", {});
        log("conformance/resume-post-response-burst-complete", ctx.params);
      })().catch(() => undefined);
    },
  )
  .onNotification("conformance/start-resume-post-response-flood", z.unknown(), (ctx) => {
    log("conformance/start-resume-post-response-flood", ctx.params);
    void (async () => {
      for (let index = 0; index < 512; index += 1) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `resume-post-response-seed-${String(index)}` },
          },
        });
      }
      // This bounded prefix lets the client prove the resume boundary before live overflow.
      // The test arms the existing conformance/start-update-flood notification afterward.
      await ctx.client.notify("conformance/resume-post-response-flood-started", {});
    })().catch(() => undefined);
  })
  .onRequest("conformance/wait-for-generic-cancel", z.unknown(), async (ctx) => {
    log("conformance/wait-for-generic-cancel", ctx.params);
    await ctx.client.notify("conformance/generic-cancel-ready", {});
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) {
        resolve();
        return;
      }
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    log("conformance/generic-cancel-observed", null);
    await ctx.client.notify("conformance/generic-cancel-observed", {});
    return { cancelled: true };
  })
  .onRequest("conformance/exit", z.unknown(), () => {
    log("conformance/exit", null);
    process.exit(17);
  });

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const connection = app.connect(ndJsonStream(output, input));

void connection.closed.then(() => process.exit(0));
