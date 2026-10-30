import fs from "node:fs";
import path from "node:path";

import {
  CommandId,
  EventId,
  GUEST_PENDING_MESSAGE_LIMIT,
  GUEST_ROUTES,
  GUEST_SESSION_COOKIE,
  GUEST_SHARE_PROTOCOL_VERSION,
  GuestMessageId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type GuestShareOwnerEvent,
  type GuestStreamEvent,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ThreadGuestShare,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, ManagedRuntime, Option, PubSub, Stream } from "effect";
import type { ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MossAccountServiceError } from "../../account/mossAccountErrors.ts";
import { MossCloudAccountServiceError } from "../../account/mossCloudAccountErrors.ts";
import { MossCloudAccountService } from "../../account/Services/MossCloudAccountService.ts";
import { MossPhoneAccountService } from "../../account/Services/MossPhoneAccountService.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { fakeProjectionSnapshotQuery } from "../../orchestration/testing/fakeProjectionSnapshotQuery.ts";
import { GuestShareRepositoryLive } from "../../persistence/Layers/GuestShareRepository.ts";
import { ManagedAttachmentRepositoryLive } from "../../persistence/Layers/ManagedAttachments.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  GuestShareRepository,
  type GuestShareRepositoryShape,
} from "../../persistence/Services/GuestShareRepository.ts";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "../../serverRuntimeStartup.ts";
import { GuestShareOwnerError } from "../Errors.ts";
import { GuestShareService, type GuestShareServiceShape } from "../Services/GuestShareService.ts";
import { ShareRelayTransport } from "../Services/ShareRelayTransport.ts";
import type { GuestRelayRequest, GuestRelayResponse } from "../shareRelayHostClient.ts";
import { FakeShareRelay } from "../testing/fakeShareRelay.ts";
import { GuestShareServiceLive } from "./GuestShareService.ts";

const NOW = "2026-10-29T10:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-guest");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-other");
const TURN_ID = TurnId.makeUnsafe("turn-1");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]);

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Fix the build",
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
    latestTurn: null,
    handoff: null,
    messages: [
      {
        id: MessageId.makeUnsafe("user-1"),
        role: "user",
        text: "hello",
        turnId: TURN_ID,
        streaming: false,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: null,
    archivedAt: null,
    session: null,
    ...overrides,
  } as OrchestrationThread;
}

