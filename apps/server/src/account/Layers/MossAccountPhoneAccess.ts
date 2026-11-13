// FILE: MossAccountPhoneAccess.ts
// Purpose: Account sign-in for the owner's phone. A phone signed in to the same Moss
//   account as this computer can ask for it without scanning a code, and never gets in
//   without a person at this computer allowing it.
//   - Listing: while phone access is on, this computer keeps one small entry about itself in
//     each signed-in account's user metadata (`moss_computers`); it removes the entry when
//     phone access goes off or the account signs out or changes.
//   - Sign-in: the phone gets a one-time code here, writes it with a fresh public key into
//     the account's metadata at the account service, and asks for a pending request. This
//     computer reads both back with its own session, shows the Moss window's confirmation
//     with a check code derived from them, and on "Allow" seals the phone's session to that
//     key (`@moss/shared/mossAccountSealedDelivery`).
// Layer: account (server)
// Exports: makeMossAccountPhoneAccess, MossAccountPhoneAccessLive,
//   startMossAccountComputerRegistry, accountSignInAvailability, mossComputerName,
//   mossComputerOrigins, parseListingRecords, MOSS_ACCOUNT_SIGN_IN_LIMITS
import * as Crypto from "node:crypto";
import os from "node:os";

import {
  AuthBearerBootstrapResult,
  type AuthAccountLoginRefusal,
  type AuthAccountPendingRequest,
  type AuthAccountPendingRequests,
  type AuthAccountRealm,
  type AuthAccountSealedSession,
  type AuthClientMetadata,
} from "@moss/contracts";
import {
  MOSS_COMPUTER_STALE_MS,
  MOSS_PHONE_LOGIN_PROOF_CLEARED,
  MOSS_PHONE_LOGIN_TTL_MS,
  mossAccountComputersRemoval,
  mossAccountComputersUpdate,
  readMossPhoneLoginProof,
  type MossAccountComputerSelf,
} from "@moss/shared/mossAccountComputers";
import {
  decodeMossPhonePublicKey,
  isUsableMossPhonePublicKey,
  mossAccountCheckCode,
  newMossAccountCheckNonce,
  sealMossAccountSession,
} from "@moss/shared/mossAccountSealedDelivery";
import { DateTime, Effect, Layer, Schedule, Schema, Stream, SubscriptionRef } from "effect";

import serverPackageJson from "../../../package.json" with { type: "json" };
import { ServerAuth, type ServerAuthShape } from "../../auth/Services/ServerAuth";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import { ServerConfig, type ServerConfigShape } from "../../config";
import { resolveLanOrigins } from "../../lanOrigins";
import {
  accountDisplayLabel,
  accountKeyOf,
  describeAccountFailure,
  makeDenialBlocks,
  makeWindowLimiter,
  sanitizeDeviceName,
  unverifiedTokenSubject,
} from "../accountSignInGuards";
import { MossCloudAccountService } from "../Services/MossCloudAccountService";
import {
  MossAccountPhoneAccess,
  MossAccountPhoneAccessRefused,
  type MossAccountPhoneAccessShape,
} from "../Services/MossAccountPhoneAccess";
import { MossPhoneAccountService } from "../Services/MossPhoneAccountService";
import {
  createMemFirePhoneAuth,
  createSupabaseGoogleAuth,
  type SupabaseMossAuthClient,
} from "../supabaseMossAuth";

type MetadataClient = Pick<SupabaseMossAuthClient, "getUser" | "updateUserMetadata">;

/** One account service this computer may be signed in to. */
export interface MossAccountPhoneAccessLane {
  readonly realm: AuthAccountRealm;
  /** Null when this build has no configuration for the realm. */
  readonly client: MetadataClient | null;
  /** This computer's own access token for the realm; null while signed out or unreachable. */
  readonly accessToken: Effect.Effect<string | null>;
  /**
   * The account this computer's account store holds for the realm, read locally without the
   * network: its id, null when the store holds no session, undefined when it cannot tell.
   * It keeps a token that cannot be renewed right now (offline after a sleep) from reading
   * as a sign-out.
   */
  readonly storedAccountId?: Effect.Effect<string | null | undefined>;
}

/** "This computer is listed in account X of realm R" — kept locally, never the token. */
export interface MossAccountListingRecord {
  readonly realm: AuthAccountRealm;
  readonly accountKey: string;
  /** Unix milliseconds of the last successful write. */
  readonly at: number;
}

