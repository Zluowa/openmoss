import { Schema } from "effect";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";
import { PageId, PageScopeSpaceId } from "./pages";

/** The WebSocket path of a Page's live editing room on the Moss server. */
export const PAGES_REALTIME_WS_PATH = "/ws/pages-realtime";
/** Subprotocol prefix; the full value names the Page so a token cannot open another room. */
export const PAGES_REALTIME_SUBPROTOCOL_PREFIX = "moss-page-room.";

export const PagesRealtimeMode = Schema.Literals(["edit", "view"]);
export type PagesRealtimeMode = typeof PagesRealtimeMode.Type;

export const PagesRealtimeTokenInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
  /** Ask for less than the caller may do, for example a read-only preview. */
  mode: Schema.optional(PagesRealtimeMode),
});
export type PagesRealtimeTokenInput = typeof PagesRealtimeTokenInput.Type;

export const PagesRealtimeTokenResult = Schema.Struct({
  pageId: PageId,
  /** Single-use within its lifetime: present it in the room URL's `ticket` parameter. */
  token: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  mode: PagesRealtimeMode,
  /** Identity of the room's document. Null until a Markdown-only Page receives its first seed. */
  generation: Schema.NullOr(TrimmedNonEmptyString),
  revision: PositiveInt,
  wsPath: TrimmedNonEmptyString,
});
export type PagesRealtimeTokenResult = typeof PagesRealtimeTokenResult.Type;
