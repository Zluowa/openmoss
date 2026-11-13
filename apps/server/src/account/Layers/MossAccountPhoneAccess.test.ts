// FILE: MossAccountPhoneAccess.test.ts
// Purpose: Account sign-in for phones and the computer list, against a stand-in account
//   service: nothing is granted without the person at the computer, nothing is published
//   unless phone access is on, and the phones an account let in leave with that account.
// Layer: account (server) tests
// Exports: none
import * as Crypto from "node:crypto";

import type { AuthAccountRealm } from "@moss/contracts";
import {
  MOSS_COMPUTERS_METADATA_KEY,
  MOSS_PHONE_LOGIN_METADATA_KEY,
  mossPhoneLoginProof,
  readMossAccountComputers,
} from "@moss/shared/mossAccountComputers";
import {
  mossAccountCheckCode,
  openMossAccountSession,
  x25519PublicKeyOf,
} from "@moss/shared/mossAccountSealedDelivery";
import { DateTime, Effect, Logger, Option, Schedule, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { SupabaseMossAuthUser } from "../supabaseMossAuth";
import {
  MOSS_ACCOUNT_SIGN_IN_LIMITS,
  accountSignInAvailability,
  makeMossAccountPhoneAccess,
  mossComputerName,
  mossComputerOrigins,
  parseListingRecords,
  startMossAccountComputerRegistry,
  type MossAccountListingRecord,
  type MossAccountPhoneAccessLane,
} from "./MossAccountPhoneAccess";
import { accountKeyOf } from "../accountSignInGuards";

// Obviously fake values; the log test checks none of them ever reaches a log line.
const jwtFor = (subject: string) =>
  [
    "fake-header",
    Buffer.from(JSON.stringify({ sub: subject, secret: "fake-token-body" }), "utf8").toString(
      "base64url",
    ),
    "fake-signature",
  ].join(".");
const subjectOf = (accessToken: string) =>
  (
    JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString("utf8")) as {
      sub: string;
    }
  ).sub;

/** A stand-in account service: one metadata record per account, addressed by token. */
function makeAccountService() {
  const metadata = new Map<string, Record<string, unknown>>();
  const calls = { getUser: 0, updateUserMetadata: 0 };
  const failure: { next: Error | null } = { next: null };
  const user = (subject: string): SupabaseMossAuthUser => ({
    id: subject,
    email: null,
    phone: "+8613800138000",
    role: "authenticated",
    audience: "authenticated",
    emailConfirmedAt: null,
    phoneConfirmedAt: "2026-07-14T00:00:00.000Z",
    lastSignInAt: null,
    createdAt: null,
    updatedAt: null,
    appMetadata: { provider: "phone", providers: ["phone"] },
    userMetadata: { ...metadata.get(subject) },
  });
  const failIfAsked = () => {
    if (failure.next) throw failure.next;
  };
  return {
    calls,
    metadata,
    failure,
    client: {
      getUser: async (accessToken: string) => {
        calls.getUser += 1;
        failIfAsked();
        return user(subjectOf(accessToken));
      },
      updateUserMetadata: async (accessToken: string, data: Readonly<Record<string, unknown>>) => {
        calls.updateUserMetadata += 1;
        failIfAsked();
        const subject = subjectOf(accessToken);
        const next: Record<string, unknown> = { ...metadata.get(subject) };
        for (const [key, value] of Object.entries(data)) {
          if (value === null) delete next[key];
          else next[key] = value;
        }
        metadata.set(subject, next);
        return user(subject);
      },
    },
  };
}

type Availability = ReturnType<typeof accountSignInAvailability>;

