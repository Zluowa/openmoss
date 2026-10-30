// FILE: mcpAppResource.ts
// Purpose: Bounded contracts for loading an MCP App resource through the
// authenticated provider runtime. HTML is runtime-only and is never a
// persistence contract.

import { Schema } from "effect";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const MCP_APP_RESOURCE_MAX_HTML_BYTES = 10_000_000 as const;
export const MCP_APP_RESOURCE_MAX_DOMAIN_ENTRIES = 32 as const;
export const MCP_APP_RESOURCE_MAX_DOMAIN_CHARS = 2_000 as const;

const McpAppResourceIdentity = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const McpAppResourceUri = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
const McpAppResourceDomain = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MCP_APP_RESOURCE_MAX_DOMAIN_CHARS),
);

export const McpAppResourceSource = Schema.Literals(["appContext", "resultMeta", "legacy"]);
export type McpAppResourceSource = typeof McpAppResourceSource.Type;

export const McpAppResourceMimeType = Schema.Literals([
  "text/html",
  "text/html;profile=mcp-app",
  "text/html+skybridge",
]);
export type McpAppResourceMimeType = typeof McpAppResourceMimeType.Type;

const McpAppResourceDomainList = Schema.Array(McpAppResourceDomain).check(
  Schema.isMaxLength(MCP_APP_RESOURCE_MAX_DOMAIN_ENTRIES),
);

/** Normalized resource metadata; raw `_meta` never crosses this boundary. */
export const McpAppResourceCsp = Schema.Struct({
  baseUriDomains: McpAppResourceDomainList,
  connectDomains: McpAppResourceDomainList,
  frameDomains: McpAppResourceDomainList,
  includeDefaultDomains: Schema.Boolean,
  isTrusted: Schema.Boolean,
  resourceDomains: McpAppResourceDomainList,
});
export type McpAppResourceCsp = typeof McpAppResourceCsp.Type;

const McpAppResourceHeightHint = Schema.Number.check(Schema.isFinite())
  .check(Schema.isGreaterThan(0))
  .check(Schema.isLessThanOrEqualTo(100_000));
const McpAppResourceMinFrameHeight = Schema.Number.check(Schema.isFinite())
  .check(Schema.isGreaterThanOrEqualTo(0))
  .check(Schema.isLessThanOrEqualTo(100_000));

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

export const McpAppResourceReadInput = Schema.Struct({
  threadId: ThreadId.check(Schema.isMaxLength(200)),
  callId: McpAppResourceIdentity,
  server: McpAppResourceIdentity,
  resourceUri: McpAppResourceUri,
  source: McpAppResourceSource,
  connectorId: Schema.optional(McpAppResourceIdentity),
});
export type McpAppResourceReadInput = typeof McpAppResourceReadInput.Type;

export const McpAppResourceReadyResult = Schema.Struct({
  state: Schema.Literal("ready"),
  resourceUri: McpAppResourceUri,
  html: Schema.String.check(Schema.isMaxLength(MCP_APP_RESOURCE_MAX_HTML_BYTES)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MCP_APP_RESOURCE_MAX_HTML_BYTES)),
  mimeType: McpAppResourceMimeType,
  csp: McpAppResourceCsp,
  heightHint: Schema.optional(McpAppResourceHeightHint),
  minFrameHeight: Schema.optional(McpAppResourceMinFrameHeight),
  prefersBorder: Schema.Boolean,
  isCollapsible: Schema.Boolean,
  widgetDomain: Schema.NullOr(McpAppResourceDomain),
  originCallId: Schema.optional(McpAppResourceIdentity),
}).check(
  Schema.makeFilter(
    (value: typeof McpAppResourceReadyResult.Type) =>
      value.sizeBytes === utf8ByteLength(value.html) &&
      value.sizeBytes <= MCP_APP_RESOURCE_MAX_HTML_BYTES,
  ),
);
export type McpAppResourceReadyResult = typeof McpAppResourceReadyResult.Type;

export const McpAppResourceNoContentResult = Schema.Struct({
  state: Schema.Literal("no_content"),
  resourceUri: McpAppResourceUri,
});
export type McpAppResourceNoContentResult = typeof McpAppResourceNoContentResult.Type;

export const McpAppResourceTooLargeResult = Schema.Struct({
  state: Schema.Literal("too_large"),
  resourceUri: McpAppResourceUri,
  sizeBytes: NonNegativeInt,
});
export type McpAppResourceTooLargeResult = typeof McpAppResourceTooLargeResult.Type;

export const McpAppResourceReadResult = Schema.Union([
  McpAppResourceReadyResult,
  McpAppResourceNoContentResult,
  McpAppResourceTooLargeResult,
]);
export type McpAppResourceReadResult = typeof McpAppResourceReadResult.Type;