interface Harness {
  readonly relay: FakeShareRelay;
  readonly service: GuestShareServiceShape;
  readonly commands: Array<OrchestrationCommand>;
  readonly publish: (event: OrchestrationEvent) => Promise<void>;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly sql: SqlClient.SqlClient;
  readonly repository: GuestShareRepositoryShape;
  readonly attachmentsDir: string;
  threads: Map<string, OrchestrationThread>;
  dispatchFailure: Error | null;
  accountSignedIn: boolean;
  readonly dispose: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const relay = await FakeShareRelay.start();
  const commands: Array<OrchestrationCommand> = [];
  const state = {
    threads: new Map<string, OrchestrationThread>([[THREAD_ID, makeThread()]]),
    dispatchFailure: null as Error | null,
    accountSignedIn: true,
  };
  const events = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  let sequence = 1000;
  // The journal head the fake snapshot (sequence 10) and published events advance.
  let highWaterSequence = 10;
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.suspend(() => {
        if (state.dispatchFailure) return Effect.fail(state.dispatchFailure as never);
        commands.push(command);
        return Effect.succeed({ sequence: ++sequence });
      }),
    subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
    streamDomainEvents: Stream.fromPubSub(events),
    getEventHighWaterSequence: Effect.sync(() => highWaterSequence),
    readThreadEventsThrough: () => Stream.empty,
  } as unknown as OrchestrationEngineShape;
  const snapshotQuery = fakeProjectionSnapshotQuery({
    getThreadShellById: (threadId) =>
      Effect.sync(() =>
        Option.fromNullishOr(
          state.threads.get(threadId) as unknown as OrchestrationThreadShell | undefined,
        ),
      ),
    getThreadDetailSnapshotById: (threadId) =>
      Effect.sync(() => {
        const thread = state.threads.get(threadId);
        return thread === undefined
          ? Option.none()
          : Option.some({ snapshotSequence: 10, thread, history: undefined });
      }),
    getThreadDetailWithoutActivitiesById: (threadId) =>
      Effect.sync(() => Option.fromNullishOr(state.threads.get(threadId))),
  });
  const secrets = new Map<string, Uint8Array>();
  const secretStore = Layer.succeed(ServerSecretStore, {
    get: (name) => Effect.succeed(secrets.get(name) ?? null),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = secrets.get(name);
        if (existing) return existing;
        const generated = Uint8Array.from({ length: bytes }, (_, index) => (index * 31 + 7) % 256);
        secrets.set(name, generated);
        return generated;
      }),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });
  const phoneAccount = Layer.succeed(MossPhoneAccountService, {
    getLocalAuthority: () => Effect.succeed({ activeRealm: "cn", identity: null }),
    getAuthorityCredential: () =>
      Effect.suspend(() =>
        state.accountSignedIn
          ? Effect.succeed({
              realm: "memfire-phone",
              issuer: "https://phone.example",
              accessToken: "phone-bearer",
              gatewayBaseUrl: "https://gateway.example",
              realtimeRelayUrl: "wss://relay.example",
            })
          : Effect.fail(
              new MossAccountServiceError({ code: "authentication_required", message: "out" }),
            ),
      ),
  } as unknown as ServiceMap.Service.Shape<typeof MossPhoneAccountService>);
  const cloudAccount = Layer.succeed(MossCloudAccountService, {
    getLocalAuthority: () => Effect.succeed({ identity: null }),
    getAuthorityCredential: () =>
      Effect.fail(
        new MossCloudAccountServiceError({ code: "authentication_required", message: "out" }),
      ),
  } as unknown as ServiceMap.Service.Shape<typeof MossCloudAccountService>);
  const transport = Layer.succeed(ShareRelayTransport, {
    fetch: (input, init) => globalThis.fetch(input, init),
    webSocket: WebSocket,
    env: { MOSS_SHARE_RELAY_URL: relay.origin },
    backoff: { initialMs: 20, maxMs: 100, replacedMs: 100 },
  });
  const persistence = Layer.mergeAll(
    GuestShareRepositoryLive,
    ManagedAttachmentRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
  const layer = GuestShareServiceLive.pipe(
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerRuntimeStartupLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "moss-guest-share-test-" })),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, engine),
        Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
        secretStore,
        phoneAccount,
        cloudAccount,
        transport,
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const startup = await runtime.runPromise(Effect.service(ServerRuntimeStartup));
  await runtime.runPromise(startup.markCommandReady);
  const service = await runtime.runPromise(Effect.service(GuestShareService));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const repository = await runtime.runPromise(Effect.service(GuestShareRepository));
  const config = await runtime.runPromise(Effect.service(ServerConfig));
  return {
    relay,
    service,
    commands,
    publish: (event) => {
      highWaterSequence = Math.max(highWaterSequence, event.sequence);
      return runtime.runPromise(PubSub.publish(events, event).pipe(Effect.asVoid));
    },
    run: (effect) => runtime.runPromise(effect),
    sql,
    repository,
    attachmentsDir: config.attachmentsDir,
    get threads() {
      return state.threads;
    },
    set threads(value) {
      state.threads = value;
    },
    get dispatchFailure() {
      return state.dispatchFailure;
    },
    set dispatchFailure(value) {
      state.dispatchFailure = value;
    },
    get accountSignedIn() {
      return state.accountSignedIn;
    },
    set accountSignedIn(value) {
      state.accountSignedIn = value;
    },
    dispose: async () => {
      await runtime.dispose();
      await relay.close();
    },
  };
}

const encoder = new TextEncoder();

const bytesStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const guestRequest = (input: {
  readonly method?: "GET" | "POST" | "HEAD";
  readonly route: string;
  readonly query?: string;
  readonly headers?: Record<string, string>;
  readonly body?: Uint8Array;
  readonly session?: string;
}): GuestRelayRequest => ({
  method: input.method ?? "GET",
  route: input.route,
  query: input.query ?? "",
  headers: {
    ...(input.session === undefined ? {} : { cookie: `${GUEST_SESSION_COOKIE}=${input.session}` }),
    ...(input.body === undefined ? {} : { "content-length": String(input.body.byteLength) }),
    ...input.headers,
  },
  body: input.body === undefined ? null : bytesStream(input.body),
  signal: new AbortController().signal,
});

const jsonRequest = (route: string, value: unknown, session?: string) =>
  guestRequest({
    method: "POST",
    route,
    headers: { "content-type": "application/json" },
    body: encoder.encode(JSON.stringify(value)),
    ...(session === undefined ? {} : { session }),
  });

