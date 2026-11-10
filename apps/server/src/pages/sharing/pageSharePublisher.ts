/**
 * The publisher: one relay share that carries every 资料空间 link and site of this Moss.
 *
 * Thread shares are one relay share each because they end after 24 hours. Page links and sites
 * last until the owner changes them, and an owner may share dozens of pages, so they ride one
 * long-lived share instead. Its id appears in every link and never changes on its own. The
 * relay registration is renewed every hour (a refresh of a known share neither counts against
 * the account's share limit nor its registration rate), and after a relay restart the host
 * client registers it again.
 */
import {
  SHARE_RELAY_PROTOCOL_VERSION,
  pageGuestPath,
  type GuestShareId,
  type PageShareRelayStatus,
  type PageAppPreviewRelayCapability,
  type PageGuestEditCapability,
} from "@moss/contracts";
import { Duration, Effect, Semaphore } from "effect";

import { guestShareOwnerError, type GuestShareOwnerError } from "../../guestShare/Errors.ts";
import { relayHostKey, relayHostKeyHash } from "../../guestShare/guestShareCredentials.ts";
import type { ShareRelayTransportShape } from "../../guestShare/Services/ShareRelayTransport.ts";
import {
  ShareRelayHostClient,
  type GuestRelayRequestHandler,
} from "../../guestShare/shareRelayHostClient.ts";
import { registerShareWithRelay } from "../../guestShare/shareRelayRegistration.ts";
import {
  resolveShareRelayAccount,
  type ShareRelayAccountSources,
} from "../../guestShare/shareRelayOrigin.ts";
import { randomShareId } from "./pageShareCredentials.ts";
import { pageSharingError, type PageSharingError } from "./PageSharingService.ts";
import type { PageSharingStore, PublisherRow } from "./pageSharingStore.ts";

/** The relay accepts at most 24 hours; renewing hourly leaves a day of slack for downtime. */
const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;
const RENEW_INTERVAL = Duration.hours(1);

export interface PageSharePublisher {
  /** Successfully registered, unexpired service identity. Never derived from a guest request. */
  readonly registration: () => {
    readonly shareId: string;
    readonly parentOrigin: string;
    readonly appPreview?: PageAppPreviewRelayCapability;
    readonly editProjection?: PageGuestEditCapability;
  } | null;
  /** The publisher, registering one first when this Moss has none yet. */
  readonly ensure: Effect.Effect<PublisherRow, PageSharingError>;
  /** `https://<relay>/p/<id>` when a publisher exists, else null. Never touches the network. */
  readonly pageBase: () => string | null;
  readonly status: () => PageShareRelayStatus;
  /** Reconnects a stored publisher; forked once at startup. */
  readonly resume: Effect.Effect<void>;
  /** Keeps the registration fresh; runs forever. */
  readonly renewForever: Effect.Effect<void>;
  readonly close: () => void;
}

const toSharingError = (error: GuestShareOwnerError): PageSharingError =>
  error.code === "guest_share.account_required"
    ? pageSharingError("account-required", "登录 Moss 账号后才能生成分享链接。", { cause: error })
    : error.code === "guest_share.rate_limited"
      ? pageSharingError("relay-unavailable", "分享服务暂时繁忙，请稍后再试。", { cause: error })
      : pageSharingError("relay-unavailable", "暂时连不上分享服务，请稍后再试。", { cause: error });

