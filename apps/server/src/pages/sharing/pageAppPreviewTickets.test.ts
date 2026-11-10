import { createHash, randomBytes } from "node:crypto";
import type { PageId, PageAppId } from "@moss/contracts";
import type { PublishedPageAppSource } from "@moss/shared/readonlyAppItem";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AuthorizedReadonlyAppItem,
  PageGuestReadonlyAppItemRequest,
} from "./PageSharingService.ts";
import { pageGuestFailure } from "./pageGuestHandler.ts";
import {
  APP_PREVIEW_OPERATION_MS,
  APP_PREVIEW_PENDING_LIMIT,
  APP_PREVIEW_TICKET_MS,
  PageAppPreviewTickets,
  pageAppPreviewIssuer,
  type PageAppPreviewRenderContext,
} from "./pageAppPreviewTickets.ts";

const shareId = "A".repeat(22);
const issuer = {
  shareId,
  parentOrigin: "https://share.example",
  contentOrigin: "https://apps.example",
};
const document: AuthorizedReadonlyAppItem = {
  source: { sourceKind: "page-item", pageId: "page-app", pageRevision: 2, dataRevision: 1 },
  html: "<h1>Coral</h1>",
  publicMetadata: { title: "Coral", revision: 2 },
  availableCapabilities: [],
};
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const request = (secret = randomBytes(32).toString("base64url")) => ({
  secret,
  input: {
    visitor: "visitor-fixture",
    pageId: "page-app" as PageId,
    expectedPageRevision: 2,
    key: "fixture-share-proof",
    frameNonce: "frame-nonce-00000001",
    frameSecretHash: hash(secret),
  },
});
const stores: Array<{ close: () => void }> = [];
function make(
  overrides: Partial<ConstructorParameters<typeof PageAppPreviewTickets<string>>[0]> = {},
) {
  const resolve = vi.fn(
    async (_request: PageGuestReadonlyAppItemRequest, _signal: AbortSignal) => document,
  );
  const render = vi.fn(
    async (
      _document: AuthorizedReadonlyAppItem,
      _context: PageAppPreviewRenderContext,
      _signal: AbortSignal,
    ) => "rendered",
  );
  const store = new PageAppPreviewTickets({ issuer: () => issuer, resolve, render, ...overrides });
  stores.push(store);
  return { store, resolve, render };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});

describe("readonly preview issuer configuration", () => {
  it.each([
    undefined,
    "https://share.example:9443",
    "https://user:password@apps.example",
    "https://apps.example/path",
    "https://apps.example?url=x",
    "https://apps.example#x",
    "http://apps.example",
  ])("rejects unavailable or non-isolated origin %s", (contentOrigin) => {
    expect(
      pageAppPreviewIssuer({ shareId, parentOrigin: issuer.parentOrigin }, contentOrigin),
    ).toBeNull();
  });
  it("requires a successful service registration and allows explicit independent loopback hosts", () => {
    expect(pageAppPreviewIssuer(null, issuer.contentOrigin)).toBeNull();
    expect(
      pageAppPreviewIssuer({ shareId, parentOrigin: issuer.parentOrigin }, issuer.contentOrigin),
    ).toEqual(issuer);
    expect(
      pageAppPreviewIssuer(
        { shareId, parentOrigin: "http://127.0.0.1:53841" },
        "http://localhost:53842",
      ),
    ).toEqual({
      shareId,
      parentOrigin: "http://127.0.0.1:53841",
      contentOrigin: "http://localhost:53842",
    });
  });
});

