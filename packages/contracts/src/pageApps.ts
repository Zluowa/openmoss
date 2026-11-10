// FILE: pageApps.ts
// Purpose: Contract for Moss 应用页 (runnable HTML pages in the 资料空间): the
// stored item, its versions, the shell <-> server RPC payloads, the frame <->
// shell postMessage protocol and the capability declaration/consent model.
// Layer: Shared contract

import { Schema } from "effect";

import { IsoDateTime, PositiveInt, SpaceId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { PAGE_APP_EXTENSION_CAPABILITIES } from "./pageAppExtensions";
import { PageSpaceId } from "./pages";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const PAGE_APP_MAX_VERSIONS = 100;
export const PAGE_APP_MAX_HTML_CHARS = 2_000_000;
export const PAGE_APP_MAX_TITLE_CHARS = 256;
export const PAGE_APP_MAX_DESCRIPTION_CHARS = 2_000;
export const PAGE_APP_MAX_THUMBNAIL_CHARS = 400_000;
/** Documents one 应用页's database may hold in total (shared + private). */
export const PAGE_APP_DB_MAX_DOCUMENTS = 10_000;
export const PAGE_APP_DB_MAX_DOCUMENT_BYTES = 256 * 1024;
export const PAGE_APP_DB_MAX_DEPTH = 32;
export const PAGE_APP_DB_MAX_RULES = 64;
export const PAGE_APP_DB_MAX_FILTERS = 10;
export const PAGE_APP_DB_MAX_QUERY_LIMIT = 1_000;
export const PAGE_APP_DB_MAX_SUBSCRIPTIONS = 64;
export const PAGE_APP_AI_MAX_INPUT_CHARS = 200_000;
export const PAGE_APP_AI_MAX_OUTPUT_TOKENS = 8_192;
export const PAGE_APP_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** A frame token stays valid this long; the shell re-mints on reload. */
export const PAGE_APP_FRAME_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** `moss.use()` resolves `null` when the shell never answers within this. */
export const PAGE_APP_USE_TIMEOUT_MS = 10_000;

/** The manifest block an 应用页's HTML may carry; the server keeps it in sync. */
export const PAGE_APP_MANIFEST_ELEMENT_ID = "moss-app-manifest";
/** Host label under `localhost` that serves 应用页 content on its own origin. */
export const PAGE_APP_HOST_SUFFIX = "moss-app.localhost";
/** Path prefix on the 应用页 origin; everything else there is 404. */
export const PAGE_APP_CONTENT_PATH = "/__moss_app/frame";
export const PAGE_APP_FALLBACK_CONTENT_PATH = "/__moss_app/isolated";

// ---------------------------------------------------------------------------
// Identity and capability names
// ---------------------------------------------------------------------------

export const PageAppId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("PageAppId"),
);
export type PageAppId = typeof PageAppId.Type;

/** Capabilities this build serves. Further capability plugins append to this list. */
export const PAGE_APP_BUILTIN_CAPABILITIES = [
  "db",
  "ai",
  "downloads",
  "user",
  "permissions",
  "page",
  ...PAGE_APP_EXTENSION_CAPABILITIES,
] as const;

export const PageAppCapabilityName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u),
);
export type PageAppCapabilityName = typeof PageAppCapabilityName.Type;

/**
 * Sharing levels a db rule can name, lowest first. `self` is a level nobody
 * holds; it only goes on the prefix rule of a `{self}` rule.
 */
export const PAGE_APP_DB_LEVELS = ["view", "interact", "admin", "owner", "self"] as const;
export const PageAppDbLevel = Schema.Literals(PAGE_APP_DB_LEVELS);
export type PageAppDbLevel = typeof PageAppDbLevel.Type;
/** Levels a viewer can actually hold. */
export const PageAppViewerLevel = Schema.Literals(["view", "interact", "admin", "owner"]);
export type PageAppViewerLevel = typeof PageAppViewerLevel.Type;

