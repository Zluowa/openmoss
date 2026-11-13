import path from "node:path";
import { Effect, Layer, Option, ServiceMap } from "effect";
import { ServerConfig } from "../config";
import { ProjectAgentService } from "../projectAgent/Services/ProjectAgentService";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { MossbotRoomError } from "@moss/shared/mossbotRoom";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments";
import { makeRoomAttachmentStore } from "./attachments";
import { MossbotRoomRuntime } from "./runtime";

export class MossbotRooms extends ServiceMap.Service<MossbotRooms, MossbotRoomRuntime>()(
  "moss/MossbotRooms",
) {}
export const MossbotRoomsLive = Layer.effect(
  MossbotRooms,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projectAgent = yield* ProjectAgentService;
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const managedAttachments = yield* ManagedAttachmentRepository;
    const runtime = new MossbotRoomRuntime({
      directory: path.join(config.stateDir, "mossbot-rooms"),
      attachments: makeRoomAttachmentStore({
        repository: managedAttachments,
        attachmentsDir: config.attachmentsDir,
      }),
      dispatch: (command) => Effect.runPromise(engine.dispatch(command)),
      // The client-linked read: each user message carries the turn it started, so a room job
      // can follow exactly its own turn in the member thread.
      thread: (id) =>
        Effect.runPromise(
          snapshots
            .getThreadDetailSnapshotById(id)
            .pipe(Effect.map((snapshot) => Option.getOrNull(snapshot)?.thread ?? null)),
        ),
      projectKind: (id) =>
        Effect.runPromise(
          snapshots
            .getProjectShellById(id)
            .pipe(Effect.map((shell) => Option.getOrNull(shell)?.kind ?? null)),
        ),
      loadMember: (id) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const overview = yield* projectAgent.getOverview({ projectId: id }, { kind: "user" });
            const c = overview.config;
            if (!c || c.agentKind !== "mossbot" || c.archivedAt || c.pausedAt)
              throw new Error("Choose an available Mossbot assistant.");
            const packet = yield* projectAgent.buildContextPacket(id, c.coordinatorThreadId);
            return {
              name: c.coordinatorName,
              icon: c.coordinatorIcon ?? null,
              color: c.coordinatorColor ?? null,
              modelSelection: c.coordinatorModelSelection,
              instructions: packet.instructions.slice(0, 12_000),
            };
          }),
        ).catch(() => {
          throw new MossbotRoomError(
            "assistant_unavailable",
            "Choose an available Mossbot assistant.",
          );
        }),
    });
    yield* Effect.acquireRelease(
      Effect.tryPromise(() => runtime.start()),
      () => Effect.promise(() => runtime.stop()),
    );
    return runtime;
  }),
);