export interface MossAccountListingStore {
  readonly read: Effect.Effect<ReadonlyArray<MossAccountListingRecord>>;
  readonly write: (records: ReadonlyArray<MossAccountListingRecord>) => Effect.Effect<void>;
}

export interface MakeMossAccountPhoneAccessOptions {
  readonly lanes: ReadonlyArray<MossAccountPhoneAccessLane>;
  /** What this computer says about itself right now (its addresses can change). */
  readonly self: () => MossAccountComputerSelf;
  /** Why account sign-in cannot run on this server now, or null when it can. */
  readonly availability: () => Extract<
    AuthAccountLoginRefusal,
    "phone_access_off" | "confirmation_unavailable"
  > | null;
  readonly auth: Pick<
    ServerAuthShape,
    "issueAccountDeviceBearerSession" | "revokeAccountDeviceSessions"
  >;
  readonly listings: MossAccountListingStore;
  readonly now?: () => number;
  readonly randomCode?: () => string;
  readonly randomId?: () => string;
  /** The check-code nonce (tests); 16 random bytes otherwise. */
  readonly randomCheckNonce?: () => Uint8Array;
}

export const MOSS_ACCOUNT_SIGN_IN_LIMITS = {
  /** Challenges per source address per minute. */
  challengesPerAddress: 6,
  /** Open challenges one address may hold. */
  openChallengesPerAddress: 3,
  openChallengesOverall: 32,
  /** Pending requests per source address per minute. */
  requestsPerAddress: 6,
  /** Status checks per source address per minute (a phone polls about every 2 s). */
  statusPerAddress: 90,
  /** Requests waiting for a person at a time; a newcomer is refused while it is full. */
  pendingRequests: 3,
  /** How long a request waits for a person. */
  requestTtlMs: 2 * 60 * 1000,
  /** How long an answered request still tells the phone the answer. */
  answerTtlMs: 60 * 1000,
  /** Two refusals within this window block the account and the address for as long. */
  denialWindowMs: 10 * 60 * 1000,
  denialsToBlock: 2,
  /** Callers remembered by each limiter. */
  trackedCallers: 256,
} as const;

/** An unchanged listing is still re-read this often, in case another device dropped it. */
const LISTING_RECHECK_MS = 6 * 60 * 60 * 1000;
const COMPUTER_REGISTRY_INTERVAL = "30 seconds";
const COMPUTER_ID_SECRET = "moss-account-computer-id";
const LISTINGS_SECRET = "moss-account-computer-listings";
const ACCOUNT_SERVICE_TIMEOUT = "10 seconds";

const refused = (
  reason: AuthAccountLoginRefusal,
  status: MossAccountPhoneAccessRefused["status"],
  message: string,
) => new MossAccountPhoneAccessRefused({ reason, status, message });

const REFUSALS = {
  phone_access_off: () =>
    refused("phone_access_off", 403, "Phone connections are turned off on this computer."),
  confirmation_unavailable: () =>
    refused(
      "confirmation_unavailable",
      409,
      "This computer cannot show a confirmation, so it does not accept account sign-in.",
    ),
  computer_not_signed_in: () =>
    refused(
      "computer_not_signed_in",
      409,
      "This computer is not signed in to a Moss account of that kind.",
    ),
  account_service_unavailable: () =>
    refused(
      "account_service_unavailable",
      503,
      "This computer could not reach the Moss account service.",
    ),
  too_many_attempts: () =>
    refused("too_many_attempts", 429, "Too many sign-in attempts. Try again later."),
  challenge_expired: () =>
    refused("challenge_expired", 401, "This sign-in took too long. Try again from the phone."),
  account_mismatch: () =>
    refused("account_mismatch", 403, "This computer is signed in to a different Moss account."),
  request_denied: () =>
    refused("request_denied", 403, "The person at this computer did not allow this phone."),
  refused: () => refused("refused", 403, "This computer did not accept the sign-in."),
  request_expired: () =>
    refused("request_expired", 410, "This request is no longer waiting. Try again from the phone."),
} as const;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && Crypto.timingSafeEqual(a, b);
}

interface OpenChallenge {
  readonly realm: AuthAccountRealm;
  readonly code: string;
  readonly expiresAt: number;
  readonly address: string;
}