async function setup(
  options: {
    readonly signedInAs?: string | null;
    readonly availability?: Availability;
    readonly records?: ReadonlyArray<MossAccountListingRecord>;
  } = {},
) {
  const service = makeAccountService();
  const clock = { now: Date.UTC(2026, 10, 11, 8, 0, 0) };
  const state = {
    token: options.signedInAs === null ? null : jwtFor(options.signedInAs ?? "user-a"),
    origins: ["http://192.168.1.20:3773"] as ReadonlyArray<string>,
    availability: options.availability ?? (null as Availability),
    records: [...(options.records ?? [])] as MossAccountListingRecord[],
    /** What the local account store says; undefined: the lane does not say. */
    stored: undefined as string | null | undefined,
  };
  const issued: Array<{ realm: string; accountKey: string; label?: string }> = [];
  const revoked: Array<{ realm: string; accountKey?: string }> = [];
  const lanes: MossAccountPhoneAccessLane[] = [
    {
      realm: "memfire-phone",
      client: service.client,
      accessToken: Effect.sync(() => state.token),
      storedAccountId: Effect.sync(() => state.stored),
    },
    { realm: "supabase-google", client: null, accessToken: Effect.succeed(null) },
  ];
  let ids = 0;
  const access = await Effect.runPromise(
    makeMossAccountPhoneAccess({
      lanes,
      now: () => clock.now,
      randomCode: () => `fake-challenge-code-${(ids += 1)}`,
      randomId: () => `id-${(ids += 1)}`,
      self: () => ({
        id: "mac-1",
        name: "Studio Mac",
        platform: "darwin",
        origins: state.origins,
        version: "1.0.5",
      }),
      availability: () => state.availability,
      auth: {
        issueAccountDeviceBearerSession: (input) =>
          Effect.sync(() => {
            issued.push({
              realm: input.realm,
              accountKey: input.accountKey,
              ...(input.client.label ? { label: input.client.label } : {}),
            });
            return {
              authenticated: true as const,
              role: "owner" as const,
              sessionMethod: "bearer-session-token" as const,
              expiresAt: DateTime.makeUnsafe(clock.now + 86_400_000),
              sessionToken: `fake-session-token-${issued.length}`,
            };
          }),
        revokeAccountDeviceSessions: (scope) =>
          Effect.sync(() => {
            revoked.push({ ...scope });
            return 1;
          }),
      },
      listings: {
        read: Effect.sync(() => [...state.records]),
        write: (records) =>
          Effect.sync(() => {
            state.records = [...records];
          }),
      },
    }),
  );

  /** A phone with a fresh key pair, signed in at the account service as `subject`. */
  const makePhone = (subject: string) => {
    const privateKey = new Uint8Array(Crypto.randomBytes(32));
    const publicKey = x25519PublicKeyOf(privateKey);
    return {
      privateKey,
      publicKey,
      proves: (code: string, key: Uint8Array = publicKey) =>
        service.client.updateUserMetadata(
          jwtFor(subject),
          mossPhoneLoginProof(
            { code, phonePublicKey: Buffer.from(key).toString("base64url") },
            clock.now,
          ),
        ),
    };
  };
  const source = (address = "192.168.1.50") => ({
    address,
    client: { deviceType: "mobile" as const },
  });

  /** The whole phone side, up to a pending request. */
  const ask = async (
    input: {
      readonly subject?: string;
      readonly address?: string;
      readonly deviceName?: string;
    } = {},
  ) => {
    const phone = makePhone(input.subject ?? "user-a");
    const challenge = await run(
      access.createChallenge({ realm: "memfire-phone", source: source(input.address) }),
    );
    await phone.proves(challenge.code);
    const pending = await run(
      access.requestAccess({
        realm: "memfire-phone",
        challengeId: challenge.challengeId,
        deviceName: input.deviceName,
        source: source(input.address),
      }),
    );
    return { phone, challenge, pending };
  };
  const waiting = () =>
    run(Stream.runHead(access.pendingRequests)).then((head) =>
      Option.getOrThrow(head).requests.map((request) => ({
        ...request,
        expiresAt: DateTime.toEpochMillis(request.expiresAt),
      })),
    );
  return { access, service, clock, state, issued, revoked, makePhone, source, ask, waiting };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const refusal = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  Effect.runPromise(effect.pipe(Effect.flip)).then((error) => error.reason);
const keyA = accountKeyOf("memfire-phone", "user-a");

describe("account sign-in never grants control by itself", () => {
  it("refuses every step while phone access is off", async () => {
    const { access, source } = await setup({ availability: "phone_access_off" });
    expect(
      await refusal(access.createChallenge({ realm: "memfire-phone", source: source() })),
    ).toBe("phone_access_off");
    expect(
      await refusal(
        access.requestAccess({ realm: "memfire-phone", challengeId: "x", source: source() }),
      ),
    ).toBe("phone_access_off");
    expect(await refusal(access.requestStatus({ requestId: "x", source: source() }))).toBe(
      "phone_access_off",
    );
  });

  it("is on only with the desktop's switch: a public URL turns nothing on", () => {
    expect(accountSignInAvailability({ desktopPhoneAccess: true })).toBeNull();
    for (const desktopPhoneAccess of [false, undefined]) {
      expect(accountSignInAvailability({ desktopPhoneAccess })).toBe("phone_access_off");
    }
    // The server's own config, with a public URL and the switch off, as a desktop started
    // from a shell that had one would get.
    const config = {
      mode: "desktop" as const,
      desktopPhoneAccess: false,
      publicUrl: new URL("https://moss.example.test"),
    };
    expect(accountSignInAvailability(config)).toBe("phone_access_off");
  });

  it("turns a proven challenge into a waiting request, and issues nothing until allowed", async () => {
    const { ask, waiting, issued, service, access, source, clock } = await setup();
    const { phone, challenge, pending } = await ask({ deviceName: "Ada's‮ phone 「x」" });

    expect(issued).toEqual([]);
    const [shown] = await waiting();
    expect(shown).toEqual({
      requestId: pending.requestId,
      deviceName: "Ada's phone x",
      accountLabel: "138****8000",
      checkCode: mossAccountCheckCode(
        challenge.code,
        phone.publicKey,
        new Uint8Array(Buffer.from(pending.checkNonce, "base64url")),
      ),
      expiresAt: DateTime.toEpochMillis(pending.expiresAt),
    });
    expect(DateTime.toEpochMillis(pending.expiresAt)).toBe(
      clock.now + MOSS_ACCOUNT_SIGN_IN_LIMITS.requestTtlMs,
    );
    // The computer removed the used proof from the account.
    expect(service.metadata.get("user-a")?.[MOSS_PHONE_LOGIN_METADATA_KEY]).toBeUndefined();
    expect(
      await run(access.requestStatus({ requestId: pending.requestId, source: source() })),
    ).toMatchObject({
      status: "pending",
    });
  });

  it("cuts device names to 40 characters and drops empty ones", async () => {
    const { ask, waiting } = await setup();
    await ask({ deviceName: "x".repeat(80) });
    await ask({ deviceName: "\u0000​  " });
    const shown = await waiting();
    expect(shown.map((request) => request.deviceName)).toEqual(["x".repeat(40), null]);
  });

  it("refuses a newcomer while three requests wait, and keeps the ones on screen", async () => {
    const { ask, waiting, access, source, makePhone } = await setup();
    const first = await ask({ address: "10.0.0.1" });
    for (const address of ["10.0.0.2", "10.0.0.3"]) await ask({ address });
    const phone = makePhone("user-a");
    const challenge = await run(
      access.createChallenge({ realm: "memfire-phone", source: source("10.0.0.4") }),
    );
    await phone.proves(challenge.code);
    expect(
      await refusal(
        access.requestAccess({
          realm: "memfire-phone",
          challengeId: challenge.challengeId,
          source: source("10.0.0.4"),
        }),
      ),
    ).toBe("refused");
    const shown = await waiting();
    expect(shown).toHaveLength(MOSS_ACCOUNT_SIGN_IN_LIMITS.pendingRequests);
    expect(shown.map((request) => request.requestId)).toContain(first.pending.requestId);
    expect(
      await run(access.requestStatus({ requestId: first.pending.requestId, source: source() })),
    ).toMatchObject({ status: "pending" });
  });

  it("delivers the session sealed to the phone once the person allows it", async () => {
    const { ask, access, issued, source, waiting } = await setup();
    const { phone, pending } = await ask({ deviceName: "Pixel" });

    await run(access.approve(pending.requestId));
    expect(issued).toEqual([{ realm: "memfire-phone", accountKey: keyA, label: "Pixel" }]);
    expect(await waiting()).toEqual([]);
    const status = await run(
      access.requestStatus({ requestId: pending.requestId, source: source() }),
    );
    if (status.status !== "approved") throw new Error("expected approval");
    expect(JSON.stringify(status)).not.toContain("fake-session-token");
    const opened = await openMossAccountSession({
      phonePrivateKey: phone.privateKey,
      requestId: pending.requestId,
      envelope: status.sealed,
    });
    expect(JSON.parse(new TextDecoder().decode(opened))).toMatchObject({
      sessionToken: "fake-session-token-1",
      role: "owner",
      sessionMethod: "bearer-session-token",
    });
  });

  it("refuses a second decision and an expired request", async () => {
    const { ask, access, clock, issued } = await setup();
    const { pending } = await ask();
    await run(access.approve(pending.requestId));
    expect(await refusal(access.approve(pending.requestId))).toBe("request_expired");
    expect(await refusal(access.deny(pending.requestId))).toBe("request_expired");
    expect(issued).toHaveLength(1);

    const late = await ask({ address: "10.0.0.9" });
    clock.now += MOSS_ACCOUNT_SIGN_IN_LIMITS.requestTtlMs + 1;
    expect(await refusal(access.approve(late.pending.requestId))).toBe("request_expired");
    expect(await refusal(access.approve("unknown"))).toBe("request_expired");
    expect(issued).toHaveLength(1);
  });

  it("tells the phone it was refused, and two refusals block the account and the address", async () => {
    const { ask, access, source, clock, makePhone } = await setup();
    const first = await ask({ address: "10.0.0.1" });
    await run(access.deny(first.pending.requestId));
    expect(
      await refusal(access.requestStatus({ requestId: first.pending.requestId, source: source() })),
    ).toBe("request_denied");
    const second = await ask({ address: "10.0.0.2" });
    await run(access.deny(second.pending.requestId));

    // Each address was refused once, the account twice: a third address gets a code,
    // but the account is blocked.
    const phone = makePhone("user-a");
    const challenge = await run(
      access.createChallenge({ realm: "memfire-phone", source: source("10.0.0.3") }),
    );
    await phone.proves(challenge.code);
    expect(
      await refusal(
        access.requestAccess({
          realm: "memfire-phone",
          challengeId: challenge.challengeId,
          source: source("10.0.0.3"),
        }),
      ),
    ).toBe("too_many_attempts");

    clock.now += MOSS_ACCOUNT_SIGN_IN_LIMITS.denialWindowMs + 1;
    await ask({ address: "10.0.0.3" });
  });

  it("blocks an address refused twice, even for another account", async () => {
    const { ask, access, source } = await setup();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { pending } = await ask({ address: "10.0.0.7" });
      await run(access.deny(pending.requestId));
    }
    expect(
      await refusal(access.createChallenge({ realm: "memfire-phone", source: source("10.0.0.7") })),
    ).toBe("too_many_attempts");
    const elsewhere = await run(
      access.createChallenge({ realm: "memfire-phone", source: source("10.0.0.8") }),
    );
    expect(elsewhere.challengeId).toBeTruthy();
  });

  it("refuses a phone of another account, a reused code, and a key the computer did not read", async () => {
    const { access, source, makePhone } = await setup();
    const stranger = makePhone("user-b");
    const challenge = await run(
      access.createChallenge({ realm: "memfire-phone", source: source() }),
    );
    await stranger.proves(challenge.code);
    expect(
      await refusal(
        access.requestAccess({
          realm: "memfire-phone",
          challengeId: challenge.challengeId,
          source: source(),
        }),
      ),
    ).toBe("account_mismatch");
    expect(
      await refusal(
        access.requestAccess({
          realm: "memfire-phone",
          challengeId: challenge.challengeId,
          source: source(),
        }),
      ),
    ).toBe("challenge_expired");

    // A low-order key cannot be sealed to; it is refused before anyone is asked.
    const phone = makePhone("user-a");
    const second = await run(access.createChallenge({ realm: "memfire-phone", source: source() }));
    await phone.proves(second.code, new Uint8Array(32));
    expect(
      await refusal(
        access.requestAccess({
          realm: "memfire-phone",
          challengeId: second.challengeId,
          source: source(),
        }),
      ),
    ).toBe("account_mismatch");
  });

  it("tells an unknown caller nothing about the computer's sign-in, and says when the service is down", async () => {
    // A challenge is open to anyone on the network: a signed-out realm gets the same plain
    // refusal as anything else, never "not signed in".
    const signedOut = await setup({ signedInAs: null });
    expect(
      await refusal(
        signedOut.access.createChallenge({ realm: "memfire-phone", source: signedOut.source() }),
      ),
    ).toBe("refused");
    expect(
      await refusal(
        signedOut.access.createChallenge({ realm: "supabase-google", source: signedOut.source() }),
      ),
    ).toBe("refused");

    const { access, source, service, makePhone } = await setup();
    const challenge = await run(
      access.createChallenge({ realm: "memfire-phone", source: source() }),
    );
    await makePhone("user-a").proves(challenge.code);
    service.failure.next = new Error("offline");
    expect(
      await refusal(
        access.requestAccess({
          realm: "memfire-phone",
          challengeId: challenge.challengeId,
          source: source(),
        }),
      ),
    ).toBe("account_service_unavailable");
  });

  it("refuses to approve once the computer changed account", async () => {
    const { ask, access, state, issued } = await setup();
    const { pending } = await ask();
    state.token = jwtFor("user-b");
    expect(await refusal(access.approve(pending.requestId))).toBe("account_mismatch");
    expect(issued).toEqual([]);
  });
});

