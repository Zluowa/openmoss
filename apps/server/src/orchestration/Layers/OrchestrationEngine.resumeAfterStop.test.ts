import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
} from "@moss/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { INTERRUPTED_TASK_CONTINUATION_PROMPT } from "@moss/shared/turnResume";
import { Effect, Exit, Layer, ManagedRuntime, Scope, ServiceMap, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive as SnapshotQueryBase } from "./ProjectionSnapshotQuery.ts";

// The mobile run (2026-11-13) stopped a Codex turn, waited for the stop to settle,
// and then had "Continue" refused with "already has an active or queued turn" for as
// long as the server ran. These tests drive the real engine and projections through
// each way a turn can start, stop it, and continue.

const SnapshotQueryLive = SnapshotQueryBase.pipe(Layer.provide(ServerSettingsService.layerTest()));
const PROJECT_ID = ProjectId.makeUnsafe("resume-after-stop-project");
const THREAD_ID = ThreadId.makeUnsafe("resume-after-stop-thread");
const BUSY = `Thread '${THREAD_ID}' already has an active or queued turn.`;

async function createSystem() {
  const layer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(SnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "moss-resume-after-stop-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  let clock = Date.parse("2026-11-13T10:36:00.000Z");
  const at = () => new Date((clock += 1_000)).toISOString();
  let commandCount = 0;
  const nextCommandId = (label: string) => CommandId.makeUnsafe(`${label}-${++commandCount}`);

  const dispatch = (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command));
  const refusal = async (command: OrchestrationCommand) => {
    const exit = await runtime.runPromiseExit(engine.dispatch(command));
    if (Exit.isSuccess(exit)) return null;
    return String(exit.cause);
  };
  const eventsFor = async (commandId: CommandId): Promise<ReadonlyArray<OrchestrationEvent>> =>
    Array.from(await runtime.runPromise(Stream.runCollect(engine.readEvents(0)))).filter(
      (event) => event.commandId === commandId,
    );

  await dispatch({
    type: "project.create",
    commandId: nextCommandId("project-create"),
    projectId: PROJECT_ID,
    title: "Resume after stop",
    workspaceRoot: "/tmp/resume-after-stop",
    defaultModelSelection: null,
    createdAt: at(),
  });
  await dispatch({
    type: "thread.create",
    commandId: nextCommandId("thread-create"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Resume after stop",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: at(),
  });

  return {
    sql,
    at,
    dispatch,
    refusal,
    eventsFor,
    send: (messageId: string, dispatchMode: "queue" | "steer" = "queue") => {
      const commandId = nextCommandId("send");
      return dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.makeUnsafe(messageId),
          role: "user",
          text: `person message ${messageId}`,
          attachments: [],
        },
        dispatchMode,
        interactionMode: "default",
        runtimeMode: "full-access",
        createdAt: at(),
      }).then(() => commandId);
    },
    /** What provider runtime ingestion dispatches as the session moves. */
    session: (status: OrchestrationSessionStatus, activeTurnId: string | null) =>
      dispatch({
        type: "thread.session.set",
        commandId: nextCommandId(`session-${status}`),
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
          status,
          providerName: "codex",
          providerInstanceId: "codex" as never,
          runtimeMode: "full-access",
          activeTurnId: activeTurnId === null ? null : TurnId.makeUnsafe(activeTurnId),
          lastError: null,
          updatedAt: at(),
        },
        createdAt: at(),
      }),
    stop: (turnId?: string) =>
      dispatch({
        type: "thread.turn.interrupt",
        commandId: nextCommandId("stop"),
        threadId: THREAD_ID,
        ...(turnId !== undefined ? { turnId: TurnId.makeUnsafe(turnId) } : {}),
        requestedBy: "user",
        createdAt: at(),
      }),
    query: <Row>(statement: Effect.Effect<ReadonlyArray<unknown>, unknown>) =>
      runtime.runPromise(statement) as Promise<ReadonlyArray<Row>>,
    dispatchQueued: (messageId: string) =>
      dispatch({
        type: "thread.turn.dispatch-queued",
        commandId: nextCommandId("dispatch-queued"),
        threadId: THREAD_ID,
        messageId: MessageId.makeUnsafe(messageId),
        dispatchMode: "queue",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: at(),
      }),
    resumeCommand: (turnId: string): OrchestrationCommand => ({
      type: "thread.turn.resume",
      commandId: nextCommandId("resume"),
      threadId: THREAD_ID,
      turnId: TurnId.makeUnsafe(turnId),
      createdAt: at(),
    }),
    /** Starts a second engine over the same database, as a server restart would. */
    restart: async () => {
      const scope = await Effect.runPromise(Scope.make("sequential"));
      const services = await runtime.runPromise(
        Layer.build(
          Layer.fresh(OrchestrationEngineLive.pipe(Layer.provide(SnapshotQueryLive))),
        ).pipe(Scope.provide(scope)),
      );
      return {
        engine: ServiceMap.get(services, OrchestrationEngineService),
        run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
        stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
      };
    },
    dispose: () => runtime.dispose(),
  };
}

type System = Awaited<ReturnType<typeof createSystem>>;

