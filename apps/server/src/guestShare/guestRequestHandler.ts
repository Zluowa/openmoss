/**
 * The guest HTTP API, served over the relay: `session`, `redeem`, `stream`, `messages`, and
 * `attachment` (`GUEST_ROUTES`). A request arrives as the relay forwarded it (method, route,
 * query, allowlisted headers, body) and the answer goes back the same way. The relay enforces
 * each route's response policy and adds the security headers; this handler owns the semantics:
 * the session is checked before a body is read, JSON bodies are small, multipart is parsed
 * with hard limits into temporary files that are removed once the request is answered, and
 * every error is a `GuestAccessErrorBody`.
 */
import {
  GUEST_MESSAGE_MAX_ATTACHMENT_BYTES,
  GUEST_MESSAGE_MAX_ATTACHMENTS,
  GUEST_ROUTES,
  GUEST_SESSION_COOKIE,
  GUEST_SHARE_TTL_MS,
  GuestRedeemRequest,
  GuestSubmitFields,
  guestAccessErrorStatus,
  guestApiPrefix,
  type GuestMessageAttachment,
  type GuestRedeemRequest as GuestRedeemRequestType,
  type GuestShareId,
  type GuestStreamEvent,
  type GuestSubmitFields as GuestSubmitFieldsType,
} from "@synara/contracts";
import { Deferred, Effect, FileSystem, Path, Schema, Stream } from "effect";
import type { Scope, ServiceMap } from "effect";
import { Multipart } from "effect/unstable/http";

import { guestAccessError, GuestShareAccessError } from "./Errors.ts";
import { isGuestInlineImageMimeType, type GuestUpload } from "./guestAttachments.ts";
import type { GuestRelayRequest, GuestRelayResponse } from "./shareRelayHostClient.ts";

/** The guest-facing operations the routes call; the service implements them. */
export interface GuestRequestOperations {
  /** Spends an invite and returns the session token for the guest's cookie. */
  readonly redeem: (
    request: GuestRedeemRequestType,
  ) => Effect.Effect<
    { readonly token: string; readonly shareId: GuestShareId },
    GuestShareAccessError
  >;
  /** Succeeds while the session can still open its share. */
  readonly check: (session: string) => Effect.Effect<void, GuestShareAccessError>;
  readonly submit: (
    session: string,
    fields: GuestSubmitFieldsType,
    uploads: ReadonlyArray<GuestUpload>,
  ) => Effect.Effect<void, GuestShareAccessError>;
  readonly stream: (
    session: string,
  ) => Effect.Effect<Stream.Stream<GuestStreamEvent>, GuestShareAccessError>;
  readonly attachment: (
    session: string,
    attachmentId: string,
  ) => Effect.Effect<
    { readonly path: string; readonly attachment: GuestMessageAttachment },
    GuestShareAccessError
  >;
}

// Cloudflare closes idle streams after about 100 seconds.
export const GUEST_STREAM_HEARTBEAT_INTERVAL = "20 seconds";
// Guest JSON bodies are a name or one message; anyone who can reach the relay can post them.
const JSON_MAX_BODY_BYTES = 64 * 1024;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

// The parser stops a request with too many parts or bytes before it reaches the disk; the
// service checks the exact limits and types.
const UPLOAD_LIMITS = Multipart.limitsServices({
  maxParts: GUEST_MESSAGE_MAX_ATTACHMENTS + 4,
  maxFileSize: GUEST_MESSAGE_MAX_ATTACHMENT_BYTES,
  maxTotalSize: GUEST_MESSAGE_MAX_ATTACHMENT_BYTES + 64 * 1024,
  // By default a JSON part is read as a field, which would drop a guest's `.json` file.
  fieldMimeTypes: [],
});

const decodeRedeem = Schema.decodeUnknownOption(GuestRedeemRequest);
const decodeSubmitFields = Schema.decodeUnknownOption(GuestSubmitFields);

export type GuestRequestServices = FileSystem.FileSystem | Path.Path;

const bytesBody = (text: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });
};

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): GuestRelayResponse => ({
  status,
  headers: { ...NO_STORE_HEADERS, "content-type": JSON_CONTENT_TYPE, ...headers },
  body: bytesBody(JSON.stringify(body)),
});

const emptyResponse = (
  status: number,
  headers: Readonly<Record<string, string>> = {},
): GuestRelayResponse => ({ status, headers: { ...NO_STORE_HEADERS, ...headers }, body: null });

const errorResponse = (error: GuestShareAccessError): GuestRelayResponse =>
  jsonResponse(guestAccessErrorStatus(error.reason), {
    reason: error.reason,
    message: error.message,
  });

