// FILE: themeToolImages.ts
// Purpose: The `images` argument of `moss_theme_set`: pictures by name and absolute path. Each is
//          stored at full quality in Moss's theme picture store, and `moss-theme-image:<name>`
//          in the theme's CSS becomes the stored reference `moss-theme-image:<id>`.
// Layer: Agent gateway tool helper

import { THEME_IMAGE_SCHEME, isThemeImageId } from "@moss/shared/themeCss";
import { Effect } from "effect";

import {
  ThemeImageError,
  resolveThemeImagePath,
  storeThemeImageFile,
  type StoredThemeImage,
} from "../themeImages.ts";
import { ToolInputError } from "./toolInput.ts";

export const THEME_TOOL_MAX_IMAGES = 8;
const IMAGE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
// Everything a reference token can be made of, so a name is never matched as a prefix.
const REFERENCE_TOKEN = /moss-theme-image:([A-Za-z0-9._-]*)/g;

export interface PreparedThemeImages {
  /** The tool arguments with every picture name in CSS replaced by its stored reference. */
  readonly args: Record<string, unknown>;
  /** What was stored for each name, for the tool result. */
  readonly stored: Readonly<Record<string, StoredThemeImage>>;
}

const fail = (message: string) => Effect.fail(new ToolInputError(message));

/** Store the named pictures and rewrite the references in `css`, `light.css` and `dark.css`. */
export function prepareThemeToolImages(
  args: Record<string, unknown>,
  directory: string,
): Effect.Effect<PreparedThemeImages, ToolInputError> {
  return Effect.gen(function* () {
    const { images, ...rest } = args;
    // No prototype: a name such as `constructor` must not find an inherited member.
    const stored: Record<string, StoredThemeImage> = Object.create(null) as Record<
      string,
      StoredThemeImage
    >;
    if (images !== undefined) {
      if (images === null || typeof images !== "object" || Array.isArray(images)) {
        return yield* fail(
          'images: expected an object of name to absolute path, like {"hero": "C:\\\\pictures\\\\hero.png"}.',
        );
      }
      const entries = Object.entries(images);
      if (entries.length > THEME_TOOL_MAX_IMAGES) {
        return yield* fail(`images: at most ${THEME_TOOL_MAX_IMAGES} pictures in one call.`);
      }
      for (const [name, path] of entries) {
        if (!IMAGE_NAME.test(name)) {
          return yield* fail(
            `images: "${name}" is not a usable name. Use a-z, 0-9 and -, starting with a letter.`,
          );
        }
        if (typeof path !== "string") return yield* fail(`images.${name}: expected a file path.`);
        stored[name] = yield* Effect.tryPromise({
          try: () => storeThemeImageFile(directory, path),
          catch: (cause) =>
            new ToolInputError(
              `images.${name}: ${cause instanceof ThemeImageError ? cause.message : "the file could not be stored."}`,
            ),
        });
      }
    }

    const unknown = new Set<string>();
    const referenced = new Set<string>();
    const rewrite = (css: string) =>
      css.replace(REFERENCE_TOKEN, (token, value: string) => {
        if (isThemeImageId(value)) {
          referenced.add(value);
          return token;
        }
        const picture = Object.hasOwn(stored, value) ? stored[value] : undefined;
        if (!picture) {
          unknown.add(value);
          return token;
        }
        referenced.add(picture.id);
        return picture.reference;
      });
    const rewritePack = (pack: unknown) =>
      pack !== null && typeof pack === "object" && !Array.isArray(pack) && "css" in pack
        ? typeof (pack as { css?: unknown }).css === "string"
          ? { ...pack, css: rewrite((pack as { css: string }).css) }
          : pack
        : pack;
    const next: Record<string, unknown> = { ...rest };
    if (typeof next.css === "string") next.css = rewrite(next.css);
    if (next.light !== undefined) next.light = rewritePack(next.light);
    if (next.dark !== undefined) next.dark = rewritePack(next.dark);

    if (unknown.size > 0) {
      const names = Object.keys(stored);
      return yield* fail(
        `css refers to ${[...unknown].map((name) => `${THEME_IMAGE_SCHEME}${name}`).join(", ")}, which is not a stored picture. ${
          names.length > 0
            ? `Pictures in this call: ${names.join(", ")}.`
            : "Pass the file in `images` by that name."
        }`,
      );
    }
    for (const id of referenced) {
      const found = yield* Effect.promise(() =>
        resolveThemeImagePath(directory, id).catch(() => null),
      );
      if (!found) {
        return yield* fail(
          `${THEME_IMAGE_SCHEME}${id} is not stored on this computer. Pass the picture again in \`images\`.`,
        );
      }
    }
    return { args: next, stored };
  });
}