interface AccessRequest {
  readonly requestId: string;
  readonly realm: AuthAccountRealm;
  readonly accountKey: string;
  readonly accountLabel: string | null;
  readonly deviceName: string | null;
  readonly checkCode: string;
  readonly phonePublicKey: Uint8Array;
  readonly address: string;
  readonly client: AuthClientMetadata;
  readonly expiresAt: number;
  state: "pending" | "approving" | "approved" | "denied";
  sealed: AuthAccountSealedSession | null;
  answeredUntil: number;
}

const encodeBearerSession = Schema.encodeSync(AuthBearerBootstrapResult);

export const makeMossAccountPhoneAccess = (
  options: MakeMossAccountPhoneAccessOptions,
): Effect.Effect<MossAccountPhoneAccessShape> =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const randomCode = options.randomCode ?? (() => Crypto.randomBytes(32).toString("base64url"));
    const randomId = options.randomId ?? (() => Crypto.randomUUID());
    const randomCheckNonce = options.randomCheckNonce ?? newMossAccountCheckNonce;
    const limits = MOSS_ACCOUNT_SIGN_IN_LIMITS;
    const lanes = new Map(options.lanes.map((lane) => [lane.realm, lane]));
    const challenges = new Map<string, OpenChallenge>();
    const requests = new Map<string, AccessRequest>();
    const limiter = (limit: number) =>
      makeWindowLimiter({ limit, windowMs: 60_000, maxKeys: limits.trackedCallers, now });
    const challengesByAddress = limiter(limits.challengesPerAddress);
    const requestsByAddress = limiter(limits.requestsPerAddress);
    const statusByAddress = limiter(limits.statusPerAddress);
    const blocks = makeDenialBlocks({
      denials: limits.denialsToBlock,
      windowMs: limits.denialWindowMs,
      maxKeys: limits.trackedCallers,
      now,
    });
    /** The account each lane was last seen signed in to (null: signed out; absent: unknown). */
    const lastSeen = new Map<AuthAccountRealm, string | null>();
    const published = new Map<AuthAccountRealm, { readonly key: string; readonly at: number }>();
    const pendingRef = yield* SubscriptionRef.make<AuthAccountPendingRequests>({ requests: [] });

    const addressKey = (address: string) => `address:${address}`;
    const accountBlockKey = (realm: AuthAccountRealm, accountKey: string) =>
      `account:${realm}:${accountKey}`;

    const pruneExpired = () => {
      const at = now();
      for (const [id, challenge] of challenges) {
        if (challenge.expiresAt <= at) challenges.delete(id);
      }
      let changed = false;
      for (const [id, request] of requests) {
        const live =
          request.state === "pending" || request.state === "approving"
            ? request.expiresAt > at
            : request.answeredUntil > at;
        if (!live) {
          requests.delete(id);
          changed = true;
        }
      }
      return changed;
    };

    const snapshot = (): AuthAccountPendingRequests => {
      const at = now();
      const waiting: AuthAccountPendingRequest[] = [];
      for (const request of requests.values()) {
        if (request.state !== "pending" || request.expiresAt <= at) continue;
        waiting.push({
          requestId: request.requestId,
          deviceName: request.deviceName,
          accountLabel: request.accountLabel,
          checkCode: request.checkCode,
          expiresAt: DateTime.makeUnsafe(request.expiresAt),
        });
      }
      return { requests: waiting };
    };
    const publishPendingNow = Effect.suspend(() => SubscriptionRef.set(pendingRef, snapshot()));

    const requireAvailable = Effect.suspend(() => {
      const reason = options.availability();
      return reason ? Effect.fail(REFUSALS[reason]()) : Effect.void;
    });

    const laneToken = (realm: AuthAccountRealm) =>
      Effect.gen(function* () {
        const lane = lanes.get(realm);
        if (!lane?.client) return null;
        const accessToken = yield* lane.accessToken;
        return accessToken ? { client: lane.client, accessToken } : null;
      });

    const signedInLane = (realm: AuthAccountRealm) =>
      laneToken(realm).pipe(
        Effect.flatMap((lane) =>
          lane ? Effect.succeed(lane) : Effect.fail(REFUSALS.computer_not_signed_in()),
        ),
      );

    /** The account behind a token this computer holds (its own session, the trusted side). */
    const tokenAccountKey = (realm: AuthAccountRealm, accessToken: string): string | null => {
      const subject = unverifiedTokenSubject(accessToken);
      return subject ? accountKeyOf(realm, subject) : null;
    };

    const accountService = <A>(operation: () => Promise<A>) =>
      Effect.tryPromise({ try: operation, catch: (cause) => cause }).pipe(
        Effect.timeout(ACCOUNT_SERVICE_TIMEOUT),
      );

    const warn = (message: string, realm: AuthAccountRealm, cause: unknown) =>
      Effect.logWarning(message, { realm, reason: describeAccountFailure(cause) });

    // ── Sign-in ──────────────────────────────────────────────────────────

    const createChallenge: MossAccountPhoneAccessShape["createChallenge"] = (input) =>
      Effect.gen(function* () {
        yield* requireAvailable;
        const address = input.source.address;
        if (blocks.isBlocked(addressKey(address))) return yield* REFUSALS.too_many_attempts();
        // Limited per address only: a shared ceiling would let a few noisy callers lock the
        // owner's phone out. Memory stays bounded by openChallengesOverall and the limiters'
        // key caps.
        if (!challengesByAddress.take(address)) return yield* REFUSALS.too_many_attempts();
        // An unauthenticated caller learns nothing about which account this computer holds.
        yield* signedInLane(input.realm).pipe(Effect.mapError(() => REFUSALS.refused()));
        pruneExpired();
        const own = [...challenges].filter(([, challenge]) => challenge.address === address);
        for (const [id] of own.slice(
          0,
          Math.max(0, own.length - limits.openChallengesPerAddress + 1),
        )) {
          challenges.delete(id);
        }
        while (challenges.size >= limits.openChallengesOverall) {
          const oldest = challenges.keys().next().value;
          if (oldest === undefined) break;
          challenges.delete(oldest);
        }
        const challengeId = randomId();
        const code = randomCode();
        const expiresAt = now() + MOSS_PHONE_LOGIN_TTL_MS;
        challenges.set(challengeId, { realm: input.realm, code, expiresAt, address });
        return { challengeId, code, expiresAt: DateTime.makeUnsafe(expiresAt) };
      });

    const requestAccess: MossAccountPhoneAccessShape["requestAccess"] = (input) =>
      Effect.gen(function* () {
        yield* requireAvailable;
        const address = input.source.address;
        if (blocks.isBlocked(addressKey(address))) return yield* REFUSALS.too_many_attempts();
        if (!requestsByAddress.take(address)) return yield* REFUSALS.too_many_attempts();
        pruneExpired();
        const challenge = challenges.get(input.challengeId);
        // A request on screen is never pushed out by a newer one: with the queue full, the
        // newcomer is refused.
        const waitingCount = [...requests.values()].filter(
          (request) => request.state === "pending" || request.state === "approving",
        ).length;
        if (waitingCount >= limits.pendingRequests) {
          challenges.delete(input.challengeId);
          return yield* REFUSALS.refused();
        }
        // One attempt per code, whatever the outcome.
        challenges.delete(input.challengeId);
        if (!challenge || challenge.realm !== input.realm || challenge.expiresAt <= now()) {
          return yield* REFUSALS.challenge_expired();
        }
        const { client, accessToken } = yield* signedInLane(input.realm);
        const user = yield* accountService(() => client.getUser(accessToken)).pipe(
          Effect.tapError((cause) =>
            warn("could not read the Moss account for a phone sign-in", input.realm, cause),
          ),
          Effect.mapError(REFUSALS.account_service_unavailable),
        );
        // Only a session of the account this computer is signed in to can have written this.
        const proof = readMossPhoneLoginProof(user.userMetadata, now());
        const phonePublicKey = proof ? decodeMossPhonePublicKey(proof.phonePublicKey) : null;
        if (
          !proof ||
          !phonePublicKey ||
          !safeEqual(proof.code, challenge.code) ||
          !isUsableMossPhonePublicKey(phonePublicKey)
        ) {
          return yield* REFUSALS.account_mismatch();
        }
        const accountKey = accountKeyOf(input.realm, user.id);
        if (blocks.isBlocked(accountBlockKey(input.realm, accountKey))) {
          return yield* REFUSALS.too_many_attempts();
        }
        // The proof has done its job; remove it from the account.
        yield* accountService(() =>
          client.updateUserMetadata(accessToken, MOSS_PHONE_LOGIN_PROOF_CLEARED),
        ).pipe(
          Effect.catch((cause) =>
            warn("could not clear a used phone sign-in proof", input.realm, cause),
          ),
        );
        // Drawn only now that the key is fixed: a key chosen in advance to reproduce another
        // phone's code matches only by chance.
        const checkNonce = randomCheckNonce();
        const requestId = randomId();
        const expiresAt = now() + limits.requestTtlMs;
        requests.set(requestId, {
          requestId,
          realm: input.realm,
          accountKey,
          accountLabel: accountDisplayLabel(user),
          deviceName: sanitizeDeviceName(input.deviceName),
          checkCode: mossAccountCheckCode(challenge.code, phonePublicKey, checkNonce),
          phonePublicKey,
          address,
          client: input.source.client,
          expiresAt,
          state: "pending",
          sealed: null,
          answeredUntil: expiresAt,
        });
        yield* publishPendingNow;
        return {
          requestId,
          expiresAt: DateTime.makeUnsafe(expiresAt),
          checkNonce: Buffer.from(checkNonce).toString("base64url"),
        };
      });

    const requestStatus: MossAccountPhoneAccessShape["requestStatus"] = (input) =>
      Effect.gen(function* () {
        yield* requireAvailable;
        if (!statusByAddress.take(input.source.address)) {
          return yield* REFUSALS.too_many_attempts();
        }
        if (pruneExpired()) yield* publishPendingNow;
        const request = requests.get(input.requestId);
        if (!request) return yield* REFUSALS.request_expired();
        if (request.state === "denied") return yield* REFUSALS.request_denied();
        if (request.state === "approved" && request.sealed) {
          return { status: "approved" as const, sealed: request.sealed };
        }
        return { status: "pending" as const, expiresAt: DateTime.makeUnsafe(request.expiresAt) };
      });

    const waitingRequest = (requestId: string) =>
      Effect.suspend(() => {
        pruneExpired();
        const request = requests.get(requestId);
        // Unknown, expired, or already answered: a decision works once.
        if (!request || request.state !== "pending" || request.expiresAt <= now()) {
          return Effect.fail(REFUSALS.request_expired());
        }
        return Effect.succeed(request);
      });

    const approve: MossAccountPhoneAccessShape["approve"] = (requestId) =>
      Effect.gen(function* () {
        const request = yield* waitingRequest(requestId);
        // Claimed before anything can yield, so a second "Allow" cannot issue twice.
        request.state = "approving";
        const sealed = yield* Effect.gen(function* () {
          const lane = yield* signedInLane(request.realm);
          if (tokenAccountKey(request.realm, lane.accessToken) !== request.accountKey) {
            return yield* REFUSALS.account_mismatch();
          }
          const session = yield* options.auth
            .issueAccountDeviceBearerSession({
              realm: request.realm,
              accountKey: request.accountKey,
              client: {
                ...request.client,
                ...(request.deviceName ? { label: request.deviceName } : {}),
              },
            })
            .pipe(Effect.mapError(REFUSALS.account_service_unavailable));
          const plaintext = new TextEncoder().encode(JSON.stringify(encodeBearerSession(session)));
          return yield* Effect.tryPromise({
            try: () =>
              sealMossAccountSession({
                phonePublicKey: request.phonePublicKey,
                requestId: request.requestId,
                plaintext,
              }),
            catch: REFUSALS.account_mismatch,
          });
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              request.state = "pending";
            }),
          ),
        );
        request.state = "approved";
        request.sealed = sealed;
        request.answeredUntil = Math.max(request.expiresAt, now() + limits.answerTtlMs);
        yield* publishPendingNow;
      });

    const deny: MossAccountPhoneAccessShape["deny"] = (requestId) =>
      Effect.gen(function* () {
        const request = yield* waitingRequest(requestId);
        request.state = "denied";
        request.answeredUntil = Math.max(request.expiresAt, now() + limits.answerTtlMs);
        blocks.record([
          addressKey(request.address),
          accountBlockKey(request.realm, request.accountKey),
        ]);
        yield* publishPendingNow;
      });

    // ── Listing ──────────────────────────────────────────────────────────

    const saveRecord = (record: MossAccountListingRecord) =>
      options.listings.read.pipe(
        Effect.flatMap((records) =>
          options.listings.write([
            ...records.filter(
              (entry) => !(entry.realm === record.realm && entry.accountKey === record.accountKey),
            ),
            record,
          ]),
        ),
      );

    const dropRecord = (realm: AuthAccountRealm, accountKey: string) =>
      options.listings.read.pipe(
        Effect.flatMap((records) =>
          options.listings.write(
            records.filter((entry) => !(entry.realm === realm && entry.accountKey === accountKey)),
          ),
        ),
      );

    /** Removes this computer's entry from the account behind `accessToken`. */
    const withdrawWith = (
      lane: { readonly client: MetadataClient; readonly accessToken: string },
      realm: AuthAccountRealm,
      accountKey: string,
    ) =>
      Effect.gen(function* () {
        const self = options.self();
        const user = yield* accountService(() => lane.client.getUser(lane.accessToken));
        const removal = mossAccountComputersRemoval(user.userMetadata, self.id, now());
        if (removal) {
          yield* accountService(() => lane.client.updateUserMetadata(lane.accessToken, removal));
        }
        published.delete(realm);
        yield* dropRecord(realm, accountKey);
      }).pipe(
        // Kept on failure: the next start with phone access off tries again, and the entry
        // expires on its own after MOSS_COMPUTER_STALE_MS.
        Effect.catch((cause) =>
          warn("could not remove this computer from the Moss account", realm, cause),
        ),
      );

    /** Ends what one account let in: its phones' sessions and its waiting requests. */
    const forgetAccount = (realm: AuthAccountRealm, accountKey: string | null) =>
      Effect.gen(function* () {
        for (const [id, challenge] of challenges) {
          if (challenge.realm === realm) challenges.delete(id);
        }
        for (const [id, request] of requests) {
          if (
            request.realm === realm &&
            (accountKey === null || request.accountKey === accountKey)
          ) {
            requests.delete(id);
          }
        }
        yield* publishPendingNow;
        const revoked = yield* options.auth
          .revokeAccountDeviceSessions(accountKey === null ? { realm } : { realm, accountKey })
          .pipe(
            Effect.catch((cause) =>
              warn("could not sign out phones of a Moss account", realm, cause).pipe(Effect.as(0)),
            ),
          );
        if (revoked > 0)
          yield* Effect.logInfo("Signed out phones of a Moss account", { realm, revoked });
      });

    const publishLane = (lane: MossAccountPhoneAccessLane) =>
      Effect.gen(function* () {
        const signedIn = yield* laneToken(lane.realm);
        const tokenKey = signedIn ? tokenAccountKey(lane.realm, signedIn.accessToken) : null;
        const stored = lane.storedAccountId ? yield* lane.storedAccountId : undefined;
        // No token right now is a sign-out only when the account store agrees: a token that
        // cannot be renewed offline leaves the account, and its phones, as they were.
        const accountKey =
          tokenKey ??
          (stored === undefined || stored === null ? null : accountKeyOf(lane.realm, stored));
        const previous = lastSeen.get(lane.realm);
        // The account changed or signed out without passing through this service: its phones
        // lose access here.
        if (previous !== undefined && previous !== null && previous !== accountKey) {
          yield* forgetAccount(lane.realm, previous);
          published.delete(lane.realm);
        }
        lastSeen.set(lane.realm, accountKey);
        if (!signedIn || !accountKey) return;
        const self = options.self();
        // Nothing to publish without an address a phone could use.
        if (self.origins.length === 0) return;
        const key = JSON.stringify([accountKey, self]);
        const last = published.get(lane.realm);
        if (last && last.key === key && now() - last.at < LISTING_RECHECK_MS) return;
        const user = yield* accountService(() => signedIn.client.getUser(signedIn.accessToken));
        const update = mossAccountComputersUpdate(user.userMetadata, self, now());
        if (update) {
          yield* accountService(() =>
            signedIn.client.updateUserMetadata(signedIn.accessToken, update),
          );
          yield* saveRecord({ realm: lane.realm, accountKey, at: now() });
        }
        published.set(lane.realm, { key, at: now() });
      }).pipe(
        Effect.catch((cause) =>
          warn("could not list this computer in the Moss account", lane.realm, cause),
        ),
      );

    let seeded = false;
    const seedFromRecords = Effect.gen(function* () {
      if (seeded) return;
      seeded = true;
      // Accounts this computer listed itself in before a restart count as "last seen", so
      // a change of account while the backend was down still ends their phones' access.
      for (const record of yield* options.listings.read) {
        if (!lastSeen.has(record.realm)) lastSeen.set(record.realm, record.accountKey);
      }
    });

    const publishComputer: MossAccountPhoneAccessShape["publishComputer"] = () =>
      Effect.suspend(() =>
        options.availability() !== null
          ? Effect.void
          : seedFromRecords.pipe(
              Effect.andThen(Effect.forEach(options.lanes, publishLane, { discard: true })),
            ),
      );

    const withdrawComputer: MossAccountPhoneAccessShape["withdrawComputer"] = () =>
      Effect.gen(function* () {
        const records = yield* options.listings.read;
        if (records.length === 0) return true;
        for (const record of records) {
          const signedIn = yield* laneToken(record.realm);
          const accountKey = signedIn ? tokenAccountKey(record.realm, signedIn.accessToken) : null;
          if (signedIn && accountKey === record.accountKey) {
            yield* withdrawWith(signedIn, record.realm, record.accountKey);
          } else if (now() - record.at > MOSS_COMPUTER_STALE_MS) {
            // That account has forgotten this computer on its own by now.
            yield* dropRecord(record.realm, record.accountKey);
          }
        }
        return (yield* options.listings.read).length === 0;
      });

    const beforeSignOut: MossAccountPhoneAccessShape["beforeSignOut"] = (realm) =>
      Effect.gen(function* () {
        const signedIn = yield* laneToken(realm);
        const accountKey = signedIn ? tokenAccountKey(realm, signedIn.accessToken) : null;
        if (signedIn && accountKey) {
          const records = yield* options.listings.read;
          if (
            records.some((record) => record.realm === realm && record.accountKey === accountKey)
          ) {
            yield* withdrawWith(signedIn, realm, accountKey);
          }
        }
        yield* forgetAccount(realm, accountKey);
        lastSeen.set(realm, null);
      }).pipe(Effect.catch(() => Effect.void));

    const aroundAccountChange: MossAccountPhoneAccessShape["aroundAccountChange"] = (
      realm,
      action,
    ) =>
      Effect.gen(function* () {
        const before = yield* laneToken(realm).pipe(Effect.catch(() => Effect.succeed(null)));
        const beforeKey = before ? tokenAccountKey(realm, before.accessToken) : null;
        const result = yield* action;
        yield* Effect.gen(function* () {
          const after = yield* laneToken(realm);
          const afterKey = after ? tokenAccountKey(realm, after.accessToken) : null;
          if (before && beforeKey && beforeKey !== afterKey) {
            const records = yield* options.listings.read;
            if (
              records.some((record) => record.realm === realm && record.accountKey === beforeKey)
            ) {
              yield* withdrawWith(before, realm, beforeKey);
            }
            yield* forgetAccount(realm, beforeKey);
          }
          lastSeen.set(realm, afterKey);
        }).pipe(Effect.catch(() => Effect.void));
        return result;
      });

    return {
      createChallenge,
      requestAccess,
      requestStatus,
      pendingRequests: SubscriptionRef.changes(pendingRef).pipe(
        Stream.map((value) => {
          // Answered or lapsed requests drop out of every snapshot a subscriber sees.
          const at = now();
          return {
            requests: value.requests.filter(
              (request) => DateTime.toEpochMillis(request.expiresAt) > at,
            ),
          };
        }),
      ),
      approve,
      deny,
      publishComputer,
      withdrawComputer,
      beforeSignOut,
      aroundAccountChange,
    } satisfies MossAccountPhoneAccessShape;
  });