describe("limits per caller", () => {
  it("keeps one noisy address from locking out another", async () => {
    const { access, source } = await setup();
    const noisy = source("10.1.1.1");
    for (let index = 0; index < MOSS_ACCOUNT_SIGN_IN_LIMITS.challengesPerAddress; index += 1) {
      await run(access.createChallenge({ realm: "memfire-phone", source: noisy }));
    }
    expect(await refusal(access.createChallenge({ realm: "memfire-phone", source: noisy }))).toBe(
      "too_many_attempts",
    );
    const quiet = await run(
      access.createChallenge({ realm: "memfire-phone", source: source("10.2.2.2") }),
    );
    expect(quiet.challengeId).toBeTruthy();
  });

  it("has no shared ceiling: callers at their own limit do not lock out another", async () => {
    const { access, source } = await setup();
    for (let caller = 1; caller <= 5; caller += 1) {
      for (let index = 0; index < MOSS_ACCOUNT_SIGN_IN_LIMITS.challengesPerAddress; index += 1) {
        await run(
          access.createChallenge({ realm: "memfire-phone", source: source(`10.3.0.${caller}`) }),
        );
      }
      expect(
        await refusal(
          access.createChallenge({ realm: "memfire-phone", source: source(`10.3.0.${caller}`) }),
        ),
      ).toBe("too_many_attempts");
    }
    const owner = await run(
      access.createChallenge({ realm: "memfire-phone", source: source("10.3.0.99") }),
    );
    expect(owner.challengeId).toBeTruthy();
    expect("challengesOverall" in MOSS_ACCOUNT_SIGN_IN_LIMITS).toBe(false);
  });

  it("keeps only the newest open challenges of one address", async () => {
    const { access, source, makePhone } = await setup();
    const challenges = [];
    for (
      let index = 0;
      index < MOSS_ACCOUNT_SIGN_IN_LIMITS.openChallengesPerAddress + 1;
      index += 1
    ) {
      challenges.push(
        await run(access.createChallenge({ realm: "memfire-phone", source: source() })),
      );
    }
    const oldest = challenges[0]!;
    await makePhone("user-a").proves(oldest.code);
    expect(
      await refusal(
        access.requestAccess({
          realm: "memfire-phone",
          challengeId: oldest.challengeId,
          source: source(),
        }),
      ),
    ).toBe("challenge_expired");
  });
});