export const PageAppDbRule = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(512)),
  read: Schema.optional(PageAppDbLevel),
  write: Schema.optional(PageAppDbLevel),
});
export type PageAppDbRule = typeof PageAppDbRule.Type;

export const PageAppDbConfig = Schema.Struct({
  rules: Schema.optional(
    Schema.Array(PageAppDbRule).check(Schema.isMaxLength(PAGE_APP_DB_MAX_RULES)),
  ),
});
export type PageAppDbConfig = typeof PageAppDbConfig.Type;

/**
 * What a page declares it may use, keyed by capability name. Each value is
 * that capability's own config (`{}` for none); plugins validate their own.
 */
export const PageAppCapabilities = Schema.Record(PageAppCapabilityName, Schema.Unknown);
export type PageAppCapabilities = typeof PageAppCapabilities.Type;

// ---------------------------------------------------------------------------
// Stored item
// ---------------------------------------------------------------------------

const AppTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(PAGE_APP_MAX_TITLE_CHARS));
const AppDescription = Schema.String.check(Schema.isMaxLength(PAGE_APP_MAX_DESCRIPTION_CHARS));
const AppHtml = Schema.String.check(Schema.isMaxLength(PAGE_APP_MAX_HTML_CHARS));
const AppThumbnail = Schema.String.check(Schema.isMaxLength(PAGE_APP_MAX_THUMBNAIL_CHARS)).check(
  Schema.isPattern(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u),
);
const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const PageAppAuthor = Schema.Literals(["local-user", "agent"]);
export type PageAppAuthor = typeof PageAppAuthor.Type;

