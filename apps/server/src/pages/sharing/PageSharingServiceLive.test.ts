import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PAGE_GUEST_LINK_PARAM,
  type PageGuestView,
  type PageId,
  type PageShareTarget,
  type SpaceItemKind,
} from "@moss/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Layer, ManagedRuntime, type ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import { MossCloudAccountServiceError } from "../../account/mossCloudAccountErrors.ts";
import { MossCloudAccountService } from "../../account/Services/MossCloudAccountService.ts";
import { MossPhoneAccountService } from "../../account/Services/MossPhoneAccountService.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ShareRelayTransport } from "../../guestShare/Services/ShareRelayTransport.ts";
import { FakeShareRelay } from "../../guestShare/testing/fakeShareRelay.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { LibraryRepositoryLive } from "../../persistence/Layers/LibraryRepository.ts";
import { makeLibraryServiceShape } from "../../library/Layers/LibraryService.ts";
import { resolveLibraryScanRoots } from "../../library/libraryScan.ts";
import { LibraryService, type LibraryServiceShape } from "../../library/Services/LibraryService.ts";
import {
  PageRealtimeService,
  PagesRealtimeLive,
  type PageRealtimeServiceShape,
} from "../realtime/PageRealtimeService";
import {
  GuestPageContentWriter,
  GuestPageContentWriterLive,
  PAGE_GUEST_AUTHOR_KEY_PURPOSE,
  type GuestPageContentWrite,
  type GuestPageContentWriterShape,
} from "../guestEditing/GuestPageContentWriter";
import {
  GuestPageRealtimeWriter,
  GuestPageRealtimeWriterLive,
  type GuestPageRealtimeWriterShape,
} from "../guestEditing/GuestPageRealtimeWriter";
import {
  GuestPageProjectionService,
  GuestPageProjectionServiceLive,
} from "../guestEditing/GuestPageProjectionService";
import { registerProjectionAdapterCases } from "../guestEditing/testing/registerProjectionAdapterCases";
import { registerGuestEditRelayCases } from "../guestEditing/testing/registerGuestEditRelayCases";
import { applyPlateValue, readPageDoc } from "../realtime/pageYjsContent";
import { sendRoomEdit } from "../realtime/testing/sendRoomEdit";
import {
  LOCAL_PAGES_PRINCIPAL,
  PagesService,
  type PagesServiceShape,
} from "../Services/PagesService.ts";
import { makePageAppsServiceShape, PageAppsService } from "../apps/PageAppsService.ts";
import { makePageAppPublications } from "./pageAppPublications.ts";
import { makePageAppPublicationOwner } from "./PageAppPublicationOwner.ts";
import { makePageSharingRpcHandlers } from "./pageSharingRpc.ts";
import { CurrentWsSessionRole } from "../../wsConnectionSessions.ts";
import { createPublishedPageAppPreview } from "./publishedPageAppPreview.ts";
import { pageAppPreviewIssuer } from "./pageAppPreviewTickets.ts";
import { preparePageAppPreviewDocument } from "./pageAppPreviewDocument.ts";
import { PageSharingService, type PageSharingServiceShape } from "./PageSharingService.ts";
import { PageSharingServiceLive } from "./PageSharingServiceLive.ts";

const VISITOR = "visitor-test-0001";
const encoder = new TextEncoder();

