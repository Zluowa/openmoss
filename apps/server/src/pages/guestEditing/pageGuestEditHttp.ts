import {
  GUEST_ROUTES,
  PAGE_GUEST_EDIT_LIMITS as limits,
  PAGE_GUEST_EDIT_ORIGIN_HEADER,
  PAGE_GUEST_EDIT_ROUTES,
  PageGuestEditOpenRequest,
  PageGuestEditSessionRequest,
  PageGuestEditUpdateRequest,
} from "@moss/contracts";
import { Effect, Option, Schema } from "effect";
import type { GuestRelayRequest, GuestRelayResponse } from "../../guestShare/shareRelayHostClient";
import type { PageProjectionOperations } from "./GuestPageProjectionService";
import { GuestProjectionError, type ProjectionFailure } from "./guestProjectionContent";
import { PageGuestEditStreams } from "./pageGuestEditStreams";

const status: Record<ProjectionFailure, number> = {
  invalid: 400,
  unavailable: 404,
  conflict: 409,
  unsupported: 422,
  "rate-limited": 429,
};
const error = (cause: unknown) =>
  cause instanceof GuestProjectionError ? cause : new GuestProjectionError("unavailable");
type Json = (status: number, body: unknown) => GuestRelayResponse;
type Read = (body: GuestRelayRequest["body"], limit: number) => Effect.Effect<Uint8Array, unknown>;
export const isGuestPageEditRequest = (route: string) =>
  PAGE_GUEST_EDIT_ROUTES.some((name) => name === route);

function decode<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
): S["Type"] {
  const decoded = Schema.decodeUnknownOption(schema)(value, { onExcessProperty: "error" });
  if (Option.isNone(decoded)) throw new GuestProjectionError("invalid");
  return decoded.value;
}

export function decodeGuestEditBytes(value: string) {
  if (
    !value ||
    value.length > limits.encodedChars ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new GuestProjectionError("invalid");
  const bytes = Buffer.from(value, "base64url");
  if (!bytes.byteLength || bytes.byteLength > limits.bytes || bytes.toString("base64url") !== value)
    throw new GuestProjectionError("invalid");
  return bytes;
}

export class PageGuestEditHttp {
  private readonly streams = new PageGuestEditStreams();
  constructor(
    private readonly projection: PageProjectionOperations,
    private readonly issuer: () => { parentOrigin: string; shareId: string } | null,
  ) {}

  handle(request: GuestRelayRequest, read: Read, json: Json): Effect.Effect<GuestRelayResponse> {
    const origin = this.issuer();
    if (!origin || request.signal.aborted)
      return Effect.succeed(json(404, { reason: "unavailable" }));
    if (request.method !== "POST") return Effect.succeed(json(405, { reason: "invalid" }));
    if (request.headers[PAGE_GUEST_EDIT_ORIGIN_HEADER] !== origin.parentOrigin)
      return Effect.succeed(json(403, { reason: "forbidden" }));
    const events = request.route === GUEST_ROUTES.pageEditEvents;
    if (
      request.query ||
      request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json" ||
      request.headers.accept !== (events ? "text/event-stream" : "application/json")
    )
      return Effect.succeed(json(400, { reason: "invalid" }));
    const stillCurrent = () => {
      const now = this.issuer();
      return now?.shareId === origin.shareId && now.parentOrigin === origin.parentOrigin;
    };
    const limit =
      request.route === GUEST_ROUTES.pageEditUpdate ? limits.updateBodyBytes : limits.jsonBytes;
    return read(request.body, limit).pipe(
      Effect.mapError(() => new GuestProjectionError("invalid")),
      Effect.flatMap((bytes) =>
        Effect.tryPromise({
          try: async () => {
            let body: unknown;
            try {
              body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            } catch {
              throw new GuestProjectionError("invalid");
            }
            if (!stillCurrent()) throw new GuestProjectionError("unavailable");
            if (request.route === GUEST_ROUTES.pageEditOpen) {
              const input = decode(PageGuestEditOpenRequest, body);
              const result = await this.projection.open(input.entry, input.pageId, request.signal);
              if (!stillCurrent() || request.signal.aborted)
                throw new GuestProjectionError("unavailable");
              return json(200, {
                v: 1,
                ticket: result.ticket,
                revision: result.revision,
                seed: Buffer.from(result.seed).toString("base64url"),
                expiresInMs: limits.ttlMs,
              });
            }
            if (request.route === GUEST_ROUTES.pageEditUpdate) {
              const input = decode(PageGuestEditUpdateRequest, body);
              const receipt = await this.projection.submit(
                input.entry,
                input.ticket,
                decodeGuestEditBytes(input.update),
                input.pageId,
                request.signal,
              );
              if (!stillCurrent() || request.signal.aborted)
                throw new GuestProjectionError("unavailable");
              return json(200, { v: 1, revision: receipt.revision, applied: receipt.applied });
            }
            const input = decode(PageGuestEditSessionRequest, body);
            if (events) {
              const stream = await this.streams.open(
                input.ticket,
                request.signal,
                stillCurrent,
                (signal) =>
                  this.projection.observe(input.entry, input.pageId, input.ticket, signal),
              );
              return {
                status: 200,
                headers: {
                  "content-type": "text/event-stream; charset=utf-8",
                  "cache-control": "no-store, no-transform",
                },
                body: stream,
              };
            }
            await this.projection.release(input.entry, input.pageId, input.ticket, request.signal);
            return { status: 204, headers: { "cache-control": "no-store" }, body: null };
          },
          catch: error,
        }),
      ),
      Effect.catch((failure) =>
        Effect.succeed(json(status[failure.code], { reason: failure.code })),
      ),
      Effect.catchCause(() => Effect.succeed(json(404, { reason: "unavailable" }))),
    );
  }

  close() {
    this.streams.close();
  }
}