/**
 * Why account sign-in cannot run on this server, or null when it can. Only the desktop's
 * "Allow phone connections" switch turns it on (it is set only in desktop mode, where a Moss
 * window can ask the person); a public URL or any other setting never does.
 */
export function accountSignInAvailability(
  config: Pick<ServerConfigShape, "desktopPhoneAccess">,
): "phone_access_off" | null {
  return config.desktopPhoneAccess === true ? null : "phone_access_off";
}

/** `Nick's-MacBook.local` reads better as `Nick's-MacBook`. */
export function mossComputerName(hostname: string): string {
  return hostname.replace(/\.(local|lan|home)$/iu, "").trim() || "Moss";
}

/** Where a phone can reach this server: its public address, else its LAN addresses. */
export function mossComputerOrigins(config: {
  readonly host: string | undefined;
  readonly port: number;
}): ReadonlyArray<string> {
  // Addresses only: account sign-in answers only requests that name this computer by an
  // address (see accountSignInRoute's host check), so a public host name would never work.
  return resolveLanOrigins({ host: config.host, port: config.port });
}

/** The stored listing records; anything unreadable counts as none. */
export function parseListingRecords(text: string): ReadonlyArray<MossAccountListingRecord> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): MossAccountListingRecord[] => {
    if (!entry || typeof entry !== "object") return [];
    const { realm, accountKey, at } = entry as Record<string, unknown>;
    if (realm !== "memfire-phone" && realm !== "supabase-google") return [];
    if (typeof accountKey !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(accountKey)) return [];
    if (typeof at !== "number" || !Number.isFinite(at)) return [];
    return [{ realm, accountKey, at }];
  });
}