function multipartBody(
  parts: ReadonlyArray<{
    readonly name: string;
    readonly data: Uint8Array | string;
    readonly filename?: string;
    readonly contentType?: string;
  }>,
): { readonly contentType: string; readonly body: Uint8Array } {
  const boundary = "----moss-guest-test-boundary";
  const chunks: Array<Uint8Array> = [];
  for (const part of parts) {
    const disposition =
      part.filename === undefined
        ? `form-data; name="${part.name}"`
        : `form-data; name="${part.name}"; filename="${part.filename}"`;
    const headers = [
      `--${boundary}`,
      `Content-Disposition: ${disposition}`,
      ...(part.contentType === undefined ? [] : [`Content-Type: ${part.contentType}`]),
      "",
      "",
    ].join("\r\n");
    chunks.push(encoder.encode(headers));
    chunks.push(typeof part.data === "string" ? encoder.encode(part.data) : part.data);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

async function readBytes(response: GuestRelayResponse): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const readBody = async (response: GuestRelayResponse) =>
  (await readBytes(response)).toString("utf8");

const readJson = async (response: GuestRelayResponse) => JSON.parse(await readBody(response));

/** Reads server-sent events one at a time, ignoring heartbeat comments. */
function makeSseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let buffer = "";
  const pending: Array<GuestStreamEvent> = [];
  return {
    /** The next event, or null once the stream closed. */
    next: async (timeoutMs = 5_000): Promise<GuestStreamEvent | null> => {
      const deadline = Date.now() + timeoutMs;
      while (pending.length === 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("No guest stream event in time.");
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("No guest stream event in time.")), remaining),
          ),
        ]);
        if (result.done) return null;
        buffer += Buffer.from(result.value).toString("utf8");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) pending.push(JSON.parse(line.slice(6)));
          }
        }
      }
      return pending.shift()!;
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const inviteOf = (inviteUrl: string) => new URL(inviteUrl).hash.slice(1);

async function joinShare(harness: Harness, name = "Ada") {
  const created = await harness.run(harness.service.create(THREAD_ID));
  const redeemed = await harness.run(
    harness.service.handleGuestRequest(
      jsonRequest(GUEST_ROUTES.redeem, { credential: inviteOf(created.inviteUrl), name }),
    ),
  );
  expect(redeemed.status).toBe(204);
  const cookie = redeemed.headers["set-cookie"] ?? "";
  const session = decodeURIComponent(/moss_guest=([^;]+)/.exec(cookie)?.[1] ?? "");
  expect(session.length).toBeGreaterThan(0);
  return { created, session };
}

