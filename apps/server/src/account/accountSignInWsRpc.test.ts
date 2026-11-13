// FILE: accountSignInWsRpc.test.ts
// Purpose: Only the local owner, in the Moss window on this computer, can see waiting phones
//   and allow or refuse them; account changes reach account sign-in first.
// Layer: account (server) tests
// Exports: none
import { ACCOUNT_SIGN_IN_WS_METHODS, AuthSessionId } from "@moss/contracts";
import { accountDeviceSubject } from "@moss/shared/ownerDeviceSession";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { AuthenticatedSession } from "../auth/Services/ServerAuth";
import {
  CurrentWsAuthenticatedSession,
  CurrentWsLocalAccess,
  CurrentWsSessionRole,
  type WsSessionRole,
} from "../wsConnectionSessions";
import {
  guardCloudAccountChanges,
  guardPhoneAccountChanges,
  makeAccountSignInWsRpcHandlers,
} from "./accountSignInWsRpc";
import {
  MossAccountPhoneAccessRefused,
  type MossAccountPhoneAccessShape,
} from "./Services/MossAccountPhoneAccess";
import type { MossCloudAccountServiceShape } from "./Services/MossCloudAccountService";
import type { MossPhoneAccountServiceShape } from "./Services/MossPhoneAccountService";

const config = {
  mode: "desktop" as const,
  host: "0.0.0.0",
  publicUrl: undefined,
  desktopPhoneAccess: true,
};

function fakeAccess() {
  const decided = new Set<string>();
  const calls: string[] = [];
  const decide = (operation: string) => (requestId: string) =>
    Effect.suspend(() => {
      calls.push(`${operation}:${requestId}`);
      if (requestId === "expired" || decided.has(requestId)) {
        return Effect.fail(
          new MossAccountPhoneAccessRefused({
            reason: "request_expired",
            status: 410,
            message: "This request is no longer waiting. Try again from the phone.",
          }),
        );
      }
      decided.add(requestId);
      return Effect.void;
    });
  const access = {
    pendingRequests: Stream.make({ requests: [] }),
    approve: decide("approve"),
    deny: decide("deny"),
    beforeSignOut: (realm: string) => Effect.sync(() => void calls.push(`beforeSignOut:${realm}`)),
    aroundAccountChange: <A, E, R>(realm: string, action: Effect.Effect<A, E, R>) =>
      Effect.sync(() => void calls.push(`around:${realm}`)).pipe(Effect.andThen(action)),
  } as unknown as MossAccountPhoneAccessShape;
  return { access, calls };
}

const session = (subject: string): AuthenticatedSession => ({
  sessionId: AuthSessionId.makeUnsafe(`session-${subject}`),
  subject,
  method: "bearer-session-token",
  role: "owner",
});

const as = <A, E>(
  caller: {
    readonly role: WsSessionRole;
    readonly local: boolean | null;
    readonly session?: AuthenticatedSession;
  },
  effect: Effect.Effect<A, E>,
) =>
  effect.pipe(
    Effect.provideService(CurrentWsSessionRole, caller.role),
    Effect.provideService(CurrentWsLocalAccess, caller.local),
    Effect.provideService(CurrentWsAuthenticatedSession, caller.session ?? null),
  );

const outcome = <A, E extends { readonly code?: string | undefined }>(
  effect: Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.as("ok"),
      Effect.catch((error) => Effect.succeed(error.code ?? "failed")),
    ),
  );

describe("account sign-in decisions", () => {
  const localOwner = { role: "owner" as const, local: true };

  it("refuses a remote owner, a client, and every kind of phone session", async () => {
    const { access, calls } = fakeAccess();
    const handlers = makeAccountSignInWsRpcHandlers(access, config);
    const approve = handlers[ACCOUNT_SIGN_IN_WS_METHODS.approve];
    const callers = [
      { role: "owner" as const, local: false },
      { role: "client" as const, local: true },
      { role: "owner" as const, local: true, session: session("owner-device") },
      {
        role: "owner" as const,
        local: true,
        session: session(accountDeviceSubject("memfire-phone", "key-a")),
      },
    ];
    for (const caller of callers) {
      expect(await outcome(as(caller, approve({ requestId: "r1" })))).toBe("AUTH_FORBIDDEN");
      expect(
        await outcome(as(caller, handlers[ACCOUNT_SIGN_IN_WS_METHODS.deny]({ requestId: "r1" }))),
      ).toBe("AUTH_FORBIDDEN");
      expect(
        await outcome(
          as(caller, Stream.runDrain(handlers[ACCOUNT_SIGN_IN_WS_METHODS.subscribe]())),
        ),
      ).toBe("AUTH_FORBIDDEN");
    }
    // None of them reached the decision.
    expect(calls).toEqual([]);
  });

  it("lets the local owner decide once, and refuses an expired request", async () => {
    const { access, calls } = fakeAccess();
    const handlers = makeAccountSignInWsRpcHandlers(access, config);
    const approve = handlers[ACCOUNT_SIGN_IN_WS_METHODS.approve];
    expect(await outcome(as(localOwner, approve({ requestId: "r1" })))).toBe("ok");
    expect(await outcome(as(localOwner, approve({ requestId: "r1" })))).toBe("request_expired");
    expect(
      await outcome(as(localOwner, handlers[ACCOUNT_SIGN_IN_WS_METHODS.deny]({ requestId: "r1" }))),
    ).toBe("request_expired");
    expect(await outcome(as(localOwner, approve({ requestId: "expired" })))).toBe(
      "request_expired",
    );
    expect(
      await outcome(
        as(localOwner, Stream.runDrain(handlers[ACCOUNT_SIGN_IN_WS_METHODS.subscribe]())),
      ),
    ).toBe("ok");
    expect(calls).toEqual(["approve:r1", "approve:r1", "deny:r1", "approve:expired"]);
  });

  it("says account sign-in is unavailable where the server has none", async () => {
    const handlers = makeAccountSignInWsRpcHandlers(undefined, config);
    expect(
      await outcome(
        as(localOwner, handlers[ACCOUNT_SIGN_IN_WS_METHODS.approve]({ requestId: "r" })),
      ),
    ).toBe("confirmation_unavailable");
  });
});

describe("account changes pass through account sign-in first", () => {
  it("runs the sign-out hook before signing out, and wraps account switches", async () => {
    const { access, calls } = fakeAccess();
    const record = (name: string) => () =>
      Effect.sync(() => {
        calls.push(name);
        return {} as never;
      });
    const phone = guardPhoneAccountChanges(
      {
        logout: record("phone.logout"),
        verifyPhoneLogin: record("phone.verify"),
      } as unknown as MossPhoneAccountServiceShape,
      access,
    );
    const cloud = guardCloudAccountChanges(
      {
        logout: record("cloud.logout"),
        selectAccount: record("cloud.select"),
        signIn: record("cloud.signIn"),
      } as unknown as MossCloudAccountServiceShape,
      access,
    );
    await Effect.runPromise(phone.logout());
    await Effect.runPromise(phone.verifyPhoneLogin({} as never));
    await Effect.runPromise(cloud.logout());
    await Effect.runPromise(cloud.selectAccount({} as never));
    await Effect.runPromise(cloud.signIn({} as never));
    expect(calls).toEqual([
      "beforeSignOut:memfire-phone",
      "phone.logout",
      "around:memfire-phone",
      "phone.verify",
      "beforeSignOut:supabase-google",
      "cloud.logout",
      "around:supabase-google",
      "cloud.select",
      "around:supabase-google",
      "cloud.signIn",
    ]);
  });
});
