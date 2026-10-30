import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { CurrentWsSessionRole } from "./wsConnectionSessions.ts";
import { ownerOnlyWsRpcHandler, ownerRoleRequired } from "./wsRpc.ts";

function runAsRole<A>(role: "owner" | "client", effect: Effect.Effect<A, unknown, never>) {
  return Effect.runPromise(effect.pipe(Effect.provideService(CurrentWsSessionRole, role)));
}

describe("WebSocket owner-only RPC authorization", () => {
  it("allows an owner session without requiring loopback or a private URL", async () => {
    await expect(runAsRole("owner", ownerRoleRequired)).resolves.toBeUndefined();
  });

  it("rejects a paired client session with the typed owner error", async () => {
    await expect(runAsRole("client", ownerRoleRequired)).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
      retryable: false,
    });
  });

  it("does not construct or invoke a host mutation before authorization", async () => {
    let calls = 0;
    const handler = ownerOnlyWsRpcHandler(() => {
      calls += 1;
      return Effect.succeed("mutated");
    });

    await expect(
      runAsRole("client", handler({ operation: "install-plugin" }, {})),
    ).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
    });
    expect(calls).toBe(0);
  });

  it("executes the guarded host mutation for an owner session", async () => {
    let calls = 0;
    const handler = ownerOnlyWsRpcHandler((input) => {
      calls += 1;
      return Effect.succeed({ input, changed: true });
    });

    await expect(
      runAsRole("owner", handler({ operation: "set-app-enabled" }, { publicConnection: true })),
    ).resolves.toEqual({
      input: { operation: "set-app-enabled" },
      changed: true,
    });
    expect(calls).toBe(1);
  });
});