export interface Harness {
  readonly relayEnv: NodeJS.ProcessEnv;
  readonly closeService: () => Promise<void>;
  readonly sql: SqlClient.SqlClient;
  readonly pages: PagesServiceShape;
  readonly writer: GuestPageContentWriterShape;
  readonly frameWriter: GuestPageRealtimeWriterShape;
  readonly projection: ServiceMap.Service.Shape<typeof GuestPageProjectionService>;
  readonly realtime: PageRealtimeServiceShape;
  readonly secretNames: () => string[];
  readonly library: LibraryServiceShape;
  readonly relay: FakeShareRelay;
  readonly sharing: PageSharingServiceShape;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: { signal: AbortSignal },
  ) => Promise<A>;
  readonly createPage: (
    title: string,
    content: string,
    options?: {
      spaceId?: string;
      parentPageId?: string;
      richContent?: string;
      kind?: SpaceItemKind;
    },
  ) => Promise<{ id: PageId; revision: number }>;
  readonly createSpace: (title: string) => Promise<{ id: string; rootPageId: PageId }>;
  readonly updatePage: (
    id: PageId,
    revision: number,
    content: string,
    richContent?: string,
  ) => Promise<number>;
  readonly dispose: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "page-share-media-"));
  const homes = {
    mossHome: directory,
    codexHome: path.join(directory, "codex"),
    claudeHome: path.join(directory, "claude"),
  };
  const libraryLayer = Layer.effect(
    LibraryService,
    makeLibraryServiceShape({
      roots: resolveLibraryScanRoots(homes),
      importRoot: path.join(directory, "library"),
    }),
  ).pipe(Layer.provide(LibraryRepositoryLive));
  const relay = await FakeShareRelay.start();
  relay.appPreviewContentOrigin = "http://localhost:53842";
  const secrets = new Map<string, Uint8Array>();
  const secretStore = Layer.succeed(ServerSecretStore, {
    get: (name) => Effect.succeed(secrets.get(name) ?? null),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = secrets.get(name);
        if (existing) return existing;
        const generated = Uint8Array.from({ length: bytes }, (_, index) => (index * 17 + 3) % 256);
        secrets.set(name, generated);
        return generated;
      }),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });
  const phoneAccount = Layer.succeed(MossPhoneAccountService, {
    getLocalAuthority: () => Effect.succeed({ activeRealm: "cn", identity: null }),
    getAuthorityCredential: () =>
      Effect.succeed({
        realm: "memfire-phone",
        issuer: "https://phone.example",
        accessToken: "phone-bearer",
        gatewayBaseUrl: "https://gateway.example",
        realtimeRelayUrl: "wss://relay.example",
      }),
  } as unknown as ServiceMap.Service.Shape<typeof MossPhoneAccountService>);
  const cloudAccount = Layer.succeed(MossCloudAccountService, {
    getLocalAuthority: () => Effect.succeed({ identity: null }),
    getAuthorityCredential: () =>
      Effect.fail(
        new MossCloudAccountServiceError({ code: "authentication_required", message: "out" }),
      ),
  } as unknown as ServiceMap.Service.Shape<typeof MossCloudAccountService>);
  const relayEnv = {
    MOSS_SHARE_RELAY_URL: relay.origin,
    MOSS_PAGE_GUEST_EDIT_ENABLED: "1",
  } as NodeJS.ProcessEnv;
  const transport = Layer.succeed(ShareRelayTransport, {
    fetch: (input, init) => globalThis.fetch(input, init),
    webSocket: WebSocket,
    env: relayEnv,
    backoff: { initialMs: 20, maxMs: 100, replacedMs: 100 },
  });
  const pagesLayer = PagesRealtimeLive;
  const layer = Layer.mergeAll(
    GuestPageContentWriterLive,
    GuestPageRealtimeWriterLive,
    GuestPageProjectionServiceLive,
  ).pipe(
    Layer.provideMerge(PageSharingServiceLive),
    Layer.provideMerge(
      Layer.effect(
        PageAppsService,
        makePageAppsServiceShape({
          ai: {
            async *ask() {
              throw new Error("guest previews may not call AI");
            },
          },
        }),
      ),
    ),
    Layer.provideMerge(pagesLayer),
    Layer.provideMerge(libraryLayer),
    Layer.provideMerge(Layer.mergeAll(secretStore, phoneAccount, cloudAccount, transport)),
    Layer.provideMerge(
      process.env.MOSS_TEST_G3_LOOPBACK_ORIGIN
        ? makeSqlitePersistenceLive(path.join(directory, "guest-edit.sqlite"))
        : SqlitePersistenceMemory,
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const sharing = await runtime.runPromise(Effect.service(PageSharingService));
  const pages = await runtime.runPromise(Effect.service(PagesService));
  const library = await runtime.runPromise(Effect.service(LibraryService));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const writer = await runtime.runPromise(Effect.service(GuestPageContentWriter));
  const frameWriter = await runtime.runPromise(Effect.service(GuestPageRealtimeWriter));
  const projection = await runtime.runPromise(Effect.service(GuestPageProjectionService));
  const realtime = await runtime.runPromise(Effect.service(PageRealtimeService));
  const run = <A, E>(effect: Effect.Effect<A, E>, options?: { signal: AbortSignal }) =>
    runtime.runPromise(effect, options);
  return {
    relayEnv,
    writer,
    frameWriter,
    projection,
    realtime,
    secretNames: () => [...secrets.keys()],
    closeService: () => runtime.dispose(),
    sql,
    pages,
    library,
    relay,
    sharing,
    run,
    createPage: async (title, content, options = {}) => {
      const result = await run(
        pages.mutate(
          {
            op: "create",
            requestId: randomUUID(),
            scopeSpaceId: null,
            title,
            content,
            ...(options.kind === undefined ? {} : { kind: options.kind }),
            ...(options.richContent === undefined ? {} : { richContent: options.richContent }),
            spaceId: (options.spaceId ?? null) as never,
            parentPageId: (options.parentPageId ?? null) as never,
          },
          LOCAL_PAGES_PRINCIPAL,
        ),
      );
      return { id: result.page.id, revision: result.page.revision };
    },
    createSpace: async (title) => {
      const result = await run(
        pages.mutate(
          { op: "create-space", requestId: randomUUID(), scopeSpaceId: null, title, content: "" },
          LOCAL_PAGES_PRINCIPAL,
        ),
      );
      return { id: result.space!.id, rootPageId: result.space!.rootPageId };
    },
    updatePage: async (id, revision, content, richContent) => {
      const result = await run(
        pages.mutate(
          {
            op: "update",
            requestId: randomUUID(),
            scopeSpaceId: null,
            pageId: id,
            expectedRevision: revision,
            content,
            ...(richContent === undefined ? {} : { richContent }),
          },
          LOCAL_PAGES_PRINCIPAL,
        ),
      );
      return result.page.revision;
    },
    dispose: async () => {
      await runtime.dispose();
      await relay.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

/** Splits a page URL into what the guest page would send: link id and fragment credential. */
const entryOf = (url: string) => {
  const parsed = new URL(url);
  const link = parsed.searchParams.get(PAGE_GUEST_LINK_PARAM);
  const key = parsed.hash.length > 1 ? decodeURIComponent(parsed.hash.slice(1)) : undefined;
  return {
    shareId: parsed.pathname.split("/")[2]!,
    ...(link === null ? {} : { link }),
    ...(key === undefined ? {} : { key }),
  };
};

async function guest(
  harness: Harness,
  shareId: string,
  route: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const host = await harness.relay.waitForHost(shareId);
  const { response } = host.request({
    method: "POST",
    route,
    headers: { "content-type": "application/json" },
    body: [encoder.encode(JSON.stringify({ visitor: VISITOR, ...body }))],
  });
  const head = await response.head;
  return { status: head.status, body: JSON.parse(await response.text()) };
}

const openPage = async (harness: Harness, url: string, extra: Record<string, unknown> = {}) => {
  const { shareId, ...entry } = entryOf(url);
  return guest(harness, shareId, "page", { ...entry, ...extra });
};

const pageTarget = (id: PageId): PageShareTarget => ({ kind: "page", id });

const IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const imageDocument = (url: string) =>
  JSON.stringify([{ type: "img", url, children: [{ text: "" }] }]);
async function media(harness: Harness, url: string, body: Record<string, unknown>) {
  const { shareId, ...entry } = entryOf(url);
  const host = await harness.relay.waitForHost(shareId);
  const { response } = host.request({
    method: "POST",
    route: "page-media",
    headers: { "content-type": "application/json" },
    body: [encoder.encode(JSON.stringify({ visitor: VISITOR, ...entry, ...body }))],
  });
  const head = await response.head;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await response.next();
    if (chunk === null) break;
    chunks.push(chunk);
  }
  return { ...head, bytes: Buffer.concat(chunks) };
}

async function uploadImage(harness: Harness, name: string) {
  return (
    await harness.run(
      harness.library.importFiles({
        files: [{ name, dataBase64: IMAGE_BYTES.toString("base64") }],
      }),
    )
  ).items[0]!;
}

describe("PageSharingService", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await makeHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  registerProjectionAdapterCases(() => harness);
  registerGuestEditRelayCases(() => harness);

  describe("internal guest edit eligibility", () => {
    type Request = Parameters<PageSharingServiceShape["resolveEditableGuestPage"]>[0];
    const resolve = (
      url: string,
      pageId: PageId,
      expectedPageRevision: number,
      extra: Partial<Request> = {},
    ) => {
      const { shareId: _shareId, ...proof } = entryOf(url);
      return harness.run(
        harness.sharing.resolveEditableGuestPage({
          ...proof,
          visitor: VISITOR,
          pageId,
          expectedPageRevision,
          ...extra,
        }),
      );
    };
    const share = async (pageId: PageId, role: "view" | "comment" | "edit" = "edit") => {
      const target = pageTarget(pageId);
      const current = await harness.run(harness.sharing.get({ scopeSpaceId: null, target }));
      return harness.run(
        harness.sharing.mutate({
          op: "set-link",
          scopeSpaceId: null,
          target,
          expectedVersion: current.version,
          setting: { access: "link", role },
        }),
      );
    };

    it("returns only current edit eligibility and an entry reference without writes or visitor identity", async () => {
      const page = await harness.createPage("Editable", "Content");
      const state = await share(page.id);
      const before = await harness.run(
        harness.sql`SELECT (SELECT COUNT(*) FROM pages_versions) AS versions, (SELECT COUNT(*) FROM pages_share_events) AS events`,
      );
      const result = await resolve(state.linkUrl!, page.id, page.revision);
      expect(result).toEqual({
        pageId: page.id,
        pageRevision: page.revision,
        scopeSpaceId: null,
        role: "edit",
        entry: {
          target: pageTarget(page.id),
          linkId: entryOf(state.linkUrl!).link,
          linkVersion: state.version,
        },
        actorRef: { kind: "share-link", linkId: entryOf(state.linkUrl!).link },
      });
      expect(
        await resolve(state.linkUrl!, page.id, page.revision, { visitor: "different-visitor" }),
      ).toEqual(result);
      expect(JSON.stringify(result)).not.toContain(entryOf(state.linkUrl!).key!);
      expect(JSON.stringify(result)).not.toContain(VISITOR);
      const after = await harness.run(
        harness.sql`SELECT (SELECT COUNT(*) FROM pages_versions) AS versions, (SELECT COUNT(*) FROM pages_share_events) AS events`,
      );
      expect(after).toEqual(before);
    });
    it.each(["view", "comment"] as const)(
      "never upgrades %s access to edit eligibility",
      async (role) => {
        const page = await harness.createPage("Readonly", "Content");
        const state = await share(page.id, role);
        await expect(resolve(state.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
          reason: "forbidden",
        });
      },
    );
    it.each(["app", "slides", "sheet", "board", "site", "file", "image"] as const)(
      "refuses a %s item's separate data model",
      async (kind) => {
        const page = await harness.createPage("Typed item", "Content", { kind });
        const state = await share(page.id);
        await expect(resolve(state.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
          reason: "forbidden",
        });
      },
    );
    it("never edits a published site even when its source page has an edit link", async () => {
      const page = await harness.createPage("Published", "Content");
      await share(page.id);
      const { site } = await harness.run(
        harness.sharing.siteMutate({
          op: "publish",
          scopeSpaceId: null,
          pageId: page.id,
          visibility: "anyone",
          acceptTerms: true,
        }),
      );
      await expect(resolve(site.url!, page.id, page.revision)).rejects.toMatchObject({
        reason: "forbidden",
      });
    });
    it.each(["visitor", "revision", "page-id"])(
      "validates malformed %s before authorization",
      async (field) => {
        const page = await harness.createPage("Editable", "Content");
        const state = await share(page.id);
        const invalid =
          field === "visitor"
            ? { visitor: "bad" }
            : field === "revision"
              ? { expectedPageRevision: Number.NaN }
              : { pageId: undefined };
        await expect(
          resolve(state.linkUrl!, page.id, page.revision, invalid as Partial<Request>),
        ).rejects.toMatchObject({ reason: "invalid" });
      },
    );
    it("rejects a stale revision instead of silently switching the edit base", async () => {
      const page = await harness.createPage("Editable", "Content");
      const state = await share(page.id);
      const updated = await harness.updatePage(page.id, page.revision, "New content");
      await expect(resolve(state.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect((await resolve(state.linkUrl!, page.id, updated)).pageRevision).toBe(updated);
    });
    it("cannot use an edit link for an unrelated page", async () => {
      const page = await harness.createPage("Shared", "Content");
      const other = await harness.createPage("Private", "Content");
      const state = await share(page.id);
      await expect(resolve(state.linkUrl!, other.id, other.revision)).rejects.toMatchObject({
        reason: "forbidden",
      });
    });
    it("cannot borrow a target page from another authorization scope", async () => {
      const page = await harness.createPage("Editable", "Content");
      const state = await share(page.id);
      await harness.run(
        harness.sql`UPDATE pages_share_links SET scope_key = 'project-space:other' WHERE target_id = ${page.id}`,
      );
      await expect(resolve(state.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
    });
    it("rechecks real proof rotation, forged proof and credential absence", async () => {
      const page = await harness.createPage("Editable", "Content");
      const state = await share(page.id);
      await expect(
        resolve(state.linkUrl!, page.id, page.revision, { key: "forged" }),
      ).rejects.toMatchObject({ reason: "forbidden" });
      await expect(
        harness.run(
          harness.sharing.resolveEditableGuestPage({
            visitor: VISITOR,
            pageId: page.id,
            expectedPageRevision: page.revision,
          }),
        ),
      ).rejects.toMatchObject({ reason: "unavailable" });
      await harness.run(
        harness.sharing.mutate({
          op: "rotate-link",
          scopeSpaceId: null,
          target: pageTarget(page.id),
          expectedVersion: state.version,
        }),
      );
      await expect(resolve(state.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
    });
    it("derives member references from authenticated proof and rechecks role downgrade/removal", async () => {
      const page = await harness.createPage("Editable", "Content");
      await share(page.id, "view");
      const state = await harness.run(
        harness.sharing.mutate({
          op: "invite",
          scopeSpaceId: null,
          target: pageTarget(page.id),
          name: "Invited editor",
          role: "edit",
        }),
      );
      const member = state.members[0]!;
      expect((await resolve(member.url!, page.id, page.revision)).actorRef).toEqual({
        kind: "share-member",
        memberId: member.id,
      });
      await harness.run(
        harness.sharing.mutate({
          op: "set-member",
          scopeSpaceId: null,
          target: pageTarget(page.id),
          memberId: member.id,
          role: "comment",
        }),
      );
      await expect(resolve(member.url!, page.id, page.revision)).rejects.toMatchObject({
        reason: "forbidden",
      });
      await harness.run(
        harness.sharing.mutate({
          op: "set-member",
          scopeSpaceId: null,
          target: pageTarget(page.id),
          memberId: member.id,
          role: null,
        }),
      );
      await expect(resolve(member.url!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
    });
    it("rechecks inherited space roles instead of trusting the page link version", async () => {
      const space = await harness.createSpace("Shared space");
      const page = await harness.createPage("Child", "Content", {
        spaceId: space.id,
        parentPageId: space.rootPageId,
      });
      const target: PageShareTarget = { kind: "space", id: space.id as never };
      const initial = await harness.run(harness.sharing.get({ scopeSpaceId: null, target }));
      const spaceState = await harness.run(
        harness.sharing.mutate({
          op: "set-link",
          scopeSpaceId: null,
          target,
          expectedVersion: initial.version,
          setting: { access: "link", role: "edit" },
        }),
      );
      const childState = await harness.run(
        harness.sharing.get({ scopeSpaceId: null, target: pageTarget(page.id) }),
      );
      expect((await resolve(childState.linkUrl!, page.id, page.revision)).role).toBe("edit");
      await harness.run(
        harness.sharing.mutate({
          op: "set-link",
          scopeSpaceId: null,
          target,
          expectedVersion: spaceState.version,
          setting: { access: "link", role: "comment" },
        }),
      );
      await expect(resolve(childState.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
        reason: "forbidden",
      });
    });
    it("rejects a trashed page on the next eligibility check", async () => {
      const page = await harness.createPage("Editable", "Content");
      const state = await share(page.id);
      await harness.run(
        harness.pages.mutate(
          {
            op: "trash",
            requestId: randomUUID(),
            scopeSpaceId: null,
            pageId: page.id,
            expectedRevision: page.revision,
          },
          LOCAL_PAGES_PRINCIPAL,
        ),
      );
      await expect(resolve(state.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
    });
    it("does not retain eligibility when a child moves outside the shared subtree", async () => {
      const root = await harness.createPage("Root", "Content");
      const child = await harness.createPage("Child", "Content", { parentPageId: root.id });
      const state = await share(root.id);
      expect((await resolve(state.linkUrl!, child.id, child.revision)).pageId).toBe(child.id);
      const moved = await harness.run(
        harness.pages.mutate(
          {
            op: "move",
            requestId: randomUUID(),
            scopeSpaceId: null,
            pageId: child.id,
            expectedRevision: child.revision,
            parentPageId: null,
            spaceId: null,
          },
          LOCAL_PAGES_PRINCIPAL,
        ),
      );
      await expect(resolve(state.linkUrl!, child.id, moved.page.revision)).rejects.toMatchObject({
        reason: "forbidden",
      });
    });
    it("does not register an edit route or write through the existing relay handler", async () => {
      const page = await harness.createPage("Editable", "Content");
      const state = await share(page.id);
      const { shareId, ...proof } = entryOf(state.linkUrl!);
      const response = await guest(harness, shareId, "page-edit-open", {
        ...proof,
        pageId: page.id,
        expectedPageRevision: page.revision,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      const current = await harness.run(
        harness.pages.read({ scopeSpaceId: null, pageId: page.id }, LOCAL_PAGES_PRINCIPAL),
      );
      expect(current.page.revision).toBe(page.revision);
      expect(current.content).toBe("Content");
    });
  });

  describe("internal app host page lookup", () => {
    const host = (url: string, pageId: PageId, expectedPageRevision: number) => {
      const { shareId: _shareId, ...entry } = entryOf(url);
      return harness.run(
        harness.sharing.resolveGuestAppHostPage({
          ...entry,
          visitor: VISITOR,
          pageId,
          expectedPageRevision,
        }),
      );
    };
    const reference = (id: string) =>
      JSON.stringify([{ type: "moss_visualization", appPageId: id, children: [{ text: "" }] }]);

    it("binds the host page to its real link without granting an app or recording a visit", async () => {
      const body = reference(randomUUID());
      const page = await harness.createPage("Host page", "", { richContent: body });
      const target = pageTarget(page.id);
      const initial = await harness.run(harness.sharing.get({ scopeSpaceId: null, target }));
      const share = await harness.run(
        harness.sharing.mutate({
          op: "set-link",
          target,
          scopeSpaceId: null,
          expectedVersion: initial.version,
          setting: { access: "link", role: "view" },
        }),
      );
      const events = () =>
        harness.run(
          harness.sql`SELECT count(*) AS n FROM pages_share_events WHERE action = 'opened'`,
        );
      const before = await events();
      expect(await host(share.linkUrl!, page.id, page.revision)).toEqual({
        entry: { kind: "link", id: entryOf(share.linkUrl!).link },
        pageId: page.id,
        pageRevision: page.revision,
        policyStamp: JSON.stringify(["link", share.version, null, null, null]),
        scopeSpaceId: null,
        spaceId: null,
        richContent: body,
      });
      expect(await events()).toEqual(before);
      const other = await harness.createPage("Private page", "", { richContent: body });
      await expect(host(share.linkUrl!, other.id, other.revision)).rejects.toMatchObject({
        reason: "forbidden",
      });
      await expect(host(share.linkUrl!, page.id, page.revision + 1)).rejects.toMatchObject({
        reason: "unavailable",
      });
      await harness.run(
        harness.sharing.mutate({
          op: "rotate-link",
          scopeSpaceId: null,
          target,
          expectedVersion: share.version,
        }),
      );
      await expect(host(share.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
    });

    it("uses the exact published site revision and rejects the unpublished draft or another page", async () => {
      const publishedBody = reference(randomUUID());
      const page = await harness.createPage("Published site host", "", {
        richContent: publishedBody,
      });
      const { site } = await harness.run(
        harness.sharing.siteMutate({
          op: "publish",
          scopeSpaceId: null,
          pageId: page.id,
          visibility: "anyone",
          acceptTerms: true,
        }),
      );
      const revision = await harness.updatePage(
        page.id,
        page.revision,
        "",
        reference(randomUUID()),
      );
      expect(await host(site.url!, page.id, page.revision)).toEqual({
        entry: { kind: "site", id: site.id },
        pageId: page.id,
        pageRevision: page.revision,
        policyStamp: JSON.stringify(["site", 1]),
        scopeSpaceId: null,
        spaceId: null,
        richContent: publishedBody,
      });
      await expect(host(site.url!, page.id, revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
      await expect(host(site.url!, randomUUID() as PageId, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
      await harness.run(
        harness.sharing.siteMutate({ op: "unpublish", scopeSpaceId: null, siteId: site.id }),
      );
      await expect(host(site.url!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unpublished",
      });
    });
  });

  describe("owner page app publication", () => {
    const owner = LOCAL_PAGES_PRINCIPAL;
    const agent = {
      kind: "agent",
      threadId: "test-agent" as import("@moss/contracts").ThreadId,
    } as const;
    const fixture = async () => {
      const apps = await harness.run(
        makePageAppsServiceShape({
          ai: {
            async *ask() {
              throw new Error("unexpected model call");
            },
          },
        }).pipe(Effect.provideService(SqlClient.SqlClient, harness.sql)),
      );
      const pubs = await harness.run(
        makePageAppPublications.pipe(
          Effect.provideService(SqlClient.SqlClient, harness.sql),
          Effect.provideService(PageSharingService, harness.sharing),
          Effect.provideService(PageAppsService, apps),
        ),
      );
      const manager = await harness.run(
        makePageAppPublicationOwner.pipe(
          Effect.provideService(SqlClient.SqlClient, harness.sql),
          Effect.provideService(PageSharingService, harness.sharing),
          Effect.provideService(PageAppsService, apps),
        ),
      );
      const { app } = await harness.run(
        apps.mutate(
          {
            op: "create",
            requestId: randomUUID(),
            scopeSpaceId: null,
            title: "Published title",
            html: "<!doctype html><html><body>published-byte-1</body></html>",
            capabilities: { db: {}, ai: {} },
          },
          owner,
        ),
      );
      const body = JSON.stringify([
        {
          type: "blockquote",
          children: [
            {
              type: "moss_visualization",
              appPageId: app.id,
              sharedPreview: true,
              children: [{ text: "" }],
            },
          ],
        },
      ]);
      const page = await harness.createPage("Host", "", { richContent: body });
      const target = pageTarget(page.id);
      const initial = await harness.run(harness.sharing.get({ scopeSpaceId: null, target }));
      const state = await harness.run(
        harness.sharing.mutate({
          op: "set-link",
          scopeSpaceId: null,
          target,
          expectedVersion: initial.version,
          setting: { access: "link", role: "edit" },
        }),
      );
      const { shareId: _share, ...proof } = entryOf(state.linkUrl!);
      const request = {
        ...proof,
        visitor: VISITOR,
        pageId: page.id,
        expectedPageRevision: page.revision,
      };
      const input = {
        entry: { kind: "link" as const, id: proof.link! },
        pageId: page.id,
        pageRevision: page.revision,
        nodePath: [0, 0],
        appId: app.id,
        appRevision: app.revision,
        expectedGeneration: 0,
      };
      return { apps, pubs, manager, app, page, request, input, target, state };
    };
    it("requires the transport owner role before reading a share or publishing an application", async () => {
      const { manager, input, target, state } = await fixture();
      const handlers = makePageSharingRpcHandlers(harness.sharing, manager);
      const method = handlers["pageSharing.appPublications"];
      const list = {
        op: "list" as const,
        scopeSpaceId: null,
        pageId: input.pageId,
        pageRevision: input.pageRevision,
        entry: input.entry,
        offset: 0,
      };
      expect(state.appPublicationEntryId).toBe(input.entry.id);
      for (const role of ["client", "owner"] as const) {
        const run = <A, E>(eff: Effect.Effect<A, E>) =>
          harness.run(eff.pipe(Effect.provideService(CurrentWsSessionRole, role)));
        if (role === "client") {
          await expect(
            run(method({ ...input, scopeSpaceId: null, op: "publish" })),
          ).rejects.toMatchObject({ code: "owner-required" });
          await expect(
            run(handlers["pageSharing.get"]({ scopeSpaceId: null, target })),
          ).rejects.toMatchObject({ code: "owner-required" });
          await expect(run(method(list))).rejects.toMatchObject({ code: "owner-required" });
        } else {
          expect((await run(method(list))).items).toEqual([
            {
              nodePath: [0, 0],
              appId: input.appId,
              revision: 1,
              title: "Published title",
              generation: 0,
              confirmedRevision: null,
            },
          ]);
          const publish = { ...input, scopeSpaceId: null, op: "publish" as const };
          expect((await run(method(publish))).items[0]).toMatchObject({
            generation: 1,
            confirmedRevision: 1,
          });
          await expect(run(method(publish))).rejects.toMatchObject({ code: "conflict" });
          expect(
            (
              await run(
                method({ ...list, op: "revoke", nodePath: input.nodePath, expectedGeneration: 1 }),
              )
            ).items[0],
          ).toMatchObject({ generation: 2, confirmedRevision: null });
        }
      }
      await expect(harness.run(manager.manage(list, agent))).rejects.toMatchObject({
        code: "invalid",
      });
      await expect(
        harness.run(manager.manage({ ...list, pageRevision: 9 }, owner)),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        harness.run(
          manager.manage(
            { ...list, scopeSpaceId: "wrong" as import("@moss/contracts").SpaceId },
            owner,
          ),
        ),
      ).rejects.toMatchObject({ code: "not-found" });
    });
    it("paginates real app nodes only, hides other-space metadata, and preserves the published site snapshot", async () => {
      const { manager, input, page, app } = await fixture();
      const { site } = await harness.run(
        harness.sharing.siteMutate({
          op: "publish",
          scopeSpaceId: null,
          pageId: page.id,
          visibility: "anyone",
          acceptTerms: true,
        }),
      );
      const nodes = Array.from({ length: 17 }, () => ({
        type: "moss_visualization",
        appPageId: app.id,
        children: [{ text: "" }],
      }));
      const rev = await harness.updatePage(
        page.id,
        page.revision,
        "",
        JSON.stringify([
          ...nodes,
          { type: "p", children: [{ text: "", type: "moss_visualization", appPageId: app.id }] },
        ]),
      );
      const list = {
        op: "list" as const,
        offset: 0,
        scopeSpaceId: null,
        pageId: page.id,
        pageRevision: rev,
        entry: input.entry,
      };
      const first = await harness.run(manager.manage(list, owner));
      expect(first.items).toHaveLength(16);
      expect(first.nextOffset).toBe(16);
      const second = await harness.run(manager.manage({ ...list, offset: 16 }, owner));
      expect(second.items.map((x) => x.nodePath)).toEqual([[16]]);
      expect(second.nextOffset).toBeNull();
      const frozen = await harness.run(
        manager.manage(
          { ...list, entry: { kind: "site", id: site.id }, pageRevision: page.revision },
          owner,
        ),
      );
      expect(frozen.items.map((x) => x.nodePath)).toEqual([[0, 0]]);
      await harness.run(
        harness.sql`UPDATE page_apps SET space_id='other-space' WHERE app_id=${app.id}`,
      );
      expect((await harness.run(manager.manage(list, owner))).items[0]).toMatchObject({
        revision: null,
        title: null,
        confirmedRevision: null,
      });
    });
    it("requires owner authority and an actual element at the fixed path; guest-authored flags do not publish", async () => {
      const { pubs, input, request } = await fixture();
      await expect(harness.run(pubs.resolve(request, randomUUID()))).rejects.toMatchObject({
        reason: "unavailable",
      });
      await expect(harness.run(pubs.publish(input, agent))).rejects.toMatchObject({
        reason: "forbidden",
      });
      for (const nodePath of [[0], [0, 0, 0], [1]])
        await expect(
          harness.run(pubs.publish({ ...input, nodePath }, owner)),
        ).rejects.toMatchObject({ reason: "unavailable" });
      const { publicationId } = await harness.run(pubs.publish(input, owner));
      await expect(
        harness.run(pubs.resolve({ ...request, key: "invalid" }, publicationId)),
      ).rejects.toMatchObject({ reason: "unavailable" });
      await expect(harness.run(pubs.resolve(request, publicationId))).resolves.toMatchObject({
        availableCapabilities: [],
        title: "Published title",
      });
    });
    it("binds immutable HTML, version title and capabilities; changed bytes at the same revision fail closed", async () => {
      const { apps, pubs, app, input, request } = await fixture();
      await harness.run(
        apps.mutate(
          {
            op: "update",
            requestId: randomUUID(),
            appId: app.id,
            expectedRevision: app.revision,
            title: "New private title",
            html: "<html><body>private-next-bytes</body></html>",
          },
          owner,
        ),
      );
      const { publicationId } = await harness.run(pubs.publish(input, owner));
      const viewed = await harness.run(pubs.resolve(request, publicationId));
      expect(viewed.title).toBe("Published title");
      expect(viewed.html).toContain("published-byte-1");
      expect(viewed.html).not.toContain("private-next-bytes");
      expect(viewed.availableCapabilities).toEqual([]);
      await harness.run(
        harness.sql`UPDATE page_app_versions SET capabilities_json='{}' WHERE app_id=${app.id} AND revision=${app.revision}`,
      );
      await expect(harness.run(pubs.resolve(request, publicationId))).rejects.toMatchObject({
        reason: "unavailable",
      });
    });
    it("does not let an authorized guest edit repoint the owner's grant at a different private app", async () => {
      const { apps, pubs, app, input, request, page } = await fixture();
      const original = await harness.run(pubs.publish(input, owner));
      const { app: other } = await harness.run(
        apps.mutate(
          {
            op: "create",
            requestId: randomUUID(),
            scopeSpaceId: null,
            title: "Unpublished",
            html: "<html><body>owner-only-sentinel</body></html>",
          },
          owner,
        ),
      );
      const forged = JSON.stringify([
        {
          type: "blockquote",
          children: [
            {
              type: "moss_visualization",
              appPageId: other.id,
              sharedPreview: true,
              publicationId: original.publicationId,
              appRevision: 1,
              children: [{ text: "" }],
            },
          ],
        },
      ]);
      const edit = await harness.run(
        harness.writer.write({
          entry: { link: request.link, key: request.key, visitor: VISITOR },
          pageId: page.id,
          expectedPageRevision: page.revision,
          richContent: forged,
        }),
      );
      expect(edit.page.revision).toBe(page.revision + 1);
      await expect(
        harness.run(
          pubs.resolve(
            { ...request, expectedPageRevision: edit.page.revision },
            original.publicationId,
          ),
        ),
      ).rejects.toMatchObject({ reason: "unavailable" });
      await expect(
        harness.run(pubs.resolve(request, original.publicationId)),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(await harness.run(harness.sql`SELECT app_id FROM page_app_publications`)).toEqual([
        { app_id: app.id },
      ]);
    });
    it("compares generations, rolls back an interrupted replacement, and never revives the old publication ID", async () => {
      const { pubs, request, input } = await fixture();
      const first = await harness.run(pubs.publish(input, owner));
      await expect(harness.run(pubs.publish(input, owner))).rejects.toMatchObject({
        reason: "conflict",
      });
      await harness.run(
        harness.sql`CREATE TRIGGER block_grant BEFORE INSERT ON page_app_publications BEGIN SELECT RAISE(ABORT,'injected'); END`,
      );
      await expect(
        harness.run(pubs.publish({ ...input, expectedGeneration: 1 }, owner)),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect((await harness.run(pubs.resolve(request, first.publicationId))).generation).toBe(1);
      await harness.run(harness.sql`DROP TRIGGER block_grant`);
      await expect(harness.run(pubs.revoke(input, 1, agent))).rejects.toMatchObject({
        reason: "forbidden",
      });
      expect(await harness.run(pubs.revoke(input, 1, owner))).toEqual({ generation: 2 });
      const next = await harness.run(pubs.publish({ ...input, expectedGeneration: 2 }, owner));
      expect(next.generation).toBe(3);
      expect(next.publicationId).not.toBe(first.publicationId);
      await expect(harness.run(pubs.resolve(request, first.publicationId))).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect((await harness.run(pubs.resolve(request, next.publicationId))).generation).toBe(3);
    });
    it("does not revive a grant after link access changes away and back or the host page is rewritten", async () => {
      const { pubs, input, request, target, state, page } = await fixture();
      const first = await harness.run(pubs.publish(input, owner));
      const hidden = await harness.run(
        harness.sharing.mutate({
          op: "set-link",
          scopeSpaceId: null,
          target,
          expectedVersion: state.version,
          setting: { access: "invited", role: "view" },
        }),
      );
      await harness.run(
        harness.sharing.mutate({
          op: "set-link",
          scopeSpaceId: null,
          target,
          expectedVersion: hidden.version,
          setting: { access: "link", role: "edit" },
        }),
      );
      await expect(harness.run(pubs.resolve(request, first.publicationId))).rejects.toMatchObject({
        reason: "unavailable",
      });
      const next = await harness.run(pubs.publish({ ...input, expectedGeneration: 1 }, owner));
      const revision = await harness.updatePage(
        page.id,
        page.revision,
        "",
        JSON.stringify([{ type: "p", children: [{ text: "changed" }] }]),
      );
      for (const rev of [page.revision, revision])
        await expect(
          harness.run(pubs.resolve({ ...request, expectedPageRevision: rev }, next.publicationId)),
        ).rejects.toMatchObject({ reason: "unavailable" });
    });
    it("keeps a site on its published version, preserves pinning and invalidates identical-revision republish", async () => {
      const { pubs, page, input } = await fixture();
      const { site } = await harness.run(
        harness.sharing.siteMutate({
          op: "publish",
          scopeSpaceId: null,
          pageId: page.id,
          visibility: "anyone",
          acceptTerms: true,
        }),
      );
      const siteInput = { ...input, entry: { kind: "site" as const, id: site.id } };
      const { shareId: _share, ...proof } = entryOf(site.url!);
      const request = {
        ...proof,
        visitor: VISITOR,
        pageId: page.id,
        expectedPageRevision: page.revision,
      };
      const grant = await harness.run(pubs.publish(siteInput, owner));
      await harness.run(
        harness.sharing.siteMutate({
          op: "pin",
          scopeSpaceId: null,
          siteId: site.id,
          pinned: true,
        }),
      );
      expect((await harness.run(pubs.resolve(request, grant.publicationId))).pageRevision).toBe(
        page.revision,
      );
      await harness.run(
        harness.sharing.siteMutate({ op: "unpublish", scopeSpaceId: null, siteId: site.id }),
      );
      await harness.run(
        harness.sharing.siteMutate({
          op: "publish",
          scopeSpaceId: null,
          pageId: page.id,
          visibility: "anyone",
        }),
      );
      await expect(harness.run(pubs.resolve(request, grant.publicationId))).rejects.toMatchObject({
        reason: "unavailable",
      });
      const next = await harness.run(pubs.publish({ ...siteInput, expectedGeneration: 1 }, owner));
      await harness.updatePage(
        page.id,
        page.revision,
        "",
        JSON.stringify([{ type: "p", children: [{ text: "private draft" }] }]),
      );
      expect((await harness.run(pubs.resolve(request, next.publicationId))).pageRevision).toBe(
        page.revision,
      );
    });
    it("cannot borrow a different space or revive grants after trash/restore or version pruning", async () => {
      const { apps, pubs, app, input, request } = await fixture();
      const first = await harness.run(pubs.publish(input, owner));
      await harness.run(
        harness.sql`UPDATE page_apps SET space_id='different-space' WHERE app_id=${app.id}`,
      );
      await expect(
        harness.run(pubs.publish({ ...input, expectedGeneration: 1 }, owner)),
      ).rejects.toMatchObject({ reason: "unavailable" });
      await harness.run(harness.sql`UPDATE page_apps SET space_id=NULL WHERE app_id=${app.id}`);
      await expect(harness.run(pubs.resolve(request, first.publicationId))).rejects.toMatchObject({
        reason: "unavailable",
      });
      const next = await harness.run(pubs.publish({ ...input, expectedGeneration: 1 }, owner));
      const { app: trashed } = await harness.run(
        apps.mutate(
          { op: "trash", requestId: randomUUID(), appId: app.id, expectedRevision: app.revision },
          owner,
        ),
      );
      await harness.run(
        apps.mutate(
          {
            op: "restore",
            requestId: randomUUID(),
            appId: app.id,
            expectedRevision: trashed.revision,
          },
          owner,
        ),
      );
      await expect(harness.run(pubs.resolve(request, next.publicationId))).rejects.toMatchObject({
        reason: "unavailable",
      });
      const last = await harness.run(pubs.publish({ ...input, expectedGeneration: 2 }, owner));
      await harness.run(
        harness.sql`DELETE FROM page_app_versions WHERE app_id=${app.id} AND revision=${app.revision}`,
      );
      await expect(harness.run(pubs.resolve(request, last.publicationId))).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect(
        await harness.run(harness.sql`SELECT generation FROM page_app_publication_slots`),
      ).toEqual([{ generation: 3 }]);
      expect(
        await harness.run(harness.sql`SELECT publication_id FROM page_app_publications`),
      ).toEqual([]);
    });
    const previewIssuer = () =>
      pageAppPreviewIssuer(
        { shareId: "A".repeat(22), parentOrigin: "https://reader.example" },
        "https://content.example",
      );
    const ticketInput = () => {
      const frameSecret = randomBytes(32).toString("base64url");
      return {
        frameSecret,
        frameSecretHash: createHash("sha256").update(frameSecret).digest("base64url"),
        frameNonce: randomUUID(),
      };
    };
    it("opens a real published page app through the registered relay by its authorized node and rechecks its active grant", async () => {
      harness.relay.appBrokerEnabled = true;
      harness.relayEnv.MOSS_PAGE_APP_PREVIEW_CONTENT_ORIGIN = "http://localhost:53842";
      const { pubs, app, state, input, request } = await fixture();
      const { shareId } = entryOf(state.linkUrl!);
      const host = await harness.relay.waitForHost(shareId);
      const headers = {
        "x-moss-app-preview-parent-origin": harness.relay.origin,
        "x-moss-app-preview-content-origin": "http://localhost:53842",
      };
      const ref = { nodePath: input.nodePath, appId: app.id };
      const open = async (
        reference: Record<string, unknown>,
        overrides: Record<string, unknown> = {},
      ) => {
        const { frameSecret, ...proof } = ticketInput();
        const response = host.request({
          method: "POST",
          route: "page-app-preview-open",
          headers: {
            ...headers,
            "x-moss-app-preview-kind": "open",
            "content-type": "application/json",
          },
          body: [encoder.encode(JSON.stringify({ ...request, reference, ...proof, ...overrides }))],
        }).response;
        return {
          status: (await response.head).status,
          result: JSON.parse(await response.text()),
          frameSecret,
          frameNonce: proof.frameNonce,
        };
      };
      expect((await openPage(harness, state.linkUrl!)).body.appPreview).toMatchObject({
        contentOrigin: "http://localhost:53842",
        brokerProtocol: 1,
      });
      expect((await open(ref)).status).toBeGreaterThanOrEqual(400);
      const published = await harness.run(pubs.publish(input, owner));
      for (const invalid of [
        { ...ref, appId: "private-app" },
        { ...ref, nodePath: [0, 1] },
        { ...ref, appRevision: 2 },
      ]) {
        expect((await open(invalid)).status).toBeGreaterThanOrEqual(400);
      }
      expect((await open(ref, { key: "invalid" })).status).toBeGreaterThanOrEqual(400);
      const document = async (ticket: string, frameSecret: string) => {
        const response = host.request({
          method: "POST",
          route: "page-app-preview-document",
          headers: {
            ...headers,
            "x-moss-app-preview-kind": "document",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: [encoder.encode(new URLSearchParams({ ticket, frameSecret }).toString())],
        }).response;
        return { status: (await response.head).status, text: await response.text() };
      };
      const parent = ticketInput();
      const granted = await open(ref, { brokerSecretHash: parent.frameSecretHash });
      expect(granted.status).toBe(200);
      const broker = async (overrides: Record<string, unknown> = {}, kind = "broker") => {
        const response = host.request({
          method: "POST",
          route: "page-app-preview-broker",
          headers: {
            ...headers,
            "x-moss-app-preview-kind": kind,
            "content-type": "application/json",
          },
          body: [
            encoder.encode(
              JSON.stringify({
                method: "permissions.state",
                handle: granted.result.brokerHandle,
                secret: parent.frameSecret,
                frameNonce: granted.frameNonce,
                ...overrides,
              }),
            ),
          ],
        }).response;
        return { status: (await response.head).status, body: JSON.parse(await response.text()) };
      };
      expect((await broker()).status).toBeGreaterThanOrEqual(400);
      expect(granted.result.source).toMatchObject({
        sourceKind: "page-app",
        appId: app.id,
        pageRevision: input.pageRevision,
        appRevision: 1,
        ...published,
      });
      const frame = await document(granted.result.ticket, granted.frameSecret);
      expect(frame.status).toBe(200);
      expect(frame.text).toContain("published-byte-1");
      expect(frame.text).not.toContain(granted.frameSecret);
      expect(frame.text).not.toContain(parent.frameSecret);
      expect(frame.text).not.toContain(granted.result.brokerHandle);
      for (const wrong of [
        { handle: granted.result.ticket },
        { secret: granted.frameSecret },
        { frameNonce: parent.frameNonce },
        { method: "db.read" },
      ])
        expect((await broker(wrong)).status).toBeGreaterThanOrEqual(400);
      expect((await broker({}, "document")).status).toBeGreaterThanOrEqual(400);
      expect(await broker()).toEqual({
        status: 200,
        body: {
          source: granted.result.source,
          expiresAt: granted.result.frameExpiresAt,
          availableCapabilities: [],
        },
      });
      const pending = await open(ref);
      await harness.run(pubs.revoke(input, published.generation, owner));
      await harness.run(pubs.publish({ ...input, expectedGeneration: 2 }, owner));
      expect((await broker()).status).toBeGreaterThanOrEqual(400);
      expect(
        (await document(pending.result.ticket, pending.frameSecret)).status,
      ).toBeGreaterThanOrEqual(400);
    });
    it("renders the published app in the readonly frame with its distinct source and a one-use frame secret", async () => {
      const { pubs, input, request } = await fixture();
      const { publicationId } = await harness.run(pubs.publish(input, owner));
      const previews = createPublishedPageAppPreview(pubs, previewIssuer);
      try {
        const { frameSecret, ...proof } = ticketInput();
        await expect(previews.open({ ...request, ...proof })).rejects.toMatchObject({
          reason: "unavailable",
        });
        const ticket = await previews.open({ ...request, ...proof, publicationId });
        expect(ticket.source).toEqual({
          sourceKind: "page-app",
          pageId: input.pageId,
          pageRevision: input.pageRevision,
          publicationId,
          generation: 1,
          appId: input.appId,
          appRevision: input.appRevision,
        });
        await expect(
          previews.consume({
            ticket: ticket.ticket,
            frameSecret: randomBytes(32).toString("base64url"),
          }),
        ).rejects.toMatchObject({ reason: "unavailable" });
        const document = await previews.consume({ ticket: ticket.ticket, frameSecret });
        expect(new TextDecoder().decode(document.bytes)).toContain("published-byte-1");
        expect(document.headers["content-security-policy"]).toContain("https://reader.example");
        expect(document.headers["cache-control"]).toBe("no-store");
        await expect(
          previews.consume({ ticket: ticket.ticket, frameSecret }),
        ).rejects.toMatchObject({ reason: "unavailable" });
      } finally {
        previews.close();
      }
    });
    it("withholds an already rendered frame if the owner revokes and republishes while preparing it", async () => {
      const { pubs, input, request } = await fixture();
      const grant = await harness.run(pubs.publish(input, owner));
      let rendered = false;
      const previews = createPublishedPageAppPreview(
        pubs,
        previewIssuer,
        async (doc, context, signal) => {
          const bytes = await preparePageAppPreviewDocument(doc, context, signal);
          rendered = true;
          const revoked = await harness.run(pubs.revoke(input, grant.generation, owner));
          await harness.run(
            pubs.publish({ ...input, expectedGeneration: revoked.generation }, owner),
          );
          return bytes;
        },
      );
      try {
        const { frameSecret, ...proof } = ticketInput();
        const { ticket } = await previews.open({
          ...request,
          ...proof,
          publicationId: grant.publicationId,
        });
        await expect(previews.consume({ ticket, frameSecret })).rejects.toMatchObject({
          reason: "unavailable",
        });
        expect(rendered).toBe(true);
        await expect(previews.consume({ ticket, frameSecret })).rejects.toMatchObject({
          reason: "unavailable",
        });
      } finally {
        previews.close();
      }
    });
  });

  describe("internal live guest frame writer", () => {
    const p = (text: string) => ({ type: "p", children: [{ text }] });
    const frame = (doc: Y.Doc, target: readonly unknown[]) => {
      const scratch = new Y.Doc();
      try {
        Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
        const before = Y.encodeStateVector(scratch);
        applyPlateValue(scratch, target, null);
        return Y.encodeStateAsUpdate(scratch, before);
      } finally {
        scratch.destroy();
      }
    };
    const fixture = async (
      body: readonly unknown[] = [p("original")],
      role: "view" | "comment" | "edit" = "edit",
    ) => {
      const page = await harness.createPage("Shared notes", "original", {
        richContent: JSON.stringify(body),
      });
      const target = pageTarget(page.id);
      const initial = await harness.run(harness.sharing.get({ scopeSpaceId: null, target }));
      const changed = await harness.run(
        harness.sharing.mutate({
          op: "set-link",
          scopeSpaceId: null,
          target,
          expectedVersion: initial.version,
          setting: { access: "link", role },
        }),
      );
      // Registration against the actual local relay can finish after the settings
      // write. Re-read the real state; never manufacture a URL or bypass its proof.
      const state = changed.linkUrl
        ? changed
        : await vi.waitFor(
            async () => {
              const current = await harness.run(
                harness.sharing.get({ scopeSpaceId: null, target }),
              );
              expect(current.linkUrl).toBeTruthy();
              return current;
            },
            { timeout: 2000, interval: 50 },
          );
      const { shareId: _shareId, ...proof } = entryOf(state.linkUrl!);
      const token = await harness.run(
        harness.realtime.issueToken({ pageId: page.id, scopeSpaceId: null }, LOCAL_PAGES_PRINCIPAL),
      );
      const sent: Array<string | Uint8Array> = [];
      const joined = await harness.realtime.join({
        pageId: page.id,
        token: token.token,
        connection: (mode) => ({ mode, send: (message) => sent.push(message), close: () => {} }),
      });
      if (!joined || !joined.room.generation) throw new Error("Expected seeded owner room");
      const input = {
        entry: { ...proof, visitor: VISITOR },
        pageId: page.id,
        generation: joined.room.generation,
      };
      const write = (update: Uint8Array) =>
        harness.run(harness.frameWriter.write({ ...input, update }));
      return {
        page,
        target,
        state,
        input,
        write,
        room: joined.room,
        connection: joined.connection,
        sent,
      };
    };

    it("publishes an authorized frame to SQLite and only then broadcasts it with guest attribution", async () => {
      const h = await fixture();
      const delta = frame(h.room.doc, [p("guest edit")]);
      h.sent.length = 0;
      expect(await h.write(delta)).toEqual({ revision: 2, applied: true });
      expect(readPageDoc(h.room.doc)).toEqual([p("guest edit")]);
      const history = await harness.run(
        harness.pages.versions({ scopeSpaceId: null, pageId: h.page.id }, LOCAL_PAGES_PRINCIPAL),
      );
      const version = history.versions[0]!;
      expect(version).toMatchObject({
        author: "guest",
        authorGuestRef: expect.stringMatching(/^[a-f0-9]{64}$/),
        content: "guest edit",
      });
      expect(version.contributors).toEqual([{ kind: "guest", actorRef: version.authorGuestRef }]);
      expect(h.sent.some((data) => data instanceof Uint8Array)).toBe(true);
      expect(await h.write(delta)).toEqual({ revision: 2, applied: false });
    });

    it.each([
      "shadowed-size",
      "shared-backing",
      "proxy",
      "forged-tag",
      "throwing-accessor",
    ] as const)("rejects %s before deriving an actor key or entering the room", async (kind) => {
      const h = await fixture();
      const entered = vi.spyOn(harness.realtime, "transactGuestFrame");
      try {
        let source: unknown;
        if (kind === "shadowed-size") {
          source = Object.defineProperties(new Uint8Array(256 * 1024 + 1), {
            length: { value: 1 },
            byteLength: { value: 1 },
          });
        } else if (kind === "shared-backing") {
          source = Object.defineProperty(new Uint8Array(new SharedArrayBuffer(16)), "buffer", {
            value: new ArrayBuffer(16),
          });
        } else if (kind === "proxy") source = new Proxy(new Uint8Array(8), {});
        else if (kind === "forged-tag")
          source = Object.defineProperty(new Uint16Array(8), Symbol.toStringTag, {
            value: "Uint8Array",
          });
        const input = {
          ...h.input,
          get update(): Uint8Array {
            if (kind === "throwing-accessor") throw new Error("input accessor");
            return source as Uint8Array;
          },
        };
        h.sent.length = 0;
        await expect(harness.run(harness.frameWriter.write(input))).rejects.toMatchObject({
          reason: "invalid",
        });
        expect(entered).not.toHaveBeenCalled();
        expect(harness.secretNames()).not.toContain(PAGE_GUEST_AUTHOR_KEY_PURPOSE);
        expect(h.room.currentRevision).toBe(1);
        expect(h.sent).toEqual([]);
      } finally {
        entered.mockRestore();
      }
    });

    it("reads the caller's update only once and accepts the precise bytes in an ordinary Buffer slice", async () => {
      const h = await fixture();
      const delta = frame(h.room.doc, [p("exact slice")]);
      const surrounding = Buffer.concat([Buffer.from([255, 255]), delta, Buffer.from([255, 255])]);
      const slice = surrounding.subarray(2, 2 + delta.length);
      let reads = 0;
      const input = {
        ...h.input,
        get update() {
          if (++reads > 1) throw new Error("input read again");
          return slice;
        },
      };
      expect(await harness.run(harness.frameWriter.write(input))).toEqual({
        revision: 2,
        applied: true,
      });
      expect(reads).toBe(1);
      expect(readPageDoc(h.room.doc)).toEqual([p("exact slice")]);
    });

    it("preflights the whole SQL prefix including valid metadata before fetching payloads", async () => {
      const h = await fixture();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        for (let index = 0; index < 40; index++) {
          expect(sendRoomEdit(h.room, h.connection, [p("owner " + index)])).toBe(true);
          await h.room.persist();
        }
        // Every row is valid JSON below the per-record cap, but the sum exceeds
        // the frame writer's 8 MiB reconstruction budget.
        await harness.run(harness.sql`UPDATE pages_realtime_updates SET contributors_json =
          printf('%*s',225000,'') || contributors_json WHERE page_id=${h.page.id}`);
        const [budget] = await harness.run(harness.sql<{ total: number; largest: number }>`SELECT
          sum(length(CAST(contributors_json AS BLOB))) AS total, max(length(CAST(contributors_json AS BLOB))) AS largest
          FROM pages_realtime_updates WHERE page_id=${h.page.id}`);
        expect(budget!.total).toBeGreaterThan(8 * 1024 * 1024);
        expect(budget!.largest).toBeLessThan(256 * 1024);
        const delta = frame(h.room.doc, [p("guest after bounded prefix")]);
        const before = Y.encodeStateAsUpdate(h.room.doc);
        h.sent.length = 0;
        await expect(h.write(delta)).rejects.toMatchObject({ reason: "unavailable" });
        expect(Y.encodeStateAsUpdate(h.room.doc)).toEqual(before);
        expect(h.room.currentRevision).toBe(1);
        expect(h.sent).toEqual([]);
        await harness.run(
          harness.sql`UPDATE pages_realtime_updates SET contributors_json=trim(contributors_json) WHERE page_id=${h.page.id}`,
        );
        expect(await h.write(delta)).toEqual({ revision: 2, applied: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["view", "comment"] as const)(
      "denies a %s proof for each submitted frame",
      async (role) => {
        const h = await fixture(undefined, role);
        const before = Y.encodeStateAsUpdate(h.room.doc);
        h.sent.length = 0;
        await expect(h.write(frame(h.room.doc, [p("secret write")]))).rejects.toMatchObject({
          reason: "forbidden",
        });
        expect(Y.encodeStateAsUpdate(h.room.doc)).toEqual(before);
        expect(h.sent).toEqual([]);
        expect(h.room.currentRevision).toBe(1);
      },
    );

    it("rechecks revoked proof even for a replayed delta", async () => {
      const h = await fixture();
      const delta = frame(h.room.doc, [p("accepted before revocation")]);
      await h.write(delta);
      await harness.run(
        harness.sharing.mutate({
          op: "rotate-link",
          scopeSpaceId: null,
          target: h.target,
          expectedVersion: h.state.version,
        }),
      );
      const before = Y.encodeStateAsUpdate(h.room.doc);
      h.sent.length = 0;
      await expect(h.write(delta)).rejects.toMatchObject({ reason: "unavailable" });
      await expect(h.write(frame(h.room.doc, [p("after revocation")]))).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect(Y.encodeStateAsUpdate(h.room.doc)).toEqual(before);
      expect(h.sent).toEqual([]);
      expect(h.room.currentRevision).toBe(2);
    });

    it("cannot expose a private library image through a live edit", async () => {
      const h = await fixture();
      const image = await uploadImage(harness, "private-live.png");
      const before = Y.encodeStateAsUpdate(h.room.doc);
      h.sent.length = 0;
      const delta = frame(h.room.doc, [
        { type: "img", url: image.previewPath, children: [{ text: "" }] },
      ]);
      await expect(h.write(delta)).rejects.toMatchObject({ reason: "forbidden" });
      expect(Y.encodeStateAsUpdate(h.room.doc)).toEqual(before);
      expect(h.sent).toEqual([]);
      const response = await media(harness, h.state.linkUrl!, {
        pageId: h.page.id,
        revision: 1,
        itemId: image.id,
      });
      expect(response.status).toBe(403);
      expect(response.bytes.equals(IMAGE_BYTES)).toBe(false);
    });

    it("preserves an owner-published image, then denies restoring its reference after removal", async () => {
      const image = await uploadImage(harness, "published-live.png");
      const img = { type: "img", url: image.previewPath, children: [{ text: "" }] };
      const h = await fixture([img, p("old caption")]);
      await h.write(frame(h.room.doc, [img, p("new caption")]));
      const visible = await media(harness, h.state.linkUrl!, {
        pageId: h.page.id,
        revision: 2,
        itemId: image.id,
      });
      expect(visible.status).toBe(200);
      expect(visible.bytes.equals(IMAGE_BYTES)).toBe(true);
      await h.write(frame(h.room.doc, [p("removed")]));
      await expect(h.write(frame(h.room.doc, [img, p("bring it back")]))).rejects.toMatchObject({
        reason: "forbidden",
      });
      expect(
        (
          await media(harness, h.state.linkUrl!, {
            pageId: h.page.id,
            revision: 3,
            itemId: image.id,
          })
        ).status,
      ).toBe(403);
    });

    it("does not publish a still-private pending owner resource with a guest edit", async () => {
      const h = await fixture();
      const image = await uploadImage(harness, "pending-owner.png");
      const img = { type: "img", url: image.previewPath, children: [{ text: "" }] };
      expect(sendRoomEdit(h.room, h.connection, [img, p("owner pending")])).toBe(true);
      const before = Y.encodeStateAsUpdate(h.room.doc);
      await expect(h.write(frame(h.room.doc, [img, p("guest edit")]))).rejects.toMatchObject({
        reason: "forbidden",
      });
      expect(Y.encodeStateAsUpdate(h.room.doc)).toEqual(before);
      expect(
        (
          await media(harness, h.state.linkUrl!, {
            pageId: h.page.id,
            revision: 1,
            itemId: image.id,
          })
        ).status,
      ).toBe(403);
      await h.room.compact();
      await h.write(frame(h.room.doc, [img, p("guest edit")]));
      expect(h.room.currentRevision).toBe(3);
    });

    it("rolls back a late SQL failure without guest bytes or controls reaching peers", async () => {
      const h = await fixture();
      const delta = frame(h.room.doc, [p("uncommitted")]);
      const before = Y.encodeStateAsUpdate(h.room.doc);
      h.sent.length = 0;
      await harness.run(harness.sql`CREATE TRIGGER fixture_guest_fail BEFORE INSERT ON pages_realtime_snapshots WHEN NEW.revision>1
        BEGIN SELECT RAISE(ABORT,'fixture guest publication failure'); END`);
      try {
        await expect(h.write(delta)).rejects.toMatchObject({ reason: "unavailable" });
        expect(Y.encodeStateAsUpdate(h.room.doc)).toEqual(before);
        expect(h.sent).toEqual([]);
        expect(
          await harness.run(
            harness.sql`SELECT revision FROM pages_versions WHERE page_id=${h.page.id}`,
          ),
        ).toEqual([{ revision: 1 }]);
        expect(
          await harness.run(
            harness.sql`SELECT seq FROM pages_realtime_updates WHERE page_id=${h.page.id}`,
          ),
        ).toEqual([]);
        expect(
          await harness.run(
            harness.sql`SELECT * FROM pages_version_contributors WHERE page_id=${h.page.id}`,
          ),
        ).toEqual([]);
        expect(
          await harness.run(
            harness.sql`SELECT next_sequence,compacted_through_sequence FROM pages_realtime_docs WHERE page_id=${h.page.id}`,
          ),
        ).toEqual([{ next_sequence: 1, compacted_through_sequence: 0 }]);
      } finally {
        await harness.run(harness.sql`DROP TRIGGER fixture_guest_fail`);
      }
      expect(await h.write(delta)).toEqual({ revision: 2, applied: true });
    });

    it.each(["other-root", "pending-struct", "pending-delete", "malformed", "oversized"] as const)(
      "rejects %s bytes before changing any live or durable state",
      async (shape) => {
        const h = await fixture();
        const rogue = new Y.Doc();
        let delta: Uint8Array;
        try {
          if (shape === "other-root") {
            rogue.getMap("private-root").set("payload", "hidden");
            delta = Y.encodeStateAsUpdate(rogue);
          } else if (shape === "pending-struct" || shape === "pending-delete") {
            const text = rogue.getText("content");
            text.insert(0, "first");
            const before = Y.encodeStateVector(rogue);
            if (shape === "pending-delete") text.delete(0, 1);
            else text.insert(5, "second");
            delta = Y.encodeStateAsUpdate(rogue, before);
          } else
            delta = shape === "oversized" ? new Uint8Array(256 * 1024 + 1) : Uint8Array.of(255);
          h.sent.length = 0;
          const before = Y.encodeStateAsUpdate(h.room.doc);
          await expect(h.write(delta)).rejects.toMatchObject({ reason: "invalid" });
          expect(Y.encodeStateAsUpdate(h.room.doc)).toEqual(before);
          expect(h.sent).toEqual([]);
          expect(h.room.currentRevision).toBe(1);
        } finally {
          rogue.destroy();
        }
      },
    );

    it("rejects an old generation, unrelated page, and caller-supplied actor or baseline", async () => {
      const h = await fixture();
      const delta = frame(h.room.doc, [p("denied")]);
      for (const extra of [
        { generation: "old-generation" },
        { pageId: "wrong-page" },
        { actorRef: "owner" },
        { baseline: "private" },
      ])
        await expect(
          harness.run(
            harness.frameWriter.write({ ...h.input, update: delta, ...extra } as Parameters<
              typeof harness.frameWriter.write
            >[0]),
          ),
        ).rejects.toBeDefined();
      expect(readPageDoc(h.room.doc)).toEqual([p("original")]);
      expect(h.room.currentRevision).toBe(1);
    });

    it("commits owner pending bytes with the guest cut and keeps a later owner frame for the following version", async () => {
      const h = await fixture([p("first"), p("second")]);
      expect(
        sendRoomEdit(h.room, h.connection, [p("first"), p("second"), p("owner pending")]),
      ).toBe(true);
      const delta = frame(h.room.doc, [p("guest first"), p("second"), p("owner pending")]);
      const entered = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const resolve = harness.sharing.resolveEditableGuestPage;
      const pause = vi
        .spyOn(harness.sharing, "resolveEditableGuestPage")
        .mockImplementation((input) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(resolve(input)),
          ),
        );
      try {
        const writing = h.write(delta);
        await harness.run(Deferred.await(entered));
        expect(
          sendRoomEdit(h.room, h.connection, [p("first"), p("owner second"), p("owner pending")]),
        ).toBe(true);
        expect(readPageDoc(h.room.doc)).toEqual([p("first"), p("second"), p("owner pending")]);
        await harness.run(Deferred.succeed(release, undefined));
        await writing;
        const saved = await harness.run(
          harness.pages.versions({ scopeSpaceId: null, pageId: h.page.id }, LOCAL_PAGES_PRINCIPAL),
        );
        expect(JSON.parse(saved.versions[0]!.richContent!)).toEqual([
          p("guest first"),
          p("second"),
          p("owner pending"),
        ]);
        expect(saved.versions[0]!.contributors).toEqual([
          { kind: "local-user" },
          { kind: "guest", actorRef: saved.versions[0]!.authorGuestRef },
        ]);
        expect(readPageDoc(h.room.doc)).toEqual([
          p("guest first"),
          p("owner second"),
          p("owner pending"),
        ]);
        await h.room.compact();
        const latest = await harness.run(
          harness.pages.versions({ scopeSpaceId: null, pageId: h.page.id }, LOCAL_PAGES_PRINCIPAL),
        );
        expect(latest.versions[0]!).toMatchObject({
          page: { revision: 3 },
          contributors: [{ kind: "local-user" }],
        });
      } finally {
        await harness.run(Deferred.succeed(release, undefined));
        pause.mockRestore();
      }
    });

    it("merges two concurrent guests from distinct proofs and refuses a downgraded member on their next frame", async () => {
      const h = await fixture([p("one"), p("two")]);
      const invitation = await harness.run(
        harness.sharing.mutate({
          op: "invite",
          scopeSpaceId: null,
          target: h.target,
          name: "guest member",
          role: "edit",
        }),
      );
      const member = invitation.members[0]!;
      const { shareId: _shareId, ...proof } = entryOf(member.url!);
      const first = frame(h.room.doc, [p("link one"), p("two")]);
      const second = frame(h.room.doc, [p("one"), p("member two")]);
      const personal = (update: Uint8Array) =>
        harness.run(
          harness.frameWriter.write({ ...h.input, entry: { ...proof, visitor: VISITOR }, update }),
        );
      const edits = await Promise.all([h.write(first), personal(second)]);
      expect(edits.map((row) => row.revision).sort()).toEqual([2, 3]);
      expect(readPageDoc(h.room.doc)).toEqual([p("link one"), p("member two")]);
      const versions = await harness.run(
        harness.pages.versions({ scopeSpaceId: null, pageId: h.page.id }, LOCAL_PAGES_PRINCIPAL),
      );
      const refs = versions.versions.slice(0, 2).map((row) => row.authorGuestRef);
      expect(refs.every((ref) => typeof ref === "string" && /^[a-f0-9]{64}$/.test(ref))).toBe(true);
      expect(new Set(refs).size).toBe(2);
      const persisted = JSON.stringify(
        await harness.run(
          harness.sql`SELECT contributors_json FROM pages_version_contributors WHERE page_id=${h.page.id}`,
        ),
      );
      for (const privateValue of [proof.key!, member.id, "guest member", VISITOR])
        expect(persisted).not.toContain(privateValue);
      await harness.run(
        harness.sharing.mutate({
          op: "set-member",
          scopeSpaceId: null,
          target: h.target,
          memberId: member.id,
          role: "comment",
        }),
      );
      await expect(personal(second)).rejects.toMatchObject({ reason: "forbidden" });
      expect(h.room.currentRevision).toBe(3);
    });

    it("rejects a mismatched full durable state even when the same generation, counters and Page revision match", async () => {
      const h = await fixture();
      const delta = frame(h.room.doc, [p("wrong base")]);
      const [old] = await harness.run(
        harness.sql<{
          state: Uint8Array;
        }>`SELECT state FROM pages_realtime_docs WHERE page_id=${h.page.id}`,
      );
      const other = new Y.Doc();
      try {
        Y.applyUpdate(other, old!.state);
        applyPlateValue(other, [p("unrelated DB cut")], null);
        await harness.run(
          harness.sql`UPDATE pages_realtime_docs SET state=${Y.encodeStateAsUpdate(other)} WHERE page_id=${h.page.id}`,
        );
        const before = Y.encodeStateAsUpdate(h.room.doc);
        h.sent.length = 0;
        await expect(h.write(delta)).rejects.toMatchObject({ reason: "unavailable" });
        expect(Y.encodeStateAsUpdate(h.room.doc)).toEqual(before);
        expect(h.sent).toEqual([]);
        expect(h.room.currentRevision).toBe(1);
      } finally {
        other.destroy();
        await harness.run(
          harness.sql`UPDATE pages_realtime_docs SET state=${old!.state} WHERE page_id=${h.page.id}`,
        );
      }
    });

    it("interrupts a deferred authorization, releases the actual SQL transaction and leaves the room retryable", async () => {
      const h = await fixture();
      const delta = frame(h.room.doc, [p("retry after cancel")]);
      const entered = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const abort = new AbortController();
      const resolve = harness.sharing.resolveEditableGuestPage;
      const pause = vi
        .spyOn(harness.sharing, "resolveEditableGuestPage")
        .mockImplementation((input) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(resolve(input)),
          ),
        );
      try {
        h.sent.length = 0;
        const pending = harness
          .run(harness.frameWriter.write({ ...h.input, update: delta }), { signal: abort.signal })
          .then(
            () => false,
            () => true,
          );
        await harness.run(Deferred.await(entered));
        abort.abort();
        expect(await pending).toBe(true);
        expect(
          await harness.run(
            harness.sql`SELECT revision FROM pages_versions WHERE page_id=${h.page.id}`,
          ),
        ).toEqual([{ revision: 1 }]);
        expect(readPageDoc(h.room.doc)).toEqual([p("original")]);
        expect(h.sent).toEqual([]);
      } finally {
        pause.mockRestore();
        await harness.run(Deferred.succeed(release, undefined));
      }
      expect(await h.write(delta)).toEqual({ revision: 2, applied: true });
    });

    it("refuses trashed or moved-scope pages even with a previously valid generation", async () => {
      const h = await fixture();
      const delta = frame(h.room.doc, [p("denied by current Page")]);
      await harness.run(
        harness.sql`UPDATE pages_share_links SET scope_key='project-space:other' WHERE target_id=${h.page.id}`,
      );
      await expect(h.write(delta)).rejects.toMatchObject({ reason: "unavailable" });
      await harness.run(
        harness.sql`UPDATE pages_share_links SET scope_key='local-default' WHERE target_id=${h.page.id}`,
      );
      await harness.run(
        harness.pages.mutate(
          {
            op: "trash",
            requestId: randomUUID(),
            scopeSpaceId: null,
            pageId: h.page.id,
            expectedRevision: 1,
          },
          LOCAL_PAGES_PRINCIPAL,
        ),
      );
      h.sent.length = 0;
      await expect(h.write(delta)).rejects.toBeDefined();
      expect(readPageDoc(h.room.doc)).toEqual([p("original")]);
      expect(h.sent).toEqual([]);
    });

    it("closes active and queued guest work on disposal without accepting or broadcasting either edit", async () => {
      const h = await fixture();
      const delta = frame(h.room.doc, [p("should not be saved")]);
      const entered = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const resolve = harness.sharing.resolveEditableGuestPage;
      const pause = vi
        .spyOn(harness.sharing, "resolveEditableGuestPage")
        .mockImplementation((input) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(resolve(input)),
          ),
        );
      try {
        h.sent.length = 0;
        const first = h.write(delta).then(
          () => false,
          () => true,
        );
        await harness.run(Deferred.await(entered));
        const second = h.write(delta).then(
          () => false,
          () => true,
        );
        await harness.closeService();
        expect(await Promise.all([first, second])).toEqual([true, true]);
        expect(h.room.currentRevision).toBe(1);
        expect(h.sent).toEqual([]);
      } finally {
        pause.mockRestore();
        await Effect.runPromise(Deferred.succeed(release, undefined));
      }
    });
  });

  describe("internal no-room guest body writer", () => {
    const rich = (text: string) => JSON.stringify([{ type: "p", children: [{ text }] }]);
    const fixture = async (
      role: "view" | "comment" | "edit" = "edit",
      kind: SpaceItemKind = "page",
    ) => {
      const page = await harness.createPage("Preserved title", "old content", { kind });
      const target = pageTarget(page.id);
      const initial = await harness.run(harness.sharing.get({ scopeSpaceId: null, target }));
      const state = await harness.run(
        harness.sharing.mutate({
          op: "set-link",
          scopeSpaceId: null,
          target,
          expectedVersion: initial.version,
          setting: { access: "link", role },
        }),
      );
      const { shareId: _shareId, ...proof } = entryOf(state.linkUrl!);
      const input: GuestPageContentWrite = {
        entry: { ...proof, visitor: VISITOR },
        pageId: page.id,
        expectedPageRevision: page.revision,
        richContent: rich("guest edit"),
      };
      return { page, state, input, target };
    };
    const stored = () =>
      harness.run(harness.sql`SELECT * FROM pages_versions ORDER BY page_id, revision`);

    it("does not let an edit grant access to a private library image", async () => {
      const { page, state, input } = await fixture();
      const image = await uploadImage(harness, "private-owner-only.png");
      const proposed = JSON.stringify([
        {
          type: "blockquote",
          children: [{ type: "image", url: image.previewPath, children: [{ text: "" }] }],
        },
      ]);
      const reason = await harness
        .run(harness.writer.write({ ...input, richContent: proposed }))
        .then(
          () => "accepted",
          (cause: { reason?: string }) => cause.reason,
        );
      const current = await harness.run(
        harness.pages.read({ scopeSpaceId: null, pageId: page.id }, LOCAL_PAGES_PRINCIPAL),
      );
      const response = await media(harness, state.linkUrl!, {
        pageId: page.id,
        revision: current.page.revision,
        itemId: image.id,
      });
      expect({
        reason,
        revision: current.page.revision,
        status: response.status,
        exposed: response.bytes.equals(IMAGE_BYTES),
      }).toEqual({ reason: "forbidden", revision: page.revision, status: 403, exposed: false });
    });

    it("preserves owner-shared images while editing and removes access when their reference is removed", async () => {
      const { page, state, input } = await fixture();
      const image = await uploadImage(harness, "owner-included.png");
      const ownerRevision = await harness.updatePage(
        page.id,
        page.revision,
        "",
        imageDocument(image.previewPath!),
      );
      const edit = JSON.stringify([
        { type: "p", children: [{ text: "guest caption" }] },
        { type: "image", url: image.previewPath, children: [{ text: "" }] },
      ]);
      const kept = await harness.run(
        harness.writer.write({ ...input, expectedPageRevision: ownerRevision, richContent: edit }),
      );
      expect(
        (
          await media(harness, state.linkUrl!, {
            pageId: page.id,
            revision: kept.page.revision,
            itemId: image.id,
          })
        ).status,
      ).toBe(200);
      const removed = await harness.run(
        harness.writer.write({
          ...input,
          expectedPageRevision: kept.page.revision,
          richContent: rich("text only"),
        }),
      );
      expect(
        (
          await media(harness, state.linkUrl!, {
            pageId: page.id,
            revision: removed.page.revision,
            itemId: image.id,
          })
        ).status,
      ).toBe(403);
      await expect(
        harness.run(
          harness.writer.write({
            ...input,
            expectedPageRevision: removed.page.revision,
            richContent: edit,
          }),
        ),
      ).rejects.toMatchObject({ reason: "forbidden" });
    });

    it("does not treat image-looking attributes on a text leaf as a shared image", async () => {
      const { page, state, input } = await fixture();
      const image = await uploadImage(harness, "inert-attributes.png");
      const inert = JSON.stringify([
        { type: "p", children: [{ text: "ordinary text", type: "img", url: image.previewPath }] },
      ]);
      const revision = await harness.updatePage(page.id, page.revision, "", inert);
      expect(
        (await media(harness, state.linkUrl!, { pageId: page.id, revision, itemId: image.id }))
          .status,
      ).toBe(403);
      await expect(
        harness.run(
          harness.writer.write({
            ...input,
            expectedPageRevision: revision,
            richContent: imageDocument(image.previewPath!),
          }),
        ),
      ).rejects.toMatchObject({ reason: "forbidden" });
    });

    it("writes only body/revision/time, preserves owner metadata and exposes an irreversible guest history author", async () => {
      const { page, input } = await fixture();
      const appearance = await harness.run(
        harness.pages.mutate(
          {
            op: "page-appearance",
            requestId: randomUUID(),
            scopeSpaceId: null,
            pageId: page.id,
            expectedRevision: page.revision,
            icon: "page-text",
            cover: "sage",
          },
          LOCAL_PAGES_PRINCIPAL,
        ),
      );
      const pinned = await harness.run(
        harness.pages.mutate(
          {
            op: "pin",
            requestId: randomUUID(),
            scopeSpaceId: null,
            pageId: page.id,
            expectedRevision: appearance.page.revision,
            pinned: true,
          },
          LOCAL_PAGES_PRINCIPAL,
        ),
      );
      const old = await harness.run(
        harness.pages.read({ scopeSpaceId: null, pageId: page.id }, LOCAL_PAGES_PRINCIPAL),
      );
      const result = await harness.run(
        harness.writer.write({ ...input, expectedPageRevision: pinned.page.revision }),
      );
      expect(result).toMatchObject({
        content: "guest edit",
        richContent: rich("guest edit"),
        page: { ...old.page, revision: old.page.revision + 1, updatedAt: expect.any(String) },
      });
      const history = await harness.run(
        harness.pages.versions(
          { scopeSpaceId: null, pageId: page.id, summaryOnly: true },
          LOCAL_PAGES_PRINCIPAL,
        ),
      );
      expect(history.versions[0]).toMatchObject({
        author: "guest",
        authorThreadId: null,
        authorGuestRef: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(history.versions[1]).toMatchObject({ author: "local-user" });
      expect(history.versions[1]).not.toHaveProperty("authorGuestRef");
      expect(harness.secretNames()).toContain(PAGE_GUEST_AUTHOR_KEY_PURPOSE);
      const dump = JSON.stringify(await stored());
      for (const value of [input.entry.key, input.entry.link, VISITOR].filter(Boolean))
        expect(dump).not.toContain(value!);
      expect(
        await harness.run(harness.sql`SELECT * FROM pages_requests WHERE actor_key LIKE 'guest%'`),
      ).toEqual([]);
    });
    it("allows just one concurrent write for the same revision", async () => {
      const { input } = await fixture();
      const results = await Promise.allSettled([
        harness.run(harness.writer.write(input)),
        harness.run(harness.writer.write({ ...input, richContent: rich("second") })),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(await stored()).toHaveLength(2);
    });
    it("keeps the entry actor stable across visitor ids, not across different pages", async () => {
      const { input, page } = await fixture();
      await harness.run(harness.writer.write(input));
      await harness.run(
        harness.writer.write({
          ...input,
          entry: { ...input.entry, visitor: "other-visitor" },
          expectedPageRevision: 2,
        }),
      );
      const refs = await harness.run(
        harness.sql`SELECT DISTINCT author_guest_ref FROM pages_versions WHERE page_id=${page.id} AND author='guest'`,
      );
      expect(refs).toHaveLength(1);
      const other = await fixture();
      await harness.run(harness.writer.write(other.input));
      expect(
        await harness.run(
          harness.sql`SELECT DISTINCT author_guest_ref FROM pages_versions WHERE author='guest'`,
        ),
      ).toHaveLength(2);
    });
    it.each(["view", "comment"] as const)("rejects %s roles at the actual writer", async (role) => {
      const { input } = await fixture(role);
      await expect(harness.run(harness.writer.write(input))).rejects.toMatchObject({
        reason: "forbidden",
      });
      expect(await stored()).toHaveLength(1);
    });
    it.each(["app", "slides", "sheet", "board", "site", "file", "image"] as const)(
      "does not write the %s data model",
      async (kind) => {
        const { input } = await fixture("edit", kind);
        await expect(harness.run(harness.writer.write(input))).rejects.toMatchObject({
          reason: "forbidden",
        });
        expect(await stored()).toHaveLength(1);
      },
    );
    it.each(["title", "scopeSpaceId", "actor", "eligibility"])(
      "rejects an injected %s rather than treating it as authority",
      async (field) => {
        const { input } = await fixture();
        await expect(
          harness.run(
            harness.writer.write({ ...input, [field]: "owner" } as GuestPageContentWrite),
          ),
        ).rejects.toMatchObject({ reason: "invalid" });
        expect(await stored()).toHaveLength(1);
      },
    );
    it.each([
      "not json",
      '[{"type":"p","children":[{"text":"x"}],"constructor":{}}]',
      "x".repeat(2_000_001),
    ])("rejects malformed or oversized canonical content %#", async (richContent) => {
      const { input } = await fixture();
      await expect(
        harness.run(harness.writer.write({ ...input, richContent })),
      ).rejects.toMatchObject({ reason: "invalid" });
      expect(await stored()).toHaveLength(1);
    });
    it("rechecks a rotated link even after eligibility was previously obtained", async () => {
      const { input, state, target } = await fixture();
      await harness.run(
        harness.sharing.resolveEditableGuestPage({
          ...input.entry,
          pageId: input.pageId,
          expectedPageRevision: 1,
        }),
      );
      await harness.run(
        harness.sharing.mutate({
          op: "rotate-link",
          scopeSpaceId: null,
          target,
          expectedVersion: state.version,
        }),
      );
      await expect(harness.run(harness.writer.write(input))).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect(await stored()).toHaveLength(1);
    });
    it.each(["view", null] as const)(
      "rechecks member downgrade/removal %s and never stores its proof/name",
      async (role) => {
        const { page, target, input } = await fixture();
        const state = await harness.run(
          harness.sharing.mutate({
            op: "invite",
            scopeSpaceId: null,
            target,
            name: "private member name",
            contact: "member@example.test",
            role: "edit",
          }),
        );
        const member = state.members[0]!;
        const { shareId: _shareId, ...proof } = entryOf(member.url!);
        const memberInput = { ...input, entry: { ...proof, visitor: VISITOR } };
        await harness.run(harness.writer.write(memberInput));
        await harness.run(
          harness.sharing.mutate({
            op: "set-member",
            scopeSpaceId: null,
            target,
            memberId: member.id,
            role,
          }),
        );
        await expect(
          harness.run(harness.writer.write({ ...memberInput, expectedPageRevision: 2 })),
        ).rejects.toBeDefined();
        const dump = JSON.stringify(await stored());
        for (const text of [proof.key!, member.id, "private member name"])
          expect(dump).not.toContain(text);
        expect(
          (
            await harness.run(
              harness.pages.read({ scopeSpaceId: null, pageId: page.id }, LOCAL_PAGES_PRINCIPAL),
            )
          ).page.revision,
        ).toBe(2);
      },
    );
    it("does not bypass an existing realtime room", async () => {
      const { input, page } = await fixture();
      await harness.run(
        harness.realtime.issueToken({ pageId: page.id, scopeSpaceId: null }, LOCAL_PAGES_PRINCIPAL),
      );
      await expect(harness.run(harness.writer.write(input))).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect(await stored()).toHaveLength(1);
    });
    it("rolls back an already-written transaction on cancellation before commit", async () => {
      const { input } = await fixture();
      const entered = Deferred.makeUnsafe<void>();
      const signal = new AbortController();
      const original = harness.sql.withTransaction;
      const spy = vi.spyOn(harness.sql, "withTransaction").mockImplementationOnce((effect) =>
        original(
          effect.pipe(
            Effect.tap(() => Deferred.succeed(entered, undefined)),
            Effect.tap(() => Effect.never),
          ),
        ),
      );
      try {
        const pending = harness
          .run(harness.writer.write(input), { signal: signal.signal })
          .catch((error) => error);
        await harness.run(Deferred.await(entered).pipe(Effect.timeout("2 seconds")));
        signal.abort();
        await pending;
      } finally {
        spy.mockRestore();
      }
      expect(await stored()).toHaveLength(1);
      expect((await harness.run(harness.writer.write(input))).page.revision).toBe(2);
    });
    it("bounds only the new guest write deadline while waiting for a room reservation", async () => {
      const { input, page } = await fixture();
      const entered = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const held = harness.run(
        harness.realtime.withRoomClosed(
          page.id,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      await harness.run(Deferred.await(entered));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const pending = harness.run(harness.writer.write(input)).catch((error) => error);
        await vi.advanceTimersByTimeAsync(5_001);
        expect(await pending).toMatchObject({ reason: "unavailable" });
      } finally {
        await harness.run(Deferred.succeed(release, undefined));
        await held;
        vi.useRealTimers();
      }
      expect(await stored()).toHaveLength(1);
      expect((await harness.run(harness.writer.write(input))).page.revision).toBe(2);
    });
    it("closes queued writes and rejects reuse after service scope disposal", async () => {
      const { input, page } = await fixture();
      const entered = Deferred.makeUnsafe<void>();
      const holding = harness
        .run(
          harness.realtime.withRoomClosed(
            page.id,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        )
        .catch((error) => error);
      await harness.run(Deferred.await(entered));
      const pending = harness.run(harness.writer.write(input)).catch((error) => error);
      await harness.closeService();
      await Promise.all([holding, pending]);
      await expect(Effect.runPromise(harness.writer.write(input))).rejects.toMatchObject({
        reason: "unavailable",
      });
    });
  });

  describe("internal readonly AppItem authorization", () => {
    type ResolveRequest = Parameters<PageSharingServiceShape["resolveReadonlyAppItem"]>[0];
    const appData = (html: string) =>
      JSON.stringify({ version: 1, html, capabilities: ["db", "ai", "user"] });
    const writeData = (pageId: PageId, revision: number, data: string, kind = "app") =>
      harness.run(harness.sql`INSERT OR REPLACE INTO pages_item_data
        (page_id, revision, kind, data, author, author_thread_id, created_at)
        VALUES (${pageId}, ${revision}, ${kind}, ${data}, 'local-user', NULL, '2026-11-06T00:00:00.000Z')`);
    const resolve = (
      url: string,
      pageId: PageId,
      expectedPageRevision: number,
      extra: Partial<ResolveRequest> = {},
    ) => {
      const { shareId: _shareId, ...proof } = entryOf(url);
      return harness.run(
        harness.sharing.resolveReadonlyAppItem({
          ...proof,
          visitor: VISITOR,
          pageId,
          expectedPageRevision,
          ...extra,
        }),
      );
    };
    const shared = async (
      role: "view" | "comment" | "edit" = "view",
      access: "anyone" | "link" = "anyone",
      title = "Authorized app",
    ) => {
      const page = await harness.createPage(title, "App text", { kind: "app" });
      await writeData(page.id, page.revision, appData("<h1>Authorized</h1>"));
      const initial = await harness.run(
        harness.sharing.get({ scopeSpaceId: null, target: pageTarget(page.id) }),
      );
      const state = await harness.run(
        harness.sharing.mutate({
          op: "set-link",
          scopeSpaceId: null,
          target: pageTarget(page.id),
          expectedVersion: initial.version,
          setting: { access, role },
        }),
      );
      return { page, state };
    };

    const openPreview = (url: string, pageId: PageId, expectedPageRevision: number) => {
      const { shareId: _shareId, ...proof } = entryOf(url);
      const frameSecret = randomBytes(32).toString("base64url");
      const input = {
        ...proof,
        visitor: VISITOR,
        pageId,
        expectedPageRevision,
        frameNonce: randomUUID(),
        frameSecretHash: createHash("sha256").update(frameSecret).digest("base64url"),
      };
      return {
        frameSecret,
        input,
        run: () => harness.run(harness.sharing.openReadonlyAppItemPreview(input)),
      };
    };
    const enablePreview = () => {
      harness.relayEnv.MOSS_PAGE_APP_PREVIEW_CONTENT_ORIGIN = "http://localhost:53842";
    };

    it.each([null, "http://localhost:53843"])(
      "requires matching preview capability in the actual registration receipt: %s",
      async (origin) => {
        harness.relay.appPreviewContentOrigin = origin;
        enablePreview();
        const { page, state } = await shared();
        const preview = openPreview(state.linkUrl!, page.id, page.revision);
        expect((await openPage(harness, state.linkUrl!)).body).not.toHaveProperty("appPreview");
        await expect(preview.run()).rejects.toMatchObject({ reason: "unavailable" });
      },
    );

    it("invalidates an unused ticket when the actual publisher registration expires", async () => {
      enablePreview();
      const { page, state } = await shared();
      const preview = openPreview(state.linkUrl!, page.id, page.revision);
      const receipt = await preview.run();
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1000 + 1_000);
      try {
        await expect(
          harness.run(
            harness.sharing.consumeReadonlyAppItemPreview({
              ticket: receipt.ticket,
              frameSecret: preview.frameSecret,
            }),
          ),
        ).rejects.toMatchObject({ reason: "unavailable" });
      } finally {
        clock.mockRestore();
      }
    });

    it("handles preview open and form document only with the registered relay context", async () => {
      enablePreview();
      const { page, state } = await shared();
      const preview = openPreview(state.linkUrl!, page.id, page.revision);
      expect((await openPage(harness, state.linkUrl!)).body.appPreview).toEqual({
        protocolVersion: 1,
        contentOrigin: "http://localhost:53842",
      });
      const { shareId } = entryOf(state.linkUrl!);
      const host = await harness.relay.waitForHost(shareId);
      const contextHeaders = {
        "x-moss-app-preview-parent-origin": harness.relay.origin,
        "x-moss-app-preview-content-origin": "http://localhost:53842",
      };
      const openResponse = host.request({
        method: "POST",
        route: "page-app-preview-open",
        headers: {
          ...contextHeaders,
          "x-moss-app-preview-kind": "open",
          "content-type": "application/json",
        },
        body: [encoder.encode(JSON.stringify(preview.input))],
      }).response;
      expect((await openResponse.head).status).toBe(200);
      const receipt = JSON.parse(await openResponse.text());
      const documentHeaders = {
        ...contextHeaders,
        "x-moss-app-preview-kind": "document",
        "content-type": "application/x-www-form-urlencoded",
      };
      const form = encoder.encode(
        new URLSearchParams({
          ticket: receipt.ticket,
          frameSecret: preview.frameSecret,
        }).toString(),
      );
      const rejected = host.request({
        method: "POST",
        route: "page-app-preview-document",
        headers: {
          ...documentHeaders,
          "x-moss-app-preview-parent-origin": "https://forged.example",
        },
        body: [form],
      }).response;
      expect((await rejected.head).status).toBeGreaterThanOrEqual(400);
      expect(JSON.parse(await rejected.text())).toMatchObject({ reason: "unavailable" });
      const document = host.request({
        method: "POST",
        route: "page-app-preview-document",
        headers: documentHeaders,
        body: [form],
      }).response;
      expect((await document.head).status).toBe(200);
      expect(await document.text()).toContain("<h1>Authorized</h1>");
    });

    it("does not issue without owner configuration; uses the registered publisher origin when enabled", async () => {
      const { page, state } = await shared();
      const preview = openPreview(state.linkUrl!, page.id, page.revision);
      await expect(preview.run()).rejects.toMatchObject({ reason: "unavailable" });
      enablePreview();
      const receipt = await preview.run();
      const result = await harness.run(
        harness.sharing.consumeReadonlyAppItemPreview({
          ticket: receipt.ticket,
          frameSecret: preview.frameSecret,
        }),
      );
      expect(result.headers["content-security-policy"]).toContain(
        `frame-ancestors ${harness.relay.origin}`,
      );
      const html = new TextDecoder().decode(result.bytes);
      expect(html).toContain("<h1>Authorized</h1>");
      expect(html).not.toContain(preview.frameSecret);
      expect(html).not.toContain(receipt.ticket);
      expect(html).not.toContain(preview.input.key!);
      expect(html).not.toContain(VISITOR);
    });

    it("rejects a real link rotation between ticket issue and consumption", async () => {
      enablePreview();
      const { page, state } = await shared("view", "link");
      const preview = openPreview(state.linkUrl!, page.id, page.revision);
      const receipt = await preview.run();
      await harness.run(
        harness.sharing.mutate({
          op: "rotate-link",
          scopeSpaceId: null,
          target: pageTarget(page.id),
          expectedVersion: state.version,
        }),
      );
      await expect(
        harness.run(
          harness.sharing.consumeReadonlyAppItemPreview({
            ticket: receipt.ticket,
            frameSecret: preview.frameSecret,
          }),
        ),
      ).rejects.toMatchObject({ reason: "unavailable" });
    });

    it("rejects a removed member after ticket issue", async () => {
      enablePreview();
      const { page } = await shared();
      const state = await harness.run(
        harness.sharing.mutate({
          op: "invite",
          scopeSpaceId: null,
          target: pageTarget(page.id),
          name: "Private member",
          role: "view",
        }),
      );
      const member = state.members[0]!;
      const preview = openPreview(member.url!, page.id, page.revision);
      const receipt = await preview.run();
      await harness.run(
        harness.sharing.mutate({
          op: "set-member",
          scopeSpaceId: null,
          target: pageTarget(page.id),
          memberId: member.id,
          role: null,
        }),
      );
      await expect(
        harness.run(
          harness.sharing.consumeReadonlyAppItemPreview({
            ticket: receipt.ticket,
            frameSecret: preview.frameSecret,
          }),
        ),
      ).rejects.toMatchObject({ reason: "unavailable" });
    });

    it("rejects a real site republish after ticket issue", async () => {
      enablePreview();
      const { page } = await shared();
      const { site } = await harness.run(
        harness.sharing.siteMutate({
          op: "publish",
          scopeSpaceId: null,
          pageId: page.id,
          visibility: "anyone",
          acceptTerms: true,
        }),
      );
      const preview = openPreview(site.url!, page.id, page.revision);
      const receipt = await preview.run();
      await harness.updatePage(page.id, page.revision, "New revision");
      await harness.run(
        harness.sharing.siteMutate({
          op: "publish",
          scopeSpaceId: null,
          pageId: page.id,
          visibility: "anyone",
        }),
      );
      await expect(
        harness.run(
          harness.sharing.consumeReadonlyAppItemPreview({
            ticket: receipt.ticket,
            frameSecret: preview.frameSecret,
          }),
        ),
      ).rejects.toMatchObject({ reason: "unavailable" });
    });

    it("rejects changed typed bytes at the same revision", async () => {
      enablePreview();
      const { page, state } = await shared();
      const preview = openPreview(state.linkUrl!, page.id, page.revision);
      const receipt = await preview.run();
      await writeData(page.id, page.revision, appData("<h1>Other HTML</h1>"));
      await expect(
        harness.run(
          harness.sharing.consumeReadonlyAppItemPreview({
            ticket: receipt.ticket,
            frameSecret: preview.frameSecret,
          }),
        ),
      ).rejects.toMatchObject({ reason: "unavailable" });
    });

    it("rejects a trashed page after ticket issue", async () => {
      enablePreview();
      const { page, state } = await shared();
      const preview = openPreview(state.linkUrl!, page.id, page.revision);
      const receipt = await preview.run();
      await harness.run(
        harness.pages.mutate(
          {
            op: "trash",
            requestId: randomUUID(),
            scopeSpaceId: null,
            pageId: page.id,
            expectedRevision: page.revision,
          },
          LOCAL_PAGES_PRINCIPAL,
        ),
      );
      await expect(
        harness.run(
          harness.sharing.consumeReadonlyAppItemPreview({
            ticket: receipt.ticket,
            frameSecret: preview.frameSecret,
          }),
        ),
      ).rejects.toMatchObject({ reason: "unavailable" });
    });

    it("allows only one real concurrent consumption", async () => {
      enablePreview();
      const { page, state } = await shared();
      const preview = openPreview(state.linkUrl!, page.id, page.revision);
      const receipt = await preview.run();
      const consume = () =>
        harness.run(
          harness.sharing.consumeReadonlyAppItemPreview({
            ticket: receipt.ticket,
            frameSecret: preview.frameSecret,
          }),
        );
      const outcomes = await Promise.allSettled([consume(), consume()]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    });

    it("closes outstanding tickets with the actual service scope", async () => {
      enablePreview();
      const { page, state } = await shared();
      const preview = openPreview(state.linkUrl!, page.id, page.revision);
      const receipt = await preview.run();
      await harness.closeService();
      await expect(
        Effect.runPromise(
          harness.sharing.consumeReadonlyAppItemPreview({
            ticket: receipt.ticket,
            frameSecret: preview.frameSecret,
          }),
        ),
      ).rejects.toMatchObject({ reason: "unavailable" });
      await expect(
        Effect.runPromise(harness.sharing.openReadonlyAppItemPreview(preview.input)),
      ).rejects.toMatchObject({ reason: "unavailable" });
    });

    it("selects the latest eligible app data row and exposes only readonly public metadata", async () => {
      const { page, state } = await shared();
      const revision = await harness.updatePage(page.id, page.revision, "New readable text");
      await writeData(page.id, revision + 1, appData("<h1>Future</h1>"));
      const result = await resolve(state.linkUrl!, page.id, revision);
      expect(result).toEqual({
        source: {
          sourceKind: "page-item",
          pageId: page.id,
          pageRevision: revision,
          dataRevision: page.revision,
        },
        html: "<h1>Authorized</h1>",
        publicMetadata: { title: "Authorized app", revision },
        availableCapabilities: [],
      });
      expect(JSON.stringify(result)).not.toContain(VISITOR);
    });

    it("keeps a site at its published revision, then rechecks republish and unpublish", async () => {
      const { page } = await shared();
      const { site } = await harness.run(
        harness.sharing.siteMutate({
          op: "publish",
          scopeSpaceId: null,
          pageId: page.id,
          visibility: "anyone",
          acceptTerms: true,
        }),
      );
      const revision = await harness.updatePage(page.id, page.revision, "Owner draft");
      await writeData(page.id, revision, appData("<h1>Draft</h1>"));
      expect((await resolve(site.url!, page.id, page.revision)).html).toBe("<h1>Authorized</h1>");
      await expect(resolve(site.url!, page.id, revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
      const { site: republished } = await harness.run(
        harness.sharing.siteMutate({
          op: "publish",
          scopeSpaceId: null,
          pageId: page.id,
          visibility: "anyone",
        }),
      );
      expect((await resolve(republished.url!, page.id, revision)).html).toBe("<h1>Draft</h1>");
      await expect(resolve(republished.url!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
      await harness.run(
        harness.sharing.siteMutate({ op: "unpublish", scopeSpaceId: null, siteId: site.id }),
      );
      await expect(resolve(republished.url!, page.id, revision)).rejects.toMatchObject({
        reason: "unpublished",
      });
    });

    it("rejects pages outside the shared page set", async () => {
      const { state } = await shared();
      const other = await harness.createPage("Private app", "private", { kind: "app" });
      await writeData(other.id, other.revision, appData("<h1>Private</h1>"));
      await expect(resolve(state.linkUrl!, other.id, other.revision)).rejects.toMatchObject({
        reason: "forbidden",
      });
    });

    it("rejects historical HTML when the current page is trashed", async () => {
      const { page, state } = await shared();
      await harness.run(
        harness.pages.mutate(
          {
            op: "trash",
            requestId: randomUUID(),
            scopeSpaceId: null,
            pageId: page.id,
            expectedRevision: page.revision,
          },
          LOCAL_PAGES_PRINCIPAL,
        ),
      );
      await expect(resolve(state.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
    });

    it("rejects a stale expected revision without silently upgrading HTML", async () => {
      const { page, state } = await shared();
      await harness.updatePage(page.id, page.revision, "Updated");
      await expect(resolve(state.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
    });

    it("revalidates a rotated link and a forged link proof", async () => {
      const { page, state } = await shared("view", "link");
      await expect(
        resolve(state.linkUrl!, page.id, page.revision, { key: "forged" }),
      ).rejects.toMatchObject({ reason: "forbidden" });
      await harness.run(
        harness.sharing.mutate({
          op: "rotate-link",
          scopeSpaceId: null,
          target: pageTarget(page.id),
          expectedVersion: state.version,
        }),
      );
      await expect(resolve(state.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
    });

    it("does not borrow a page id from another scope", async () => {
      const { page, state } = await shared();
      await harness.run(
        harness.sql`UPDATE pages_share_links SET scope_key = 'project-space:other' WHERE target_id = ${page.id}`,
      );
      await expect(resolve(state.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
    });

    it.each(["wrong-kind", "future-only", "malformed", "oversized"])(
      "does not execute %s typed payloads",
      async (kind) => {
        const { page, state } = await shared();
        await harness.run(harness.sql`DELETE FROM pages_item_data WHERE page_id = ${page.id}`);
        if (kind === "wrong-kind")
          await writeData(page.id, page.revision, appData("<h1>Wrong kind</h1>"), "slides");
        else if (kind === "future-only")
          await writeData(page.id, page.revision + 1, appData("<h1>Future</h1>"));
        else
          await writeData(
            page.id,
            page.revision,
            kind === "malformed" ? "{" : appData("x".repeat(2_000_001)),
          );
        await expect(resolve(state.linkUrl!, page.id, page.revision)).rejects.toMatchObject({
          reason: "unavailable",
        });
      },
    );

    it.each(["view", "comment", "edit"] as const)(
      "does not upgrade a %s role to app capabilities or visitor identity",
      async (role) => {
        const { page, state } = await shared(role);
        const first = await resolve(state.linkUrl!, page.id, page.revision);
        const anotherVisitor = await resolve(state.linkUrl!, page.id, page.revision, {
          visitor: "another-visitor",
        });
        expect(first.availableCapabilities).toEqual([]);
        expect(anotherVisitor).toEqual(first);
        expect(Object.keys(first.publicMetadata).sort()).toEqual(["revision", "title"]);
      },
    );

    it("rechecks member removal and never treats a visitor id as a credential", async () => {
      const { page } = await shared();
      const state = await harness.run(
        harness.sharing.mutate({
          op: "invite",
          scopeSpaceId: null,
          target: pageTarget(page.id),
          name: "Private member name",
          role: "view",
        }),
      );
      const member = state.members[0]!;
      const result = await resolve(member.url!, page.id, page.revision);
      expect(JSON.stringify(result)).not.toContain("Private member name");
      await harness.run(
        harness.sharing.mutate({
          op: "set-member",
          scopeSpaceId: null,
          target: pageTarget(page.id),
          memberId: member.id,
          role: null,
        }),
      );
      await expect(resolve(member.url!, page.id, page.revision)).rejects.toMatchObject({
        reason: "unavailable",
      });
      await expect(
        harness.run(
          harness.sharing.resolveReadonlyAppItem({
            visitor: VISITOR,
            pageId: page.id,
            expectedPageRevision: page.revision,
          }),
        ),
      ).rejects.toMatchObject({ reason: "unavailable" });
    });

    it("keeps the existing Page title boundary and validates the existing guest request shape", async () => {
      const title = "a".repeat(256);
      const { page, state } = await shared("view", "anyone", title);
      expect((await resolve(state.linkUrl!, page.id, page.revision)).publicMetadata.title).toBe(
        title,
      );
      await expect(
        resolve(state.linkUrl!, page.id, page.revision, { visitor: "bad" }),
      ).rejects.toMatchObject({ reason: "invalid" });
      await expect(resolve(state.linkUrl!, page.id, Number.NaN)).rejects.toMatchObject({
        reason: "invalid",
      });
    });
  });

  it("serves only image references in the authorized page revision and rechecks link and trash state", async () => {
    const image = await uploadImage(harness, "included.png");
    const other = await uploadImage(harness, "not-shared.png");
    const page = await harness.createPage("Picture", "", {
      richContent: imageDocument(image.previewPath!),
    });
    const outside = await harness.createPage("Private", "", {
      richContent: imageDocument(other.previewPath!),
    });
    const initial = await harness.run(
      harness.sharing.get({ scopeSpaceId: null, target: pageTarget(page.id) }),
    );
    const state = await harness.run(
      harness.sharing.mutate({
        op: "set-link",
        scopeSpaceId: null,
        target: pageTarget(page.id),
        expectedVersion: initial.version,
        setting: { access: "link", role: "view" },
      }),
    );
    const request = { pageId: page.id, revision: page.revision, itemId: image.id };
    const allowed = await media(harness, state.linkUrl!, request);
    expect(allowed.status).toBe(200);
    expect(allowed.bytes).toEqual(IMAGE_BYTES);
    expect(allowed.headers["content-type"]).toBe("image/png");
    expect(allowed.headers["cache-control"]).toBe("no-store");
    expect((await media(harness, state.linkUrl!, { ...request, itemId: other.id })).status).toBe(
      403,
    );
    expect(
      (await media(harness, state.linkUrl!, { ...request, pageId: outside.id, itemId: other.id }))
        .status,
    ).toBe(403);
    expect((await media(harness, state.linkUrl!, { ...request, key: "forged" })).status).toBe(403);
    expect(
      (await media(harness, state.linkUrl!, { ...request, itemId: "../file.png" })).status,
    ).toBe(400);
    await harness.run(harness.library.trash({ ids: [image.id] }));
    expect((await media(harness, state.linkUrl!, request)).status).toBe(404);
    await harness.run(harness.library.restore({ ids: [image.id] }));
    expect((await media(harness, state.linkUrl!, request)).status).toBe(200);
    await harness.run(
      harness.sharing.mutate({
        op: "rotate-link",
        scopeSpaceId: null,
        target: pageTarget(page.id),
        expectedVersion: state.version,
      }),
    );
    expect((await media(harness, state.linkUrl!, request)).status).toBe(404);
  });

  it("keeps site images at the published revision and invalidates old media on republish/unpublish", async () => {
    const image = await uploadImage(harness, "published.png");
    const draft = await uploadImage(harness, "draft.png");
    const page = await harness.createPage("Site", "", {
      richContent: imageDocument(image.previewPath!),
    });
    const { site } = await harness.run(
      harness.sharing.siteMutate({
        op: "publish",
        scopeSpaceId: null,
        pageId: page.id,
        visibility: "anyone",
        acceptTerms: true,
      }),
    );
    const revision = await harness.updatePage(
      page.id,
      page.revision,
      "",
      imageDocument(draft.previewPath!),
    );
    const old = { pageId: page.id, revision: page.revision, itemId: image.id };
    expect((await media(harness, site.url!, old)).status).toBe(200);
    expect((await media(harness, site.url!, { ...old, itemId: draft.id })).status).toBe(403);
    expect((await media(harness, site.url!, { ...old, revision, itemId: draft.id })).status).toBe(
      404,
    );
    const { site: published } = await harness.run(
      harness.sharing.siteMutate({
        op: "publish",
        scopeSpaceId: null,
        pageId: page.id,
        visibility: "anyone",
      }),
    );
    expect((await media(harness, published.url!, old)).status).toBe(404);
    expect(
      (await media(harness, published.url!, { ...old, revision, itemId: draft.id })).status,
    ).toBe(200);
    await harness.run(
      harness.sharing.siteMutate({ op: "unpublish", scopeSpaceId: null, siteId: site.id }),
    );
    expect(
      (await media(harness, published.url!, { ...old, revision, itemId: draft.id })).status,
    ).toBe(404);
  });

  it("does not turn external image URLs or stale shared revisions into library access", async () => {
    const image = await uploadImage(harness, "private.png");
    const page = await harness.createPage("External", "", {
      richContent: imageDocument(`https://outside.invalid${image.previewPath}`),
    });
    const initial = await harness.run(
      harness.sharing.get({ scopeSpaceId: null, target: pageTarget(page.id) }),
    );
    const state = await harness.run(
      harness.sharing.mutate({
        op: "set-link",
        scopeSpaceId: null,
        target: pageTarget(page.id),
        expectedVersion: initial.version,
        setting: { access: "anyone", role: "view" },
      }),
    );
    const request = { pageId: page.id, revision: page.revision, itemId: image.id };
    expect((await media(harness, state.linkUrl!, request)).status).toBe(403);
    const revision = await harness.updatePage(
      page.id,
      page.revision,
      "",
      imageDocument(image.previewPath!),
    );
    expect((await media(harness, state.linkUrl!, request)).status).toBe(404);
    expect((await media(harness, state.linkUrl!, { ...request, revision })).status).toBe(200);
  });

  it("registers one publisher and keeps invited-only links closed", async () => {
    const page = await harness.createPage("计划", "第一段");
    const state = await harness.run(
      harness.sharing.get({ scopeSpaceId: null, target: pageTarget(page.id) }),
    );
    expect(state.effective).toEqual({ access: "invited", role: "view" });
    expect(state.linkUrl).toContain(`${harness.relay.origin}/p/`);
    expect(harness.relay.registerCalls).toHaveLength(1);

    const second = await harness.createPage("第二页", "");
    await harness.run(harness.sharing.get({ scopeSpaceId: null, target: pageTarget(second.id) }));
    expect(harness.relay.registerCalls).toHaveLength(1);

    const refused = await openPage(harness, state.linkUrl!);
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe("invite-only");
  });

  it("opens a link page read-only, takes guest comments, and audits opens", async () => {
    const page = await harness.createPage("周报", "本周完成了发布。");
    const initial = await harness.run(
      harness.sharing.get({ scopeSpaceId: null, target: pageTarget(page.id) }),
    );
    const state = await harness.run(
      harness.sharing.mutate({
        op: "set-link",
        scopeSpaceId: null,
        target: pageTarget(page.id),
        expectedVersion: initial.version,
        setting: { access: "link", role: "comment" },
      }),
    );
    const opened = await openPage(harness, state.linkUrl!);
    expect(opened.status).toBe(200);
    const view = opened.body as PageGuestView;
    expect(view.page.content).toBe("本周完成了发布。");
    expect(view.canComment).toBe(true);

    const { shareId, link } = entryOf(state.linkUrl!);
    const forged = await guest(harness, shareId, "page", { link, key: "l.AAAAAAAAAAAAAAAAAAAAAA" });
    expect(forged.status).toBe(403);
    const noKey = await guest(harness, shareId, "page", { link });
    expect(noKey.body.reason).toBe("invite-only");

    const comment = await guest(harness, shareId, "page-comments", {
      ...entryOf(state.linkUrl!),
      shareId: undefined,
      action: "add",
      pageId: page.id,
      name: "小王",
      content: "第二段能再展开吗？",
    });
    expect(comment.status).toBe(200);
    expect(comment.body.comments).toHaveLength(1);

    const activity = await harness.run(
      harness.sharing.activity({ scopeSpaceId: null, pageId: page.id }),
    );
    expect(activity.comments[0]).toMatchObject({ authorKind: "guest", authorName: "小王" });
    expect(activity.events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["opened", "commented", "link-changed"]),
    );
    // A second open by the same visitor within half an hour is not counted again.
    await openPage(harness, state.linkUrl!);
    const after = await harness.run(
      harness.sharing.activity({ scopeSpaceId: null, pageId: page.id }),
    );
    expect(after.events.filter((event) => event.action === "opened")).toHaveLength(1);

    const replied = await harness.run(
      harness.sharing.reply({ scopeSpaceId: null, pageId: page.id, content: "好的，明天补上" }),
    );
    expect(replied.comments.map((item) => item.authorKind)).toEqual(["guest", "owner"]);
  });

  it("refuses comments for view-only links and kills rotated links", async () => {
    const page = await harness.createPage("只读", "内容");
    const initial = await harness.run(
      harness.sharing.get({ scopeSpaceId: null, target: pageTarget(page.id) }),
    );
    const state = await harness.run(
      harness.sharing.mutate({
        op: "set-link",
        scopeSpaceId: null,
        target: pageTarget(page.id),
        expectedVersion: initial.version,
        setting: { access: "anyone", role: "view" },
      }),
    );
    const { shareId, link } = entryOf(state.linkUrl!);
    expect((await guest(harness, shareId, "page", { link })).status).toBe(200);
    const comment = await guest(harness, shareId, "page-comments", {
      link,
      action: "add",
      pageId: page.id,
      name: "访客",
      content: "你好",
    });
    expect(comment.status).toBe(403);

    const stale = harness.run(
      harness.sharing.mutate({
        op: "rotate-link",
        scopeSpaceId: null,
        target: pageTarget(page.id),
        expectedVersion: initial.version,
      }),
    );
    await expect(stale).rejects.toMatchObject({ code: "conflict" });
    const rotated = await harness.run(
      harness.sharing.mutate({
        op: "rotate-link",
        scopeSpaceId: null,
        target: pageTarget(page.id),
        expectedVersion: state.version,
      }),
    );
    expect(rotated.linkUrl).not.toBe(state.linkUrl);
    expect((await guest(harness, shareId, "page", { link })).status).toBe(404);
    expect((await openPage(harness, rotated.linkUrl!)).status).toBe(200);
  });

  it("lets invited people in through their personal link until they are removed", async () => {
    const page = await harness.createPage("合同", "条款");
    const state = await harness.run(
      harness.sharing.mutate({
        op: "invite",
        scopeSpaceId: null,
        target: pageTarget(page.id),
        name: "李律师",
        contact: "li@example.com",
        role: "comment",
      }),
    );
    const member = state.members[0]!;
    expect(member.url).not.toContain(`${PAGE_GUEST_LINK_PARAM}=`);
    const opened = await openPage(harness, member.url!);
    expect(opened.status).toBe(200);
    expect(opened.body.viewerName).toBe("李律师");

    const { shareId, key } = entryOf(member.url!);
    const comment = await guest(harness, shareId, "page-comments", {
      key,
      action: "add",
      pageId: page.id,
      content: "第三条需要修改",
    });
    expect(comment.body.comments[0]).toMatchObject({ authorKind: "member", authorName: "李律师" });

    await harness.run(
      harness.sharing.mutate({
        op: "set-member",
        scopeSpaceId: null,
        target: pageTarget(page.id),
        memberId: member.id,
        role: null,
      }),
    );
    expect((await openPage(harness, member.url!)).status).toBe(404);
  });

  it("turns an approved access request into a personal credential", async () => {
    const page = await harness.createPage("预算", "数字");
    const state = await harness.run(
      harness.sharing.get({ scopeSpaceId: null, target: pageTarget(page.id) }),
    );
    const { shareId, link } = entryOf(state.linkUrl!);
    const filed = await guest(harness, shareId, "page-access", {
      link,
      action: "request",
      name: "张三",
      note: "我负责财务",
      role: "view",
    });
    expect(filed.body.status).toBe("pending");
    const status = { action: "status", requestId: filed.body.requestId, secret: filed.body.secret };
    expect((await guest(harness, shareId, "page-access", status)).body.status).toBe("pending");
    const wrongSecret = await guest(harness, shareId, "page-access", { ...status, secret: "nope" });
    expect(wrongSecret.status).toBe(404);

    const pending = await harness.run(
      harness.sharing.get({ scopeSpaceId: null, target: pageTarget(page.id) }),
    );
    expect(pending.requests).toHaveLength(1);
    const approved = await harness.run(
      harness.sharing.mutate({
        op: "decide-request",
        scopeSpaceId: null,
        target: pageTarget(page.id),
        requestId: pending.requests[0]!.id,
        decision: "approve",
      }),
    );
    expect(approved.requests).toHaveLength(0);
    expect(approved.members.map((item) => item.name)).toEqual(["张三"]);
    const decided = await guest(harness, shareId, "page-access", status);
    expect(decided.body.status).toBe("approved");
    const opened = await guest(harness, shareId, "page", { key: decided.body.key });
    expect(opened.status).toBe(200);
  });

  it("inherits space access and never lets a page narrow it", async () => {
    const space = await harness.createSpace("项目");
    const child = await harness.createPage("子页", "内容", {
      spaceId: space.id,
      parentPageId: space.rootPageId,
    });
    const spaceTarget: PageShareTarget = { kind: "space", id: space.id as never };
    const spaceState = await harness.run(
      harness.sharing.get({ scopeSpaceId: null, target: spaceTarget }),
    );
    await harness.run(
      harness.sharing.mutate({
        op: "set-link",
        scopeSpaceId: null,
        target: spaceTarget,
        expectedVersion: spaceState.version,
        setting: { access: "link", role: "comment" },
      }),
    );
    const pageState = await harness.run(
      harness.sharing.get({ scopeSpaceId: null, target: pageTarget(child.id) }),
    );
    expect(pageState.inheritedFrom?.title).toBe("项目");
    expect(pageState.direct).toBeNull();
    expect(pageState.effective).toEqual({ access: "link", role: "comment" });
    expect((await openPage(harness, pageState.linkUrl!)).status).toBe(200);

    const narrower = harness.run(
      harness.sharing.mutate({
        op: "set-link",
        scopeSpaceId: null,
        target: pageTarget(child.id),
        expectedVersion: pageState.version,
        setting: { access: "invited", role: "view" },
      }),
    );
    await expect(narrower).rejects.toMatchObject({ code: "invalid" });

    const spaceLink = await openPage(harness, spaceState.linkUrl!);
    expect(spaceLink.status).toBe(200);
    expect(spaceLink.body.pages.map((item: { id: string }) => item.id)).toContain(child.id);
    const childView = await openPage(harness, spaceState.linkUrl!, { pageId: child.id });
    expect(childView.body.page.title).toBe("子页");
  });

  it("publishes a site at a fixed revision, counts views, and unpublishes", async () => {
    const page = await harness.createPage("活动报名", "第一版");
    const needsTerms = harness.run(
      harness.sharing.siteMutate({
        op: "publish",
        scopeSpaceId: null,
        pageId: page.id,
        visibility: "anyone",
      }),
    );
    await expect(needsTerms).rejects.toMatchObject({ code: "terms-required" });
    const { site } = await harness.run(
      harness.sharing.siteMutate({
        op: "publish",
        scopeSpaceId: null,
        pageId: page.id,
        visibility: "anyone",
        acceptTerms: true,
      }),
    );
    expect(site.url).not.toContain("#");
    await harness.updatePage(page.id, page.revision, "第二版草稿");

    // The same visitor opening the page through a share link first does not hide the site visit.
    const initial = await harness.run(
      harness.sharing.get({ scopeSpaceId: null, target: pageTarget(page.id) }),
    );
    const shared = await harness.run(
      harness.sharing.mutate({
        op: "set-link",
        scopeSpaceId: null,
        target: pageTarget(page.id),
        expectedVersion: initial.version,
        setting: { access: "anyone", role: "view" },
      }),
    );
    expect((await openPage(harness, shared.linkUrl!)).status).toBe(200);
    const opened = await openPage(harness, site.url!);
    expect(opened.body.mode).toBe("site");
    expect(opened.body.page.content).toBe("第一版");
    const listed = await harness.run(harness.sharing.sitesList({ scopeSpaceId: null }));
    expect(listed.termsAccepted).toBe(true);
    expect(listed.sites[0]).toMatchObject({ views30d: 1, hasUnpublishedChanges: true });

    const { site: linkOnly } = await harness.run(
      harness.sharing.siteMutate({
        op: "set-visibility",
        scopeSpaceId: null,
        siteId: site.id,
        visibility: "link",
      }),
    );
    const { shareId, link } = entryOf(linkOnly.url!);
    expect((await guest(harness, shareId, "page", { link })).status).toBe(403);
    expect((await openPage(harness, linkOnly.url!)).status).toBe(200);

    await harness.run(
      harness.sharing.siteMutate({ op: "unpublish", scopeSpaceId: null, siteId: site.id }),
    );
    const gone = await openPage(harness, linkOnly.url!);
    expect(gone.body.reason).toBe("unpublished");
    const pinned = await harness.run(
      harness.sharing.siteMutate({ op: "pin", scopeSpaceId: null, siteId: site.id, pinned: true }),
    );
    expect(pinned.site).toMatchObject({ pinned: true, published: false, url: null });
  });
});
