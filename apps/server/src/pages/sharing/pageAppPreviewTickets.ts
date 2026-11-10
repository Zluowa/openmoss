// Memory-only admission for one readonly document; exposed only by the opt-in two-host adapter.
import { createHash, randomBytes } from "node:crypto";
import { PAGE_APP_PREVIEW_LIMITS, type PageGuestAppReference } from "@moss/contracts";
import { isPageAppHttpOrigin } from "@moss/shared/pageAppContentPolicy";
import type {
  PageItemAppSource,
  PublishedPageAppSource,
  ReadonlyAppItemDocument,
} from "@moss/shared/readonlyAppItem";
import { timingSafeEqualBase64Url } from "../../auth/utils.ts";
import { parseShareRelayOrigin } from "../../guestShare/shareRelayOrigin.ts";
import type { PageGuestReadonlyAppItemRequest } from "./PageSharingService.ts";
import { pageGuestFailure } from "./pageGuestHandler.ts";

export const APP_PREVIEW_TICKET_MS = PAGE_APP_PREVIEW_LIMITS.ticketMs;
export const APP_PREVIEW_FRAME_MS = PAGE_APP_PREVIEW_LIMITS.frameMs;
export const APP_PREVIEW_OPERATION_MS = PAGE_APP_PREVIEW_LIMITS.operationMs;
export const APP_PREVIEW_PENDING_LIMIT = PAGE_APP_PREVIEW_LIMITS.pendingPerPublisher;
export const APP_PREVIEW_TOTAL_LIMIT = PAGE_APP_PREVIEW_LIMITS.pendingTotal;
export const APP_PREVIEW_CONCURRENCY = PAGE_APP_PREVIEW_LIMITS.concurrentOperations;

export interface PageAppPreviewIssuer {
  readonly shareId: string;
  readonly parentOrigin: string;
  readonly contentOrigin: string;
}
export type TicketSource = PageItemAppSource | PublishedPageAppSource;
export type GuestPreviewDocument<S extends TicketSource> = ReadonlyAppItemDocument<S> & {
  readonly availableCapabilities: readonly [];
};
type TicketRequest = PageGuestReadonlyAppItemRequest & {
  readonly publicationId?: string | undefined;
};
export type PageAppPreviewOpenRequest = TicketRequest & {
  readonly reference?: PageGuestAppReference | undefined;
  /** Private to the guest shell. Its separate secret never travels to the content frame. */
  readonly brokerSecretHash?: string | undefined;
  readonly frameSecretHash: string;
  readonly frameNonce: string;
};
export interface PageAppPreviewOpenResult<S extends TicketSource = TicketSource> {
  readonly ticket: string;
  readonly brokerHandle?: string;
  readonly ticketExpiresAt: string;
  readonly frameExpiresAt: string;
  readonly source: S;
  readonly publicMetadata: GuestPreviewDocument<S>["publicMetadata"];
}
export interface PageAppPreviewDocumentRequest {
  readonly ticket: string;
  readonly frameSecret: string;
}
export interface PageAppPreviewRenderContext {
  readonly issuer: PageAppPreviewIssuer;
  readonly brokerProtocol?: 1;
  readonly frameNonce: string;
  readonly frameExpiresAt: string;
}
interface TicketRecord extends PageAppPreviewRenderContext {
  readonly request: TicketRequest;
  readonly documentHash: string;
  readonly frameSecretHash: string;
  readonly ticketExpiresAt: number;
  readonly broker?: {
    readonly handleHash: string;
    readonly secretHash: string;
    busy: boolean;
    started: number[];
  };
}
export interface PageAppBrokerProof {
  readonly handle: string;
  readonly secret: string;
  readonly frameNonce: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const validDigest = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]{43}$/u.test(value) &&
  Buffer.from(value, "base64url").toString("base64url") === value;
const sameIssuer = (a: PageAppPreviewIssuer, b: PageAppPreviewIssuer) =>
  a.shareId === b.shareId &&
  a.parentOrigin === b.parentOrigin &&
  a.contentOrigin === b.contentOrigin;
const documentHash = (document: GuestPreviewDocument<TicketSource>) =>
  digest(
    JSON.stringify([
      document.source.sourceKind,
      document.source.pageId,
      document.source.pageRevision,
      ...(document.source.sourceKind === "page-item"
        ? [document.source.dataRevision]
        : [
            document.source.publicationId,
            document.source.generation,
            document.source.appId,
            document.source.appRevision,
          ]),
      document.html,
      document.publicMetadata.title,
      document.publicMetadata.revision,
    ]),
  );

