// FILE: boardAssistRoute.ts
// Purpose: Mounts `POST /api/moss/board/assist` SSE endpoint for hosted 板上 Moss.
//          Enforces trusted origin CORS, owner/startup-bearer auth, and optional/verified
//          board scope checks (PR #106/#107 parity) without any synchronous FS calls.
// Layer: Server HTTP route.

import { PageId, SpaceId } from "@moss/contracts";
import { parseBoardItem } from "@moss/shared/spaceItems/itemData";
import { Effect, FileSystem, Option, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError, ServerAuth } from "./auth/Services/ServerAuth";
import { authErrorResponse, makeEffectAuthRequest } from "./auth/effectHttp";
import {
  BOARD_ASSIST_FAST_MODELS,
  BOARD_ASSIST_MESSAGES,
  cachedBoardAssistCredential,
  cachedBoardAssistModels,
  readBoardAssistBody,
  streamBoardAssist,
} from "./boardAssist";
import { ServerConfig } from "./config";
import { resolveMossMediaCredential } from "./mossMediaAuthority";
import {
  canvasBoardScopeFromUrl,
  matchesCanvasBoard,
  type CanvasBoardScope,
} from "./mossCanvasBoardStorage";
import { mossCanvasTextModels } from "./mossCanvasText";
import { makePageAppAiGateway, pageAppAiStubEndpoint } from "./pages/apps/aiGateway";
import { LOCAL_PAGES_PRINCIPAL } from "./pages/Services/PagesService";
import { PageTypesService } from "./pages/types/PageTypesService";
import { isLoopbackStartupBearer, requestPeer } from "./startupAccess";
import {
  isTrustedAppOrigin,
  normalizeCorsOrigin,
  shouldRejectAuthMutationOrigin,
} from "./trustedOrigins";

export const MOSS_BOARD_ASSIST_ROUTE_PATH = "/api/moss/board/assist";

function boardAssistCorsHeaders(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly config: {
    readonly allowPublicAccess?: boolean;
    readonly devUrl?: URL | undefined;
    readonly publicBaseUrl?: URL | undefined;
  };
}): Record<string, string> | null {
  const origin = normalizeCorsOrigin(input.request.headers.origin);
  if (!origin) return {};
  if (
    !isTrustedAppOrigin({ origin, requestOrigin: input.url.origin, config: input.config as never })
  ) {
    return null;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    Vary: "Origin",
  };
}

class BoardAssistHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const verifyCanvasBoardScope = (boardScope: CanvasBoardScope | null, expectedBoard: unknown) =>
  Effect.gen(function* () {
    if (!boardScope && expectedBoard === undefined) return;
    if (!boardScope || !matchesCanvasBoard(expectedBoard, boardScope)) {
      return yield* Effect.fail(new BoardAssistHttpError(403, "Board scope mismatch."));
    }
    const typesOpt = yield* Effect.serviceOption(PageTypesService);
    if (Option.isNone(typesOpt)) {
      return yield* Effect.fail(new BoardAssistHttpError(503, "Board service unavailable."));
    }
    const item = yield* typesOpt.value
      .read(
        {
          pageId: PageId.makeUnsafe(boardScope.pageId),
          scopeSpaceId:
            boardScope.scopeSpaceId === null ? null : SpaceId.makeUnsafe(boardScope.scopeSpaceId),
        },
        LOCAL_PAGES_PRINCIPAL,
      )
      .pipe(
        Effect.catch(() => Effect.fail(new BoardAssistHttpError(404, "Board item was not found."))),
      );
    if (
      item.kind !== "board" ||
      item.page.trashedAt !== null ||
      item.page.scopeSpaceId !== boardScope.scopeSpaceId
    ) {
      return yield* Effect.fail(new BoardAssistHttpError(403, "Board scope rejected."));
    }
    if (item.data !== null) {
      try {
        const parsed = parseBoardItem(item.data);
        if (parsed.canvasProjectKey !== boardScope.canvasProjectKey) {
          return yield* Effect.fail(new BoardAssistHttpError(403, "Board project mismatch."));
        }
      } catch {
        return yield* Effect.fail(new BoardAssistHttpError(403, "Board metadata mismatch."));
      }
    }
  });

const boardAssistEffectHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

  const config = yield* ServerConfig;
  const corsHeaders = boardAssistCorsHeaders({ request, url, config });
  if (corsHeaders === null) {
    return HttpServerResponse.jsonUnsafe(
      { error: "Trusted request origin required." },
      { status: 403 },
    );
  }
  if (request.method === "OPTIONS") {
    return HttpServerResponse.empty({ status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  const loopbackBearer = isLoopbackStartupBearer({
    ...config,
    authorization: request.headers.authorization,
    peer: requestPeer(request),
  });
  if (!loopbackBearer) {
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
    if (session.role !== "owner") {
      return HttpServerResponse.jsonUnsafe(
        { error: "Owner authorization required.", code: "owner_authorization_required" },
        { status: 403, headers: corsHeaders },
      );
    }
    if (
      shouldRejectAuthMutationOrigin({
        rawOrigin: request.headers.origin,
        requestOrigin: url.origin,
        config,
        credentialSource: session.credentialSource,
      })
    ) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Trusted request origin required." },
        { status: 403, headers: corsHeaders },
      );
    }
  }

  let boardScope: CanvasBoardScope | null = null;
  try {
    boardScope = canvasBoardScopeFromUrl(url);
  } catch {
    return HttpServerResponse.jsonUnsafe(
      { error: "Malformed board scope parameters." },
      { status: 400, headers: corsHeaders },
    );
  }

  const body = yield* request.json.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(512 * 1024)),
    Effect.catch(() => Effect.succeed(null)),
  );
  const input = readBoardAssistBody(body);
  if (!input) {
    return HttpServerResponse.jsonUnsafe(
      { error: "Malformed board ask." },
      { status: 400, headers: corsHeaders },
    );
  }

  yield* verifyCanvasBoardScope(boardScope, input.expectedBoard);

  const encoder = new TextEncoder();
  const sse = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  const stub = pageAppAiStubEndpoint(process.env);
  const credentialResult = stub
    ? null
    : yield* Effect.result(cachedBoardAssistCredential(resolveMossMediaCredential));

  if (credentialResult && credentialResult._tag === "Failure") {
    return HttpServerResponse.stream(
      Stream.succeed(
        sse({
          type: "error",
          code: "authentication_required",
          message: BOARD_ASSIST_MESSAGES.authentication_required,
        }),
      ),
      {
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: {
          ...corsHeaders,
          "Cache-Control": "no-cache",
        },
      },
    );
  }

  const gateway = makePageAppAiGateway({
    fast: true,
    preferModels: BOARD_ASSIST_FAST_MODELS,
    resolveEndpoint: async () => {
      if (stub) return stub;
      const current = credentialResult!.success;
      return {
        baseUrl: current.gatewayBaseUrl,
        accessToken: current.accessToken,
        models: await cachedBoardAssistModels(current.accessToken, () =>
          mossCanvasTextModels(current),
        ),
      };
    },
  });

  async function* runStream() {
    const controller = new AbortController();
    try {
      yield* streamBoardAssist(gateway, input!, controller.signal);
    } finally {
      controller.abort();
    }
  }

  const stream = Stream.fromAsyncIterable(runStream(), (cause) => cause).pipe(
    Stream.map(sse),
    Stream.catch(() =>
      Stream.succeed(
        sse({
          type: "error",
          code: "upstream_error",
          message: BOARD_ASSIST_MESSAGES.upstream_error,
        }),
      ),
    ),
  );

  return HttpServerResponse.stream(stream, {
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    headers: {
      ...corsHeaders,
      "Cache-Control": "no-cache",
    },
  });
}).pipe(
  Effect.catch((error) =>
    Effect.succeed(
      error instanceof AuthError
        ? authErrorResponse(error)
        : error instanceof BoardAssistHttpError
          ? HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status })
          : HttpServerResponse.jsonUnsafe({ error: "Board ask failed." }, { status: 500 }),
    ),
  ),
);

export const boardAssistEffectRouteLayer = HttpRouter.add(
  "*",
  MOSS_BOARD_ASSIST_ROUTE_PATH,
  boardAssistEffectHandler,
);
