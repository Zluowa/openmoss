// FILE: thumbnail.ts
// Purpose: Validate generated raster previews before storing app metadata.
// Layer: Server pages/apps

import {
  PAGE_APP_THUMBNAIL_HEIGHT,
  PAGE_APP_THUMBNAIL_MAX_BYTES,
  PAGE_APP_THUMBNAIL_WIDTH,
} from "@moss/shared/pageAppFrameRuntime";

import { jpegDimensions } from "../../jpegHeader";

export function validPageAppThumbnail(value: string): boolean {
  if (value.length > Math.ceil(PAGE_APP_THUMBNAIL_MAX_BYTES / 3) * 4 + 23) return false;
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const bytes = Buffer.from(value.slice(23), "base64");
  if (bytes.length > PAGE_APP_THUMBNAIL_MAX_BYTES) return false;
  if (bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
  const size = jpegDimensions(bytes);
  return Boolean(
    size && size.width <= PAGE_APP_THUMBNAIL_WIDTH && size.height <= PAGE_APP_THUMBNAIL_HEIGHT,
  );
}