describe("GuestShareService", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe("create", () => {
    it("registers the share with the relay, returns the link, and connects the host", async () => {
      const ownerEvents: Array<GuestShareOwnerEvent> = [];
      const subscription = await harness.run(
        harness.service.subscribe().pipe(
          Stream.runForEach((event) => Effect.sync(() => void ownerEvents.push(event))),
          Effect.forkDetach,
        ),
      );
      await waitFor(() => ownerEvents.length === 1);
      expect(ownerEvents[0]).toEqual({ type: "snapshot", shares: [] });

      const created = await harness.run(harness.service.create(THREAD_ID));
      expect(created.inviteUrl).toBe(
        `${harness.relay.origin}/s/${created.share.id}#${inviteOf(created.inviteUrl)}`,
      );
      expect(created.share).toMatchObject({
        threadId: THREAD_ID,
        relayOrigin: harness.relay.origin,
        inviteUrl: created.inviteUrl,
        guestName: null,
        messages: [],
      });
      expect(harness.relay.registerCalls).toHaveLength(1);
      expect(harness.relay.registerCalls[0]).toMatchObject({
        shareId: created.share.id,
        bearer: "phone-bearer",
        expiresAt: created.share.expiresAt,
      });
      await harness.relay.waitForHost(created.share.id);
      await waitFor(() =>
        ownerEvents.some(
          (event) => event.type === "upsert" && event.share.relayStatus === "online",
        ),
      );
      await harness.run(Fiber.interrupt(subscription));
    });

    it("replaces an earlier share on the thread", async () => {
      const first = await harness.run(harness.service.create(THREAD_ID));
      await harness.relay.waitForHost(first.share.id);
      const second = await harness.run(harness.service.create(THREAD_ID));
      expect(second.share.id).not.toBe(first.share.id);
      await waitFor(() =>
        harness.relay.deleteCalls.some((call) => call.shareId === first.share.id),
      );
      expect(
        harness.relay.deleteCalls.find((call) => call.shareId === first.share.id)?.hostKeyValid,
      ).toBe(true);
      const records = await harness.run(harness.repository.list());
      expect(records.map((record) => record.id)).toEqual([second.share.id]);
    });

    it("needs a signed-in account and surfaces relay rate limits", async () => {
      harness.accountSignedIn = false;
      const noAccount = await harness.run(harness.service.create(THREAD_ID).pipe(Effect.result));
      expect(noAccount._tag === "Failure" && noAccount.failure.code).toBe(
        "guest_share.account_required",
      );
      harness.accountSignedIn = true;
      harness.relay.registerStatus = 429;
      const limited = await harness.run(harness.service.create(THREAD_ID).pipe(Effect.result));
      expect(limited._tag === "Failure" && limited.failure.code).toBe("guest_share.rate_limited");
      expect(await harness.run(harness.service.close(THREAD_ID).pipe(Effect.result))).toMatchObject(
        {
          _tag: "Failure",
          failure: expect.objectContaining({ code: "guest_share.not_found" }),
        },
      );
    });

    it("refuses archived or unknown threads", async () => {
      harness.threads.set(THREAD_ID, makeThread({ archivedAt: NOW }));
      const archived = await harness.run(harness.service.create(THREAD_ID).pipe(Effect.result));
      expect(archived._tag === "Failure" && archived.failure.code).toBe(
        "guest_share.thread_unavailable",
      );
      const unknown = await harness.run(
        harness.service.create(OTHER_THREAD_ID).pipe(Effect.result),
      );
      expect(unknown._tag === "Failure" && unknown.failure.code).toBe(
        "guest_share.thread_unavailable",
      );
    });
  });

  describe("redeem and session", () => {
    it("redeems a link once, sets the session cookie, and then refuses it as used", async () => {
      const { created, session } = await joinShare(harness);
      const check = await harness.run(
        harness.service.handleGuestRequest(guestRequest({ route: GUEST_ROUTES.session, session })),
      );
      expect(check.status).toBe(204);
      const again = await harness.run(
        harness.service.handleGuestRequest(
          jsonRequest(GUEST_ROUTES.redeem, {
            credential: inviteOf(created.inviteUrl),
            name: "Bob",
          }),
        ),
      );
      expect(again.status).toBe(409);
      expect(await readJson(again)).toMatchObject({ reason: "used" });
    });

    it("refuses a forged credential, a missing session, and an expired share", async () => {
      const { created, session } = await joinShare(harness);
      const forged = await harness.run(
        harness.service.handleGuestRequest(
          jsonRequest(GUEST_ROUTES.redeem, {
            credential: `${created.share.id}.AAAAAAAAAAAAAAAAAAAAAA`,
            name: "Eve",
          }),
        ),
      );
      expect(forged.status).toBe(403);
      expect(await readJson(forged)).toMatchObject({ reason: "invalid" });
      const anonymous = await harness.run(
        harness.service.handleGuestRequest(guestRequest({ route: GUEST_ROUTES.session })),
      );
      expect(anonymous.status).toBe(403);
      expect(await readJson(anonymous)).toMatchObject({ reason: "invalid" });
      await harness.run(
        harness.sql`UPDATE guest_shares SET expires_at = ${"2020-01-01T00:00:00.000Z"}`,
      );
      const expired = await harness.run(
        harness.service.handleGuestRequest(guestRequest({ route: GUEST_ROUTES.session, session })),
      );
      expect(expired.status).toBe(403);
      expect(await readJson(expired)).toMatchObject({ reason: "inactive" });
    });

    it("rejects a malformed redeem body and an oversized one", async () => {
      await harness.run(harness.service.create(THREAD_ID));
      const malformed = await harness.run(
        harness.service.handleGuestRequest(jsonRequest(GUEST_ROUTES.redeem, { name: "x" })),
      );
      expect(malformed.status).toBe(400);
      const oversized = await harness.run(
        harness.service.handleGuestRequest(
          guestRequest({
            method: "POST",
            route: GUEST_ROUTES.redeem,
            headers: { "content-type": "application/json" },
            body: encoder.encode(JSON.stringify({ credential: "x".repeat(70_000), name: "y" })),
          }),
        ),
      );
      expect(oversized.status).toBe(400);
      expect(await readJson(oversized)).toMatchObject({ reason: "too_large" });
    });
  });

  describe("messages", () => {
    it("takes text proposals until the pending limit, then answers busy", async () => {
      const { session } = await joinShare(harness);
      for (let index = 0; index < GUEST_PENDING_MESSAGE_LIMIT; index += 1) {
        const response = await harness.run(
          harness.service.handleGuestRequest(
            jsonRequest(GUEST_ROUTES.messages, { text: `proposal ${index}` }, session),
          ),
        );
        expect(response.status).toBe(204);
      }
      const busy = await harness.run(
        harness.service.handleGuestRequest(
          jsonRequest(GUEST_ROUTES.messages, { text: "more" }, session),
        ),
      );
      expect(busy.status).toBe(409);
      expect(await readJson(busy)).toMatchObject({ reason: "busy" });
      const empty = await harness.run(
        harness.service.handleGuestRequest(
          jsonRequest(GUEST_ROUTES.messages, { text: "  " }, session),
        ),
      );
      expect(await readJson(empty)).toMatchObject({ reason: "empty" });
      const anonymous = await harness.run(
        harness.service.handleGuestRequest(jsonRequest(GUEST_ROUTES.messages, { text: "x" })),
      );
      expect(anonymous.status).toBe(403);
    });

    it("stores multipart files as the share's managed attachments and checks image bytes", async () => {
      const { session } = await joinShare(harness);
      const accepted = multipartBody([
        { name: "text", data: "see attached" },
        { name: "file", filename: "shot.png", contentType: "image/png", data: PNG },
        { name: "file", filename: "notes.txt", contentType: "text/plain", data: "plain notes" },
      ]);
      const response = await harness.run(
        harness.service.handleGuestRequest(
          guestRequest({
            method: "POST",
            route: GUEST_ROUTES.messages,
            headers: { "content-type": accepted.contentType },
            body: accepted.body,
            session,
          }),
        ),
      );
      expect(response.status).toBe(204);
      const view = await harness.run(harness.repository.getByThreadId(THREAD_ID));
      const message = Option.getOrThrow(view).messages[0]!;
      expect(message.text).toBe("see attached");
      expect(
        message.attachments.map((attachment) => [
          attachment.type,
          attachment.name,
          attachment.mimeType,
        ]),
      ).toEqual([
        ["image", "shot.png", "image/png"],
        ["file", "notes.txt", "text/plain"],
      ]);
      const blobs = await harness.run(
        harness.sql<{
          readonly state: string;
          readonly ownerKind: string;
          readonly ownerId: string;
          readonly relativePath: string;
        }>`
          SELECT state, owner_kind AS "ownerKind", owner_id AS "ownerId", relative_path AS "relativePath"
          FROM managed_attachment_blobs ORDER BY created_at
        `,
      );
      expect(blobs).toHaveLength(2);
      expect(
        blobs.every((blob) => blob.state === "staged" && blob.ownerKind === "guest-share"),
      ).toBe(true);
      expect(
        blobs.every((blob) => fs.existsSync(path.join(harness.attachmentsDir, blob.relativePath))),
      ).toBe(true);

      const fakeImage = multipartBody([
        { name: "text", data: "" },
        { name: "file", filename: "page.png", contentType: "image/png", data: "<html></html>" },
      ]);
      const rejected = await harness.run(
        harness.service.handleGuestRequest(
          guestRequest({
            method: "POST",
            route: GUEST_ROUTES.messages,
            headers: { "content-type": fakeImage.contentType },
            body: fakeImage.body,
            session,
          }),
        ),
      );
      expect(rejected.status).toBe(400);
      expect(await readJson(rejected)).toMatchObject({ reason: "unsupported_file" });

      const tooMany = multipartBody([
        { name: "text", data: "" },
        ...Array.from({ length: 5 }, (_, index) => ({
          name: "file",
          filename: `f${index}.txt`,
          contentType: "text/plain",
          data: "x",
        })),
      ]);
      const refused = await harness.run(
        harness.service.handleGuestRequest(
          guestRequest({
            method: "POST",
            route: GUEST_ROUTES.messages,
            headers: { "content-type": tooMany.contentType },
            body: tooMany.body,
            session,
          }),
        ),
      );
      expect(refused.status).toBe(400);
      expect(await readJson(refused)).toMatchObject({ reason: "too_many_files" });
      const blobsAfter = await harness.run(
        harness.sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM managed_attachment_blobs WHERE state = 'staged'`,
      );
      expect(blobsAfter[0]?.count).toBe(2);
    });

    it("serves the guest's own files and the thread's files, but nothing else", async () => {
      const { session } = await joinShare(harness);
      const upload = multipartBody([
        { name: "text", data: "pic" },
        { name: "file", filename: "shot.png", contentType: "image/png", data: PNG },
      ]);
      await harness.run(
        harness.service.handleGuestRequest(
          guestRequest({
            method: "POST",
            route: GUEST_ROUTES.messages,
            headers: { "content-type": upload.contentType },
            body: upload.body,
            session,
          }),
        ),
      );
      const share = Option.getOrThrow(
        await harness.run(harness.repository.getByThreadId(THREAD_ID)),
      );
      const attachmentId = share.messages[0]!.attachments[0]!.id;
      const served = await harness.run(
        harness.service.handleGuestRequest(
          guestRequest({ route: GUEST_ROUTES.attachment, query: `id=${attachmentId}`, session }),
        ),
      );
      expect(served.status).toBe(200);
      expect(served.headers["content-type"]).toBe("image/png");
      expect(await readBytes(served)).toEqual(Buffer.from(PNG));
      const unknown = await harness.run(
        harness.service.handleGuestRequest(
          guestRequest({
            route: GUEST_ROUTES.attachment,
            query: "id=att_v2_00000000000000000000000000000000",
            session,
          }),
        ),
      );
      expect(unknown.status).toBe(403);
      expect(await readJson(unknown)).toMatchObject({ reason: "unavailable" });
    });
  });

  describe("owner decisions", () => {
    it("sends a message to the agent exactly once, with attribution and attachments", async () => {
      const { session } = await joinShare(harness);
      const upload = multipartBody([
        { name: "text", data: "please add tests" },
        { name: "file", filename: "shot.png", contentType: "image/png", data: PNG },
      ]);
      await harness.run(
        harness.service.handleGuestRequest(
          guestRequest({
            method: "POST",
            route: GUEST_ROUTES.messages,
            headers: { "content-type": upload.contentType },
            body: upload.body,
            session,
          }),
        ),
      );
      const share = Option.getOrThrow(
        await harness.run(harness.repository.getByThreadId(THREAD_ID)),
      );
      const guestMessageId = share.messages[0]!.id;
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          harness.run(
            harness.service
              .resolveMessage({ threadId: THREAD_ID, guestMessageId, decision: "send" })
              .pipe(Effect.result),
          ),
        ),
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(
        results
          .filter((result) => result._tag === "Failure")
          .map((result) => result._tag === "Failure" && result.failure.code),
      ).toEqual(["guest_share.message_not_pending", "guest_share.message_not_pending"]);
      expect(harness.commands).toHaveLength(1);
      const command = harness.commands[0]!;
      expect(command.type).toBe("thread.turn.start");
      if (command.type !== "thread.turn.start") return;
      expect(command.message.text).toBe(
        "Message from guest Ada, sent by the owner:\n\nplease add tests",
      );
      expect(command.message.attachments).toEqual(share.messages[0]!.attachments);
      expect(command).toMatchObject({
        threadId: THREAD_ID,
        dispatchMode: "queue",
        runtimeMode: "full-access",
        interactionMode: "default",
        modelSelection: { provider: "codex", model: "gpt-5.5" },
      });
      const after = Option.getOrThrow(
        await harness.run(harness.repository.getByThreadId(THREAD_ID)),
      );
      expect(after.messages[0]?.status).toBe("sent");
      expect(after.sentMessages).toEqual([
        { guestMessageId, messageId: command.message.messageId },
      ]);
    });

    it("puts a message back when the dispatch fails", async () => {
      const { session } = await joinShare(harness);
      await harness.run(
        harness.service.handleGuestRequest(
          jsonRequest(GUEST_ROUTES.messages, { text: "retry me" }, session),
        ),
      );
      const share = Option.getOrThrow(
        await harness.run(harness.repository.getByThreadId(THREAD_ID)),
      );
      const guestMessageId = share.messages[0]!.id;
      harness.dispatchFailure = new Error("provider down");
      const failed = await harness.run(
        harness.service
          .resolveMessage({ threadId: THREAD_ID, guestMessageId, decision: "send" })
          .pipe(Effect.result),
      );
      expect(failed._tag === "Failure" && failed.failure.code).toBe("guest_share.send_failed");
      const after = Option.getOrThrow(
        await harness.run(harness.repository.getByThreadId(THREAD_ID)),
      );
      expect(after.messages[0]?.status).toBe("pending");
      expect(after.sentMessages).toEqual([]);
      harness.dispatchFailure = null;
      await harness.run(
        harness.service.resolveMessage({ threadId: THREAD_ID, guestMessageId, decision: "send" }),
      );
      expect(harness.commands).toHaveLength(1);
    });

    it("dismisses a message and deletes its files", async () => {
      const { session } = await joinShare(harness);
      const upload = multipartBody([
        { name: "text", data: "never mind" },
        { name: "file", filename: "shot.png", contentType: "image/png", data: PNG },
      ]);
      await harness.run(
        harness.service.handleGuestRequest(
          guestRequest({
            method: "POST",
            route: GUEST_ROUTES.messages,
            headers: { "content-type": upload.contentType },
            body: upload.body,
            session,
          }),
        ),
      );
      const blobs = await harness.run(
        harness.sql<{
          readonly relativePath: string;
        }>`SELECT relative_path AS "relativePath" FROM managed_attachment_blobs`,
      );
      const filePath = path.join(harness.attachmentsDir, blobs[0]!.relativePath);
      expect(fs.existsSync(filePath)).toBe(true);
      const share = Option.getOrThrow(
        await harness.run(harness.repository.getByThreadId(THREAD_ID)),
      );
      await harness.run(
        harness.service.resolveMessage({
          threadId: THREAD_ID,
          guestMessageId: share.messages[0]!.id,
          decision: "dismiss",
        }),
      );
      expect(fs.existsSync(filePath)).toBe(false);
      const states = await harness.run(
        harness.sql<{ readonly state: string }>`SELECT state FROM managed_attachment_blobs`,
      );
      expect(states[0]?.state).toBe("deleting");
      const again = await harness.run(
        harness.service
          .resolveMessage({
            threadId: THREAD_ID,
            guestMessageId: share.messages[0]!.id,
            decision: "dismiss",
          })
          .pipe(Effect.result),
      );
      expect(again._tag === "Failure" && again.failure.code).toBe(
        "guest_share.message_not_pending",
      );
      expect(harness.commands).toHaveLength(0);
    });
  });

  describe("stream", () => {
    const openStream = async (session: string) => {
      const response = await harness.run(
        harness.service.handleGuestRequest(guestRequest({ route: GUEST_ROUTES.stream, session })),
      );
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream");
      return makeSseReader(response.body!);
    };

    it("opens with hello, view, and the owner's snapshot, then follows the thread live", async () => {
      const { session } = await joinShare(harness);
      const reader = await openStream(session);
      expect(await reader.next()).toEqual({
        type: "hello",
        protocolVersion: GUEST_SHARE_PROTOCOL_VERSION,
      });
      expect(await reader.next()).toMatchObject({
        type: "view",
        view: { guestName: "Ada", messages: [], model: { provider: "codex", name: "GPT-5.5" } },
      });
      const snapshot = await reader.next();
      expect(snapshot).toMatchObject({
        type: "thread",
        item: {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: 10,
            thread: { id: THREAD_ID, title: "Fix the build", branch: null, worktreePath: null },
            history: { totalMessageCount: 1, olderCursor: null },
          },
        },
      });
      const snapshotThread =
        snapshot?.type === "thread" && snapshot.item.kind === "snapshot"
          ? snapshot.item.snapshot.thread
          : null;
      expect(snapshotThread?.messages.map((message) => message.id)).toEqual(["user-1"]);
      expect(snapshotThread).not.toHaveProperty("notes");

      const payload = {
        threadId: THREAD_ID,
        messageId: MessageId.makeUnsafe("assistant-1"),
        role: "assistant",
        text: "Working on it",
        turnId: TURN_ID,
        streaming: true,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW,
      } as const;
      await harness.publish({
        sequence: 11,
        eventId: EventId.makeUnsafe("event-11"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: NOW,
        commandId: CommandId.makeUnsafe("command-11"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload,
      });
      expect(await reader.next()).toMatchObject({
        type: "thread",
        item: { kind: "event", event: { sequence: 11, type: "thread.message-sent", payload } },
      });

      // Owner-private events are not forwarded; a title change is.
      await harness.publish({
        sequence: 12,
        eventId: EventId.makeUnsafe("event-12"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: NOW,
        commandId: CommandId.makeUnsafe("command-12"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.meta-updated",
        payload: { threadId: THREAD_ID, notes: "private", updatedAt: NOW },
      });
      await harness.publish({
        sequence: 13,
        eventId: EventId.makeUnsafe("event-13"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: NOW,
        commandId: CommandId.makeUnsafe("command-13"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.meta-updated",
        payload: {
          threadId: THREAD_ID,
          title: "Renamed",
          worktreePath: "/private",
          updatedAt: NOW,
        },
      });
      expect(await reader.next()).toMatchObject({
        type: "thread",
        item: {
          kind: "event",
          event: {
            sequence: 13,
            type: "thread.meta-updated",
            payload: { threadId: THREAD_ID, title: "Renamed", updatedAt: NOW },
          },
        },
      });

      // The guest's own proposal updates their view.
      await harness.run(
        harness.service.handleGuestRequest(
          jsonRequest(GUEST_ROUTES.messages, { text: "hi" }, session),
        ),
      );
      const view = await reader.next();
      expect(view).toMatchObject({ type: "view" });
      expect(view?.type === "view" && view.view.messages.map((message) => message.status)).toEqual([
        "pending",
      ]);

      // Stopping the share ends the stream with `ended`.
      await harness.run(harness.service.close(THREAD_ID));
      expect(await reader.next()).toEqual({ type: "ended", reason: "closed" });
      expect(await reader.next()).toBeNull();
    });

    it("ends with `replaced` when the owner creates a new link", async () => {
      const { session } = await joinShare(harness);
      const reader = await openStream(session);
      for (let index = 0; index < 3; index += 1) await reader.next();
      await harness.run(harness.service.create(THREAD_ID));
      expect(await reader.next()).toEqual({ type: "ended", reason: "replaced" });
      const stale = await harness.run(
        harness.service.handleGuestRequest(guestRequest({ route: GUEST_ROUTES.session, session })),
      );
      expect(stale.status).toBe(403);
    });

    it("ends with `archived` when the thread is archived", async () => {
      const { created, session } = await joinShare(harness);
      await harness.relay.waitForHost(created.share.id);
      const reader = await openStream(session);
      for (let index = 0; index < 3; index += 1) await reader.next();
      await harness.publish({
        sequence: 12,
        eventId: EventId.makeUnsafe("event-12"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: NOW,
        commandId: CommandId.makeUnsafe("command-12"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.archived",
        payload: { threadId: THREAD_ID, archivedAt: NOW, updatedAt: NOW },
      });
      expect(await reader.next()).toEqual({ type: "ended", reason: "archived" });
      await waitFor(() =>
        harness.relay.deleteCalls.some((call) => call.shareId === created.share.id),
      );
      expect(harness.relay.hosts.has(created.share.id)).toBe(false);
    });
  });

  describe("through the relay", () => {
    it("answers guest requests forwarded over the host socket", async () => {
      const { created, session } = await joinShare(harness);
      const host = await harness.relay.waitForHost(created.share.id);
      const { response } = host.request({
        method: "GET",
        route: GUEST_ROUTES.session,
        headers: { cookie: `${GUEST_SESSION_COOKIE}=${session}` },
      });
      expect((await response.head).status).toBe(204);
      expect(await response.text()).toBe("");
      const proposal = host.request({
        method: "POST",
        route: GUEST_ROUTES.messages,
        headers: {
          "content-type": "application/json",
          cookie: `${GUEST_SESSION_COOKIE}=${session}`,
        },
        body: [encoder.encode(JSON.stringify({ text: "over the relay" }))],
      });
      expect((await proposal.response.head).status).toBe(204);
      const ownerEvents = await harness.run(
        harness.service.subscribe().pipe(Stream.take(1), Stream.runCollect),
      );
      const share = (ownerEvents[0] as Extract<GuestShareOwnerEvent, { type: "snapshot" }>)
        .shares[0]!;
      expect(share.messages.map((message) => message.text)).toEqual(["over the relay"]);
      expect(share.relayStatus).toBe("online");
      expect(share).toMatchObject({
        guestName: "Ada",
        inviteUrl: null,
      } satisfies Partial<ThreadGuestShare>);
      expect(GuestShareOwnerError.name).toBe("GuestShareOwnerError");
      expect(GuestMessageId.makeUnsafe(share.messages[0]!.id)).toBe(share.messages[0]!.id);
    });
  });
});
