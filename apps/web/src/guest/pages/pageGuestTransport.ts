// FILE: pageGuestTransport.ts
// Purpose: Page view, comments, access and authorized image routes over the relay.
// Layer: Guest page (page links and sites)

import {
  GUEST_ROUTES,
  GUEST_MEDIA_MAX_BYTES,
  guestApiPath,
  type PageGuestAccessRequest,
  type PageGuestAccessResult,
  type PageGuestCommentsRequest,
  type PageGuestCommentsResult,
  type PageGuestErrorReason,
  type PageGuestView,
  type PageGuestViewRequest,
  type PageGuestMediaRequest,
} from "@moss/contracts";
import {
  createGuestAppPreviewTransport,
  type GuestAppPreviewTransport,
} from "./guestAppPreviewTransport";
import { createGuestEditTransport, type GuestEditTransport } from "./guestPageEditTransport";

export type PageGuestFailure =
  | { readonly kind: "network" }
  /** The relay answered for the owner: offline (503), or the publisher ended (404/410). */
  | { readonly kind: "relay"; readonly status: number; readonly reason: string | null }
  | { readonly kind: "refused"; readonly reason: PageGuestErrorReason };

export type PageGuestResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: PageGuestFailure };

const PAGE_REASONS = new Set<string>([
  "invite-only",
  "unavailable",
  "unpublished",
  "forbidden",
  "invalid",
  "rate-limited",
]);

export interface PageGuestTransport {
  readonly appPreview?: GuestAppPreviewTransport;
  readonly edit?: GuestEditTransport;
  readonly media: (request: PageGuestMediaRequest) => Promise<PageGuestResult<Blob>>;
  readonly view: (request: PageGuestViewRequest) => Promise<PageGuestResult<PageGuestView>>;
  readonly comments: (
    request: PageGuestCommentsRequest,
  ) => Promise<PageGuestResult<PageGuestCommentsResult>>;
  readonly access: (
    request: PageGuestAccessRequest,
  ) => Promise<PageGuestResult<PageGuestAccessResult>>;
}

export function createHttpPageGuestTransport(
  shareId: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): PageGuestTransport {
  const post = async <A>(
    route: string,
    body: unknown,
    image = false,
  ): Promise<PageGuestResult<A>> => {
    let response: Response;
    try {
      response = await fetchImpl(guestApiPath(shareId, route as never), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          accept: image ? "image/png,image/jpeg,image/gif,image/webp" : "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, failure: { kind: "network" } };
    }
    if (response.ok && image) {
      try {
        const blob = await response.blob();
        if (
          !/^image\/(png|jpeg|gif|webp)$/u.test(blob.type) ||
          blob.size === 0 ||
          blob.size > GUEST_MEDIA_MAX_BYTES
        )
          return { ok: false, failure: { kind: "refused", reason: "unavailable" } };
        return { ok: true, value: blob as A };
      } catch {
        return { ok: false, failure: { kind: "network" } };
      }
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) return { ok: true, value: parsed as A };
    const reason =
      typeof parsed === "object" && parsed !== null && "reason" in parsed
        ? String((parsed as { reason: unknown }).reason)
        : null;
    if (reason !== null && PAGE_REASONS.has(reason)) {
      return { ok: false, failure: { kind: "refused", reason: reason as PageGuestErrorReason } };
    }
    return { ok: false, failure: { kind: "relay", status: response.status, reason } };
  };
  return {
    appPreview: createGuestAppPreviewTransport(shareId, fetchImpl),
    edit: createGuestEditTransport(shareId, fetchImpl),
    media: (request) => post<Blob>(GUEST_ROUTES.pageMedia, request, true),
    view: (request) => post(GUEST_ROUTES.page, request),
    comments: (request) => post(GUEST_ROUTES.pageComments, request),
    access: (request) => post(GUEST_ROUTES.pageAccess, request),
  };
}