/** Only service registration + an explicit local configuration may construct an issuer. */
export function pageAppPreviewIssuer(
  registration: { readonly shareId: string; readonly parentOrigin: string } | null,
  configuredContentOrigin: string | undefined,
): PageAppPreviewIssuer | null {
  if (
    !registration ||
    !configuredContentOrigin ||
    !/^[A-Za-z0-9_-]{22}$/u.test(registration.shareId)
  )
    return null;
  const parentOrigin = parseShareRelayOrigin(registration.parentOrigin);
  const contentOrigin = parseShareRelayOrigin(configuredContentOrigin);
  if (
    !parentOrigin ||
    !contentOrigin ||
    !isPageAppHttpOrigin(parentOrigin) ||
    !isPageAppHttpOrigin(contentOrigin)
  )
    return null;
  const parent = new URL(parentOrigin),
    content = new URL(contentOrigin);
  // A different port on the same hostname is not the required independent hostname.
  if (parent.hostname === content.hostname || parent.protocol !== content.protocol) return null;
  return { shareId: registration.shareId, parentOrigin, contentOrigin };
}

export class PageAppPreviewTickets<Response, S extends TicketSource = PageItemAppSource> {
  readonly #pending = new Map<string, TicketRecord>();
  readonly #live = new Map<string, TicketRecord>();
  readonly #active = new Set<AbortController>();
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  constructor(
    private readonly deps: {
      readonly issuer: () => PageAppPreviewIssuer | null;
      readonly brokerAvailable?: () => boolean;
      readonly findForGuest?: (
        request: TicketRequest,
        reference: PageGuestAppReference,
        signal: AbortSignal,
      ) => Promise<string>;
      readonly resolve: (
        request: TicketRequest,
        signal: AbortSignal,
      ) => Promise<GuestPreviewDocument<S>>;
      readonly render: (
        document: GuestPreviewDocument<S>,
        context: PageAppPreviewRenderContext,
        signal: AbortSignal,
      ) => Promise<Response>;
      readonly now?: () => number;
    },
  ) {}