export const MossAccountPhoneAccessLive = Layer.effect(
  MossAccountPhoneAccess,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const secretStore = yield* ServerSecretStore;
    const serverAuth = yield* ServerAuth;
    const phone = yield* MossPhoneAccountService;
    const cloud = yield* MossCloudAccountService;
    const phoneAuth = createMemFirePhoneAuth();
    const googleAuth = createSupabaseGoogleAuth();
    // Random and local to this installation: it names the computer, it is not a secret.
    const computerId = yield* secretStore.getOrCreateRandom(COMPUTER_ID_SECRET, 9).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.orElseSucceed(() => Crypto.randomBytes(9).toString("base64url")),
    );
    const tokenOrNull = <E>(
      credential: Effect.Effect<{ readonly accessToken: string }, E>,
    ): Effect.Effect<string | null> =>
      credential.pipe(
        Effect.map((value) => value.accessToken),
        Effect.orElseSucceed(() => null),
      );
    // The local account store, read without the network; a read that fails tells nothing.
    const storedAccount = <E>(
      authority: Effect.Effect<
        { readonly identity: { readonly account: { readonly id: string } } | null },
        E
      >,
    ): Effect.Effect<string | null | undefined> =>
      authority.pipe(
        Effect.map((state) => state.identity?.account.id ?? null),
        Effect.orElseSucceed(() => undefined),
      );
    const listings: MossAccountListingStore = {
      read: secretStore.get(LISTINGS_SECRET).pipe(
        Effect.map((bytes) =>
          bytes ? parseListingRecords(Buffer.from(bytes).toString("utf8")) : [],
        ),
        Effect.orElseSucceed((): ReadonlyArray<MossAccountListingRecord> => []),
      ),
      write: (records) =>
        (records.length === 0
          ? secretStore.remove(LISTINGS_SECRET)
          : secretStore.set(LISTINGS_SECRET, new TextEncoder().encode(JSON.stringify(records)))
        ).pipe(
          Effect.catch(() => Effect.logWarning("could not remember where this computer is listed")),
        ),
    };
    return yield* makeMossAccountPhoneAccess({
      lanes: [
        {
          realm: "memfire-phone",
          client: phoneAuth.available ? phoneAuth.client : null,
          accessToken: Effect.suspend(() => tokenOrNull(phone.getAuthorityCredential())),
          storedAccountId: Effect.suspend(() => storedAccount(phone.getLocalAuthority())),
        },
        {
          realm: "supabase-google",
          client: googleAuth.available ? googleAuth.client : null,
          accessToken: Effect.suspend(() => tokenOrNull(cloud.getAuthorityCredential())),
          storedAccountId: Effect.suspend(() => storedAccount(cloud.getLocalAuthority())),
        },
      ],
      self: () => ({
        id: computerId,
        name: mossComputerName(os.hostname()),
        platform: process.platform,
        origins: mossComputerOrigins(config),
        version: serverPackageJson.version,
      }),
      availability: () => accountSignInAvailability(config),
      auth: serverAuth,
      listings,
    });
  }),
);

/**
 * With phone access on: lists this computer at startup, then every 30 seconds checks
 * whether its addresses or account changed. With it off: publishes nothing, and removes the
 * entries an earlier run left, every 30 seconds until none is left (the account service may
 * be out of reach at first). The loop is scoped to the caller and stops with it.
 */
export const startMossAccountComputerRegistry = (
  access: Pick<MossAccountPhoneAccessShape, "publishComputer" | "withdrawComputer">,
  config: Pick<ServerConfigShape, "desktopPhoneAccess">,
  interval: Schedule.Schedule<unknown> | undefined = undefined,
) => {
  const every = interval ?? Schedule.spaced(COMPUTER_REGISTRY_INTERVAL);
  return (
    accountSignInAvailability(config) === null
      ? access.publishComputer().pipe(Effect.repeat(every))
      : access.withdrawComputer().pipe(Effect.repeat({ schedule: every, until: (done) => done }))
  ).pipe(Effect.forkScoped, Effect.asVoid);
};