export const makePageSharePublisher = (deps: {
  readonly store: PageSharingStore;
  readonly signingKey: Uint8Array;
  readonly transport: ShareRelayTransportShape;
  readonly accountSources: ShareRelayAccountSources;
  readonly handle: GuestRelayRequestHandler;
}) =>
  Effect.gen(function* () {
    const { store, signingKey, transport } = deps;
    const lock = yield* Semaphore.make(1);
    let current: { readonly row: PublisherRow; client: ShareRelayHostClient | null } | null = null;
    let registered:
      | (NonNullable<ReturnType<PageSharePublisher["registration"]>> & {
          readonly expiresAt: number;
        })
      | null = null;
    let relayStatus: PageShareRelayStatus = "unavailable";

    const register = (row: PublisherRow) =>
      Effect.gen(function* () {
        const account = yield* resolveShareRelayAccount(deps.accountSources);
        if (account.origin !== row.relay_origin) {
          // The owner switched region: the old links name the old relay, so they cannot move.
          return yield* guestShareOwnerError(
            "guest_share.relay_unavailable",
            new Error("The share relay of this account changed."),
          );
        }
        const receipt = yield* registerShareWithRelay({
          fetch: transport.fetch,
          origin: account.origin,
          bearer: account.bearer,
          request: {
            shareId: row.share_id as GuestShareId,
            hostKeyHash: relayHostKeyHash(relayHostKey(signingKey, row.share_id as GuestShareId)),
            expiresAt: new Date(Date.now() + REGISTRATION_TTL_MS).toISOString(),
            protocolVersion: SHARE_RELAY_PROTOCOL_VERSION,
          },
        });
        registered = {
          shareId: row.share_id,
          parentOrigin: row.relay_origin,
          expiresAt: Date.parse(receipt.expiresAt),
          ...(receipt.appPreview ? { appPreview: receipt.appPreview } : {}),
          ...(receipt.editProjection ? { editProjection: receipt.editProjection } : {}),
        };
      });

    const startClient = (row: PublisherRow) => {
      const entry = { row, client: null as ShareRelayHostClient | null };
      current = entry;
      const client = new ShareRelayHostClient({
        origin: row.relay_origin,
        shareId: row.share_id as GuestShareId,
        hostKey: relayHostKey(signingKey, row.share_id as GuestShareId),
        handle: deps.handle,
        onStatus: (status) => {
          if (current === entry) relayStatus = status;
        },
        onEnded: () => {
          // Only this Moss holds the host key, so the share ended because the relay dropped it
          // for good. Its links are dead; the next share dialog registers a new publisher.
          if (current !== entry) return;
          current = null;
          registered = null;
          relayStatus = "offline";
          Effect.runFork(
            store.deletePublisher.pipe(
              Effect.andThen(Effect.logWarning("The page share publisher was ended by the relay.")),
              Effect.ignore,
            ),
          );
        },
        reregister: () =>
          Effect.runPromise(
            register(row).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            ),
          ),
        webSocket: transport.webSocket,
        ...(transport.backoff === undefined ? {} : { backoff: transport.backoff }),
      });
      entry.client = client;
      relayStatus = "connecting";
      client.start();
    };

    const ensure: PageSharePublisher["ensure"] = lock.withPermits(1)(
      Effect.gen(function* () {
        if (current !== null) return current.row;
        const stored = yield* store.getPublisher.pipe(
          Effect.mapError((cause) => pageSharingError("storage", "读取分享设置失败。", { cause })),
        );
        if (stored !== null) {
          yield* register(stored).pipe(Effect.mapError(toSharingError));
          startClient(stored);
          return stored;
        }
        const account = yield* resolveShareRelayAccount(deps.accountSources).pipe(
          Effect.mapError(toSharingError),
        );
        const row: PublisherRow = {
          share_id: randomShareId(),
          relay_origin: account.origin,
          created_at: new Date().toISOString(),
        };
        yield* register(row).pipe(Effect.mapError(toSharingError));
        yield* store
          .insertPublisher(row)
          .pipe(
            Effect.mapError((cause) =>
              pageSharingError("storage", "保存分享设置失败。", { cause }),
            ),
          );
        startClient(row);
        yield* Effect.logInfo("Registered the page share publisher.", { shareId: row.share_id });
        return row;
      }),
    );

    const resume: PageSharePublisher["resume"] = lock
      .withPermits(1)(
        Effect.gen(function* () {
          if (current !== null) return;
          const stored = yield* store.getPublisher;
          if (stored === null) return;
          // A failed refresh is not fatal: the client registers again when the relay answers 4404.
          yield* register(stored).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not refresh the page share publisher.", {
                code: error.code,
              }),
            ),
          );
          startClient(stored);
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not resume the page share publisher.", { cause: String(cause) }),
        ),
      );

    const renewForever: PageSharePublisher["renewForever"] = Effect.gen(function* () {
      const entry = current;
      if (entry === null) return;
      yield* register(entry.row).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not renew the page share publisher.", { code: error.code }),
        ),
      );
    }).pipe(Effect.delay(RENEW_INTERVAL), Effect.forever);

    return {
      registration: () =>
        current !== null &&
        registered !== null &&
        registered.shareId === current.row.share_id &&
        registered.expiresAt > Date.now()
          ? {
              shareId: registered.shareId,
              parentOrigin: registered.parentOrigin,
              ...(registered.appPreview ? { appPreview: registered.appPreview } : {}),
              ...(registered.editProjection ? { editProjection: registered.editProjection } : {}),
            }
          : null,
      ensure,
      pageBase: () =>
        current === null
          ? null
          : `${current.row.relay_origin}${pageGuestPath(current.row.share_id)}`,
      status: () => (current === null ? "unavailable" : relayStatus),
      resume,
      renewForever,
      close: () => {
        current?.client?.close();
        current = null;
        registered = null;
      },
    } satisfies PageSharePublisher;
  });
