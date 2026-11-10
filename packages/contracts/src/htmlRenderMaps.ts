// FILE: htmlRenderMaps.ts
// Purpose: The map a live html_render page draws, as the server hands it to the app:
//   the provider for the reader's account lane and its browser key, or a keyless map.
// Layer: Contracts (schema only)

import { Schema } from "effect";

const MapKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const HtmlRenderMapConfig = Schema.Union([
  Schema.Struct({
    lane: Schema.Literal("global"),
    provider: Schema.Literal("google"),
    google: Schema.Struct({ apiKey: MapKey }),
  }),
  Schema.Struct({ lane: Schema.Literal("global"), provider: Schema.Literal("openfreemap") }),
  Schema.Struct({
    lane: Schema.Literal("cn"),
    provider: Schema.Literal("amap"),
    amap: Schema.Struct({ key: MapKey, securityJsCode: Schema.optional(MapKey) }),
  }),
  Schema.Struct({ lane: Schema.Literal("cn"), provider: Schema.Literal("plain") }),
]);
export type HtmlRenderMapConfig = typeof HtmlRenderMapConfig.Type;
