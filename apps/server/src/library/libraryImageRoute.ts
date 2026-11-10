// FILE: libraryImageRoute.ts
// Purpose: Serve persistent library image URLs only to the authenticated owner.
// Layer: Server HTTP

import { LIBRARY_IMAGE_ROUTE_PREFIX, libraryImageIdFromPath } from "@moss/shared/localPreviewFiles";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authErrorResponse, makeEffectAuthRequest } from "../auth/effectHttp.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { LibraryService } from "./Services/LibraryService.ts";
import { LIBRARY_IMAGE_HEADERS } from "./libraryImage.ts";

/** The saved URL is stable; every load still checks the current owner session and library row. */
export const libraryImageEffectRouteLayer = HttpRouter.add(
  "GET",
  `${LIBRARY_IMAGE_ROUTE_PREFIX}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* ServerAuth;
    const session = yield* auth.authenticateHttpRequest(makeEffectAuthRequest(request));
    if (session.role !== "owner") return HttpServerResponse.empty({ status: 403 });
    const url = HttpServerRequest.toURL(request);
    const id = url && url.search === "" ? libraryImageIdFromPath(url.pathname) : null;
    if (id === null) return HttpServerResponse.empty({ status: 404 });
    const library = yield* LibraryService;
    const image = yield* library.readImage(id);
    if (image === null)
      return HttpServerResponse.empty({ status: 404, headers: LIBRARY_IMAGE_HEADERS });
    return HttpServerResponse.uint8Array(image.bytes, {
      contentType: image.mimeType,
      headers: LIBRARY_IMAGE_HEADERS,
    });
  }).pipe(
    Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error))),
    Effect.catchTag("LibraryServiceError", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 404, headers: LIBRARY_IMAGE_HEADERS })),
    ),
  ),
);