/** The settle sequence the mobile run recorded: interrupted, a reconnect, ready. */
async function settleStoppedTurn(system: System, turnId: string) {
  await system.session("interrupted", null);
  // The Codex runtime reconnects after a stop; the chat is busy until it is ready.
  await system.session("starting", null);
  await expect(system.refusal(system.resumeCommand(turnId))).resolves.toContain(BUSY);
  await system.session("ready", null);
}

async function expectContinued(system: System, turnId: string) {
  const command = system.resumeCommand(turnId);
  await system.dispatch(command);
  const events = await system.eventsFor(command.commandId);
  expect(events.map((event) => event.type)).toEqual([
    "thread.message-sent",
    "thread.turn-start-requested",
  ]);
  expect(events[0]?.payload).toMatchObject({
    role: "user",
    text: INTERRUPTED_TASK_CONTINUATION_PROMPT,
    dispatchOrigin: "user",
  });
  expect(events[1]?.payload).toMatchObject({
    messageId: `resume:${command.commandId}`,
    dispatchMode: "queue",
  });
}

describe("Continue after Stop", () => {
  it("continues a turn started by a plain send", async () => {
    const system = await createSystem();
    try {
      await system.send("plain-message");
      await system.session("running", "turn-plain");
      await system.stop("turn-plain");
      await settleStoppedTurn(system, "turn-plain");
      await expectContinued(system, "turn-plain");
    } finally {
      await system.dispose();
    }
  });

  it("continues a turn started by a queued send once its queue promotion ran", async () => {
    const system = await createSystem();
    try {
      await system.send("first-message");
      await system.session("running", "turn-first");
      const queued = await system.send("queued-message");
      expect((await system.eventsFor(queued)).map((event) => event.type)).toContain(
        "thread.turn-queued",
      );
      await system.session("ready", null);
      await system.dispatchQueued("queued-message");
      await system.session("running", "turn-queued");
      await system.stop("turn-queued");
      await settleStoppedTurn(system, "turn-queued");
      await expectContinued(system, "turn-queued");
    } finally {
      await system.dispose();
    }
  });

  it("continues after a steer rode the live turn", async () => {
    const system = await createSystem();
    try {
      await system.send("steered-turn-message");
      await system.session("running", "turn-steered");
      const steer = await system.send("steer-message", "steer");
      expect((await system.eventsFor(steer)).map((event) => event.type)).toContain(
        "thread.turn-start-requested",
      );
      await system.stop("turn-steered");
      await settleStoppedTurn(system, "turn-steered");
      await expectContinued(system, "turn-steered");
    } finally {
      await system.dispose();
    }
  });

  it("continues a turn whose start was still unconfirmed when Stop arrived", async () => {
    const system = await createSystem();
    try {
      await system.send("uncertain-message");
      // Stop lands while the provider has not acknowledged the start (the mobile run's
      // order: Stop at 10:36:51, the start reported at 10:36:55).
      await system.stop();
      await expect(system.refusal(system.resumeCommand("turn-late"))).resolves.not.toBeNull();
      await system.session("running", "turn-late");
      await settleStoppedTurn(system, "turn-late");
      await expectContinued(system, "turn-late");
    } finally {
      await system.dispose();
    }
  });

  it("continues a chat whose stored person message has no turn id, also after a restart", async () => {
    const system = await createSystem();
    try {
      await system.send("stored-message");
      await system.session("running", "turn-stored");
      await system.stop("turn-stored");
      await settleStoppedTurn(system, "turn-stored");
      // The row looks exactly like the mobile run's database: the message that started
      // the settled turn still has no turn id.
      const rows = await system.query<{ readonly turnId: string | null }>(
        system.sql`
          SELECT turn_id AS "turnId" FROM projection_thread_messages
          WHERE thread_id = ${THREAD_ID} AND message_id = 'stored-message'
        `,
      );
      expect(rows).toEqual([{ turnId: null }]);

      const restarted = await system.restart();
      try {
        const command = system.resumeCommand("turn-stored");
        await restarted.run(restarted.engine.dispatch(command));
        expect((await system.eventsFor(command.commandId)).map((event) => event.type)).toEqual([
          "thread.message-sent",
          "thread.turn-start-requested",
        ]);
      } finally {
        await restarted.stop();
      }
    } finally {
      await system.dispose();
    }
  });

  it("still refuses while a queued follow-up is on its way", async () => {
    const system = await createSystem();
    try {
      await system.send("running-message");
      await system.session("running", "turn-running");
      await system.send("follow-up-message");
      // The turn is still running: nothing to continue yet.
      await expect(system.refusal(system.resumeCommand("turn-running"))).resolves.not.toBeNull();
      // A steer on a provider without native steering, or a goal fence, interrupts the
      // turn but keeps the queued follow-up, which the reactor promotes at once.
      await system.session("interrupted", null);
      await system.dispatchQueued("follow-up-message");
      await expect(system.refusal(system.resumeCommand("turn-running"))).resolves.toContain(BUSY);
      // Once the follow-up runs, the stopped turn is no longer the latest one.
      await system.session("running", "turn-follow-up");
      await expect(system.refusal(system.resumeCommand("turn-running"))).resolves.toContain(
        "is not the latest turn",
      );
    } finally {
      await system.dispose();
    }
  });
});
