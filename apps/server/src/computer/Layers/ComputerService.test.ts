import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { ComputerService, type ComputerServiceShape } from "../Services/ComputerService.ts";
import { makeComputerServiceLayer } from "./ComputerService.ts";

/** Builds the service exactly as the server does, then runs `body` against it. */
async function withComputerService(
  backend: FakeComputerBackend,
  body: (service: ComputerServiceShape) => Promise<void>,
): Promise<void> {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ComputerService;
        yield* Effect.promise(() => body(service));
      }).pipe(Effect.provide(makeComputerServiceLayer({ backend }))),
    ),
  );
}

describe("ComputerServiceLive", () => {
  /**
   * The regression this pins is a backend being established by the act of
   * starting the server. Boot decides availability
   * from the passive probe, and seeding a thread's panel — which the web
   * composer does for every ordinary chat — must not upgrade that to the
   * establishing read either.
   */
  it("boots and seeds a thread without ever asking the backend for the desktop", async () => {
    const backend = new FakeComputerBackend();

    await withComputerService(backend, async (service) => {
      expect(service.supported).toBe(true);
      expect(service.availability).toEqual({
        kind: "available",
        backend: "fake",
      });
      expect(backend.calls.map((call) => call.method)).toEqual(["probeAvailability"]);

      const seeded = await service.manager.getThreadState("thread-boot");
      expect(seeded.availability).toEqual({
        kind: "available",
        backend: "fake",
      });
      expect(seeded.windows).toEqual([]);
      expect(backend.calls.map((call) => call.method)).toEqual([
        "probeAvailability",
        "probeAvailability",
      ]);
    });
  });

  /**
   * Supported means the host could ever drive a desktop, not that it can right
   * now. A backend whose boot probe fails — a helper not yet installed, a
   * compositor briefly unreachable — must stay routed through the manager, or
   * the frozen verdict caches "unsupported" in every WS handler and the agent
   * gateway until the server restarts, and the backend's re-probe can never
   * report the desktop coming up.
   */
  it("stays supported when the boot probe merely reports the backend unavailable", async () => {
    const backend = new FakeComputerBackend();
    backend.setAvailability({
      kind: "backend-unavailable",
      message: "The backend is not available yet.",
    });

    await withComputerService(backend, async (service) => {
      expect(service.supported).toBe(true);
      expect(service.availability).toMatchObject({
        kind: "backend-unavailable",
      });
    });
  });

  it("keeps the configured override ahead of both reads", async () => {
    const backend = new FakeComputerBackend();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ComputerService;
          expect(service.supported).toBe(false);
          expect(service.availability).toMatchObject({
            kind: "backend-unavailable",
          });
          // An operator switching the feature off is not a question for the
          // desktop, so neither read runs at all.
          expect(backend.calls).toEqual([]);
        }).pipe(Effect.provide(makeComputerServiceLayer({ backend, supported: false }))),
      ),
    );
  });

  /**
   * Cua supports Windows. When this Windows server has no host endpoint, the
   * desktop's control host did not start, which is this instance's problem and
   * not the platform's. The surface must stay refused (never the fake desktop)
   * and must say "not running", never "unsupported platform".
   */
  it("reports a Windows server without a host as not running, not as unsupported", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ComputerService;
          expect(service.supported).toBe(false);
          expect(service.availability).toEqual({
            kind: "backend-unavailable",
            message: "Moss's computer control is not running yet. Restart Moss, then refresh.",
            reason: "host-not-running",
          });
          const state = yield* Effect.promise(() =>
            service.manager.getThreadState("thread-windows"),
          );
          expect(state.availability.kind).toBe("backend-unavailable");
        }).pipe(Effect.provide(makeComputerServiceLayer({ platform: "win32" }))),
      ),
    );
  });

  it("still reports a platform Cua has no host for as unsupported", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ComputerService;
          expect(service.availability).toEqual({
            kind: "unsupported-platform",
            platform: "freebsd",
          });
        }).pipe(Effect.provide(makeComputerServiceLayer({ platform: "freebsd" }))),
      ),
    );
  });

  /**
   * Off-darwin the gate is endpoint presence, not platform identity: a
   * configured host socket means a real driver host exists to reach, so the
   * surface routes a live backend instead of the unsupported-platform
   * refusal. The probe — not the platform — reports whether it answers.
   */
  it("routes a real backend on Windows when a host endpoint is configured", async () => {
    vi.stubEnv("MOSS_CUA_HOST_SOCKET", "\\\\.\\pipe\\moss-cua-test");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ComputerService;
            expect(service.supported).toBe(true);
            // The endpoint is unreachable from the test host, so the probe
            // reports the backend unavailable — never unsupported-platform.
            expect(service.availability).not.toMatchObject({
              kind: "unsupported-platform",
            });
          }).pipe(Effect.provide(makeComputerServiceLayer({ platform: "win32" }))),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("selects the fake backend only when explicitly requested", async () => {
    vi.stubEnv("MOSS_COMPUTER_BACKEND", "fake");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ComputerService;
            expect(service.supported).toBe(true);
            expect(service.availability).toEqual({
              kind: "available",
              backend: "fake",
            });
          }).pipe(Effect.provide(makeComputerServiceLayer({ platform: "darwin" }))),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