describe("readonly preview single-use tickets", () => {
  it("binds the complete authorized document and never exposes proof or HTML in the open receipt", async () => {
    const { store, resolve, render } = make();
    const { input, secret } = request();
    const result = await store.open(input);
    expect(Object.keys(result).sort()).toEqual([
      "frameExpiresAt",
      "publicMetadata",
      "source",
      "ticket",
      "ticketExpiresAt",
    ]);
    expect(JSON.stringify(result)).not.toContain(input.key);
    expect(JSON.stringify(result)).not.toContain(document.html);
    expect(Date.parse(result.frameExpiresAt) - Date.parse(result.ticketExpiresAt)).toBe(270_000);
    expect(await store.consume({ ticket: result.ticket, frameSecret: secret })).toBe("rendered");
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(render).toHaveBeenCalledOnce();
    expect(Object.keys(render.mock.calls[0]![1]).sort()).toEqual([
      "frameExpiresAt",
      "frameNonce",
      "issuer",
    ]);
    await expect(
      store.consume({ ticket: result.ticket, frameSecret: secret }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("expires a live broker independently of its spent form, revokes on issuer change during a check, and retains capacity until cancellation settles", async () => {
    vi.useFakeTimers();
    const publicationId = "f463958c-a809-4a86-8122-ba756c71dba6";
    const appId = "published" as PageAppId,
      doc = {
        ...document,
        source: {
          sourceKind: "page-app" as const,
          pageId: "page-app",
          pageRevision: 2,
          appId,
          appRevision: 1,
          generation: 1,
          publicationId,
        },
      };
    let available = true;
    const resolve = vi.fn(async () => doc);
    const store = new PageAppPreviewTickets<string, PublishedPageAppSource>({
      issuer: () => issuer,
      brokerAvailable: () => available,
      findForGuest: async () => publicationId,
      resolve,
      render: async () => "public",
    });
    stores.push(store);
    const open = async () => {
      const { input, secret } = request(),
        parent = request();
      const ticket = await store.open({
        ...input,
        reference: { appId, nodePath: [0] },
        brokerSecretHash: parent.input.frameSecretHash,
      });
      const proof = {
        handle: ticket.brokerHandle!,
        secret: parent.secret,
        frameNonce: input.frameNonce,
      };
      await store.consume({ ticket: ticket.ticket, frameSecret: secret });
      return proof;
    };
    const active = await open();
    let release!: (value: typeof doc) => void;
    resolve.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const cancel = new AbortController();
    const check = store.inspectBroker(active, cancel.signal);
    await Promise.resolve();
    cancel.abort();
    await expect(check).rejects.toMatchObject({ reason: "unavailable" });
    await expect(store.inspectBroker(active)).rejects.toMatchObject({ reason: "rate-limited" });
    release(doc);
    await vi.advanceTimersByTimeAsync(1);
    expect((await store.inspectBroker(active)).availableCapabilities).toEqual([]);
    resolve.mockImplementationOnce(async () => {
      available = false;
      return doc;
    });
    await expect(store.inspectBroker(active)).rejects.toMatchObject({ reason: "unavailable" });
    available = true;
    await expect(store.inspectBroker(active)).rejects.toMatchObject({ reason: "unavailable" });
    const fresh = await open();
    await vi.advanceTimersByTimeAsync(300_001);
    await expect(store.inspectBroker(fresh)).rejects.toMatchObject({ reason: "unavailable" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a missing configured issuer before authorization", async () => {
    const { store, resolve } = make({ issuer: () => null });
    await expect(store.open(request().input)).rejects.toMatchObject({ reason: "unavailable" });
    expect(resolve).not.toHaveBeenCalled();
  });
  it("rejects invalid hashes/nonces before authorization", async () => {
    const { store, resolve } = make();
    await expect(store.open({ ...request().input, frameSecretHash: "x" })).rejects.toMatchObject({
      reason: "invalid",
    });
    await expect(store.open({ ...request().input, frameNonce: "<script>" })).rejects.toMatchObject({
      reason: "invalid",
    });
    expect(resolve).not.toHaveBeenCalled();
  });
  it("does not consume a ticket with an incorrect possession secret or forged ticket", async () => {
    const { store } = make();
    const { input, secret } = request();
    const result = await store.open(input);
    await expect(
      store.consume({ ticket: result.ticket, frameSecret: request().secret }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await expect(
      store.consume({ ticket: request().secret, frameSecret: secret }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(await store.consume({ ticket: result.ticket, frameSecret: secret })).toBe("rendered");
  });
  it("atomically claims before asynchronous reauthorization, allowing only one concurrent consumer", async () => {
    let finish!: (value: AuthorizedReadonlyAppItem) => void;
    const { store, resolve } = make();
    const { input, secret } = request();
    const result = await store.open(input);
    resolve.mockImplementationOnce(
      () =>
        new Promise((accept) => {
          finish = accept;
        }),
    );
    const first = store.consume({ ticket: result.ticket, frameSecret: secret });
    await expect(
      store.consume({ ticket: result.ticket, frameSecret: secret }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    finish(document);
    expect(await first).toBe("rendered");
  });
  it.each(["html", "title", "pageRevision", "dataRevision"])(
    "rejects changed %s even after the original authorization succeeded",
    async (field) => {
      const { store, resolve, render } = make();
      const { input, secret } = request();
      const result = await store.open(input);
      const changed = structuredClone(document);
      if (field === "html") (changed as { html: string }).html = "<h1>Other</h1>";
      if (field === "title") (changed.publicMetadata as { title: string }).title = "Other";
      if (field === "pageRevision") (changed.source as { pageRevision: number }).pageRevision = 3;
      if (field === "dataRevision") (changed.source as { dataRevision: number }).dataRevision = 2;
      resolve.mockResolvedValueOnce(changed);
      await expect(
        store.consume({ ticket: result.ticket, frameSecret: secret }),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(render).not.toHaveBeenCalled();
      await expect(
        store.consume({ ticket: result.ticket, frameSecret: secret }),
      ).rejects.toMatchObject({ reason: "unavailable" });
    },
  );
  it("rejects replacement of the registered publisher or content origin", async () => {
    let current = issuer;
    const { store } = make({ issuer: () => current });
    const { input, secret } = request();
    const result = await store.open(input);
    current = { ...issuer, shareId: "B".repeat(22) };
    await expect(
      store.consume({ ticket: result.ticket, frameSecret: secret }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    current = { ...issuer, contentOrigin: "https://other.example" };
    await expect(
      store.consume({ ticket: result.ticket, frameSecret: secret }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
  it.each(["authorization", "render"])(
    "does not restore a ticket after %s failure",
    async (stage) => {
      const { store, resolve, render } = make();
      const { input, secret } = request();
      const result = await store.open(input);
      (stage === "authorization" ? resolve : render).mockRejectedValueOnce(
        pageGuestFailure("forbidden"),
      );
      await expect(
        store.consume({ ticket: result.ticket, frameSecret: secret }),
      ).rejects.toMatchObject({ reason: "forbidden" });
      await expect(
        store.consume({ ticket: result.ticket, frameSecret: secret }),
      ).rejects.toMatchObject({ reason: "unavailable" });
    },
  );
  it("expires with one bounded timer and releases it without waiting for another request", async () => {
    vi.useFakeTimers();
    const { store } = make();
    const { input, secret } = request();
    const result = await store.open(input);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(APP_PREVIEW_TICKET_MS);
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      store.consume({ ticket: result.ticket, frameSecret: secret }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("replaces an unused ticket for the same browser opening context", async () => {
    const { store } = make();
    const { input, secret } = request();
    const old = await store.open(input);
    const next = await store.open(input);
    await expect(store.consume({ ticket: old.ticket, frameSecret: secret })).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(await store.consume({ ticket: next.ticket, frameSecret: secret })).toBe("rendered");
  });
  it("bounds pending tickets per publisher", async () => {
    const { store } = make();
    for (let index = 0; index < APP_PREVIEW_PENDING_LIMIT; index++)
      await store.open(request().input);
    await expect(store.open(request().input)).rejects.toMatchObject({ reason: "rate-limited" });
  });
  it("bounds the owner total across registered publishers", async () => {
    let current = issuer;
    const { store } = make({ issuer: () => current });
    for (let publisher = 0; publisher < 4; publisher++) {
      current = { ...issuer, shareId: String(publisher).repeat(22) };
      for (let index = 0; index < APP_PREVIEW_PENDING_LIMIT; index++)
        await store.open(request().input);
    }
    current = { ...issuer, shareId: "E".repeat(22) };
    await expect(store.open(request().input)).rejects.toMatchObject({ reason: "rate-limited" });
  });
  it("does not enqueue a third expensive operation", async () => {
    const finishes: Array<(value: AuthorizedReadonlyAppItem) => void> = [];
    const { store, resolve } = make();
    resolve.mockImplementation(() => new Promise((finish) => finishes.push(finish)));
    const first = store.open(request().input),
      second = store.open(request().input);
    await expect(store.open(request().input)).rejects.toMatchObject({ reason: "rate-limited" });
    for (const finish of finishes) finish(document);
    await Promise.all([first, second]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it("cancels an in-flight claim, burns the ticket and observes the dependency abort signal", async () => {
    const { store, resolve, render } = make();
    const { input, secret } = request();
    const result = await store.open(input);
    let dependencySignal!: AbortSignal;
    resolve.mockImplementationOnce(
      (_request, signal) =>
        new Promise((_, reject) => {
          dependencySignal = signal;
          signal.addEventListener("abort", () => reject(pageGuestFailure("unavailable")), {
            once: true,
          });
        }),
    );
    const external = new AbortController();
    const consuming = store.consume(
      { ticket: result.ticket, frameSecret: secret },
      external.signal,
    );
    const failed = expect(consuming).rejects.toMatchObject({ reason: "unavailable" });
    await Promise.resolve();
    external.abort();
    await failed;
    expect(dependencySignal.aborted).toBe(true);
    expect(render).not.toHaveBeenCalled();
    await expect(
      store.consume({ ticket: result.ticket, frameSecret: secret }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("close aborts work and clears pending expiry timers; a late resolver cannot issue", async () => {
    vi.useFakeTimers();
    let finish!: (value: AuthorizedReadonlyAppItem) => void;
    const { store, resolve } = make();
    await store.open(request().input);
    resolve.mockImplementationOnce(
      () =>
        new Promise((accept) => {
          finish = accept;
        }),
    );
    const opening = store.open(request().input);
    const failed = expect(opening).rejects.toMatchObject({ reason: "unavailable" });
    await Promise.resolve();
    store.close();
    await failed;
    finish(document);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    await expect(store.open(request().input)).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("times out bounded work without restoring its claim", async () => {
    vi.useFakeTimers();
    const { store, render } = make();
    const { input, secret } = request();
    const result = await store.open(input);
    render.mockImplementationOnce(
      (_document, _context, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(pageGuestFailure("unavailable")), {
            once: true,
          }),
        ),
    );
    const failed = expect(
      store.consume({ ticket: result.ticket, frameSecret: secret }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(APP_PREVIEW_OPERATION_MS);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      store.consume({ ticket: result.ticket, frameSecret: secret }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("rejects an expired frame lease after the machine clock advances during preparation", async () => {
    let now = Date.now();
    const { store, render } = make({ now: () => now });
    const { input, secret } = request();
    const result = await store.open(input);
    render.mockImplementationOnce(async () => {
      now += 300_000;
      return "rendered";
    });
    await expect(
      store.consume({ ticket: result.ticket, frameSecret: secret }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
  it.each(["revoked", "changed bytes"])(
    "rechecks authorization after rendering when the page is %s",
    async (state) => {
      const { store, resolve, render } = make();
      const { input, secret } = request();
      const result = await store.open(input);
      render.mockImplementationOnce(async () => {
        if (state === "revoked") resolve.mockRejectedValueOnce(pageGuestFailure("unavailable"));
        else resolve.mockResolvedValueOnce({ ...document, html: "<h1>Other</h1>" });
        return "rendered";
      });
      await expect(
        store.consume({ ticket: result.ticket, frameSecret: secret }),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(resolve).toHaveBeenCalledTimes(3);
      await expect(
        store.consume({ ticket: result.ticket, frameSecret: secret }),
      ).rejects.toMatchObject({ reason: "unavailable" });
    },
  );
});
