import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { WS_METHODS } from "@moss/contracts";
import { makeMossCloudAccountRpcHandlers, makeMossEnterpriseKeyRpcHandlers } from "../wsRpc";
import { MossCloudAccountServiceError } from "../account/mossCloudAccountErrors";

describe("Apps reconciliation through the existing account RPCs", () => {
  it("refreshes after select, token refresh and logout, but not a failed login", async () => {
    const changed = vi.fn(() => Effect.void);
    const handlers = makeMossCloudAccountRpcHandlers(
      {
        selectAccount: () => Effect.succeed({}),
        refresh: () => Effect.succeed({}),
        logout: () => Effect.succeed({}),
        signIn: () =>
          Effect.fail(
            new MossCloudAccountServiceError({
              code: "invalid_credentials",
              message: "fake rejected login",
            }),
          ),
      } as never,
      changed,
    );
    await Effect.runPromise(
      handlers[WS_METHODS.serverMossCloudAccountSelect]({ accountId: "a" as never }),
    );
    await Effect.runPromise(handlers[WS_METHODS.serverMossCloudAccountRefresh]());
    await Effect.runPromise(handlers[WS_METHODS.serverMossCloudAccountLogout]());
    expect(changed).toHaveBeenCalledTimes(3);
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.serverMossCloudAccountSignIn]({
          email: "fake@example.test",
          password: "fake",
        }),
      ),
    ).rejects.toThrow();
    expect(changed).toHaveBeenCalledTimes(3);
  });
  it("refreshes after enterprise sign-in, activation and sign-out", async () => {
    const changed = vi.fn(() => Effect.void);
    const handlers = makeMossEnterpriseKeyRpcHandlers(
      {
        signIn: () => Effect.succeed({}),
        activate: () => Effect.succeed({}),
        signOut: () => Effect.succeed({}),
      } as never,
      changed,
    );
    await Effect.runPromise(
      handlers[WS_METHODS.serverMossEnterpriseKeySignIn]({ apiKey: `moss_sk_${"t".repeat(43)}` }),
    );
    await Effect.runPromise(handlers[WS_METHODS.serverMossEnterpriseKeyActivate]());
    await Effect.runPromise(handlers[WS_METHODS.serverMossEnterpriseKeySignOut]());
    expect(changed).toHaveBeenCalledTimes(3);
  });
});