export const PageApp = Schema.Struct({
  id: PageAppId,
  /** Same authorization domain as Pages; null is the local default domain. */
  scopeSpaceId: Schema.NullOr(SpaceId),
  /** Document space it is filed in; null means 个人. */
  spaceId: Schema.NullOr(PageSpaceId),
  title: AppTitle,
  description: AppDescription,
  revision: PositiveInt,
  capabilities: PageAppCapabilities,
  favorite: Schema.Boolean,
  thumbnail: Schema.NullOr(AppThumbnail),
  sourceThreadId: Schema.NullOr(ThreadId),
  htmlChars: Schema.Int,
  trashedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PageApp = typeof PageApp.Type;

export const PageAppVersion = Schema.Struct({
  appId: PageAppId,
  revision: PositiveInt,
  title: AppTitle,
  description: AppDescription,
  capabilities: PageAppCapabilities,
  htmlChars: Schema.Int,
  operation: Schema.String,
  author: PageAppAuthor,
  authorThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type PageAppVersion = typeof PageAppVersion.Type;

// ---------------------------------------------------------------------------
// Errors (stable codes; page code branches on these)
// ---------------------------------------------------------------------------

export const PAGE_APP_ERROR_CODES = [
  "invalid_argument",
  "not_found",
  "conflict",
  /** The page did not declare this capability. */
  "not_declared",
  /** The viewer has not granted it (or declined it this load). */
  "not_granted",
  /** The capability is not served on this view. */
  "unavailable",
  "resource_exhausted",
  "quota_exceeded",
  "revoked",
  "authentication_required",
  "upstream_error",
  "cancelled",
  "storage",
] as const;
export const PageAppErrorCode = Schema.Literals(PAGE_APP_ERROR_CODES);
export type PageAppErrorCode = typeof PageAppErrorCode.Type;

export class PageAppsRpcError extends Schema.TaggedErrorClass<PageAppsRpcError>()(
  "PageAppsRpcError",
  {
    code: PageAppErrorCode,
    message: Schema.String,
    currentRevision: Schema.optional(PositiveInt),
  },
) {}

export const PageAppCallError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
export type PageAppCallError = typeof PageAppCallError.Type;

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/** Same four words page code sees through `permissions.state()`. */
export const PageAppPermissionState = Schema.Literals([
  "granted",
  "prompt",
  "denied",
  "unavailable",
]);
export type PageAppPermissionState = typeof PageAppPermissionState.Type;
/** What is remembered per page per capability. Absent means "ask". */
export const PageAppStoredConsent = Schema.Literals(["granted", "denied"]);
export type PageAppStoredConsent = typeof PageAppStoredConsent.Type;

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

export const PageAppViewer = Schema.Struct({
  /** Stable id inside this Moss; private db subtrees are keyed on it. */
  id: TrimmedNonEmptyString,
  name: Schema.String,
  level: PageAppViewerLevel,
  isOwner: Schema.Boolean,
});
export type PageAppViewer = typeof PageAppViewer.Type;

// ---------------------------------------------------------------------------
// RPC payloads (shell / agent tools -> server)
// ---------------------------------------------------------------------------

export const PageAppsListInput = Schema.Struct({
  scopeSpaceId: Schema.NullOr(SpaceId),
  includeTrashed: Schema.optional(Schema.Boolean),
});
export type PageAppsListInput = typeof PageAppsListInput.Type;
export const PageAppsListResult = Schema.Struct({ apps: Schema.Array(PageApp) });
export type PageAppsListResult = typeof PageAppsListResult.Type;

export const PageAppsReadInput = Schema.Struct({
  appId: PageAppId,
  revision: Schema.optional(PositiveInt),
});
export type PageAppsReadInput = typeof PageAppsReadInput.Type;
export const PageAppsReadResult = Schema.Struct({
  app: PageApp,
  /** Revision actually served (the current one unless `revision` asked otherwise). */
  revision: PositiveInt,
  html: AppHtml,
  capabilities: PageAppCapabilities,
});
export type PageAppsReadResult = typeof PageAppsReadResult.Type;

export const PageAppsVersionsInput = Schema.Struct({
  appId: PageAppId,
  beforeRevision: Schema.optional(PositiveInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(PAGE_APP_MAX_VERSIONS))),
});
export type PageAppsVersionsInput = typeof PageAppsVersionsInput.Type;
export const PageAppsVersionsResult = Schema.Struct({ versions: Schema.Array(PageAppVersion) });
export type PageAppsVersionsResult = typeof PageAppsVersionsResult.Type;

const AppMutationFields = {
  requestId: RequestId,
  appId: PageAppId,
  expectedRevision: PositiveInt,
};
export const PageAppsMutateInput = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("create"),
    requestId: RequestId,
    scopeSpaceId: Schema.NullOr(SpaceId),
    spaceId: Schema.optional(Schema.NullOr(PageSpaceId)),
    /** Falls back to the HTML manifest, then `<title>`, then 未命名应用页. */
    title: Schema.optional(AppTitle),
    description: Schema.optional(AppDescription),
    html: AppHtml,
    /** Falls back to the HTML manifest's `capabilities`, then none. */
    capabilities: Schema.optional(PageAppCapabilities),
    sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  }),
  Schema.Struct({
    op: Schema.Literal("update"),
    ...AppMutationFields,
    html: Schema.optional(AppHtml),
    title: Schema.optional(AppTitle),
    description: Schema.optional(AppDescription),
    capabilities: Schema.optional(PageAppCapabilities),
  }),
  Schema.Struct({ op: Schema.Literal("rename"), ...AppMutationFields, title: AppTitle }),
  Schema.Struct({ op: Schema.Literal("favorite"), ...AppMutationFields, favorite: Schema.Boolean }),
  Schema.Struct({
    op: Schema.Literal("set-thumbnail"),
    ...AppMutationFields,
    thumbnail: Schema.NullOr(AppThumbnail),
  }),
  Schema.Struct({
    op: Schema.Literal("move"),
    ...AppMutationFields,
    spaceId: Schema.NullOr(PageSpaceId),
  }),
  Schema.Struct({ op: Schema.Literal("trash"), ...AppMutationFields }),
  Schema.Struct({ op: Schema.Literal("restore"), ...AppMutationFields }),
  Schema.Struct({
    op: Schema.Literal("restore-version"),
    ...AppMutationFields,
    revision: PositiveInt,
  }),
]);
export type PageAppsMutateInput = typeof PageAppsMutateInput.Type;
export const PageAppsMutateResult = Schema.Struct({ app: PageApp });
export type PageAppsMutateResult = typeof PageAppsMutateResult.Type;

