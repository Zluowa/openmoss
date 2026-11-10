/**
 * Answers the 资料空间 guest routes the share relay forwards over the publisher connection:
 * Every route is POST with a small JSON body, so link credentials never travel in a URL.
 * Page media answers with validated image bytes; other responses and every error are JSON.
 */
import {
  GUEST_ROUTES,
  PageGuestAccessRequest,
  PageGuestCommentsRequest,
  PageGuestMediaRequest,
  PageGuestViewRequest,
  PageGuestAppPreviewOpenRequest,
  PageGuestAppPreviewBrokerRequest,
  PageGuestAppPreviewDocumentRequest,
  PAGE_APP_PREVIEW_LIMITS,
  PAGE_APP_PREVIEW_CONTEXT_HEADERS,
  pageGuestErrorStatus,
  type PageGuestAccessResult,
  type PageGuestCommentsResult,
  type PageGuestErrorReason,
  type PageGuestView,
} from "@moss/contracts";
import { Data, Effect, Schema } from "effect";

import type {
  GuestRelayRequest,
  GuestRelayResponse,
} from "../../guestShare/shareRelayHostClient.ts";
import { LIBRARY_IMAGE_HEADERS, type LibraryImage } from "../../library/libraryImage.ts";
import type { PageAppPreviewIssuer, PageAppPreviewOpenResult } from "./pageAppPreviewTickets.ts";
import type { PageAppPreviewDocument } from "./pageAppPreviewDocument.ts";
import { isGuestPageEditRequest, type PageGuestEditHttp } from "../guestEditing/pageGuestEditHttp";

/** What a guest is told; the guest page words it by `reason`. */
export class PageGuestFailure extends Data.TaggedError("PageGuestFailure")<{
  readonly reason: PageGuestErrorReason;
  readonly cause?: unknown;
}> {}

export const pageGuestFailure = (reason: PageGuestErrorReason, cause?: unknown) =>
  new PageGuestFailure({ reason, ...(cause === undefined ? {} : { cause }) });

const GUEST_MESSAGES: Record<PageGuestErrorReason, string> = {
  "invite-only": "Only invited people can open this page.",
  unavailable: "This link is no longer available.",
  unpublished: "This site is not published.",
  forbidden: "This link does not allow that.",
  invalid: "The request was not valid.",
  "rate-limited": "Too many requests. Try again later.",
};

export interface PageGuestOperations {
  readonly edit?: PageGuestEditHttp;
  readonly preview?: {
    readonly issuer: () => PageAppPreviewIssuer | null;
    readonly inspect?: (request: PageGuestAppPreviewBrokerRequest) => Effect.Effect<
      {
        readonly source: import("@moss/shared/readonlyAppItem").PublishedPageAppSource;
        readonly expiresAt: string;
        readonly availableCapabilities: readonly [];
      },
      PageGuestFailure
    >;
    readonly open: (
      request: PageGuestAppPreviewOpenRequest,
    ) => Effect.Effect<PageAppPreviewOpenResult, PageGuestFailure>;
    readonly document: (
      request: PageGuestAppPreviewDocumentRequest,
    ) => Effect.Effect<PageAppPreviewDocument, PageGuestFailure>;
  };
  readonly media: (request: PageGuestMediaRequest) => Effect.Effect<LibraryImage, PageGuestFailure>;
  readonly view: (request: PageGuestViewRequest) => Effect.Effect<PageGuestView, PageGuestFailure>;
  readonly comments: (
    request: PageGuestCommentsRequest,
  ) => Effect.Effect<PageGuestCommentsResult, PageGuestFailure>;
  readonly access: (
    request: PageGuestAccessRequest,
  ) => Effect.Effect<PageGuestAccessResult, PageGuestFailure>;
}

/** Guest bodies are tiny: a comment is the largest. */
const MAX_BODY_BYTES = 32 * 1024;
const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

const json = (status: number, body: unknown): GuestRelayResponse => {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    headers: { ...HEADERS, "content-length": String(bytes.byteLength) },
    body: new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
};

const failureResponse = (reason: PageGuestErrorReason) =>
  json(pageGuestErrorStatus(reason), { reason, message: GUEST_MESSAGES[reason] });

export const readBoundedBytes = (
  body: ReadableStream<Uint8Array> | null,
  maxBytes = MAX_BODY_BYTES,
): Effect.Effect<Uint8Array, PageGuestFailure> =>
  Effect.tryPromise({
    try: async (signal) => {
      if (body === null) throw new Error("missing body");
      const reader = body.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          if (signal.aborted) throw new Error("body cancelled");
          const { done, value } = await reader.read();
          if (signal.aborted) throw new Error("body cancelled");
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error("body too large");
          }
          chunks.push(value);
        }
        return Buffer.concat(chunks);
      } finally {
        signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    },
    catch: (cause) => pageGuestFailure("invalid", cause),
  });

export const readBoundedJson = (
  body: ReadableStream<Uint8Array> | null,
  maxBytes = MAX_BODY_BYTES,
): Effect.Effect<unknown, PageGuestFailure> =>
  readBoundedBytes(body, maxBytes).pipe(
    Effect.flatMap((bytes) =>
      Effect.try({
        try: () => JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown,
        catch: (cause) => pageGuestFailure("invalid", cause),
      }),
    ),
  );

