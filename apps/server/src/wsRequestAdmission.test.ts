import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@moss/contracts";
import { Deferred, Effect, Fiber, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { classifyWsRequest } from "@moss/shared/wsRequestClass";

import { makeWsRequestAdmission, WS_REQUEST_REJECTION_LOG_INTERVAL_MS } from "./wsRequestAdmission";

describe("WsRequestAdmission", () => {
  // Ported from upstream #2119.
  it("logs what holds a saturated class, at most once per client and class per interval", async () => {
    const logs: Array<{ readonly level: string; readonly message: unknown }> = [];
    const logger = Logger.make(({ logLevel, message }) => logs.push({ level: logLevel, message }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = yield* makeWsRequestAdmission;
        yield* admission.acquire(1, ORCHESTRATION_WS_METHODS.getSnapshot);
        yield* TestClock.adjust("1500 millis");
        yield* admission.acquire(1, WS_METHODS.statsGetProfileStats);
        yield* TestClock.adjust("500 millis");
        for (let attempt = 0; attempt < 3; attempt += 1) {
          yield* admission.acquire(1, WS_METHODS.gitStatus).pipe(Effect.exit);
        }

        expect(logs).toEqual([
          {
            level: "Warn",
            message: [
              "WebSocket request rejected: class capacity in use",
              {
                clientId: 1,
                method: WS_METHODS.gitStatus,
                requestClass: "expensive-read",
                limit: 2,
                heldBy: [
                  { method: ORCHESTRATION_WS_METHODS.getSnapshot, heldForMs: 2000 },
                  { method: WS_METHODS.statsGetProfileStats, heldForMs: 500 },
                ],
                suppressedSinceLastLog: 0,
              },
            ],
          },
        ]);

        // Another client's lane is its own and is reported on its own.
        yield* admission.acquire(2, ORCHESTRATION_WS_METHODS.getSnapshot);
        yield* admission.acquire(2, ORCHESTRATION_WS_METHODS.getSnapshot);
        yield* admission.acquire(2, WS_METHODS.gitStatus).pipe(Effect.exit);
        expect(logs).toHaveLength(2);

        // After the interval the next rejection logs again with the skipped count.
        yield* TestClock.adjust(WS_REQUEST_REJECTION_LOG_INTERVAL_MS);
        yield* admission.acquire(1, WS_METHODS.gitStatus).pipe(Effect.exit);
        expect(logs).toHaveLength(3);
        expect(logs[2]?.message).toEqual([
          "WebSocket request rejected: class capacity in use",
          expect.objectContaining({ clientId: 1, suppressedSinceLastLog: 2 }),
        ]);
        expect((yield* admission.snapshot).rejectedTotal).toBe(5);
      }).pipe(
        Effect.provide(
          Layer.merge(Logger.layer([logger], { mergeWithExisting: false }), TestClock.layer()),
        ),
        Effect.scoped,
      ),
    );
  });

  it("gives the import panel's scan its own lane beside an expensive-read flood", async () => {
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.listProjectImports)).toBe("import-scan");
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = yield* makeWsRequestAdmission;
        // Start-up fills the expensive lane with snapshot and provider discovery reads.
        yield* admission.acquire(1, ORCHESTRATION_WS_METHODS.getSnapshot);
        yield* admission.acquire(1, WS_METHODS.providerListModels);
        const blocked = yield* Effect.flip(
          admission.acquire(1, ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot),
        );
        expect(blocked.code).toBe("RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED");
        // The scan still starts at once.
        const scan = yield* admission.acquire(1, ORCHESTRATION_WS_METHODS.listProjectImports);
        expect(scan.requestClass).toBe("import-scan");
      }),
    );
  });

  it("keeps lightweight shell reads out of the expensive lane", () => {
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.getShellSnapshot)).toBe("standard");
    expect(classifyWsRequest(WS_METHODS.providerGetCatalogSnapshot)).toBe("standard");
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot)).toBe(
      "expensive-read",
    );
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.getTurnDiff)).toBe("expensive-read");
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.repairState)).toBe("expensive-read");
    expect(classifyWsRequest(WS_METHODS.serverPrewarmVoice)).toBe("interactive-read");
    expect(classifyWsRequest(WS_METHODS.terminalAckOutput)).toBe("control");
    expect(classifyWsRequest(WS_METHODS.serverGetRuntimeStatus)).toBe("control");
  });

  it("reserves bounded interactive reads for plugin and voice UX during discovery floods", async () => {
    expect(classifyWsRequest(WS_METHODS.providerListPlugins)).toBe("interactive-read");
    expect(classifyWsRequest(WS_METHODS.providerReadPlugin)).toBe("interactive-read");
    expect(classifyWsRequest(WS_METHODS.serverPrewarmVoice)).toBe("interactive-read");

    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = yield* makeWsRequestAdmission;
        const firstDiscovery = yield* admission.acquire(1, WS_METHODS.providerListModels);
        const secondDiscovery = yield* admission.acquire(1, WS_METHODS.providerListAgents);

        const pluginCatalog = yield* admission.acquire(1, WS_METHODS.providerListPlugins);
        const pluginDetail = yield* admission.acquire(1, WS_METHODS.providerReadPlugin);
        const voicePrewarm = yield* admission.acquire(1, WS_METHODS.serverPrewarmVoice);
        const skillsCatalog = yield* admission.acquire(1, WS_METHODS.providerListSkills);
        const voiceTranscription = yield* admission.acquire(1, WS_METHODS.serverTranscribeVoice);
        const installableSkills = yield* admission.acquire(1, WS_METHODS.providerListSkillsCatalog);
        const overflow = yield* admission
          .acquire(1, WS_METHODS.providerListPlugins)
          .pipe(Effect.exit);

        expect(pluginCatalog.requestClass).toBe("interactive-read");
        expect(pluginDetail.requestClass).toBe("interactive-read");
        expect(voicePrewarm.requestClass).toBe("interactive-read");
        expect(skillsCatalog.requestClass).toBe("interactive-read");
        expect(voiceTranscription.requestClass).toBe("interactive-read");
        expect(installableSkills.requestClass).toBe("interactive-read");
        expect(overflow._tag).toBe("Failure");
        if (overflow._tag === "Failure") {
          expect(String(overflow.cause)).toContain("RPC_INTERACTIVE_READ_CAPACITY_EXCEEDED");
        }

        yield* admission.release(firstDiscovery);
        yield* admission.release(secondDiscovery);
        yield* admission.release(pluginCatalog);
        yield* admission.release(pluginDetail);
        yield* admission.release(voicePrewarm);
        yield* admission.release(skillsCatalog);
        yield* admission.release(voiceTranscription);
        yield* admission.release(installableSkills);
        expect(yield* admission.snapshot).toMatchObject({ active: 0 });
      }),
    );
  });

  it("reserves independent capacity for control traffic during an expensive-read flood", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = yield* makeWsRequestAdmission;
        const first = yield* admission.acquire(1, ORCHESTRATION_WS_METHODS.getSnapshot);
        const second = yield* admission.acquire(1, WS_METHODS.statsGetProfileStats);
        const rejected = yield* admission
          .acquire(1, WS_METHODS.gitReadWorkingTreeDiff)
          .pipe(Effect.exit);

        expect(rejected._tag).toBe("Failure");
        if (rejected._tag === "Failure") {
          expect(String(rejected.cause)).toContain("RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED");
        }

        const control = yield* admission.acquire(1, WS_METHODS.terminalAckOutput);
        expect(control.requestClass).toBe("control");
        yield* admission.release(first);
        yield* admission.release(first);
        yield* admission.release(second);
        yield* admission.release(control);
        expect(yield* admission.snapshot).toMatchObject({
          active: 0,
          admittedTotal: 3,
          releasedTotal: 3,
          rejectedTotal: 1,
        });
      }),
    );
  });

  it("keeps client budgets independent and releases failed work exactly once", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = yield* makeWsRequestAdmission;
        const clientOne = yield* admission.acquire(1, ORCHESTRATION_WS_METHODS.getSnapshot);
        const clientTwo = yield* admission.acquire(2, ORCHESTRATION_WS_METHODS.getSnapshot);

        const failed = yield* admission
          .guard(1, WS_METHODS.gitStatus, Effect.fail("expected"))
          .pipe(Effect.exit);
        expect(failed._tag).toBe("Failure");

        yield* admission.release(clientOne);
        yield* admission.release(clientTwo);
        expect(yield* admission.snapshot).toMatchObject({
          clients: 0,
          active: 0,
          admittedTotal: 3,
          releasedTotal: 3,
        });
      }),
    );
  });

  it("releases an interrupted request lease exactly once", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = yield* makeWsRequestAdmission;
        const started = yield* Deferred.make<void>();
        const fiber = yield* admission
          .guard(
            1,
            ORCHESTRATION_WS_METHODS.getSnapshot,
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild);

        yield* Deferred.await(started);
        expect(yield* admission.snapshot).toMatchObject({ active: 1, releasedTotal: 0 });
        yield* Fiber.interrupt(fiber);
        expect(yield* admission.snapshot).toMatchObject({
          active: 0,
          admittedTotal: 1,
          releasedTotal: 1,
        });
      }),
    );
  });
});