describe("the computer list", () => {
  it("publishes nothing while phone access is off, and at the wiring only withdraws", async () => {
    const { access, service, state } = await setup({ availability: "phone_access_off" });
    await run(access.publishComputer());
    expect(service.calls).toEqual({ getUser: 0, updateUserMetadata: 0 });

    // The wiring: with the switch off the registry never starts its loop.
    await run(
      Effect.scoped(
        startMossAccountComputerRegistry(access, { desktopPhoneAccess: false }).pipe(
          Effect.andThen(Effect.sleep("10 millis")),
        ),
      ),
    );
    expect(service.calls).toEqual({ getUser: 0, updateUserMetadata: 0 });
    expect(state.records).toEqual([]);
  });

  it("publishes nothing with a public URL and the switch off, and only withdraws", async () => {
    const config = {
      mode: "desktop" as const,
      desktopPhoneAccess: false,
      publicUrl: new URL("https://moss.example.test"),
    };
    const { access, service, clock, state } = await setup({
      availability: accountSignInAvailability(config),
    });
    // An entry an earlier run listed: the registry removes it and lists nothing.
    service.metadata.set("user-a", {
      [MOSS_COMPUTERS_METADATA_KEY]: [
        { i: "mac-1", n: "Studio Mac", p: "darwin", o: [], v: "1", t: clock.now / 1000 },
      ],
    });
    state.records = [{ realm: "memfire-phone", accountKey: keyA, at: clock.now }];
    await run(
      Effect.scoped(
        startMossAccountComputerRegistry(access, config).pipe(
          Effect.andThen(Effect.sleep("20 millis")),
        ),
      ),
    );
    await run(access.publishComputer());
    expect(service.metadata.get("user-a")?.[MOSS_COMPUTERS_METADATA_KEY]).toBeUndefined();
    expect(state.records).toEqual([]);
    // One read and one removal; nothing listed.
    expect(service.calls).toEqual({ getUser: 1, updateUserMetadata: 1 });
  });

  it("publishes with phone access on and an address, and remembers where", async () => {
    const { access, service, state, clock } = await setup();
    state.origins = [];
    await run(access.publishComputer());
    expect(service.calls.updateUserMetadata).toBe(0);

    state.origins = ["http://192.168.1.20:3773"];
    await run(access.publishComputer());
    expect(readMossAccountComputers(service.metadata.get("user-a") ?? {}, clock.now)).toHaveLength(
      1,
    );
    expect(state.records).toEqual([{ realm: "memfire-phone", accountKey: keyA, at: clock.now }]);
    // Unchanged: no new write.
    const writes = service.calls.updateUserMetadata;
    await run(access.publishComputer());
    expect(service.calls.updateUserMetadata).toBe(writes);
  });

  it("removes the entry at the next start with phone access off, and retries after a failure", async () => {
    const { access, service, state } = await setup();
    await run(access.publishComputer());
    expect(service.metadata.get("user-a")?.[MOSS_COMPUTERS_METADATA_KEY]).toBeDefined();

    // The next start: same records, switch off.
    state.availability = "phone_access_off";
    service.failure.next = new Error("offline");
    await run(access.withdrawComputer());
    expect(state.records).toHaveLength(1);
    service.failure.next = null;
    await run(access.withdrawComputer());
    expect(service.metadata.get("user-a")?.[MOSS_COMPUTERS_METADATA_KEY]).toBeUndefined();
    expect(state.records).toEqual([]);
  });

  it("after switch-off keeps retrying the withdrawal every pass until it succeeds", async () => {
    const { access, service, state } = await setup();
    await run(access.publishComputer());
    state.availability = "phone_access_off";
    // The account service is out of reach for the first two passes.
    let failures = 2;
    const getUser = service.client.getUser;
    service.client.getUser = async (token: string) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("offline");
      }
      return getUser(token);
    };
    let passes = 0;
    await run(
      Effect.scoped(
        startMossAccountComputerRegistry(
          {
            publishComputer: access.publishComputer,
            withdrawComputer: () =>
              access.withdrawComputer().pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    passes += 1;
                  }),
                ),
              ),
          },
          { desktopPhoneAccess: false },
          Schedule.spaced("1 millis"),
        ).pipe(Effect.andThen(Effect.sleep("300 millis"))),
      ),
    );
    expect(passes).toBe(3);
    expect(state.records).toEqual([]);
    expect(service.metadata.get("user-a")?.[MOSS_COMPUTERS_METADATA_KEY]).toBeUndefined();
  });

  it("keeps a record it cannot act on until the entry has expired by itself", async () => {
    const records = [{ realm: "memfire-phone" as AuthAccountRealm, accountKey: "other", at: 0 }];
    const { access, state, clock } = await setup({ records, availability: "phone_access_off" });
    state.records = [{ ...records[0]!, at: clock.now }];
    expect(await run(access.withdrawComputer())).toBe(false);
    expect(state.records).toHaveLength(1);
    state.records = [{ ...records[0]!, at: clock.now - 8 * 24 * 60 * 60 * 1000 }];
    expect(await run(access.withdrawComputer())).toBe(true);
    expect(state.records).toEqual([]);
  });

  it("removes the entry and signs out the account's phones before the computer signs out", async () => {
    const { access, service, state, revoked, ask, waiting } = await setup();
    await run(access.publishComputer());
    await ask();
    await run(access.beforeSignOut("memfire-phone"));
    expect(service.metadata.get("user-a")?.[MOSS_COMPUTERS_METADATA_KEY]).toBeUndefined();
    expect(state.records).toEqual([]);
    expect(revoked).toEqual([{ realm: "memfire-phone", accountKey: keyA }]);
    expect(await waiting()).toEqual([]);
  });

  it("on an account switch, leaves the old account and ends only its phones", async () => {
    const { access, service, state, revoked } = await setup();
    await run(access.publishComputer());
    const result = await run(
      access.aroundAccountChange(
        "memfire-phone",
        Effect.sync(() => {
          state.token = jwtFor("user-b");
          return "switched";
        }),
      ),
    );
    expect(result).toBe("switched");
    expect(service.metadata.get("user-a")?.[MOSS_COMPUTERS_METADATA_KEY]).toBeUndefined();
    expect(revoked).toEqual([{ realm: "memfire-phone", accountKey: keyA }]);

    // Signing in again to the same account is no switch.
    await run(access.aroundAccountChange("memfire-phone", Effect.void));
    expect(revoked).toHaveLength(1);
  });

  it("ends the phones of an account that changed without passing through Moss", async () => {
    const { access, state, revoked } = await setup();
    await run(access.publishComputer());
    state.token = null;
    await run(access.publishComputer());
    expect(revoked).toEqual([{ realm: "memfire-phone", accountKey: keyA }]);
  });

  it("keeps the phones when the token cannot be renewed offline but the account is still there", async () => {
    const { access, state, revoked } = await setup();
    state.stored = "user-a";
    await run(access.publishComputer());
    // Waking without a network: no token for now, the account store still holds user-a.
    state.token = null;
    await run(access.publishComputer());
    await run(access.publishComputer());
    expect(revoked).toEqual([]);
    // The account store now says signed out: its phones leave.
    state.stored = null;
    await run(access.publishComputer());
    expect(revoked).toEqual([{ realm: "memfire-phone", accountKey: keyA }]);
  });

  it("ends the phones when the account store holds another account", async () => {
    const { access, state, revoked } = await setup();
    state.stored = "user-a";
    await run(access.publishComputer());
    state.token = null;
    state.stored = "user-b";
    await run(access.publishComputer());
    expect(revoked).toEqual([{ realm: "memfire-phone", accountKey: keyA }]);
  });

  it("names the computer and its addresses plainly, and reads its records defensively", () => {
    expect(mossComputerName("Studio-Mac.local")).toBe("Studio-Mac");
    // Addresses only: a host name would never pass the routes' host check.
    expect(mossComputerOrigins({ host: "192.168.1.20", port: 3773 })).toEqual([
      "http://192.168.1.20:3773",
    ]);
    expect(parseListingRecords("not json")).toEqual([]);
    expect(
      parseListingRecords(
        JSON.stringify([
          { realm: "memfire-phone", accountKey: "k", at: 1 },
          { realm: "elsewhere", accountKey: "k", at: 1 },
          { realm: "supabase-google", accountKey: "bad key!", at: 1 },
        ]),
      ),
    ).toEqual([{ realm: "memfire-phone", accountKey: "k", at: 1 }]);
  });
});