const readPreviewForm = (body: ReadableStream<Uint8Array> | null) =>
  readBoundedBytes(body, PAGE_APP_PREVIEW_LIMITS.documentBodyBytes).pipe(
    Effect.flatMap((bytes) =>
      Effect.try({
        try: () => {
          const params = new URLSearchParams(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
          if (
            params.size !== 2 ||
            params.getAll("ticket").length !== 1 ||
            params.getAll("frameSecret").length !== 1
          )
            throw new Error("Invalid preview form");
          return Object.fromEntries(params);
        },
        catch: () => pageGuestFailure("invalid"),
      }),
    ),
  );

const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (input: unknown): Effect.Effect<S["Type"], PageGuestFailure> => {
    const result = Schema.decodeUnknownOption(schema)(input);
    return result._tag === "Some"
      ? Effect.succeed(result.value)
      : Effect.fail(pageGuestFailure("invalid"));
  };

/** Never fails: every failure becomes a JSON error body. */
export const handlePageGuestRequest = (
  operations: PageGuestOperations,
  request: GuestRelayRequest,
): Effect.Effect<GuestRelayResponse> =>
  Effect.gen(function* () {
    if (isGuestPageEditRequest(request.route)) {
      return operations.edit
        ? yield* operations.edit.handle(request, readBoundedBytes, json)
        : json(404, { reason: "unavailable" });
    }
    const previewKind =
      request.route === GUEST_ROUTES.pageAppPreviewOpen
        ? "open"
        : request.route === GUEST_ROUTES.pageAppPreviewDocument
          ? "document"
          : request.route === GUEST_ROUTES.pageAppPreviewBroker
            ? "broker"
            : null;
    if (previewKind !== null) {
      const preview = operations.preview;
      const issuer = preview?.issuer();
      const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (
        !preview ||
        !issuer ||
        request.method !== "POST" ||
        request.query ||
        request.signal.aborted ||
        request.headers[PAGE_APP_PREVIEW_CONTEXT_HEADERS.parent] !== issuer.parentOrigin ||
        request.headers[PAGE_APP_PREVIEW_CONTEXT_HEADERS.content] !== issuer.contentOrigin ||
        request.headers[PAGE_APP_PREVIEW_CONTEXT_HEADERS.kind] !== previewKind ||
        type !==
          (previewKind === "document" ? "application/x-www-form-urlencoded" : "application/json")
      )
        return failureResponse("unavailable");
      if (previewKind === "broker") {
        if (!preview.inspect) return failureResponse("unavailable");
        const body = yield* readBoundedJson(request.body, PAGE_APP_PREVIEW_LIMITS.openBodyBytes);
        return json(
          200,
          yield* decode(PageGuestAppPreviewBrokerRequest)(body).pipe(
            Effect.flatMap(preview.inspect),
          ),
        );
      }
      if (previewKind === "open") {
        const body = yield* readBoundedJson(request.body, PAGE_APP_PREVIEW_LIMITS.openBodyBytes);
        return json(
          200,
          yield* decode(PageGuestAppPreviewOpenRequest)(body).pipe(Effect.flatMap(preview.open)),
        );
      }
      const body = yield* readPreviewForm(request.body);
      const document = yield* decode(PageGuestAppPreviewDocumentRequest)(body).pipe(
        Effect.flatMap(preview.document),
      );
      return {
        status: 200,
        headers: document.headers,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(document.bytes);
            controller.close();
          },
        }),
      } satisfies GuestRelayResponse;
    }
    switch (request.route) {
      case GUEST_ROUTES.page:
      case GUEST_ROUTES.pageComments:
      case GUEST_ROUTES.pageAccess:
      case GUEST_ROUTES.pageMedia:
        break;
      default:
        return failureResponse("unavailable");
    }
    if (request.method !== "POST") return json(405, { reason: "invalid", message: "POST only." });
    const body = yield* readBoundedJson(request.body);
    switch (request.route) {
      case GUEST_ROUTES.pageMedia: {
        const image = yield* decode(PageGuestMediaRequest)(body).pipe(
          Effect.flatMap(operations.media),
        );
        return {
          status: 200,
          headers: {
            ...LIBRARY_IMAGE_HEADERS,
            "content-type": image.mimeType,
            "content-length": String(image.bytes.byteLength),
          },
          body: new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(image.bytes);
              controller.close();
            },
          }),
        } satisfies GuestRelayResponse;
      }
      case GUEST_ROUTES.page:
        return json(
          200,
          yield* decode(PageGuestViewRequest)(body).pipe(Effect.flatMap(operations.view)),
        );
      case GUEST_ROUTES.pageComments:
        return json(
          200,
          yield* decode(PageGuestCommentsRequest)(body).pipe(Effect.flatMap(operations.comments)),
        );
      default:
        return json(
          200,
          yield* decode(PageGuestAccessRequest)(body).pipe(Effect.flatMap(operations.access)),
        );
    }
  }).pipe(
    Effect.catchTag("PageGuestFailure", (failure) => {
      const log =
        failure.cause === undefined ||
        request.route === GUEST_ROUTES.pageAppPreviewOpen ||
        request.route === GUEST_ROUTES.pageAppPreviewBroker ||
        request.route === GUEST_ROUTES.pageAppPreviewDocument
          ? Effect.void
          : Effect.logDebug("A page guest request was refused.", {
              route: request.route,
              reason: failure.reason,
              cause: String(failure.cause),
            });
      return log.pipe(Effect.as(failureResponse(failure.reason)));
    }),
    Effect.catchCause((cause) =>
      request.signal.aborted
        ? Effect.succeed(failureResponse("unavailable"))
        : Effect.logError("A page guest request failed unexpectedly.", {
            route: request.route,
            ...(request.route === GUEST_ROUTES.pageAppPreviewOpen ||
            request.route === GUEST_ROUTES.pageAppPreviewBroker ||
            request.route === GUEST_ROUTES.pageAppPreviewDocument
              ? {}
              : { cause: String(cause) }),
          }).pipe(Effect.as(failureResponse("unavailable"))),
    ),
  );