const badRequest = (): GuestRelayResponse =>
  jsonResponse(400, { reason: "invalid", message: "The request was not valid." });

const notFound = (): GuestRelayResponse =>
  jsonResponse(404, { reason: "unavailable", message: "This item is not available." });

const methodNotAllowed = (): GuestRelayResponse =>
  jsonResponse(405, { reason: "unavailable", message: "This item is not available." });

/** The value of one cookie in a `cookie` header, or an empty string. */
export function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return "";
}

/** The guest session cookie: scoped to this share's routes; the relay rewrites attributes. */
export function guestSessionCookie(shareId: GuestShareId, token: string): string {
  return [
    `${GUEST_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    `Path=${guestApiPrefix(shareId)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${Math.floor(GUEST_SHARE_TTL_MS / 1000)}`,
  ].join("; ");
}

/** `attachment; filename=...` that survives quotes, line breaks, and non-ASCII names. */
export function downloadContentDisposition(name: string): string {
  const clean = name.replace(/[\r\n"\\]/g, "_").trim() || "file";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/** Reads a small JSON body; null when it is missing or not JSON. */
const readJsonBody = (
  request: GuestRelayRequest,
): Effect.Effect<unknown | null, GuestShareAccessError> =>
  Effect.gen(function* () {
    // A declared length over the cap is refused before reading; chunked bodies hit the cap below.
    if (Number(request.headers["content-length"] ?? "0") > JSON_MAX_BODY_BYTES) {
      return yield* guestAccessError("too_large");
    }
    if (request.body === null) return null;
    const body = request.body;
    return yield* Effect.tryPromise({
      try: async () => {
        const reader = body.getReader();
        const chunks: Array<Uint8Array> = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > JSON_MAX_BODY_BYTES) throw new TooLargeBody();
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        try {
          return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } catch {
          return null;
        }
      },
      catch: (cause) =>
        cause instanceof TooLargeBody
          ? guestAccessError("too_large")
          : guestAccessError("rejected", cause),
    });
  });

class TooLargeBody extends Error {}

interface GuestSubmission {
  readonly fields: GuestSubmitFieldsType;
  readonly uploads: ReadonlyArray<GuestUpload>;
}

const multipartReason = (error: Multipart.MultipartError): GuestShareAccessError =>
  guestAccessError(
    error.reason._tag === "TooManyParts"
      ? "too_many_files"
      : error.reason._tag === "Parse" || error.reason._tag === "InternalError"
        ? "rejected"
        : "too_large",
    error,
  );

/**
 * A message as JSON (text only), or as multipart form data with `file` parts. The caller's
 * scope owns the parser's temporary files, so they outlive the service call that copies them.
 */
const readSubmission = (
  request: GuestRelayRequest,
): Effect.Effect<
  GuestSubmission | null,
  GuestShareAccessError,
  GuestRequestServices | Scope.Scope
> =>
  Effect.gen(function* () {
    const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      const fields = decodeSubmitFields(yield* readJsonBody(request));
      return fields._tag === "None" ? null : { fields: fields.value, uploads: [] };
    }
    if (request.body === null) return null;
    const body = request.body;
    const parts = Stream.fromReadableStream({
      evaluate: () => body,
      onError: (cause) => Multipart.MultipartError.fromReason("InternalError", cause),
    }).pipe(Stream.pipeThroughChannel(Multipart.makeChannel(request.headers)));
    // Files land in a temporary directory that the enclosing scope removes.
    const persisted = yield* Multipart.toPersisted(parts).pipe(
      Effect.provideServices(UPLOAD_LIMITS),
      Effect.mapError(multipartReason),
    );
    const textField = persisted.text;
    const text = typeof textField === "string" ? textField : "";
    const fields = decodeSubmitFields({ text });
    if (fields._tag === "None") return null;
    const files = persisted.file;
    const uploads: ReadonlyArray<GuestUpload> = Array.isArray(files)
      ? files.filter(Multipart.isPersistedFile).map(({ name, contentType, path }) => ({
          name,
          contentType,
          path,
        }))
      : [];
    return { fields: fields.value, uploads };
  });

/** Server-sent events with a heartbeat, never cached or buffered on the way. */
export const guestEventStreamBody = (
  events: Stream.Stream<GuestStreamEvent>,
): Stream.Stream<Uint8Array> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // The heartbeat stops with the events, so a finished stream closes the response.
      const finished = yield* Deferred.make<void>();
      const data = events.pipe(
        Stream.map((event) => `data: ${JSON.stringify(event)}\n\n`),
        Stream.ensuring(Deferred.succeed(finished, undefined)),
      );
      const heartbeat = Stream.tick(GUEST_STREAM_HEARTBEAT_INTERVAL).pipe(
        Stream.map(() => ": ping\n\n"),
        Stream.interruptWhen(Deferred.await(finished)),
      );
      return Stream.merge(data, heartbeat).pipe(Stream.encodeText);
    }),
  );

const GUEST_STREAM_HEADERS = {
  "content-type": "text/event-stream",
  // no-transform keeps any compression on the way from buffering the stream.
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
} as const;

// A file never runs as a page on the relay origin, whatever its bytes; the relay adds the
// sandbox CSP and nosniff on top.
const FILE_HEADERS = { ...NO_STORE_HEADERS } as const;

const isReadLike = (method: GuestRelayRequest["method"]) => method === "GET" || method === "HEAD";

/**
 * Answers one relayed guest request. Never fails: every outcome is a response, and an unexpected
 * failure becomes a 500 with a `rejected` body.
 */
export const handleGuestRequest = (
  operations: GuestRequestOperations,
  request: GuestRelayRequest,
): Effect.Effect<GuestRelayResponse, never, GuestRequestServices> =>
  Effect.gen(function* () {
    const session = readCookie(request.headers.cookie, GUEST_SESSION_COOKIE);
    const services = yield* Effect.services<GuestRequestServices>();
    const toReadable = <E>(stream: Stream.Stream<Uint8Array, E, GuestRequestServices>) =>
      Stream.toReadableStreamWith(stream, services as ServiceMap.ServiceMap<GuestRequestServices>);
    switch (request.route) {
      case GUEST_ROUTES.session: {
        if (!isReadLike(request.method)) return methodNotAllowed();
        yield* operations.check(session);
        return emptyResponse(204);
      }
      case GUEST_ROUTES.redeem: {
        if (request.method !== "POST") return methodNotAllowed();
        const body = decodeRedeem(yield* readJsonBody(request));
        if (body._tag === "None") return badRequest();
        const { token, shareId } = yield* operations.redeem(body.value);
        return emptyResponse(204, { "set-cookie": guestSessionCookie(shareId, token) });
      }
      case GUEST_ROUTES.stream: {
        if (!isReadLike(request.method)) return methodNotAllowed();
        const events = yield* operations.stream(session);
        return {
          status: 200,
          headers: GUEST_STREAM_HEADERS,
          body: toReadable(guestEventStreamBody(events)),
        };
      }
      case GUEST_ROUTES.messages: {
        if (request.method !== "POST") return methodNotAllowed();
        // The session is checked before the body is read, so only a guest can make the server
        // parse and store up to 10 MB.
        yield* operations.check(session);
        const submission = yield* readSubmission(request);
        if (submission === null) return badRequest();
        yield* operations.submit(session, submission.fields, submission.uploads);
        return emptyResponse(204);
      }
      case GUEST_ROUTES.attachment: {
        if (!isReadLike(request.method)) return methodNotAllowed();
        const attachmentId = new URLSearchParams(request.query).get("id");
        if (!attachmentId) return badRequest();
        const { path, attachment } = yield* operations.attachment(session, attachmentId);
        const fileSystem = yield* FileSystem.FileSystem;
        const info = yield* fileSystem
          .stat(path)
          .pipe(Effect.mapError((cause) => guestAccessError("unavailable", cause)));
        // Images of the four checked types load inline; anything else downloads as bytes, so a
        // guest's HTML or SVG never renders as a page on the relay origin.
        const typeHeaders =
          attachment.type === "image" && isGuestInlineImageMimeType(attachment.mimeType)
            ? { "content-type": attachment.mimeType }
            : {
                "content-type": "application/octet-stream",
                "content-disposition": downloadContentDisposition(attachment.name),
              };
        return {
          status: 200,
          headers: {
            ...FILE_HEADERS,
            ...typeHeaders,
            "content-length": String(info.size),
          },
          body: toReadable(fileSystem.stream(path)),
        };
      }
      default:
        return notFound();
    }
  }).pipe(
    // The parser's temporary files are removed once the response is ready.
    Effect.scoped,
    Effect.catchTag("GuestShareAccessError", (error) => Effect.succeed(errorResponse(error))),
    Effect.catchCause((cause) =>
      Effect.logError("A guest request failed unexpectedly.", {
        route: request.route,
        cause: String(cause),
      }).pipe(Effect.as(errorResponse(guestAccessError("rejected")))),
    ),
  );