describe("no secrets in logs", () => {
  it("logs reasons, never tokens, codes, keys or the account service's message", async () => {
    const logged: string[] = [];
    const logger = Logger.make(({ message }) => {
      logged.push(JSON.stringify(message));
    });
    const withLogs = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    const { access, service, source, makePhone } = await setup();
    const token = jwtFor("user-a");
    const phone = makePhone("user-a");
    const challenge = await run(
      access.createChallenge({ realm: "memfire-phone", source: source() }),
    );
    await phone.proves(challenge.code);
    // A failure whose message echoes what was sent, as a careless error might.
    const leaky = Object.assign(new Error(`rejected ${token} ${challenge.code}`), {
      operation: "update_user_metadata",
      status: 500,
      code: "server_error",
    });
    service.failure.next = leaky;
    await run(withLogs(access.publishComputer()));
    await run(
      withLogs(
        access
          .requestAccess({
            realm: "memfire-phone",
            challengeId: challenge.challengeId,
            source: source(),
          })
          .pipe(Effect.ignore),
      ),
    );
    await run(withLogs(access.beforeSignOut("memfire-phone")));

    expect(logged.length).toBeGreaterThan(0);
    const all = logged.join("\n");
    expect(all).toContain("update_user_metadata:500:server_error");
    for (const secret of [
      token,
      "fake-token-body",
      challenge.code,
      Buffer.from(phone.publicKey).toString("base64url"),
      "rejected",
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});
