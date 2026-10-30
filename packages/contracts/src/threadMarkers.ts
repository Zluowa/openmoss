import { Schema } from "effect";
import { MessageId, TrimmedNonEmptyString } from "./baseSchemas";

export const THREAD_MARKER_LABEL_MAX_CHARS = 60;
export const ThreadMarkerId = TrimmedNonEmptyString.pipe(Schema.brand("ThreadMarkerId"));
export type ThreadMarkerId = typeof ThreadMarkerId.Type;
export const ThreadMarkerStyle = Schema.Literals(["highlight", "underline"]);
export type ThreadMarkerStyle = typeof ThreadMarkerStyle.Type;
export const ThreadMarkerColor = Schema.Literals(["yellow", "blue", "green", "pink", "purple"]);
export type ThreadMarkerColor = typeof ThreadMarkerColor.Type;
export const ThreadMarker = Schema.Struct({
  id: ThreadMarkerId,
  messageId: MessageId,
  startOffset: Schema.Int,
  endOffset: Schema.Int,
  selectedText: Schema.String,
  style: ThreadMarkerStyle,
  color: ThreadMarkerColor,
  label: Schema.NullOr(Schema.String),
  done: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ThreadMarker = typeof ThreadMarker.Type;
