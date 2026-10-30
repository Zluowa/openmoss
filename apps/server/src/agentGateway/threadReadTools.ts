import {
  MOSS_GATEWAY_MAX_THREADS_PER_OPERATION,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect, Option } from "effect";

import {
  isOrdinaryProjectRow,
  type SpaceAssignmentWorkspacePaths,
} from "../orchestration/commandInvariants.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import { MOSS_HARNESS_POLICY_VERSION } from "./harnessPolicy.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import {
  AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
  agentGatewayTargetOptionGuidance,
  loadAgentGatewayProviderCatalog,
  type AgentGatewayProviderInstances,
} from "./targetResolver.ts";
import {
  deriveAgentThreadStatus,
  READ_THREAD_MAX_MESSAGE_CHARS,
  READ_THREAD_MAX_MESSAGE_LIMIT,
  summarizeThreadDetail,
  summarizeThreadShell,
  summarizeWaitThreadText,
  WAIT_THREAD_SUMMARY_MAX_CHARS,
} from "./threadSummary.ts";
import {
  decodeWaitForThreadsInput,
  errorText,
  PROVIDER_KINDS,
  readBooleanArg,
  readIsoTimestampArg,
  readNumberArg,
  readStringArg,
  ToolInputError,
} from "./toolInput.ts";
import {
  gatewayToolErrorResult,
  GatewayToolError,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";
import type { AgentGatewayCapability } from "./Services/AgentGatewaySessionRegistry.ts";

const LIST_THREADS_DEFAULT_LIMIT = 50;
const LIST_THREADS_MAX_LIMIT = 200;

export interface ThreadReadToolsInput {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly projectionTurns: ProjectionTurnRepositoryShape;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly loadProviderInstances: Effect.Effect<AgentGatewayProviderInstances, unknown, never>;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown, never>;
  readonly workspacePaths: SpaceAssignmentWorkspacePaths;
}

export function buildMossContextCapabilities(
  capabilities: ReadonlySet<AgentGatewayCapability>,
  turnId: string | null,
) {
  return {
    threadRead: capabilities.has("thread:read"),
    threadCreate: turnId !== null && capabilities.has("thread:write"),
    threadWait: capabilities.has("thread:read"),
    diagnostics: capabilities.has("diagnostics:read"),
    automations: turnId !== null && capabilities.has("automation:write"),
    computerHistory: {
      status: capabilities.has("history:status"),
      query: capabilities.has("history:query"),
      readOnly: true,
      notImplicitlyInjected: true,
    },
  };
}

export function makeThreadReadTools(input: ThreadReadToolsInput): ReadonlyArray<ToolEntry> {
  const {
    snapshotQuery,
    projectionTurns,
    providerDiscovery,
    loadProviderInstances,
    requireThreadShell,
    workspacePaths,
  } = input;

  const contextTool: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "moss_context",
      description:
        "Inspect the current Moss harness identity, caller thread/turn, and authorized coordination capabilities.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        title: "Moss context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (_args, context) =>
      Effect.gen(function* () {
        const caller = yield* requireThreadShell(context.callerThreadId);
        const turnId = caller.latestTurn?.state === "running" ? caller.latestTurn.turnId : null;
        return mcpToolResultJson({
          harness: { name: "Moss", policyVersion: MOSS_HARNESS_POLICY_VERSION },
          caller: {
            threadId: caller.id,
            turnId,
            provider: context.callerProvider,
            projectId: caller.projectId,
          },
          capabilities: buildMossContextCapabilities(context.callerCapabilities, turnId),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const capabilitiesTool: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "moss_capabilities",
      description: `List canonical Moss provider/model targets, exact provider option keys, examples, and gateway limits used to validate thread creation. ${AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION}`,
      inputSchema: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: PROVIDER_KINDS,
            description:
              "Optional canonical provider driver filter. Use it when the requested child provider is already known so unrelated model catalogs do not consume the parent context.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Moss capabilities",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const providerFilter = readStringArg(args, "provider");
        if (
          providerFilter !== undefined &&
          !PROVIDER_KINDS.some((provider) => provider === providerFilter)
        ) {
          return yield* Effect.fail(
            new ToolInputError(`Argument "provider" must be one of: ${PROVIDER_KINDS.join(", ")}.`),
          );
        }
        const caller = yield* requireThreadShell(context.callerThreadId);
        const project = yield* snapshotQuery.getProjectShellById(caller.projectId).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new ToolInputError(`Project "${caller.projectId}" was not found.`)),
              onSome: Effect.succeed,
            }),
          ),
        );
        const instances = yield* loadProviderInstances;
        // Provider discovery is independently bounded per adapter. Run the
        // probes concurrently so several slow or degraded CLIs cannot add
        // their timeouts together and make the MCP client time out before the
        // capability receipt is returned.
        const providers = yield* Effect.forEach(
          [...instances.values()].filter(
            (instance) => providerFilter === undefined || instance.provider === providerFilter,
          ),
          (instance) =>
            loadAgentGatewayProviderCatalog({
              instanceId: instance.instanceId,
              provider: instance.provider,
              discovery: providerDiscovery,
              availability: instance,
              cwd: project.workspaceRoot,
            }),
          { concurrency: "unbounded" },
        );
        const targetConstruction = Object.fromEntries(
          providers.map((provider) => [
            provider.instanceId,
            {
              modelValueSource: "providers[].models[].slug",
              ...agentGatewayTargetOptionGuidance(provider),
            },
          ]),
        );
        return mcpToolResultJson({
          targetConstruction,
          providers,
          limits: {
            maxThreadsPerOperation: MOSS_GATEWAY_MAX_THREADS_PER_OPERATION,
            maxWaitMs: 60_000,
            oneCreationPlanPerActiveTurn: true,
          },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const listProjects: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "moss_list_projects",
      description:
        "List Moss projects (id, title, workspace root). System-managed containers (the Chats and Studio surfaces) are not projects and are excluded. Use before creating a thread in another project.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List Moss projects", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: () =>
      snapshotQuery.getShellSnapshot().pipe(
        Effect.map((snapshot) =>
          mcpToolResultJson({
            projects: snapshot.projects
              .filter((project) =>
                isOrdinaryProjectRow({
                  projectKind: project.kind,
                  projectTitle: project.title,
                  projectWorkspaceRoot: project.workspaceRoot,
                  workspacePaths,
                }),
              )
              .map((project) => ({
                projectId: project.id,
                title: project.title,
                workspaceRoot: project.workspaceRoot,
                isPinned: project.isPinned,
              })),
          }),
        ),
        Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
      ),
  };

  const listThreads: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "moss_list_threads",
      description:
        "Discover Moss threads by project, hierarchy, provider, model, status, title, creation source, or update window. Archived threads are hidden unless includeArchived is true.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Only threads of this project." },
          parentThreadId: {
            type: "string",
            description: "Only child threads of this thread (e.g. your own thread id).",
          },
          provider: { type: "string", enum: [...PROVIDER_KINDS] },
          model: { type: "string", description: "Exact model slug." },
          status: {
            type: "string",
            description:
              "Derived thread status such as working, idle, error, or waiting-for-approval.",
          },
          titleContains: { type: "string", description: "Case-insensitive title substring." },
          creationSource: { type: "string", description: "Exact thread creation source." },
          updatedAfter: { type: "string", description: "ISO timestamp lower bound (inclusive)." },
          updatedBefore: { type: "string", description: "ISO timestamp upper bound (inclusive)." },
          includeArchived: { type: "boolean", description: "Include archived threads." },
          limit: { type: "number", description: "Max results (default 50, max 200)." },
        },
        additionalProperties: false,
      },
      annotations: { title: "List Moss threads", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const projectId = readStringArg(args, "projectId");
        const parentThreadId = readStringArg(args, "parentThreadId");
        const provider = readStringArg(args, "provider");
        const model = readStringArg(args, "model");
        const status = readStringArg(args, "status");
        const titleContains = readStringArg(args, "titleContains")?.toLocaleLowerCase();
        const creationSource = readStringArg(args, "creationSource");
        const updatedAfter = readIsoTimestampArg(args, "updatedAfter");
        const updatedBefore = readIsoTimestampArg(args, "updatedBefore");
        const includeArchived = readBooleanArg(args, "includeArchived") ?? false;
        const limit = Math.max(
          1,
          Math.min(
            readNumberArg(args, "limit") ?? LIST_THREADS_DEFAULT_LIMIT,
            LIST_THREADS_MAX_LIMIT,
          ),
        );
        const snapshot = yield* snapshotQuery
          .getShellSnapshot()
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        const instances = yield* loadProviderInstances;
        const providerForThread = (thread: OrchestrationThreadShell): string =>
          // ModelSelection.provider is authoritative under the current contract;
          // the session name is only a fallback for legacy rows.
          (thread.modelSelection.instanceId !== undefined
            ? instances.get(thread.modelSelection.instanceId)?.provider
            : undefined) ??
          thread.session?.providerName ??
          thread.modelSelection.provider;
        const matching = snapshot.threads
          .filter((thread) => (projectId ? thread.projectId === projectId : true))
          .filter((thread) => (parentThreadId ? thread.parentThreadId === parentThreadId : true))
          .filter((thread) => (provider ? providerForThread(thread) === provider : true))
          .filter((thread) => (model ? thread.modelSelection.model === model : true))
          .filter((thread) => (status ? deriveAgentThreadStatus(thread) === status : true))
          .filter((thread) =>
            titleContains ? thread.title.toLocaleLowerCase().includes(titleContains) : true,
          )
          .filter((thread) =>
            creationSource ? (thread.creationSource ?? null) === creationSource : true,
          )
          .filter((thread) => (updatedAfter ? thread.updatedAt >= updatedAfter : true))
          .filter((thread) => (updatedBefore ? thread.updatedAt <= updatedBefore : true))
          .filter((thread) => (includeArchived ? true : (thread.archivedAt ?? null) === null))
          .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        const threads = matching
          .slice(0, limit)
          .map((thread) =>
            summarizeThreadShell(thread, context.callerThreadId, providerForThread(thread)),
          );
        return mcpToolResultJson({ threads, totalMatching: matching.length });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const readThread: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "moss_read_thread",
      description:
        "Read one Moss thread's status and recent messages (newest last). Pass nextCursor as cursor to page older messages. To read one settled long message losslessly, pass the summary's index, messageId, and messageVersion with messageOffsetChars 0, then follow messagePage.nextOffsetChars with the same identity and version.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to read." },
          cursor: { type: "string", description: "Pagination cursor from a previous call." },
          messageLimit: {
            type: "integer",
            minimum: 1,
            maximum: READ_THREAD_MAX_MESSAGE_LIMIT,
            description: `Messages per transcript page (default 20, max ${READ_THREAD_MAX_MESSAGE_LIMIT}).`,
          },
          maxMessageChars: {
            type: "integer",
            minimum: 50,
            maximum: READ_THREAD_MAX_MESSAGE_CHARS,
            description: `Characters per message or single-message slice (default 1500, max ${READ_THREAD_MAX_MESSAGE_CHARS}). The response reports the effective value.`,
          },
          messageIndex: {
            type: "integer",
            minimum: 0,
            description:
              "Current transcript index of one message to read losslessly; messageId and messageVersion detect stale coordinates.",
          },
          messageOffsetChars: {
            type: "integer",
            minimum: 0,
            description:
              "Character offset within messageIndex (default 0); follow messagePage.nextOffsetChars until absent.",
          },
          messageId: {
            type: "string",
            description:
              "Message identity returned in each message summary; required with messageIndex.",
          },
          messageVersion: {
            type: "string",
            description:
              "Opaque version returned in each message summary; required with messageIndex so slices stay bound to one snapshot.",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Read a Moss thread", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const cursor = readStringArg(args, "cursor");
        const messageLimit = readNumberArg(args, "messageLimit");
        const maxMessageChars = readNumberArg(args, "maxMessageChars");
        const messageIndex = readNumberArg(args, "messageIndex");
        const messageOffsetChars = readNumberArg(args, "messageOffsetChars");
        const messageId = readStringArg(args, "messageId");
        const messageVersion = readStringArg(args, "messageVersion");
        const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.makeUnsafe(threadId)).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`)),
              onSome: (thread) => Effect.succeed(thread),
            }),
          ),
        );
        const instances = yield* loadProviderInstances;
        return mcpToolResultJson(
          summarizeThreadDetail({
            thread: detail,
            provider:
              (detail.modelSelection.instanceId !== undefined
                ? instances.get(detail.modelSelection.instanceId)?.provider
                : undefined) ??
              detail.session?.providerName ??
              detail.modelSelection.provider,
            cursor,
            messageLimit,
            maxMessageChars,
            messageIndex,
            messageOffsetChars,
            messageId,
            messageVersion,
          }),
        );
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const waitForThreads: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "moss_wait_for_threads",
      description: `Wait for the pinned turns of 1–20 Moss threads and return every outcome in input order. Returns promptly when a thread needs approval or user input; surface that thread to the user instead of polling. Assistant summaries are capped at ${WAIT_THREAD_SUMMARY_MAX_CHARS} characters; use each result's readThread call to page the full transcript. Timeouts only report progress; they never retry, replace, cancel, or create work.`,
      inputSchema: {
        type: "object",
        properties: {
          threadIds: {
            type: "array",
            minItems: 1,
            maxItems: MOSS_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: { type: "string" },
          },
          runIds: {
            type: "array",
            maxItems: MOSS_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: { type: ["string", "null"] },
            description: "Optional pinned turn ids from a prior wait. Must match threadIds length.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 0,
            maximum: 60_000,
            description: "Long-poll duration; defaults to 30000ms.",
          },
        },
        required: ["threadIds"],
        additionalProperties: false,
      },
      annotations: {
        title: "Wait for Moss threads",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const waitInput = decodeWaitForThreadsInput(args);
        if (waitInput.runIds && waitInput.runIds.length !== waitInput.threadIds.length) {
          throw new ToolInputError('Argument "runIds" must have the same length as "threadIds".');
        }
        const timeoutMs = waitInput.timeoutMs ?? 30_000;
        const deadline = Date.now() + timeoutMs;
        const pinned = yield* Effect.forEach(waitInput.threadIds, (threadId, index) =>
          snapshotQuery.getThreadShellById(threadId).pipe(
            Effect.mapError((error) => new ToolInputError(errorText(error))),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new GatewayToolError("thread_not_found", `Thread "${threadId}" was not found.`),
                  ),
                onSome: (thread) => {
                  const runId = waitInput.runIds?.[index] ?? thread.latestTurn?.turnId ?? null;
                  return Effect.succeed({
                    threadId,
                    runId,
                    shell: thread,
                    awaitingGatewayTurn:
                      runId === null &&
                      thread.gatewayOperationId != null &&
                      thread.settledAt == null,
                  });
                },
              }),
            ),
          ),
        );

        const initialStateByKey = new Map(
          pinned.map((pin) => {
            const shell = pin.shell;
            return [
              `${pin.threadId}\u0000${pin.runId ?? ""}`,
              shell.latestTurn?.turnId === pin.runId ? shell.latestTurn.state : "pending",
            ] as const;
          }),
        );
        const refreshUnresolvedGatewayTurns = () =>
          Effect.forEach(
            pinned,
            (pin) => {
              if (!pin.awaitingGatewayTurn || pin.runId !== null) return Effect.void;
              return snapshotQuery.getThreadShellById(pin.threadId).pipe(
                Effect.mapError((error) => new ToolInputError(errorText(error))),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        new GatewayToolError(
                          "thread_not_found",
                          `Thread "${pin.threadId}" was not found.`,
                        ),
                      ),
                    onSome: (shell) =>
                      Effect.sync(() => {
                        pin.shell = shell;
                        const latestTurn = shell.latestTurn;
                        if (latestTurn) {
                          pin.runId = latestTurn.turnId;
                          pin.awaitingGatewayTurn = false;
                          initialStateByKey.set(
                            `${pin.threadId}\u0000${latestTurn.turnId}`,
                            latestTurn.state,
                          );
                          return;
                        }
                        pin.awaitingGatewayTurn =
                          shell.gatewayOperationId != null && shell.settledAt == null;
                      }),
                  }),
                ),
              );
            },
            { discard: true, concurrency: "unbounded" },
          );

        const readPinnedStates = () =>
          refreshUnresolvedGatewayTurns().pipe(
            Effect.andThen(
              projectionTurns
                .getManyWaitSnapshot({
                  threadIds: pinned.map((pin) => ThreadId.makeUnsafe(pin.threadId)),
                  turns: pinned.flatMap((pin) =>
                    pin.runId === null
                      ? []
                      : [{ threadId: pin.threadId, turnId: TurnId.makeUnsafe(pin.runId) }],
                  ),
                })
                .pipe(
                  Effect.mapError((error) => new ToolInputError(errorText(error))),
                  Effect.flatMap((snapshot) => {
                    const existingThreadIds = new Set(snapshot.existingThreadIds);
                    const missing = pinned.find((pin) => !existingThreadIds.has(pin.threadId));
                    if (missing) {
                      return Effect.fail(
                        new GatewayToolError(
                          "thread_not_found",
                          `Thread "${missing.threadId}" was not found.`,
                        ),
                      );
                    }
                    const turnsByKey = new Map(
                      snapshot.turns.map(
                        (turn) => [`${turn.threadId}\u0000${turn.turnId}`, turn] as const,
                      ),
                    );
                    return Effect.succeed(
                      pinned.map((pin) => {
                        const turn =
                          pin.runId === null
                            ? undefined
                            : turnsByKey.get(`${pin.threadId}\u0000${pin.runId}`);
                        const state =
                          pin.runId === null
                            ? pin.awaitingGatewayTurn
                              ? ("pending" as const)
                              : ("idle" as const)
                            : (turn?.state ??
                              initialStateByKey.get(`${pin.threadId}\u0000${pin.runId}`) ??
                              "pending");
                        const terminal =
                          state === "idle" ||
                          state === "completed" ||
                          state === "error" ||
                          state === "interrupted";
                        const blockedReason = terminal
                          ? null
                          : (turn?.pendingApprovalCount ?? 0) > 0
                            ? ("waiting-for-approval" as const)
                            : (turn?.pendingUserInputCount ?? 0) > 0
                              ? ("waiting-for-user-input" as const)
                              : null;
                        return {
                          threadId: pin.threadId,
                          runId: pin.runId,
                          state,
                          terminal,
                          blockedReason,
                          timedOut: false,
                          summary: null as string | null,
                          summaryTruncated: false,
                          error: null as string | null,
                          readThread: {
                            tool: "moss_read_thread" as const,
                            arguments: { threadId: pin.threadId },
                          },
                        };
                      }),
                    );
                  }),
                ),
            ),
          );

        let results = yield* readPinnedStates();
        let pollDelayMs = 200;
        while (
          results.some((result) => !result.terminal) &&
          !results.some((result) => result.blockedReason !== null) &&
          Date.now() < deadline
        ) {
          yield* Effect.sleep(Math.min(pollDelayMs, Math.max(1, deadline - Date.now())));
          results = yield* readPinnedStates();
          pollDelayMs = Math.min(1_000, Math.ceil(pollDelayMs * 1.5));
        }
        const blocked = results.some((result) => result.blockedReason !== null);
        const timedOut = !blocked && results.some((result) => !result.terminal);
        const finalResults = yield* Effect.forEach(results, (result) =>
          Effect.gen(function* () {
            if (!result.terminal || result.runId === null) {
              return { ...result, timedOut: !result.terminal && timedOut };
            }
            const detail = yield* snapshotQuery.getThreadDetailById(result.threadId).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new GatewayToolError(
                        "thread_not_found",
                        `Thread "${result.threadId}" was not found.`,
                      ),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            );
            const assistantMessage = detail.messages.findLast(
              (message) => message.role === "assistant" && message.turnId === result.runId,
            );
            const summary = summarizeWaitThreadText(assistantMessage?.text);
            return {
              ...result,
              timedOut: false,
              summary: summary.summary,
              summaryTruncated: summary.truncated,
              error:
                result.state === "error" ? (detail.session?.lastError ?? "Turn failed.") : null,
            };
          }),
        );
        return mcpToolResultJson({
          callerThreadId: context.callerThreadId,
          runIds: pinned.map((pin) => pin.runId),
          allTerminal: finalResults.every((result) => result.terminal),
          blocked,
          timedOut,
          threads: finalResults,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            error instanceof GatewayToolError
              ? gatewayToolErrorResult(error)
              : mcpToolResultError(errorText(error)),
          ),
        ),
      ),
  };

  return [contextTool, capabilitiesTool, listProjects, listThreads, readThread, waitForThreads];
}