export const PageAppFrameMode = Schema.Literals(["full", "embed", "guest"]);
export type PageAppFrameMode = typeof PageAppFrameMode.Type;

/** Shell asks for a short-lived URL that serves the page on its own origin. */
export const PageAppsOpenFrameInput = Schema.Struct({
  appId: PageAppId,
  revision: Schema.optional(PositiveInt),
  mode: PageAppFrameMode,
  /** Origin of the Moss UI that will frame it; becomes `frame-ancestors`. */
  parentOrigin: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type PageAppsOpenFrameInput = typeof PageAppsOpenFrameInput.Type;
export const PageAppsOpenFrameResult = Schema.Struct({
  app: PageApp,
  revision: PositiveInt,
  capabilities: PageAppCapabilities,
  /** Absolute URL for the iframe `src`. */
  frameUrl: Schema.String,
  /** Origin messages from the page must carry. "null" for the opaque fallback. */
  frameOrigin: Schema.String,
  /** True when the page runs on its own `*.localhost` origin (storage works). */
  ownOrigin: Schema.Boolean,
  /** Availability of declared script/import/style resources only, not arbitrary
   * JavaScript-created URLs or a promise that the entire app works offline. */
  offlineReady: Schema.optional(Schema.Boolean),
  expiresAt: IsoDateTime,
  viewer: PageAppViewer,
  consent: Schema.Record(PageAppCapabilityName, PageAppStoredConsent),
});
export type PageAppsOpenFrameResult = typeof PageAppsOpenFrameResult.Type;

export const PageAppsConsentInput = Schema.Union([
  Schema.Struct({ op: Schema.Literal("get"), appId: PageAppId }),
  Schema.Struct({
    op: Schema.Literal("set"),
    appId: PageAppId,
    capability: PageAppCapabilityName,
    /** null forgets the answer, so the next use asks again. */
    state: Schema.NullOr(PageAppStoredConsent),
  }),
]);
export type PageAppsConsentInput = typeof PageAppsConsentInput.Type;
export const PageAppsConsentResult = Schema.Struct({
  consent: Schema.Record(PageAppCapabilityName, PageAppStoredConsent),
});
export type PageAppsConsentResult = typeof PageAppsConsentResult.Type;

/** One request/response capability call relayed by the shell broker. */
export const PageAppsCallInput = Schema.Struct({
  appId: PageAppId,
  revision: PositiveInt,
  capability: PageAppCapabilityName,
  method: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  args: Schema.Unknown,
});
export type PageAppsCallInput = typeof PageAppsCallInput.Type;
export const PageAppsCallResult = Schema.Struct({ value: Schema.Unknown });
export type PageAppsCallResult = typeof PageAppsCallResult.Type;

/** A streaming capability call: db subscriptions and streamed ai text. */
export const PageAppsWatchInput = PageAppsCallInput;
export type PageAppsWatchInput = typeof PageAppsWatchInput.Type;
export const PageAppsWatchEvent = Schema.Struct({ value: Schema.Unknown });
export type PageAppsWatchEvent = typeof PageAppsWatchEvent.Type;

// ---------------------------------------------------------------------------
// db wire shapes (args of `db.*` calls, after the frame runtime builds them)
// ---------------------------------------------------------------------------

export const PAGE_APP_DB_FILTER_OPS = [
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "not-in",
  "array-contains",
] as const;
export const PageAppDbFilter = Schema.Struct({
  field: Schema.String.check(Schema.isMaxLength(256)),
  op: Schema.Literals(PAGE_APP_DB_FILTER_OPS),
  value: Schema.Unknown,
});
export type PageAppDbFilter = typeof PageAppDbFilter.Type;
export const PageAppDbQuery = Schema.Struct({
  collection: Schema.String.check(Schema.isMaxLength(1024)),
  where: Schema.optional(
    Schema.Array(PageAppDbFilter).check(Schema.isMaxLength(PAGE_APP_DB_MAX_FILTERS)),
  ),
  orderBy: Schema.optional(
    Schema.Struct({
      field: Schema.String.check(Schema.isMaxLength(256)),
      dir: Schema.Literals(["asc", "desc"]),
    }),
  ),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PAGE_APP_DB_MAX_QUERY_LIMIT)),
  ),
});
export type PageAppDbQuery = typeof PageAppDbQuery.Type;
export const PageAppDbDocument = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  exists: Schema.Boolean,
  data: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type PageAppDbDocument = typeof PageAppDbDocument.Type;