  #now() {
    return (this.deps.now ?? Date.now)();
  }
  #issuer() {
    const issuer = this.deps.issuer();
    if (this.#closed || !issuer) throw pageGuestFailure("unavailable");
    return issuer;
  }
  #check(signal: AbortSignal, issuer: PageAppPreviewIssuer) {
    if (signal.aborted || !sameIssuer(this.#issuer(), issuer))
      throw pageGuestFailure("unavailable");
  }
  #checkBrokerAvailable() {
    if (this.deps.brokerAvailable && !this.deps.brokerAvailable())
      throw pageGuestFailure("unavailable");
  }
  #scheduleExpiry() {
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    const now = this.#now();
    let next = Infinity;
    for (const [hash, record] of this.#pending) {
      if (record.ticketExpiresAt <= now) this.#pending.delete(hash);
      else next = Math.min(next, record.ticketExpiresAt);
    }
    for (const [hash, record] of this.#live) {
      const expires = Date.parse(record.frameExpiresAt);
      if (expires <= now) this.#live.delete(hash);
      else next = Math.min(next, expires);
    }
    if (!this.#closed && Number.isFinite(next))
      this.#expiryTimer = setTimeout(() => this.#scheduleExpiry(), Math.max(1, next - now));
  }
  async #operation<A>(
    work: (signal: AbortSignal) => Promise<A>,
    external?: AbortSignal,
  ): Promise<A> {
    if (this.#closed || external?.aborted) throw pageGuestFailure("unavailable");
    if (this.#active.size >= APP_PREVIEW_CONCURRENCY) throw pageGuestFailure("rate-limited");
    const controller = new AbortController();
    this.#active.add(controller);
    const abort = () => controller.abort();
    external?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, APP_PREVIEW_OPERATION_MS);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(pageGuestFailure("unavailable"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    // Keep capacity reserved until the underlying work actually settles, even if a
    // dependency takes time to observe cancellation. No cancelled work can issue a ticket.
    const job = Promise.resolve()
      .then(() => work(controller.signal))
      .finally(() => this.#active.delete(controller));
    try {
      return await Promise.race([job, aborted]);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  open(
    input: PageAppPreviewOpenRequest,
    signal?: AbortSignal,
  ): Promise<PageAppPreviewOpenResult<S>> {
    return this.#operation(async (operationSignal) => {
      const issuer = this.#issuer();
      if (
        !validDigest(input.frameSecretHash) ||
        typeof input.frameNonce !== "string" ||
        !/^[A-Za-z0-9_-]{16,64}$/u.test(input.frameNonce)
      )
        throw pageGuestFailure("invalid");
      if (
        input.brokerSecretHash !== undefined &&
        (!input.reference ||
          !validDigest(input.brokerSecretHash) ||
          input.brokerSecretHash === input.frameSecretHash)
      )
        throw pageGuestFailure("invalid");
      if (input.brokerSecretHash !== undefined) this.#checkBrokerAvailable();
      const { frameSecretHash, frameNonce } = input;
      if (input.reference && (input.publicationId || !this.deps.findForGuest))
        throw pageGuestFailure("unavailable");
      const selectedId = input.reference
        ? await this.deps.findForGuest!(input, input.reference, operationSignal)
        : input.publicationId;
      this.#check(operationSignal, issuer);
      if (
        input.publicationId !== undefined &&
        (typeof input.publicationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            input.publicationId,
          ))
      )
        throw pageGuestFailure("invalid");
      const request: TicketRequest = {
        visitor: input.visitor,
        pageId: input.pageId,
        expectedPageRevision: input.expectedPageRevision,
        ...(input.link === undefined ? {} : { link: input.link }),
        ...(input.key === undefined ? {} : { key: input.key }),
        ...(selectedId === undefined ? {} : { publicationId: selectedId }),
      };
      const document = await this.deps.resolve(request, operationSignal);
      if (
        document.source.sourceKind === "page-app"
          ? document.source.publicationId !== request.publicationId
          : request.publicationId !== undefined
      )
        throw pageGuestFailure("unavailable");
      if (
        input.reference &&
        (document.source.sourceKind !== "page-app" ||
          document.source.appId !== input.reference.appId ||
          (input.reference.appRevision !== undefined &&
            document.source.appRevision !== input.reference.appRevision))
      )
        throw pageGuestFailure("unavailable");
      this.#check(operationSignal, issuer);
      this.#scheduleExpiry();
      for (const [hash, record] of this.#pending) {
        if (sameIssuer(record.issuer, issuer) && record.frameSecretHash === frameSecretHash)
          this.#pending.delete(hash);
      }
      const publisherCount = [...this.#pending.values()].filter(
        (record) => record.issuer.shareId === issuer.shareId,
      ).length;
      if (
        publisherCount >= APP_PREVIEW_PENDING_LIMIT ||
        this.#pending.size >= APP_PREVIEW_TOTAL_LIMIT
      )
        throw pageGuestFailure("rate-limited");
      const ticket = randomBytes(32).toString("base64url");
      if (input.brokerSecretHash !== undefined) this.#checkBrokerAvailable();
      const brokerHandle = input.brokerSecretHash
        ? randomBytes(32).toString("base64url")
        : undefined;
      const now = this.#now();
      const ticketExpiresAt = now + APP_PREVIEW_TICKET_MS;
      const frameExpiresAt = new Date(now + APP_PREVIEW_FRAME_MS).toISOString();
      this.#pending.set(digest(ticket), {
        issuer: { ...issuer },
        request,
        documentHash: documentHash(document),
        frameSecretHash,
        frameNonce,
        ticketExpiresAt,
        frameExpiresAt,
        ...(brokerHandle && input.brokerSecretHash
          ? {
              broker: {
                handleHash: digest(brokerHandle),
                secretHash: input.brokerSecretHash,
                busy: false,
                started: [],
              },
            }
          : {}),
      });
      this.#scheduleExpiry();
      return {
        ticket,
        ...(brokerHandle ? { brokerHandle } : {}),
        ticketExpiresAt: new Date(ticketExpiresAt).toISOString(),
        frameExpiresAt,
        source: { ...document.source },
        publicMetadata: { ...document.publicMetadata },
      };
    }, signal);
  }

  async consume(input: PageAppPreviewDocumentRequest, signal?: AbortSignal): Promise<Response> {
    const issuer = this.#issuer();
    if (!validDigest(input.ticket) || !validDigest(input.frameSecret))
      throw pageGuestFailure("unavailable");
    this.#scheduleExpiry();
    // Lookup is only by a hash. No scan over raw tokens or matching caller-supplied identity.
    const hash = digest(input.ticket);
    const record = this.#pending.get(hash);
    if (
      !record ||
      !sameIssuer(record.issuer, issuer) ||
      !timingSafeEqualBase64Url(record.frameSecretHash, digest(input.frameSecret))
    )
      throw pageGuestFailure("unavailable");
    // Claim synchronously, before any await. Failure, abort or an overloaded renderer never restores it.
    this.#pending.delete(hash);
    this.#scheduleExpiry();
    return this.#operation(async (operationSignal) => {
      const document = await this.deps.resolve(record.request, operationSignal);
      this.#check(operationSignal, issuer);
      if (
        this.#now() >= Date.parse(record.frameExpiresAt) ||
        documentHash(document) !== record.documentHash
      )
        throw pageGuestFailure("unavailable");
      if (record.broker) this.#checkBrokerAvailable();
      const response = await this.deps.render(
        document,
        {
          issuer: record.issuer,
          frameNonce: record.frameNonce,
          frameExpiresAt: record.frameExpiresAt,
          ...(record.broker ? { brokerProtocol: 1 as const } : {}),
        },
        operationSignal,
      );
      this.#check(operationSignal, issuer);
      // Deriving local resources is asynchronous. Revoke/republish/typed-byte
      // changes during that work must not escape in the completed response.
      const current = await this.deps.resolve(record.request, operationSignal);
      this.#check(operationSignal, issuer);
      if (
        this.#now() >= Date.parse(record.frameExpiresAt) ||
        documentHash(current) !== record.documentHash
      )
        throw pageGuestFailure("unavailable");
      if (record.broker) {
        this.#checkBrokerAvailable();
        this.#scheduleExpiry();
        const perPublisher = [...this.#live.values()].filter(
          (v) => v.issuer.shareId === issuer.shareId,
        ).length;
        if (perPublisher >= APP_PREVIEW_PENDING_LIMIT || this.#live.size >= APP_PREVIEW_TOTAL_LIMIT)
          throw pageGuestFailure("rate-limited");
        this.#live.set(record.broker.handleHash, record);
        this.#scheduleExpiry();
      }
      return response;
    }, signal);
  }

  /** Revalidate an active frame's readonly grant before answering its parent shell.
   * No caller-supplied identity, publisher reference, scope or capability is trusted. */
  inspectBroker(proof: PageAppBrokerProof, signal?: AbortSignal) {
    return this.#operation(async (operationSignal) => {
      const issuer = this.#issuer();
      this.#checkBrokerAvailable();
      if (!validDigest(proof.handle) || !validDigest(proof.secret))
        throw pageGuestFailure("unavailable");
      this.#scheduleExpiry();
      const handleHash = digest(proof.handle),
        record = this.#live.get(handleHash);
      if (
        !record?.broker ||
        !sameIssuer(record.issuer, issuer) ||
        proof.frameNonce !== record.frameNonce ||
        !timingSafeEqualBase64Url(record.broker.secretHash, digest(proof.secret))
      )
        throw pageGuestFailure("unavailable");
      const broker = record.broker,
        now = this.#now();
      broker.started = broker.started.filter((start) => now - start < 60_000);
      if (broker.busy || broker.started.length >= 12) throw pageGuestFailure("rate-limited");
      broker.busy = true;
      broker.started.push(now);
      try {
        const document = await this.deps.resolve(record.request, operationSignal);
        this.#check(operationSignal, issuer);
        this.#checkBrokerAvailable();
        if (
          document.source.sourceKind !== "page-app" ||
          this.#live.get(handleHash) !== record ||
          this.#now() >= Date.parse(record.frameExpiresAt) ||
          documentHash(document) !== record.documentHash
        )
          throw pageGuestFailure("unavailable");
        const source: PublishedPageAppSource = document.source;
        return {
          source: { ...source },
          expiresAt: record.frameExpiresAt,
          availableCapabilities: [] as const,
        };
      } catch (error) {
        if (!operationSignal.aborted) this.#live.delete(handleHash);
        throw error;
      } finally {
        broker.busy = false;
      }
    }, signal);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    this.#pending.clear();
    this.#live.clear();
    for (const controller of this.#active) controller.abort();
  }
}