// ---------------------------------------------------------------------------
// ai wire shapes
// ---------------------------------------------------------------------------

export const PageAppAiMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
});
export const PageAppAiRequest = Schema.Struct({
  input: Schema.Union([
    Schema.String,
    Schema.Array(PageAppAiMessage).check(Schema.isMaxLength(64)),
  ]),
  system: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
  json: Schema.optional(Schema.Boolean),
  maxTokens: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PAGE_APP_AI_MAX_OUTPUT_TOKENS)),
  ),
  tier: Schema.optional(Schema.Literals(["default", "quick", "complex"])),
});
export type PageAppAiRequest = typeof PageAppAiRequest.Type;
/** Stream events of `ai.ask`: text deltas, then exactly one `done`. */
export type PageAppAiEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "done"; readonly text: string; readonly model: string };

// ---------------------------------------------------------------------------
// Frame <-> shell postMessage protocol
// ---------------------------------------------------------------------------

/** Every message in either direction carries this tag. */
export const PAGE_APP_PROTOCOL = "moss-app/1" as const;

/** Messages the page frame sends to the shell. Decoded as untrusted input. */
export const PageAppFrameMessage = Schema.Union([
  Schema.Struct({ protocol: Schema.Literal(PAGE_APP_PROTOCOL), kind: Schema.Literal("hello") }),
  Schema.Struct({
    protocol: Schema.Literal(PAGE_APP_PROTOCOL),
    kind: Schema.Literal("call"),
    id: Schema.Int,
    capability: PageAppCapabilityName,
    method: Schema.String.check(Schema.isMaxLength(64)),
    args: Schema.Unknown,
  }),
  Schema.Struct({
    protocol: Schema.Literal(PAGE_APP_PROTOCOL),
    kind: Schema.Literal("watch"),
    id: Schema.Int,
    capability: PageAppCapabilityName,
    method: Schema.String.check(Schema.isMaxLength(64)),
    args: Schema.Unknown,
  }),
  Schema.Struct({
    protocol: Schema.Literal(PAGE_APP_PROTOCOL),
    kind: Schema.Literal("unwatch"),
    id: Schema.Int,
  }),
  Schema.Struct({
    protocol: Schema.Literal(PAGE_APP_PROTOCOL),
    kind: Schema.Literal("resize"),
    height: Schema.Finite,
  }),
]);
export type PageAppFrameMessage = typeof PageAppFrameMessage.Type;

/** Messages the shell sends to the page frame. */
export type PageAppShellMessage =
  | {
      readonly protocol: typeof PAGE_APP_PROTOCOL;
      readonly kind: "init";
      /** Capabilities this view serves to this page (declared ∩ shipped ∩ mode). */
      readonly served: readonly string[];
    }
  | {
      readonly protocol: typeof PAGE_APP_PROTOCOL;
      readonly kind: "result";
      readonly id: number;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly protocol: typeof PAGE_APP_PROTOCOL;
      readonly kind: "result";
      readonly id: number;
      readonly ok: false;
      readonly error: PageAppCallError;
    }
  | {
      readonly protocol: typeof PAGE_APP_PROTOCOL;
      readonly kind: "event";
      readonly id: number;
      readonly value: unknown;
    }
  | {
      readonly protocol: typeof PAGE_APP_PROTOCOL;
      readonly kind: "end";
      readonly id: number;
      readonly error?: PageAppCallError;
    };
